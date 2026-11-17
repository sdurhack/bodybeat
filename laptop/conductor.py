"""BodyBeats, actor 3: the laptop. Relays the band to the browser, which makes the sound.

    python conductor.py            real hardware; open http://localhost:8000
    python conductor.py --sim      fake UNO Q + Nicla, no hardware needed

Listens on UDP 7100 like every other peer. Each packet from an actor goes to the
browser over Server-Sent Events (/events). Twice a second it says "hello" to
every actor it has heard from, with the address book of the whole band, so the
UNO Q and the Nicla find each other. Once a second it also broadcasts that
hello on every local network, so the Nicla finds the laptop with no IP typed in.

Relay: the UNO Q's Python runs inside an App Lab container, which may not let
packets from the Nicla in. So the laptop also forwards Nicla state/fill to the
UNO Q and UNO Q beats/state to the Nicla, marked "via": "laptop". Receivers
drop duplicates by (boot, seq) and judge freshness by their own receipt time.

Demo controls (also buttons on the page):
    POST /api/cut?actor=unoq     pretend that actor's WiFi died (both directions)
    POST /api/cut?actor=unoq&off=1   bring it back
Stdlib only.
"""
import argparse
import json
import math
import os
import queue
import random
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "unoq", "python"))
import band  # noqa: E402

WEB = os.path.join(HERE, "web")
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css"}

peers = band.Peers("laptop")
cut = set()  # actors whose link we're pretending is dead
subs = []
lock = threading.Lock()
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def publish(msg):
    data = "data: %s\n\n" % json.dumps(msg)
    for q in list(subs):
        try:
            q.put_nowait(data)
        except queue.Full:
            pass


RELAY = {"nicla": ("unoq", ("state", "fill")), "unoq": ("nicla", ("state", "beat"))}
stats = {"relayed": 0}


def local_ips():
    """IPv4 addresses of this laptop (the hotspot address changes between setups)."""
    ips = set()
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    for probe in ("8.8.8.8", "192.168.137.255", "10.255.255.255"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((probe, 9))
            ips.add(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def broadcast_targets():
    out = {("255.255.255.255", ARGS.udp)}
    for ip in local_ips():
        out.add((ip.rsplit(".", 1)[0] + ".255", ARGS.udp))  # assumes a /24 (true for hotspots)
    return out


def udp_loop():
    while True:
        data, addr = sock.recvfrom(4096)
        msg = band.decode(data)
        if not msg or msg["from"] in cut or msg["from"] == "laptop" or msg.get("via"):
            continue
        with lock:
            peers.heard(msg["from"], addr, time.time())
            dest = RELAY.get(msg["from"])
            to = peers.addr.get(dest[0]) if dest and msg.get("type") in dest[1] and dest[0] not in cut else None
        if to:
            try:
                sock.sendto(band.encode(dict(msg, via="laptop")), to)
                stats["relayed"] += 1
            except OSError:
                pass
        if msg.get("type") == "hello":  # someone is looking for us: answer at once
            try:
                sock.sendto(band.encode({"from": "laptop", "type": "hello", "peers": peers.table()}), addr)
            except OSError:
                pass
        publish(msg)


def hello_loop():
    n = 0
    bcast = set()
    while True:
        now = time.time()
        with lock:
            msg = {"from": "laptop", "type": "hello", "peers": peers.table(), "links": peers.links(now)}
            targets = [a for name, a in peers.addr.items() if name not in cut]
            targets += [a for a in ARGS.peer if a not in targets]  # --peer: say hello directly
        data = band.encode(msg)
        if n % 20 == 0:
            bcast = broadcast_targets()  # refresh: hotspot may come up after we start
        if n % 2 == 0 and not ARGS.sim:
            targets += list(bcast)
        for addr in targets:
            try:
                sock.sendto(data, addr)
            except OSError:
                pass
        publish(dict(msg, cut=sorted(cut), relayed=stats["relayed"]))
        n += 1
        time.sleep(0.5)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/cut" and q.get("actor"):
            name = q["actor"][0]
            if q.get("off"):
                cut.discard(name)
            else:
                cut.add(name)
            print("link %s: %s" % (name, "CUT (simulated)" if name in cut else "restored"), flush=True)
            return self._send(200, json.dumps({"cut": sorted(cut)}).encode())
        if u.path == "/api/nicla":  # live.html passes on the Nicla it reads over USB -> UNO Q
            try:
                msg = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 4096)))
            except ValueError:
                return self._send(400, b"{}")
            if not isinstance(msg, dict) or msg.get("type") not in ("state", "fill"):
                return self._send(400, b"{}")
            msg.update({"from": "nicla", "via": "laptop"})
            with lock:
                to = peers.addr.get("unoq") if "nicla" not in cut and "unoq" not in cut else None
            if to:
                try:
                    sock.sendto(band.encode(msg), to)
                    stats["relayed"] += 1
                except OSError:
                    pass
            return self._send(200, b"{}")
        if u.path == "/api/show":  # live.html -> UNO Q: what's playing (light show) + demo heart rate
            try:
                msg = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 2048)))
            except ValueError:
                return self._send(400, b"{}")
            if not isinstance(msg, dict):
                return self._send(400, b"{}")
            msg.update({"from": "laptop", "type": "show"})
            with lock:
                to = peers.addr.get("unoq") if "unoq" not in cut else None
            if to:
                try:
                    sock.sendto(band.encode(msg), to)
                except OSError:
                    pass
            return self._send(200, json.dumps({"sent": bool(to)}).encode())
        self._send(404, b"{}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q = queue.Queue(maxsize=500)
            subs.append(q)
            try:
                while True:
                    try:
                        msg = q.get(timeout=10)
                    except queue.Empty:
                        msg = ": keepalive\n\n"
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                subs.remove(q)
            return
        name = "live.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB, name))
        if not full.startswith(WEB) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain")
        with open(full, "rb") as f:
            self._send(200, f.read(), TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))


# ---- --sim: fake actors that talk real UDP, so link cuts behave exactly like WiFi drops --

def fake_actor(name, step):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    s.settimeout(0.01)
    home = ("127.0.0.1", ARGS.udp)
    p = band.Peers(name)
    ctx = {"t0": time.time()}
    while True:
        now = time.time()
        ctx["inbox"] = []
        try:
            data, addr = s.recvfrom(4096)
            msg = band.decode(data)
            if msg:
                if not msg.get("via"):
                    p.heard(msg["from"], addr, now)
                ctx["inbox"].append((msg, addr))
        except socket.timeout:
            pass
        for m in step(ctx, now, p.links(now)):
            s.sendto(band.encode(m), home)


def sim_unoq(ctx, now, links):
    if "brain" not in ctx:
        ctx["brain"], ctx["last"], ctx["hb"] = band.UnoQBrain(), 0.0, now
    b, t = ctx["brain"], now - ctx["t0"]
    out = []
    for msg, addr in ctx.get("inbox", []):  # relayed Nicla state -> mood + presence, as on the board
        b.on_packet(msg, addr, now)
    # SIM pulse: no lock for the first 8 s (default tempo), then a fake heart
    heart = 72 + 22 * (0.5 + 0.5 * math.sin(t / 25.0))
    locked = t > 8
    b.pulse = {"status": "locked (SIM)" if locked else "searching (SIM)",
               "bpm": round(heart, 1) if locked else None, "channel": "sim", "rate_hz": 40.0}
    if locked and now - ctx["hb"] >= 60.0 / heart:
        ctx["hb"] = now
        b.clock.heart(heart, now)
        out.append({"from": "unoq", "type": "heart", "bpm": round(heart, 1)})
    out += [b.beat(i) for i in b.clock.tick(now)]
    if now - ctx["last"] >= 0.2:
        ctx["last"] = now
        st = b.state(now)
        st["links"] = links
        st["sim"] = True
        out.append(st)
    return out


def sim_nicla(ctx, now, links):
    t = now - ctx["t0"]
    ctx.setdefault("seq", 0)
    ctx.setdefault("last", 0.0)
    ctx.setdefault("pattern", 1)
    out = []
    if now - ctx["last"] >= 0.2:
        ctx["last"] = now
        energy = max(0.0, min(1.0, 0.5 + 0.5 * math.sin(t / 11.0) + random.gauss(0, 0.05)))
        ctx["pattern"] = 0 if energy < 0.15 else 1 if energy < 0.4 else 2 if energy < 0.75 else 3
        ctx["seq"] += 1
        brightness = 0.5 + 0.45 * math.sin(t / 15.0)       # room light drifts: mood changes
        present = (t % 60) < 45                              # walks away for 15 s every minute
        out.append({"from": "nicla", "type": "state", "seq": ctx["seq"], "boot": ctx.setdefault("boot", 1),
                    "mode": "vision", "energy": round(energy, 2), "pattern": ctx["pattern"],
                    "brightness": round(brightness, 3), "person_present": present,
                    "person_confidence": 0.9 if present else 0.1, "vision_method": "sim",
                    "inference_ms": None, "distance_mm": None, "links": links, "sim": True})
        # SIM face expression, cycling every 12 s, in the shape the mood sketch sends
        labels = ["neutral", "happy", "surprise", "neutral", "sad", "angry"]
        top = labels[int(t // 12) % len(labels)]
        scores = {k: 0.05 for k in ("angry", "happy", "neutral", "sad", "surprise")}
        scores[top] = 0.8
        out[-1].update(mood_label=top, mood_confidence=0.8, mood_scores=scores,
                       mood_model="SIM", vision_method="sim-mood")
        if random.random() < 0.02:
            out.append({"from": "nicla", "type": "fill"})
    return out


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", action="store_true", help="fake UNO Q + Nicla")
    ap.add_argument("--http", type=int, default=8000)
    ap.add_argument("--udp", type=int, default=band.PORT)
    ap.add_argument("--peer", action="append", default=[], metavar="IP",
                    help="board to say hello to directly, e.g. the UNO Q on a WiFi that blocks broadcast "
                         "(it then answers this laptop). Repeatable.")
    ARGS = ap.parse_args()
    ARGS.peer = [band.parse_addr(p) for p in ARGS.peer]
    sock.bind(("0.0.0.0", ARGS.udp))
    srv = ThreadingHTTPServer(("0.0.0.0", ARGS.http), Handler)
    srv.daemon_threads = True
    for fn in (udp_loop, hello_loop):
        threading.Thread(target=fn, daemon=True).start()
    if ARGS.sim:
        for name, step in (("unoq", sim_unoq), ("nicla", sim_nicla)):
            threading.Thread(target=fake_actor, args=(name, step), daemon=True).start()
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except OSError:
        pass
    ips = local_ips()
    print("BodyBeats conductor: open http://127.0.0.1:%d   (udp :%d)%s"
          % (ARGS.http, ARGS.udp, "  SIM" if ARGS.sim else ""), flush=True)
    print("This laptop's IPs: %s  -> put the one on the UNO Q's network in its peers.txt (or BB_PEERS)"
          % (", ".join(ips) or "none found"), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
