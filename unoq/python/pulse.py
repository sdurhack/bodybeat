"""Fingertip pulse from the Modulino Light (LTR381) for the bodybeat.

The MCU sketch sends one Bridge "ppg" call per FRESH sensor measurement
(it polls the chip's data-ready flag), with the MCU timestamp in ms:

    t_ms, ir, red, green, blue

This module only lets a sample reach the pulse detector if it is believable:
  * timestamps must move forward (repeats = the same measurement twice: dropped)
  * near-zero channels are ignored (ppg.MultiChannel.MIN_LEVEL)
  * saturated channels (>= 98% of the 16-bit range) are ignored for 2 s
  * a sudden jump in light from finger slip blanks beats
  * no fresh sample for STALE_S seconds = stale: detector reset, "searching"

It reports a measured heart rate ONLY when ppg's autocorrelation gate has
locked. Until then the status is "searching" and bpm is None.
"""
import time
from collections import deque

import ppg

FULL_SCALE = 65535  # 16-bit ADC resolution set in the sketch
STALE_S = 1.0
JUMP = 0.08  # fractional change in one sample that can only be motion / finger slip


class LightPulse:
    CHANNELS = ["ir", "red", "green", "clear"]

    def __init__(self):
        self.det = ppg.MultiChannel(self.CHANNELS, max_level=FULL_SCALE)
        self.last_t = None          # MCU time of last accepted sample (s)
        self.last_rx = -1e9         # OUR receipt time of last accepted sample
        self.prev = None
        self.arrivals = deque(maxlen=80)  # MCU timestamps, for effective rate
        self.dropped_repeat = 0
        self.accepted = 0
        self.motion = 0.0
        self.levels = {}

    def add(self, t_ms, ir, r, g, b, now=None):
        """Feed one sample. Returns a list of beat times (validated or not:
        callers should only announce beats when .bpm is not None)."""
        now = time.time() if now is None else now
        t = float(t_ms) / 1000.0
        if self.last_t is not None and t <= self.last_t:
            self.dropped_repeat += 1     # duplicate or out-of-order: not a new measurement
            return []
        values = {"ir": float(ir), "red": float(r), "green": float(g), "clear": float(r) + float(g) + float(b)}
        motion = 0.0  # optical artifact rejection without an accelerometer
        if self.prev is not None:
            for n in ("ir", "red", "green"):
                p = self.prev[n]
                if p > ppg.MultiChannel.MIN_LEVEL and abs(values[n] - p) / p > JUMP:
                    motion = max(motion, 1.0)  # finger slipped / pressed: treat as motion
        self.prev = values
        self.levels = values
        self.motion = motion
        self.last_t = t
        self.last_rx = now
        self.arrivals.append(t)
        self.accepted += 1
        return self.det.add(t, values, motion)

    def check_stale(self, now=None):
        """Call a few times a second. Resets the detector if the Light went quiet."""
        now = time.time() if now is None else now
        if self.accepted and now - self.last_rx > STALE_S and self.det.bpm is not None:
            for d in self.det.det.values():
                d.reset()
        return self.stale(now)

    def stale(self, now=None):
        now = time.time() if now is None else now
        return now - self.last_rx > STALE_S

    def rate_hz(self):
        """Effective rate of FRESH measurements, from the MCU timestamps."""
        a = self.arrivals
        if len(a) < 5 or a[-1] <= a[0]:
            return None
        return (len(a) - 1) / (a[-1] - a[0])

    @property
    def bpm(self):
        return self.det.bpm

    def status(self, now=None):
        now = time.time() if now is None else now
        if not self.accepted:
            return "no sensor data"
        if self.stale(now):
            return "stale"
        if not self.det.usable(self.last_t):
            return "searching (no usable channel: covered? saturated?)"
        if self.motion > self.det.det[self.det.best].motion_thresh:
            return "searching (motion)"
        return "locked" if self.det.bpm is not None else "searching"

    def summary(self, now=None):
        now = time.time() if now is None else now
        rate = self.rate_hz()
        return {
            "status": self.status(now),
            "bpm": round(self.det.bpm, 1) if self.det.bpm else None,
            "confidence": round(self.det.confidence, 2),
            "channel": self.det.best,
            "usable": self.det.usable(self.last_t) if self.last_t is not None else [],
            "rate_hz": round(rate, 1) if rate else None,
            "level": round(self.levels.get(self.det.best, 0.0)),
            "repeats_dropped": self.dropped_repeat,
        }
