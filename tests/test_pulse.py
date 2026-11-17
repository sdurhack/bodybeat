"""Light-pulse validation tests. Run: python tests/test_pulse.py"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "unoq", "python"))
import pulse  # noqa: E402


def feed(lp, seconds, bpm=72, fs=40, level=20000, amp=0.012, t0=0.0, noise=8, now0=1000.0,
         sat=False):
    random.seed(1)
    n = int(seconds * fs)
    for i in range(n):
        t = t0 + i / fs
        ph = (t * bpm / 60.0) % 1.0
        v = level * (1 - amp * math.exp(-((ph - 0.15) / 0.07) ** 2)) + random.gauss(0, noise)
        ir = 65535 if sat else v
        lp.add(int(t * 1000), ir, v * 0.9, v * 0.4, v * 0.2, now=now0 + t)
    return now0 + t0 + seconds


def test_starts_searching_and_never_invents_bpm():
    lp = pulse.LightPulse()
    assert lp.status(0.0) == "no sensor data" and lp.bpm is None
    now = feed(lp, 2.0)
    assert lp.bpm is None and lp.summary(now)["status"].startswith("searching")


def test_locks_on_clean_40hz_signal():
    lp = pulse.LightPulse()
    now = feed(lp, 20.0, bpm=72)
    s = lp.summary(now)
    assert s["status"] == "locked", s
    assert abs(s["bpm"] - 72) < 3, s
    assert 39 < s["rate_hz"] < 41, s


def test_repeated_timestamps_are_not_new_samples():
    lp = pulse.LightPulse()
    for _ in range(5):
        lp.add(1000, 100, 100, 100, 100, now=1.0)
    assert lp.accepted == 1 and lp.dropped_repeat == 4


def test_saturated_channel_is_never_used():
    lp = pulse.LightPulse()
    now = feed(lp, 20.0, sat=True)
    assert "ir" not in lp.summary(now)["usable"]
    assert lp.det.best != "ir"


def test_near_zero_channels_rejected():
    lp = pulse.LightPulse()
    now = feed(lp, 6.0, level=20)
    s = lp.summary(now)
    assert s["usable"] == [] and s["status"].startswith("searching (no usable")
    assert s["bpm"] is None


def test_stale_light_resets_and_reports_stale():
    lp = pulse.LightPulse()
    now = feed(lp, 20.0)
    assert lp.bpm is not None
    assert lp.check_stale(now + 2.0)
    assert lp.bpm is None and lp.status(now + 2.0) == "stale"


def test_optical_jump_blanks_pulse():
    lp = pulse.LightPulse()
    now = feed(lp, 20.0)
    lp.add(20000, 30000, 27000, 12000, 6000, now=now)
    assert lp.status(now).startswith("searching (motion)")

if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
