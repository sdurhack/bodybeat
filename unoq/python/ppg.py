"""Pure-Python PPG (pulse) pipeline. No dependencies, so it runs on the UNO Q,
a laptop, or in tests.

    raw samples (any rate, timestamped)
      -> resample to FS Hz
      -> bandpass ~0.5-3.0 Hz (pass 40-180 BPM)
      -> invert (transmitted light DROPS when blood arrives)
      -> adaptive-threshold peak detection with refractory period
      -> BPM = median of recent beat intervals
    motion (accel magnitude away from 1 g) blanks beats for a short time.
"""
import math
from collections import deque

FS = 25.0  # internal sample rate, Hz


class Biquad:
    """RBJ cookbook biquad, Direct Form I."""

    def __init__(self, kind, f0, fs, q=0.7071):
        w = 2 * math.pi * f0 / fs
        a = math.sin(w) / (2 * q)
        c = math.cos(w)
        if kind == "lp":
            b0, b1, b2 = (1 - c) / 2, 1 - c, (1 - c) / 2
        else:  # "hp"
            b0, b1, b2 = (1 + c) / 2, -(1 + c), (1 + c) / 2
        a0, a1, a2 = 1 + a, -2 * c, 1 - a
        self.b = (b0 / a0, b1 / a0, b2 / a0)
        self.a = (a1 / a0, a2 / a0)
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def reset(self, x):
        # Start in steady state for a constant input x (avoids a huge startup spike).
        b0, b1, b2 = self.b
        a1, a2 = self.a
        y = x * (b0 + b1 + b2) / (1 + a1 + a2)
        self.x1 = self.x2 = x
        self.y1 = self.y2 = y

    def __call__(self, x):
        b0, b1, b2 = self.b
        a1, a2 = self.a
        y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2
        self.x2, self.x1 = self.x1, x
        self.y2, self.y1 = self.y1, y
        return y


class PulseDetector:
    """Feed (t_seconds, value[, motion_g]) via add(). Returns a list of beat
    times detected by that call. Read .bpm, .quality, .last_filtered."""

    def __init__(self, fs=FS, lo=0.5, hi=3.0, refractory=0.33, motion_thresh=0.15,
                 motion_hold=1.0):
        self.fs = fs
        self.dt = 1.0 / fs
        # Gentle high-pass (one stage, Q=0.5): a steeper one phase-shifts slow
        # heart rates by ~180 deg and the "peak" lands on the wrong part of the beat.
        self.filters = [Biquad("hp", lo, fs, q=0.5),
                        Biquad("lp", hi, fs), Biquad("lp", hi, fs)]
        self.refractory = refractory
        self.motion_thresh = motion_thresh
        self.motion_hold = motion_hold
        self.reset()

    LOCK_ON, LOCK_OFF = 0.45, 0.3  # autocorrelation peak needed to show / keep a reading

    def reset(self):
        self.started = False
        self.t_next = None
        self.prev = None  # (t, value) last raw sample
        self.hist = deque(maxlen=int(self.fs * 2.5))  # filtered, for threshold
        self.long = deque(maxlen=int(self.fs * 8))    # filtered, for autocorrelation
        self.n = 0
        self.bpm_peaks = None   # from beat-to-beat intervals
        self.bpm_ac = None      # from autocorrelation of the last 8 s
        self.locked = False
        self.ac_hist = deque(maxlen=5)
        self.confidence = 0.0   # 0..1: how periodic the signal is (autocorrelation peak)
        self.y1 = self.y2 = 0.0
        self.last_beat = None
        self.ibis = deque(maxlen=8)
        self.beats = deque(maxlen=32)
        self.motion_until = -1.0
        self.bpm = None
        self.last_filtered = 0.0
        self.dc = None
        self.quality = 0.0  # ~ perfusion index: AC amplitude / DC level

    # --- public -----------------------------------------------------------
    def add(self, t, value, motion_g=0.0):
        if motion_g > self.motion_thresh:
            self.motion_until = t + self.motion_hold
        if self.prev is None:
            self.prev = (t, value)
            self.t_next = t
            return []
        if t - self.prev[0] > 1.0:  # gap (finger removed / dropout): restart
            m = self.motion_until
            self.reset()
            self.motion_until = m
            self.prev = (t, value)
            self.t_next = t
            return []
        out = []
        t0, v0 = self.prev
        while self.t_next <= t:  # linear-interpolate onto the FS grid
            frac = 0.0 if t == t0 else (self.t_next - t0) / (t - t0)
            b = self._step(self.t_next, v0 + (value - v0) * frac)
            if b is not None:
                out.append(b)
            self.t_next += self.dt
        self.prev = (t, value)
        return out

    # --- internals --------------------------------------------------------
    def _step(self, t, x):
        if not self.started:
            v = x
            for f in self.filters:  # prime each stage at steady state
                f.reset(v)
                v = f(v)
            self.started = True
            self.dc = x
        self.dc += 0.02 * (x - self.dc)
        y = x
        for f in self.filters:
            y = f(y)
        y = -y  # pulse = dip in transmitted light; flip so beats are maxima
        self.last_filtered = y
        self.hist.append(y)
        self.long.append(y)
        self.n += 1
        if self.n % int(self.fs / 2) == 0:  # twice a second
            self._autocorr()
        beat = None
        # local max at y1 (previous sample)
        if self.y1 > self.y2 and self.y1 >= y and len(self.hist) >= self.fs:
            lo, hi = min(self.hist), max(self.hist)
            amp = hi - lo
            if self.dc:
                self.quality = amp / abs(self.dc)
            thresh = lo + 0.6 * amp
            # sub-sample peak time (parabola through the 3 points around the max)
            den = self.y2 - 2 * self.y1 + y
            off = 0.5 * (self.y2 - y) / den if den else 0.0
            tb = t - self.dt + max(-0.5, min(0.5, off)) * self.dt
            in_motion = tb < self.motion_until
            if amp > 0 and self.y1 > thresh and not in_motion and (
                    self.last_beat is None or tb - self.last_beat >= self.refractory):
                if self.last_beat is not None:
                    ibi = tb - self.last_beat
                    if 0.33 <= ibi <= 1.5:  # 40-180 BPM
                        self._accept_ibi(ibi)
                self.last_beat = tb
                self.beats.append(tb)
                beat = tb
            elif in_motion:
                self.last_beat = None  # don't bridge an interval across motion
        self.y2, self.y1 = self.y1, y
        return beat

    def _accept_ibi(self, ibi):
        if len(self.ibis) >= 3:
            med = sorted(self.ibis)[len(self.ibis) // 2]
            if abs(ibi - med) > 0.35 * med:  # reject outliers (missed/extra beat)
                # but let a genuinely changed rate through after a few tries
                self._rejects = getattr(self, "_rejects", 0) + 1
                if self._rejects < 3:
                    return
        self._rejects = 0
        self.ibis.append(ibi)
        s = sorted(self.ibis)
        k = len(s) // 4  # trimmed mean: robust like a median, but smooth
        mid = s[k:len(s) - k] or s
        self.bpm_peaks = 60.0 * len(mid) / sum(mid)
        self._fuse()

    def _autocorr(self):
        """Second opinion on the rate. Peak-picking fails by missing or
        double-counting beats; autocorrelation asks "what period does the last
        8 s repeat at?" and is immune to both. Its peak height (0..1) doubles
        as a signal-quality score."""
        x = list(self.long)
        n = len(x)
        if n < self.fs * 4:
            return
        # remove slow drift (breathing, finger pressure) with a 1 s moving average
        w = int(self.fs) | 1
        h = w // 2
        cs = [0.0]
        for v in x:
            cs.append(cs[-1] + v)
        x = [x[i] - (cs[min(n, i + h + 1)] - cs[max(0, i - h)]) / (min(n, i + h + 1) - max(0, i - h))
             for i in range(n)]
        e = sum(v * v for v in x)
        if e <= 0:
            return
        lo, hi = int(self.fs * 0.33), min(int(self.fs * 1.5), n // 2)
        r = [0.0] * (hi + 2)
        for lag in range(lo - 1, hi + 2):
            # unbiased: scale by overlap so long lags aren't penalised
            r[lag] = sum(x[i] * x[i + lag] for i in range(n - lag)) / e * n / (n - lag)
        peaks = [k for k in range(lo, hi + 1) if r[k] > r[k - 1] and r[k] >= r[k + 1]]
        top = max((r[k] for k in peaks), default=0.0)
        if top <= 0.05:  # nothing repeats: no pulse in this signal
            self.confidence *= 0.8
            self._fuse()
            return
        # first peak nearly as tall as the tallest = the fundamental, not 2x the period
        k = next(k for k in peaks if r[k] >= 0.85 * top)
        # octave check: noise can bury the true peak so we land on 2x the
        # period (half the rate). If there is a decent peak at half the lag, use it.
        half = [j for j in peaks if abs(j - k / 2.0) <= 1.5 and r[j] >= 0.6 * r[k]]
        if half:
            k = max(half, key=lambda j: r[j])
        den = r[k - 1] - 2 * r[k] + r[k + 1]
        off = 0.5 * (r[k - 1] - r[k + 1]) / den if den else 0.0
        # A real pulse repeats again at twice the lag. Filtered noise also
        # "rings" for one cycle but has died out by the second, so require both.
        r2 = max(sum(x[i] * x[i + j] for i in range(n - j)) / e * n / (n - j)
                 for j in (2 * k - 1, 2 * k, 2 * k + 1) if j < n - int(self.fs))
        self.confidence = max(0.0, min(1.0, r[k], r2))
        self.ac_hist.append(60.0 * self.fs / (k + max(-0.5, min(0.5, off))))
        self.bpm_ac = sorted(self.ac_hist)[len(self.ac_hist) // 2]  # median of 2.5 s: no blips
        self._fuse()

    def _fuse(self):
        """Peaks give a fast, smooth number; autocorrelation is the referee."""
        p, a, c = self.bpm_peaks, self.bpm_ac, self.confidence
        # No reading beats a wrong reading: on a noisy signal the peak-picker
        # happily reports a confident-looking number, so gate on periodicity.
        self.locked = c >= (self.LOCK_OFF if self.locked else self.LOCK_ON)
        if not (a and self.locked):
            self.bpm = None
        elif p and abs(p - a) <= 0.06 * a:
            self.bpm = 0.5 * (p + a)    # they agree: blend (peaks react faster, a is steadier)
        elif p and abs(p - a) <= 0.15 * a:
            self.bpm = a                # close: periodicity wins, keep the peak tracker
        else:
            self.bpm = a                # they disagree: trust the periodicity
            self.ibis.clear()           # let the peak tracker re-lock at the right rate
            self.bpm_peaks = None


def accel_motion(ax, ay, az):
    """How far the accel magnitude (in g) is from 1 g. ~0 when still."""
    return abs(math.sqrt(ax * ax + ay * ay + az * az) - 1.0)


class MultiChannel:
    """Runs one PulseDetector per light channel and reports the one with the
    clearest pulse (highest AC/DC). Saves guessing which channel works best
    for your LED + finger."""

    MIN_LEVEL = 40  # counts

    def __init__(self, names, max_level=None):
        self.det = {n: PulseDetector() for n in names}
        self.best = names[0]
        # Optional ADC ceiling (e.g. 65535 for 16-bit). A channel that touched
        # it in the last ~2 s is clipped: the pulse is flattened away, so skip it.
        self.max_level = max_level
        self.clip_until = {n: -1.0 for n in names}

    def usable(self, t=None):
        """Channels that are neither near zero nor saturated."""
        ok = []
        for n, d in self.det.items():
            if (d.dc or 0) < self.MIN_LEVEL:
                continue
            if t is not None and t < self.clip_until[n]:
                continue
            ok.append(n)
        return ok

    def add(self, t, values, motion_g=0.0):
        beats = {}
        for n, v in values.items():
            if self.max_level and v >= 0.98 * self.max_level:
                self.clip_until[n] = t + 2.0
            beats[n] = self.det[n].add(t, v, motion_g)
        # A channel reading only a few counts is all quantisation steps: its
        # "pulse" is rounding noise with a huge fake AC/DC. Never pick it.
        usable = self.usable(t) or list(self.det)
        ranked = sorted(usable, key=lambda n: (self.det[n].bpm is not None,
                                               self.det[n].quality), reverse=True)
        top, cur = self.det[ranked[0]], self.det[self.best]
        # hysteresis: only switch channel when clearly better (avoids flapping)
        if self.best not in usable or (cur.bpm is None and top.bpm is not None) or top.quality > 1.3 * cur.quality:
            self.best = ranked[0]
        return beats.get(self.best, [])

    @property
    def bpm(self):
        return self.det[self.best].bpm

    @property
    def quality(self):
        return self.det[self.best].quality

    @property
    def confidence(self):
        return self.det[self.best].confidence

    @property
    def last_filtered(self):
        return self.det[self.best].last_filtered
