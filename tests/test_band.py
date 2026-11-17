"""Tests for the Body Beat decisions + link layer. Run: python tests/test_band.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "unoq", "python"))
import band  # noqa: E402


def test_clock_follows_heart_then_holds():
    c = band.BandClock(bpm=80)
    t = 0.0
    beats = 0
    while t < 30:
        c.heart(110, t)
        beats += len(c.tick(t))
        t += 0.01
    assert abs(c.bpm - 110) < 1, c.bpm
    # pulse lost (finger off / Nicla offline): tempo holds, beats keep coming
    held = c.bpm
    before = c.index
    while t < 60:
        c.tick(t)
        t += 0.01
    assert abs(c.bpm - held) < 0.01
    assert c.index - before > 50  # ~55 beats in 30 s at 110 BPM


def test_clock_clamps_tempo():
    c = band.BandClock()
    for i in range(2000):
        c.heart(190, i * 0.01)
        c.tick(i * 0.01)
    assert c.bpm <= 150.01


def test_clock_after_sleep_does_not_burst():
    c = band.BandClock(bpm=60)
    c.tick(0.0)
    assert len(c.tick(100.0)) <= 2


def test_mood_hysteresis():
    m = band.Mood()
    assert m(0.0) == "night"
    assert m(0.36) == "night"   # inside the hysteresis band: stays
    assert m(0.5) == "dusk"
    assert m(0.95) == "day"
    assert m(0.63) == "day"
    assert m(0.5) == "dusk"


def test_autorange_self_calibrates():
    a = band.AutoRange()
    for _ in range(50):
        a(5)        # covered
        a(5000)     # torch
    assert a(5) < 0.1 and a(5000) > 0.9


def test_peers_offline_and_gossip():
    p = band.Peers("unoq", ["192.168.137.1"])
    p.heard("laptop", ("192.168.137.1", 7100), 0.0)
    assert p.online("laptop", 1.0)
    assert not p.online("laptop", 3.0)  # WiFi dropped
    p.learn({"nicla": "192.168.137.20:7100", "unoq": "x:1"})
    assert p.addr["nicla"] == ("192.168.137.20", 7100)
    assert "unoq" not in p.addr
    assert ("192.168.137.1", 7100) in p.targets()
    p.heard("laptop", ("192.168.137.1", 7100), 10.0)  # back: re-synced
    assert p.online("laptop", 10.5)


def test_brain_state_only_contains_used_hardware_data():
    b = band.UnoQBrain()
    s = b.state(0.0)
    assert s["from"] == "unoq" and s["pulse"]["status"] == "searching"
    assert "knob" not in s and "tilt" not in s and "instrument" not in s and "breakdown" not in s
    msg = band.decode(band.encode(s))
    assert msg["seq"] == 1
    assert band.decode(b"garbage") is None

# ---- source routing: Light = pulse, Nicla brightness = mood ----------------

def nicla(seq, brightness=0.5, present=None, conf=None, boot=1, via=None):
    m = {"from": "nicla", "type": "state", "seq": seq, "boot": boot, "mode": "vision",
         "energy": 0.2, "pattern": 1, "brightness": brightness, "person_present": present,
         "person_confidence": conf, "vision_method": "motion", "inference_ms": None}
    if via:
        m["via"] = via
    return m


def test_mood_comes_from_nicla_brightness_not_light():
    b = band.UnoQBrain()
    assert b.state(0.0)["mood_source"] == "default"
    t, seq = 0.0, 0
    for _ in range(40):             # dark room
        seq += 1
        b.on_packet(nicla(seq, 0.02), ("10.0.0.5", 7100), t)
        t += 0.2
    for _ in range(40):             # lights on
        seq += 1
        b.on_packet(nicla(seq, 0.9), ("10.0.0.5", 7100), t)
        t += 0.2
    st = b.state(t)
    assert st["mood"] == "day" and st["mood_source"] == "camera" and st["light"] == 0.9
    assert st["nicla_path"] == "direct" and st["vision_fresh"]


def test_stale_camera_holds_mood_and_never_fades_on_a_guess():
    b = band.UnoQBrain()
    b.on_packet(nicla(1, 0.9, present=False, conf=0.1), ("10.0.0.5", 7100), 0.0)
    st = b.state(0.5)
    assert st["presence"] == 0.0 and st["person_present"] is False
    st = b.state(10.0)              # camera silent for 10 s
    assert not st["vision_fresh"] and st["mood_source"] == "held"
    assert st["presence"] == 1.0 and st["person_present"] is None  # unknown -> full band
    assert st["nicla_path"] == "none"


def test_ml_unavailable_means_full_band_and_null_fields():
    b = band.UnoQBrain()
    b.on_packet(nicla(1, 0.5, present=None, conf=None), ("10.0.0.5", 7100), 0.0)
    st = b.state(0.1)
    assert st["presence"] == 1.0 and st["person_present"] is None


def test_duplicates_and_out_of_order_ignored():
    b = band.UnoQBrain()
    a = ("10.0.0.5", 7100)
    assert b.on_packet(nicla(5, 0.5), a, 0.0)
    assert not b.on_packet(nicla(5, 0.1, via="laptop"), ("10.0.0.1", 7100), 0.05)  # relayed copy
    assert not b.on_packet(nicla(4, 0.1), a, 0.1)                                 # late
    assert b.vision.brightness == 0.5
    assert b.on_packet(nicla(1, 0.2, boot=2), a, 0.3)   # Nicla rebooted: seq restarts
    assert b.on_packet(nicla(1, 0.3, boot=2), a, 9.0) is True  # long gap also resets


def test_relayed_packet_does_not_fake_a_direct_link():
    b = band.UnoQBrain()
    b.on_packet(nicla(1, via="laptop"), ("10.0.0.1", 7100), 0.0)
    st = b.state(0.1)
    assert st["nicla_path"] == "relay" and not st["links"].get("nicla", False)


def test_tempo_source_labels():
    c = band.BandClock()
    assert c.bpm == band.DEFAULT_BPM == 80.0 and c.tempo_source(0) == "default"
    c.heart(70, 1.0)
    assert c.tempo_source(2.0) == "heart"
    assert c.tempo_source(20.0) == "held"


# ---- face-expression scores decide the key --------------------------------

def face(seq, top, conf=0.8, boot=1, brightness=0.9):
    scores = {k: round((1 - conf) / 4, 3) for k in ("angry", "happy", "neutral", "sad", "surprise")}
    scores[top] = conf
    m = nicla(seq, brightness, boot=boot)
    m.update(mood_label=top, mood_confidence=conf, mood_scores=scores, vision_method="ei-mood+motion")
    return m


def test_face_mood_sets_key_not_brightness():
    b = band.UnoQBrain()
    t = 0.0
    for i in range(1, 30):          # bright room but a sad face: key follows the face
        b.on_packet(face(i, "sad"), ("10.0.0.5", 7100), t)
        t += 0.2
    st = b.state(t)
    assert st["mood"] == "night" and st["mood_from"] == "face" and st["face_mood"] == "sad"
    for i in range(30, 60):
        b.on_packet(face(i, "happy"), ("10.0.0.5", 7100), t)
        t += 0.2
    assert b.state(t)["mood"] == "day"


def test_face_mood_ignores_low_confidence_and_single_frames():
    b = band.UnoQBrain()
    t = 0.0
    for i in range(1, 20):
        b.on_packet(face(i, "neutral"), ("10.0.0.5", 7100), t)
        t += 0.2
    assert b.state(t)["mood"] == "dusk"
    b.on_packet(face(20, "angry"), ("10.0.0.5", 7100), t)   # one odd frame
    assert b.state(t)["mood"] == "dusk"
    for i in range(21, 40):                                   # unsure model (no face?)
        b.on_packet(face(i, "happy", conf=0.3), ("10.0.0.5", 7100), t)
        t += 0.2
    assert b.state(t)["mood"] == "dusk"


def test_face_mood_held_when_camera_stale():
    b = band.UnoQBrain()
    for i in range(1, 20):
        b.on_packet(face(i, "happy"), ("10.0.0.5", 7100), i * 0.2)
    st = b.state(20.0)
    assert st["mood"] == "day" and st["mood_source"] == "held" and st["face_mood"] is None


def test_face_mood_on_real_model_outputs():
    """Scores recorded from a real face-expression model (smile, neutral, frown)."""
    measured = {
        "day": {"angry": .215, "happy": .234, "neutral": .035, "sad": .043, "surprise": .477},  # smile, tight crop
        "dusk": {"angry": .109, "happy": .008, "neutral": .883, "sad": 0, "surprise": 0},      # flat grey frame
    }
    for want, scores in measured.items():
        f = band.FaceMood()
        assert f.on_scores(scores, 0.0) and f.mood == want, (want, f.mood)
    noise = {"angry": .105, "happy": .406, "neutral": .199, "sad": .266, "surprise": .023}
    assert not band.FaceMood().on_scores(noise, 0.0)  # random pixels: ignored


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
