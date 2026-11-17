"""BodyBeats: the musical decisions and the peer-to-peer link layer.

Pure Python, no hardware and no dependencies, so it runs on the UNO Q, on a
laptop (the conductor's --sim actors use it) and in tests.

Every device in the band is a peer. Each one sends small JSON packets over UDP
port 7100 to every peer it knows and remembers when it last heard from each.
No device is in charge: if a link goes quiet, that device keeps playing its
own part from the last state it heard, and re-syncs when packets come back.
"""
import json
import math
import random
import time

PORT = 7100
LINK_TIMEOUT = 2.5  # seconds of silence before a peer counts as offline
HEART_TIMEOUT = 5.0  # seconds without a pulse before the band clock free-runs
DEFAULT_BPM = 80.0  # tempo before the first real pulse lock: always labelled "default"
VISION_TIMEOUT = 2.5  # seconds without a fresh Nicla state before vision counts as stale
MOODS = ["night", "dusk", "day"]  # dark room = minor ... bright room = major
BOOT = random.randint(1, 1 << 30)  # changes every restart, so peers reset seq tracking


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


class AutoRange:
    """Normalises a light reading to 0..1 against the darkest and brightest it
    has seen, on a log scale. Self-calibrates in any room: cover the sensor for
    dark, shine a phone torch for bright. The range relaxes slowly so one
    flash does not squash everything forever."""

    def __init__(self, relax=0.0005, min_span=0.7):
        self.lo = self.hi = None
        self.relax = relax
        self.min_span = min_span  # in log units (~2x brightness)

    def __call__(self, raw):
        v = math.log(max(raw, 0.0) + 1.0)
        if self.lo is None:
            self.lo, self.hi = v - self.min_span / 2, v + self.min_span / 2
        self.lo = min(self.lo + (v - self.lo) * self.relax, v)
        self.hi = max(self.hi + (v - self.hi) * self.relax, v)
        span = max(self.hi - self.lo, self.min_span)
        return clamp((v - self.lo) / span, 0.0, 1.0)


class Mood:
    """Light level -> night / dusk / day, with hysteresis so it doesn't flicker."""

    EDGES = (0.33, 0.66)
    HYST = 0.06

    def __init__(self):
        self.index = 1

    def __call__(self, level):
        lo, hi = self.EDGES
        i = self.index
        if i == 0 and level > lo + self.HYST:
            i = 1
        if i == 1 and level < lo - self.HYST:
            i = 0
        elif i == 1 and level > hi + self.HYST:
            i = 2
        if i == 2 and level < hi - self.HYST:
            i = 1
        self.index = i
        return MOODS[i]


class BandClock:
    """Steady beat that follows the heart.

    Real heartbeats are a little irregular, so the band does not hit on them
    directly. It runs its own clock and eases its tempo towards the heart rate
    a quarter of the way on each beat. With no pulse for HEART_TIMEOUT seconds
    (finger off, Nicla dropped) it keeps the last tempo: the song never stops.
    """

    def __init__(self, bpm=DEFAULT_BPM, lo=55.0, hi=150.0):
        self.bpm = bpm
        self.lo, self.hi = lo, hi
        self.index = -1
        self.next_t = None
        self.heart_bpm = None
        self.heart_t = -1e9

    def heart(self, bpm, now):
        if bpm and 35 <= bpm <= 200:
            self.heart_bpm = bpm
            self.heart_t = now

    def heart_live(self, now):
        return now - self.heart_t < HEART_TIMEOUT

    def tempo_source(self, now):
        """Where the band tempo comes from right now, for honest labels:
        "heart" = following a validated pulse, "held" = pulse lost, holding
        the last tempo, "default" = no pulse lock yet (DEFAULT_BPM)."""
        if self.heart_bpm is None:
            return "default"
        return "heart" if self.heart_live(now) else "held"

    def tick(self, now):
        """Returns the beat indices that fell due since the last call."""
        if self.next_t is None:
            self.next_t = now
        fired = []
        while now >= self.next_t:
            self.index += 1
            fired.append(self.index)
            if self.heart_live(now) and self.heart_bpm:
                target = clamp(self.heart_bpm, self.lo, self.hi)
                self.bpm += (target - self.bpm) * 0.25
            self.next_t += 60.0 / self.bpm
            if now - self.next_t > 2.0:  # we were asleep: don't machine-gun beats
                self.next_t = now + 60.0 / self.bpm
        return fired


class Peers:
    """Who is in the band, where they are, and when we last heard from them."""

    def __init__(self, me, seeds=(), timeout=LINK_TIMEOUT):
        self.me = me
        self.addr = {}  # name -> (ip, port)
        self.seen = {}  # name -> time
        self.seeds = [parse_addr(s) for s in seeds if s]
        self.timeout = timeout

    def heard(self, name, addr, now):
        if name and name != self.me:
            self.addr[name] = addr
            self.seen[name] = now

    def learn(self, table):
        """Gossip from another peer: {"nicla": "192.168.137.20:7100", ...}."""
        for name, s in (table or {}).items():
            if name != self.me and name not in self.addr:
                try:
                    self.addr[name] = parse_addr(s)
                except ValueError:
                    pass

    def online(self, name, now):
        return now - self.seen.get(name, -1e9) < self.timeout

    def links(self, now):
        return {n: self.online(n, now) for n in sorted(set(self.addr) | set(self.seen))}

    def targets(self):
        out = set(self.addr.values())
        out.update(self.seeds)
        return out

    def table(self):
        return {n: "%s:%d" % a for n, a in self.addr.items()}


def parse_addr(s, default_port=PORT):
    if isinstance(s, tuple):
        return s
    host, _, port = s.strip().partition(":")
    if not host:
        raise ValueError(s)
    return host, int(port) if port else default_port


def encode(msg):
    return json.dumps(msg, separators=(",", ":")).encode()


def decode(data):
    try:
        msg = json.loads(data.decode(errors="ignore"))
    except ValueError:
        return None
    return msg if isinstance(msg, dict) and "from" in msg else None


class SeqFilter:
    """Drops duplicate and out-of-order state packets per sender.

    Packets can arrive twice (direct + relayed by the laptop) or late. A
    sender that reboots starts its seq again from 1, so a new "boot" id, or a
    silence longer than `reset_after` seconds, starts tracking afresh.
    Freshness is always judged by OUR receipt time, never the sender's clock."""

    def __init__(self, reset_after=LINK_TIMEOUT):
        self.last = {}  # name -> (boot, seq, receipt time)
        self.reset_after = reset_after

    def accept(self, msg, now):
        name, seq = msg.get("from"), msg.get("seq")
        if not isinstance(seq, int):
            return True  # sender without seq numbers: nothing to compare
        boot = msg.get("boot")
        prev = self.last.get(name)
        if prev is not None:
            pboot, pseq, pt = prev
            same_run = boot == pboot and now - pt < self.reset_after
            if same_run and seq <= pseq:
                return False
        self.last[name] = (boot, seq, now)
        return True


# Face-expression scores in 5 classes (the page sends its model's scores in these labels).
# Each class votes for a key. Positive/excited -> major, calm -> dorian, low/tense -> minor.
EMOTION_TO_MOOD = {"happy": "day", "surprise": "day", "neutral": "dusk", "sad": "night", "angry": "night"}


class FaceMood:
    """Model scores -> key, smoothed so one odd frame can't flip the song.

    Scores are summed per key and averaged over time (EMA). A frame only counts
    if its leading KEY gets at least MIN_CONF of the vote. Gating on the key, not
    the single top label, matters: on a real smiling face (offline test) the model
    splits ~0.48 surprise / 0.23 happy, both "day" (0.71), while random noise
    leaves no key above ~0.43. The key changes only when another leads by MARGIN."""

    MIN_CONF = 0.55
    ALPHA = 0.25    # per state packet (5 Hz): ~1 s to follow a new expression
    MARGIN = 0.15

    def __init__(self):
        self.avg = {m: 1.0 / 3 for m in MOODS}
        self.mood = None
        self.label = None
        self.confidence = None
        self.t = -1e9

    def on_scores(self, scores, now):
        if not isinstance(scores, dict) or not scores:
            return False
        try:
            top = max(scores, key=lambda k: float(scores[k]))
            conf = float(scores[top])
        except (TypeError, ValueError):
            return False
        self.label, self.confidence = top, conf
        votes = {m: 0.0 for m in MOODS}
        for label, v in scores.items():
            m = EMOTION_TO_MOOD.get(label)
            if m:
                votes[m] += clamp(float(v), 0.0, 1.0)
        total = sum(votes.values()) or 1.0
        if max(votes.values()) / total < self.MIN_CONF:
            return False
        for m in MOODS:
            self.avg[m] += (votes[m] / total - self.avg[m]) * self.ALPHA
        lead = max(MOODS, key=lambda m: self.avg[m])
        if self.mood is None or (lead != self.mood and self.avg[lead] > self.avg[self.mood] + self.MARGIN):
            self.mood = lead
        self.t = now
        return True


class Vision:
    """What the UNO Q knows about the room from the Nicla camera.

    brightness -> mood (key). person_present -> band presence (fade in/out).
    Everything is timestamped on receipt; stale data is held, never extended:
    the mood stays where it was and presence falls back to "unknown"."""

    def __init__(self):
        self.level = AutoRange(min_span=0.5)
        self.mood = Mood()
        self.t = -1e9
        self.brightness = None
        self.person_present = None
        self.person_confidence = None
        self.method = None
        self.inference_ms = None
        self.via = None
        self.mood_name = None
        self.face = FaceMood()
        self.mood_from = None  # "face" (expression scores) or "brightness"

    def on_state(self, msg, now, via):
        b = msg.get("brightness")
        if isinstance(b, (int, float)):
            self.brightness = clamp(float(b), 0.0, 1.0)
        if "mood_scores" in msg:
            # mood build: the face-expression model decides the key; brightness is display only
            if self.face.on_scores(msg.get("mood_scores"), now):
                self.mood_name, self.mood_from = self.face.mood, "face"
        elif self.brightness is not None:
            self.mood_name, self.mood_from = self.mood(self.level(self.brightness * 1000.0)), "brightness"
        self.person_present = msg.get("person_present") if msg.get("person_present") in (True, False) else None
        c = msg.get("person_confidence")
        self.person_confidence = clamp(float(c), 0.0, 1.0) if isinstance(c, (int, float)) else None
        self.method = msg.get("vision_method")
        self.inference_ms = msg.get("inference_ms")
        self.via = via
        self.t = now

    def fresh(self, now):
        return now - self.t < VISION_TIMEOUT

    def presence(self, now):
        """Target band level: 1 = full band, 0 = quiet backing pattern.
        Unknown (no ML, or stale camera) = full band: never fade out on a guess."""
        if self.fresh(now) and self.person_present is False:
            return 0.0
        return 1.0


class UnoQBrain:
    """Everything the UNO Q decides, from raw sensor values to the packets it
    sends. main.py feeds it; tests drive it with fake time."""

    def __init__(self, seeds=()):
        self.vision = Vision()
        self.seqs = SeqFilter()
        self.clock = BandClock()
        self.peers = Peers("unoq", seeds)
        self.seq = 0
        self.pulse = {"status": "searching"}  # filled in by main.py from the Light pipeline

    def on_packet(self, msg, addr, now):
        """Returns False for a duplicate / out-of-order state packet (ignored)."""
        name = msg.get("from")
        relayed = msg.get("via") == "laptop"
        if not relayed:  # a relayed packet says nothing about OUR link to its sender
            self.peers.heard(name, addr, now)
        if msg.get("type") == "hello":
            self.peers.learn(msg.get("peers"))
        if msg.get("type") == "state":
            if not self.seqs.accept(msg, now):
                return False
            if name == "nicla":
                self.vision.on_state(msg, now, "relay" if relayed else "direct")
        return True

    def state(self, now):
        self.seq += 1
        c, v = self.clock, self.vision
        fresh = v.fresh(now)
        return {
            "from": "unoq", "type": "state", "seq": self.seq, "boot": BOOT,
            # musical tempo (band clock) and where it comes from: heart / held / default
            "bpm": round(c.bpm, 1), "beat": c.index, "tempo_source": c.tempo_source(now),
            # measured heart rate: only ever a validated pulse lock, never the tempo
            "heart_bpm": round(c.heart_bpm, 1) if c.heart_bpm else None,
            "heart_live": c.heart_live(now),
            "pulse": dict(self.pulse),
            # room, from the Nicla camera (relative brightness, not lux)
            "mood": v.mood_name or "dusk",
            "mood_source": ("camera" if fresh else "held") if v.mood_name else "default",
            "mood_from": v.mood_from,
            "face_mood": v.face.label if fresh else None,
            "face_confidence": round(v.face.confidence, 3) if fresh and v.face.confidence is not None else None,
            "face_fresh": now - v.face.t < VISION_TIMEOUT,
            "light": round(v.brightness, 3) if v.brightness is not None else None,
            "presence": v.presence(now),
            "person_present": v.person_present if fresh else None,
            "vision_fresh": fresh,
            "vision_age": round(now - v.t, 1) if v.t > 0 else None,
            "nicla_path": v.via if fresh else "none",
            "links": self.peers.links(now)}

    def beat(self, index):
        return {"from": "unoq", "type": "beat", "beat": index, "bpm": round(self.clock.bpm, 1),
                "boot": BOOT}


def now():
    return time.time()
