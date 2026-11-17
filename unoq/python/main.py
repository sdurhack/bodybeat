"""Body Beat, actor 2: the UNO Q. Runs in App Lab on the board, or on a laptop with --sim.

Senses:   Modulino Light + steady red LED = fingertip pulse (Bridge "ppg", raw 16-bit counts)
          Modulino Movement = melody intensity + tilt, Modulino Knob = instrument / breakdown
          Nicla camera state over UDP :7100 = room brightness (mood), person presence, motion
Decides:  band tempo (follows a VALIDATED pulse; holds it on loss; 80 BPM labelled
          "default" before the first lock), key/mood, presence, intensity, instrument
Acts:     LED matrix (tempo + beat), breadboard LEDs (beat, mood, link status),
          and tells the rest of the band over UDP :7100

Resilience: the band clock lives HERE. If WiFi drops, the matrix and the beat
LED keep going at the last tempo and the status LEDs blink.

    BB_PEERS=192.168.137.1      laptop running laptop/conductor.py (comma-separated list ok;
                                empty = try broadcast discovery, works only if the container
                                can send/receive broadcasts)
    BB_PORT=7100                UDP port this board listens on
    BB_KNOB_STEP=2              encoder counts per knob click

Laptop test:  BB_PORT=7110 HB_PORT=7005 BB_PEERS=127.0.0.1:7100 python main.py --sim
"""
import argparse
import math
import os
import random
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import band  # noqa: E402
import pulse  # noqa: E402
import server  # noqa: E402  (same /bpm + /events API as heartbeat/, on :7000)

try:
    from arduino.app_utils import App, Bridge  # only exists on the UNO Q
except ImportError:
    App = Bridge = None

PORT = int(os.environ.get("BB_PORT", band.PORT))
def _peers_default():
    """BB_PEERS, else peers.txt next to this file (edit it over adb, no App Lab needed), else the hotspot.
    The app's container only receives replies to packets it sent first, so the laptop must be listed
    here when it is not on the hotspot (e.g. both on the venue WiFi)."""
    if os.environ.get("BB_PEERS"):
        return os.environ["BB_PEERS"]
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "peers.txt")) as f:
            txt = ",".join(line.split("#")[0].strip() for line in f)
        if txt.strip(", "):
            return txt
    except OSError:
        pass
    return "192.168.137.1"


SEEDS = [s.strip() for s in _peers_default().split(",") if s.strip()]
HTTP_PORT = int(os.environ.get("HB_PORT", 7000))

brain = band.UnoQBrain(SEEDS, knob_step=int(os.environ.get("BB_KNOB_STEP", 2)))
lock = threading.Lock()
light = pulse.LightPulse()
diag = {"light_found": None, "reads": None, "mcu_rate": None, "env_calls": 0, "ppg_calls": 0}
counters = {"rx": 0, "dup": 0}
# demo mode (the page's Demo buttons): a forced heart rate, refreshed by every "show" packet
demo = {"bpm": None, "until": 0.0}


def demo_bpm(now):
    return demo["bpm"] if now < demo["until"] else None
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
except OSError:
    pass
sock.bind(("0.0.0.0", PORT))


def mcu(name, *args):
    if Bridge is None:
        return
    try:
        Bridge.notify(name, *args)
    except Exception as e:  # the display must never kill the band
        print("bridge %s failed: %s" % (name, e), flush=True)


def send(msg):
    data = band.encode(msg)
    for addr in brain.peers.targets():
        try:
            sock.sendto(data, addr)
        except OSError:  # no route while WiFi is down: keep going
            pass


# ---- inputs from the MCU ---------------------------------------------------

def on_env(t_ms, ax, ay, az, knob, pressed):
    """Movement + Knob, ~20 Hz."""
    diag["env_calls"] += 1
    with lock:
        brain.on_env(float(ax), float(ay), float(az), int(knob), bool(pressed))


def on_ppg(t_ms, ir, r, g, b, ax=0.0, ay=0.0, az=1.0):
    """One FRESH Light measurement (the sketch waits for data-ready)."""
    diag["ppg_calls"] += 1
    now = time.time()
    with lock:
        beats = light.add(t_ms, ir, r, g, b, ax, ay, az, now=now)
        bpm = light.bpm
        if bpm and demo_bpm(now) is None:  # demo mode wins over the real finger
            brain.clock.heart(bpm, now)
        summary = light.summary(now)
    if bpm is None:
        return
    for _ in beats:  # only validated beats: the laptop plays a soft "lub-dub"
        send({"from": "unoq", "type": "heart", "bpm": round(bpm, 1)})
        server.STATE.update(bpm=summary["bpm"], quality=summary["confidence"],
                            source="light:%s" % summary["channel"],
                            beats=server.STATE.snapshot()["beats"] + 1)
        server.STATE.publish("beat", server.STATE.snapshot())


def on_diag(have_light, reads, rate_x10):
    """Every 2 s: did the Light start, how many fresh readings, MCU-measured rate."""
    diag["light_found"], diag["reads"] = bool(have_light), int(reads)
    diag["mcu_rate"] = int(rate_x10) / 10.0


# ---- network ---------------------------------------------------------------

def band_loop():
    while True:
        data, addr = sock.recvfrom(4096)
        msg = band.decode(data)
        if msg and msg.get("from") == "laptop" and msg.get("type") == "show":
            on_show(msg)
        if msg and msg.get("from") != "unoq":
            with lock:
                counters["rx"] += 1
                if not brain.on_packet(msg, addr, time.time()):
                    counters["dup"] += 1


def on_show(msg):
    """~5 Hz from live.html: what the band is playing, for the breadboard light show
    (the MCU renders it on this board's own beat clock), plus demo mode's forced heart rate."""
    def i(k, lo, hi, default):
        try:
            return max(lo, min(hi, int(round(float(msg.get(k, default))))))
        except (TypeError, ValueError):
            return default
    d = msg.get("demo")
    with lock:
        try:
            demo["bpm"], demo["until"] = (float(d), time.time() + 2.0) if d else (None, 0.0)
        except (TypeError, ValueError):
            demo["bpm"], demo["until"] = None, 0.0
    mcu("show", i("playing", 0, 1, 0), i("pattern", 0, 4, 1), i("level", 0, 2, 1), i("src", 0, 1, 0),
        i("energy", 0, 100, 40), i("mood", 0, 2, 1), i("fill", 0, 1, 0))


def discovery_loop():
    """No laptop known (BB_PEERS empty or wrong): shout on the local broadcast address."""
    while True:
        with lock:
            known = brain.peers.online("laptop", time.time())
        if not known:
            try:
                sock.sendto(band.encode({"from": "unoq", "type": "hello"}), ("255.255.255.255", PORT))
            except OSError:
                pass
        time.sleep(2.0)


# ---- outputs ---------------------------------------------------------------

def clock_loop():
    """100 Hz: fire band beats on time, even if everything else is down."""
    while True:
        now = time.time()
        with lock:
            d = demo_bpm(now)
            if d:  # demo mode: the clock follows the forced rate like a real pulse
                brain.clock.heart(d, now)
            fired = brain.clock.tick(now)
            msgs = [brain.beat(i) for i in fired]
            beat_ms = int(60000 / brain.clock.bpm)
        for i, m in zip(fired, msgs):
            send(m)
            mcu("beat")
            mcu("tick", int(i), beat_ms)  # light show: beat number + length, the MCU fills in 16ths
        time.sleep(0.01)


def status_loop():
    """5 Hz: share state with the band, update LEDs and matrix."""
    last_bpm = None
    n = 0
    while True:
        now = time.time()
        with lock:
            light.check_stale(now)
            brain.pulse = light.summary(now)
            st = brain.state(now)
        send(st)
        links = st["links"]
        mcu("status", band.MOODS.index(st["mood"]), int(links.get("laptop", False)),
            int(st["vision_fresh"]))
        bpm = int(round(st["bpm"]))
        if bpm != last_bpm:
            mcu("show_bpm", bpm)
            last_bpm = bpm
        n += 1
        if n % 5 == 0:
            p = st["pulse"]
            server.STATE.update(bpm=p["bpm"], quality=p["confidence"], source="light:%s" % p["channel"])
            server.STATE.publish("bpm", dict(server.STATE.snapshot(), pulse=p, tempo=st["bpm"],
                                             tempo_source=st["tempo_source"]))
            print("tempo=%.1f (%s) heart=%s pulse=[%s ch=%s %s Hz lvl=%s] mood=%s(%s via %s, face=%s %s) presence=%.0f "
                  "int=%.2f inst=%s nicla=%s laptop=%s rx=%d dup=%d light_found=%s mcu_rate=%s" % (
                      st["bpm"], st["tempo_source"], p["bpm"], p["status"], p["channel"], p["rate_hz"],
                      p["level"], st["mood"], st["mood_source"], st["mood_from"], st["face_mood"],
                      st["face_confidence"], st["presence"], st["intensity"],
                      st["instrument"], st["nicla_path"], links.get("laptop", False),
                      counters["rx"], counters["dup"], diag["light_found"], diag["mcu_rate"]),
                  flush=True)
        time.sleep(0.2)


# ---- simulation (no hardware) ----------------------------------------------

def sim_loop():
    """Fake Movement/Knob + a fake fingertip PPG at 40 Hz (labelled SIM in the log)."""
    print("bodyband unoq: SIMULATION (fake Movement, Knob and Light PPG)", flush=True)
    t, phase = 0.0, 0.0
    while True:
        shake = 0.5 * max(0.0, math.sin(t / 7.0)) ** 8      # a burst of movement every ~45 s
        ax = 0.3 * math.sin(t / 5.0) + random.gauss(0, shake)
        on_env(int(t * 1000), ax, random.gauss(0, shake), 1 + random.gauss(0, shake),
               int(t // 15) * 2, False)
        bpm = 70 + 25 * (0.5 + 0.5 * math.sin(t / 30.0))
        for _ in range(2):
            phase = (phase + bpm / 60.0 / 40.0) % 1.0
            v = 20000 - 300 * math.exp(-((phase - 0.15) / 0.07) ** 2) + random.gauss(0, 10)
            on_ppg(int(t * 1000), v, v * 0.8, v * 0.3, v * 0.2, 0.0, 0.0, 1.0)
            t += 0.025
        time.sleep(0.05)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", action="store_true")
    a = ap.parse_args()
    print("bodyband unoq: udp :%d peers=%s default tempo %d BPM until a pulse locks" % (
        PORT, SEEDS or "(broadcast discovery)", band.DEFAULT_BPM), flush=True)
    server.start(HTTP_PORT)
    for fn in (band_loop, clock_loop, status_loop, discovery_loop):
        threading.Thread(target=fn, daemon=True).start()
    if a.sim:
        threading.Thread(target=sim_loop, daemon=True).start()
    if Bridge is not None:
        Bridge.provide("env", on_env)
        Bridge.provide("ppg", on_ppg)
        Bridge.provide("diag", on_diag)
        App.run()
    else:
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
