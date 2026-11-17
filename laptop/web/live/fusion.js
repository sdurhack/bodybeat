// BodyBeats web: the browser "brain" that fuses every sensor into one musical state.
// Pure JS, no DOM: tests/test_web_live.mjs runs it in Node.
//
// Sources (each optional, each judged fresh by OUR receipt time):
//   unoq   breadboard via the conductor (SSE): finger pulse tempo and beat clock
//   nicla  over USB (Web Serial) or WiFi: nicla_web sketch, camera motion, mic level, claps (no model)
//   face   face-api expressions on the Nicla camera's picture (USB), or the laptop webcam
//   cam    laptop webcam (optional): POS webcam pulse, face present, motion
//   mic    laptop microphone: loudness over background, clap onsets
//
// Decisions (same rules as the UNO Q in unoq/python/band.py, so the two brains agree):
//   tempo   finger pulse (UNO Q) > webcam pulse > UNO Q clock > hold the last tempo
//   key     face-api expressions (Nicla camera or webcam), summed per key, smoothed,
//           a frame counts only if its leading key has >= 55%, change needs a 0.15 lead
//   drums   pattern 0..3 from max(motion, sound above background), with hysteresis
//   melody  intensity follows Nicla camera motion and sound; fixed lead voice
//   band    fades to quiet backing when no camera sees a face for FACE_AWAY_MS

export const STALE_MS = 2500, HEART_MS = 5000, FACE_AWAY_MS = 10000;
export const DEFAULT_BPM = 80, BPM_LO = 55, BPM_HI = 150;
const UP = [0.12, 0.35, 0.65], DOWN = [0.07, 0.27, 0.55];
const MOODS = ["night", "dusk", "day"];
export const EMOTION_TO_MOOD = {
  // 5-class labels (kept so the vote also reads any happy/sad/... scores)
  happy: "day", surprise: "day", neutral: "dusk", sad: "night", angry: "night",
  // face-api.js labels
  surprised: "day", fearful: "night", disgusted: "night",
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class KeyVote {
  static MIN_CONF = 0.55;
  static ALPHA = 0.25;
  static MARGIN = 0.15;
  constructor() { this.avg = { night: 1 / 3, dusk: 1 / 3, day: 1 / 3 }; this.mood = null; this.t = -1e9; this.ignored = 0; }
  // returns true if this frame counted
  add(scores, now) {
    if (!scores || typeof scores !== "object") return false;
    const votes = { night: 0, dusk: 0, day: 0 };
    for (const [label, v] of Object.entries(scores)) {
      const m = EMOTION_TO_MOOD[label];
      if (m && Number.isFinite(+v)) votes[m] += clamp(+v, 0, 1);
    }
    const total = votes.night + votes.dusk + votes.day;
    if (!total || Math.max(...Object.values(votes)) / total < KeyVote.MIN_CONF) { this.ignored++; return false; }
    for (const m of MOODS) this.avg[m] += (votes[m] / total - this.avg[m]) * KeyVote.ALPHA;
    const lead = MOODS.reduce((a, b) => (this.avg[b] > this.avg[a] ? b : a));
    if (this.mood == null || (lead !== this.mood && this.avg[lead] > this.avg[this.mood] + KeyVote.MARGIN)) this.mood = lead;
    this.t = now;
    return true;
  }
}

export class Brain {
  constructor() {
    this.bpm = DEFAULT_BPM; this.tempoFrom = "default";
    this.key = new KeyVote(); this.keyFeeds = {};      // source -> last time it fed a counted frame
    this.pattern = 1; this.energy = 0;
    this.unoq = { t: -1e9, d: {} };
    this.nicla = { t: -1e9, d: {}, path: null };
    this.cam = { pulse: null, pulseT: -1e9, faceT: -1e9, startedT: null, motion: 0, motionT: -1e9 };
    this.mic = { level: 0, background: 0, t: -1e9 };
    this.lastUpdate = null;
    this.demo = null;          // demo mode: a forced heart rate (BPM) that wins over every sensor
  }

  // demo buttons: force a heart rate (null = back to the real sensors). The page also sends it
  // to the UNO Q, whose band clock then follows it like a real pulse, so the two stay in step.
  setDemo(bpm) { this.demo = Number.isFinite(bpm) ? clamp(bpm, BPM_LO, BPM_HI) : null; }

  // ---- inputs ----
  onUnoq(d, now) { this.unoq = { t: now, d: { ...this.unoq.d, ...d } }; }
  // The Nicla runs nicla_web (motion + mic, no model). Mood scores from any other Nicla
  // sketch are ignored: the key comes from the face model in this page.
  onNicla(d, now, path) {
    this.nicla = { t: now, d: { ...this.nicla.d, ...d }, path };
  }
  // face-api: {neutral, happy, sad, angry, fearful, disgusted, surprised}, run on the Nicla
  // camera's picture (source "Nicla camera") or on the optional laptop webcam ("webcam")
  onFace(expressions, now, source = "webcam") {
    this.cam.faceT = now;
    if (this.key.add(expressions, now)) this.keyFeeds[source] = now;
  }
  onCamStarted(now) { this.cam.startedT = now; }
  onCamPulse(est, now) { if (est) { this.cam.pulse = est; if (est.trusted && est.bpm >= 42 && est.bpm <= 180) this.cam.pulseT = now; } }
  onCamMotion(m, now) { this.cam.motion = m; this.cam.motionT = now; }
  onMic(level, background, now) { this.mic = { level, background, t: now }; }

  fresh(t, now, ms = STALE_MS) { return now - t < ms; }
  unoqOnline(now) { return this.fresh(this.unoq.t, now); }
  niclaOnline(now) { return this.fresh(this.nicla.t, now); }

  // ---- decisions, call ~10x a second ----
  update(now) {
    const dt = this.lastUpdate == null ? 0 : Math.min(1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    const u = this.unoq.d, uOn = this.unoqOnline(now);

    // tempo
    let target = null;
    this.followUnoq = false;
    if (this.demo != null) {
      // the UNO Q follows the demo too: use its clock once it has caught up, else ease here
      if (uOn && u.tempo_source === "heart" && Math.abs((u.heart_bpm ?? 0) - this.demo) < 1) { this.bpm = u.bpm; this.followUnoq = true; }
      else target = this.demo;
      this.tempoFrom = "demo mode";
    }
    else if (uOn && u.tempo_source === "heart") { this.bpm = u.bpm; this.tempoFrom = "finger pulse (UNO Q)"; this.followUnoq = true; }
    else if (this.fresh(this.cam.pulseT, now, HEART_MS)) { target = this.cam.pulse.bpm; this.tempoFrom = "webcam pulse"; }
    else if (uOn && Number.isFinite(u.bpm)) { this.bpm = u.bpm; this.tempoFrom = "UNO Q clock (" + (u.tempo_source || "?") + ")"; this.followUnoq = true; }
    else this.tempoFrom = this.tempoFrom === "default" ? "default" : "held";
    if (target != null) {
      // ease a quarter of the way per beat, like the UNO Q's BandClock
      const beats = dt * this.bpm / 60;
      this.bpm += (clamp(target, BPM_LO, BPM_HI) - this.bpm) * (1 - Math.pow(0.75, beats));
    }
    this.bpm = clamp(this.bpm, BPM_LO, BPM_HI);

    // drums: movement (Nicla camera, else webcam) or sound above the room's background
    const n = this.nicla.d, nOn = this.niclaOnline(now);
    const motion = nOn && Number.isFinite(n.energy) ? n.energy : this.fresh(this.cam.motionT, now) ? this.cam.motion : 0;
    let sound = 0;
    if (nOn && Number.isFinite(n.sound_level)) sound = clamp((n.sound_level - (n.sound_background ?? 0)) * 2.5, 0, 1);
    if (this.fresh(this.mic.t, now)) sound = Math.max(sound, clamp((this.mic.level - this.mic.background) * 2.5, 0, 1));
    const drive = Math.max(motion, sound);
    this.energy += (drive - this.energy) * (drive > this.energy ? 0.4 : 0.05);
    if (this.pattern < 3 && this.energy > UP[this.pattern]) this.pattern++;
    else if (this.pattern > 0 && this.energy < DOWN[this.pattern - 1]) this.pattern--;
    this.drumsFrom = drive === 0 ? "--" : sound > motion ? "sound" : nOn ? "Nicla motion" : "webcam motion";

    // key
    const feeders = Object.entries(this.keyFeeds).filter(([, t]) => this.fresh(t, now)).map(([k]) => k);
    let mood = this.key.mood;
    if (!feeders.length && mood == null && uOn && u.mood) mood = u.mood;
    this.keyFrom = feeders.length ? "face: " + feeders.join(" + ") : mood ? "held" : "default";

    // presence: only judged while the webcam is running
    let presence = 1;
    if (this.cam.startedT != null && now - this.cam.startedT > FACE_AWAY_MS && !this.fresh(this.cam.faceT, now, FACE_AWAY_MS)) presence = 0;

    // exercise signals for whatever picks recorded music (live/spotify.js): the measured pulse
    // (finger pulse first, else a trusted webcam pulse; null when neither is fresh) and movement
    let heart = null;
    if (this.demo != null) heart = { bpm: this.demo, from: "demo", quality: 1 };
    else if (uOn && u.heart_live && Number.isFinite(u.heart_bpm)) heart = { bpm: u.heart_bpm, from: "finger pulse (UNO Q)", quality: 1 };
    else if (this.fresh(this.cam.pulseT, now, HEART_MS)) heart = { bpm: this.cam.pulse.bpm, from: "webcam pulse", quality: clamp(this.cam.pulse.quality ?? 0.5, 0, 1) };
    const moveFresh = nOn || this.fresh(this.cam.motionT, now) || this.fresh(this.mic.t, now);

    return {
      heart, movement: moveFresh ? this.energy : null,
      bpm: this.bpm, mood: mood || "dusk", pattern: this.pattern, presence,
      intensity: clamp(this.energy * 1.2, 0.15, 1),
    };
  }
}
