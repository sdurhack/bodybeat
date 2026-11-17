// Body Beat music engine: plain Web Audio, no libraries (nothing to download at the venue).
//
// A 16-step sequencer. Every part reads the latest musical state, so when an
// actor goes offline its part simply keeps using the last values it sent.
//   UNO Q  -> tempo (band clock, follows the heart), mood/key, intensity, tilt, instrument
//   Nicla  -> drum pattern (0..3) and fills
//   heart  -> a soft "lub-dub" thump on every real heartbeat, off the grid on purpose
//   presence (UNO Q decision from the Nicla person classifier) -> person enters: the
//   band fades in; person leaves: fades to a quiet backing pattern (pad, soft kick, bass)
//
// Mix (all built from Web Audio nodes, no samples):
//   drums ─┐                                   ┌─ reverb (generated stereo impulse) ─┐
//   music ─┼─ master ─ tone LPF ─ HPF ─ glue comp ─ limiter ─ out ─ analyser ─ speakers
//   (music is side-chained by the kick)        └─ ping-pong echo, dotted 8th, synced ─┘
//   Voices are panned across the stereo field; odd 16ths swing a little.

export const MOODS = {
  // root MIDI note, scale, one chord per bar (semitones from root)
  night: { name: "A minor", root: 57, scale: [0, 2, 3, 5, 7, 8, 10],
           chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]] },          // Am F C G
  dusk:  { name: "D dorian", root: 50, scale: [0, 2, 3, 5, 7, 9, 10],
           chords: [[0, 3, 7, 10], [5, 9, 12], [0, 3, 7, 10], [-2, 2, 5]] },  // Dm7 G Dm7 C
  day:   { name: "C major", root: 60, scale: [0, 2, 4, 5, 7, 9, 11],
           chords: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]] },       // C G Am F
};

const DRUMS = [  // per pattern: which of the 16 steps hit. h = closed hats, o = open hat
  { k: [0], s: [], h: [], o: [] },
  { k: [0, 8], s: [], h: [4, 12], o: [] },
  { k: [0, 8], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], o: [14] },
  { k: [0, 6, 8, 11], s: [4, 12], h: [...Array(16).keys()], o: [6, 14] },
];

const SWING = 0.12;          // odd 16ths land this fraction of a 16th late
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const human = (v) => v * (0.9 + Math.random() * 0.2);

export class Engine {
  constructor(getState, onNote) {
    this.getState = getState;   // () => {bpm, mood, intensity, tilt, instrument, pattern, breakdown}
    this.onNote = onNote || (() => {});
    this.step = 0;              // 16ths since start
    this.quarterTimes = [];     // recent [time, stepIndex] of scheduled quarter notes, for re-sync
    this.melodyIdx = 7;
    this.lastNote = null;
    this.fillPending = false;
    this.bar = { mood: "dusk", chord: 0 };
    this.voicing = null;        // last pad voicing, for smooth voice leading
    this.level = 1;             // smoothed presence: 1 = full band, 0 = quiet backing
    this.muted = false;
    this.onStep = null;         // (info) => {}: every 16th as it's scheduled, for the light show
  }

  async start() {
    const ctx = (this.ctx = new AudioContext({ latencyHint: "interactive" }));
    const node = (n, set = {}) => { for (const [k, v] of Object.entries(set)) (n[k] instanceof AudioParam ? (n[k].value = v) : (n[k] = v)); return n; };

    // master chain
    this.master = node(ctx.createGain(), { gain: 0.8 });   // presence fade + stop fade
    this.tone = node(ctx.createBiquadFilter(), { type: "lowpass", frequency: 18000, Q: 0.5 });
    const hp = node(ctx.createBiquadFilter(), { type: "highpass", frequency: 28, Q: 0.7 });
    const glue = node(ctx.createDynamicsCompressor(), { threshold: -16, ratio: 2.5, knee: 8, attack: 0.015, release: 0.25 });
    const limit = node(ctx.createDynamicsCompressor(), { threshold: -2, ratio: 20, knee: 0, attack: 0.002, release: 0.08 });
    this.out = node(ctx.createGain(), { gain: 1 });       // mute switch (Spotify mode)
    this.analyser = node(ctx.createAnalyser(), { fftSize: 1024 });
    this.master.connect(this.tone).connect(hp).connect(glue).connect(limit).connect(this.out).connect(this.analyser).connect(ctx.destination);

    // groups: drums dry, music ducks under the kick
    this.drums = node(ctx.createGain(), { gain: 0.9 });
    this.music = node(ctx.createGain(), { gain: 1 });
    this.drums.connect(this.master);
    this.music.connect(this.master);

    // reverb: a generated stereo impulse, darker as it decays, 15 ms pre-delay
    this.verbIn = ctx.createGain();
    const verb = node(ctx.createConvolver(), { buffer: this.impulse(2.8, 3.0) });
    const verbHp = node(ctx.createBiquadFilter(), { type: "highpass", frequency: 200 });
    const verbRet = node(ctx.createGain(), { gain: 0.5 });
    this.verbIn.connect(verb).connect(verbHp).connect(verbRet).connect(this.master);

    // ping-pong echo: L then R, feedback through a lowpass so repeats get darker
    this.echoIn = ctx.createGain();
    this.dl = ctx.createDelay(2); this.dr = ctx.createDelay(2);
    const fb = node(ctx.createGain(), { gain: 0.38 });
    const fbLp = node(ctx.createBiquadFilter(), { type: "lowpass", frequency: 2800 });
    const merge = ctx.createChannelMerger(2);
    const echoRet = node(ctx.createGain(), { gain: 0.32 });
    this.echoIn.connect(this.dl);
    this.dl.connect(merge, 0, 0); this.dl.connect(this.dr); this.dr.connect(merge, 0, 1);
    this.dr.connect(fbLp).connect(fb).connect(this.dl);
    merge.connect(echoRet).connect(this.master);
    this.dl.delayTime.value = this.dr.delayTime.value = this.stepDur * 3;
    this.echo = this.echoIn;    // old name, kept for anything poking at it from the console

    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    await ctx.resume();
    this.play();
  }

  impulse(sec, decay) {
    const rate = this.ctx.sampleRate, len = Math.floor(sec * rate), b = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.6 - 0.45 * x);   // one-pole lowpass that closes over time
        d[i] = i < rate * 0.015 ? 0 : lp * Math.pow(1 - x, decay);
      }
    }
    return b;
  }

  get playing() { return !!this.timer; }

  // Stop keeps the AudioContext running (the laptop mic is analysed on it); it just stops
  // scheduling notes and fades the master out. play() picks up again from a fresh bar.
  play() {
    if (!this.ctx || this.timer) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0.8, t);
    this.step = 0; this.quarterTimes = []; this.fillPending = false;
    this.nextTime = t + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer); this.timer = null;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.08);   // notes already scheduled fade away quickly
  }

  // Spotify mode: the band keeps its clock (MIDI out, UNO Q sync) but goes silent.
  setMuted(m) {
    this.muted = !!m;
    if (this.out) this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.4);
  }

  get stepDur() { return 60 / clamp(this.getState().bpm || 80, 40, 180) / 4; }

  schedule() {
    const ahead = this.ctx.currentTime + 0.12;
    while (this.nextTime < ahead) {
      this.playStep(this.step, this.nextTime);
      if (this.step % 4 === 0) {
        this.quarterTimes.push([this.nextTime, this.step]);
        if (this.quarterTimes.length > 16) this.quarterTimes.shift();
      }
      this.nextTime += this.stepDur;
      this.step++;
    }
  }

  // The UNO Q owns the band clock. Each of its beats nudges our grid towards it:
  // half the error per beat, at most half a 16th. A WiFi gap of any length
  // just means a bigger error, which melts away over the next few beats.
  syncBeat(remoteBeat, latency = 0.01) {
    if (!this.ctx || !this.timer || !this.quarterTimes.length) return 0;
    const t = this.ctx.currentTime - latency;
    let best = this.quarterTimes[0];
    for (const q of this.quarterTimes) if (Math.abs(q[0] - t) < Math.abs(best[0] - t)) best = q;
    const err = t - best[0];
    this.nextTime += clamp(err * 0.5, -this.stepDur * 0.5, this.stepDur * 0.5);
    // keep the downbeat where the UNO Q has it (its beat 0,4,8.. = our step 0 of a bar)
    const want = (((remoteBeat % 4) + 4) % 4) * 4;
    const have = best[1] % 16;
    if (want !== have) {
      const shift = (((want - have) % 16) + 16) % 16;
      this.step += shift;
      for (const q of this.quarterTimes) q[1] += shift;
    }
    return err;
  }

  fill() { this.fillPending = true; }

  playStep(step, t) {
    const s = this.getState();
    const i16 = step % 16, sd = this.stepDur;
    const ts = t + (i16 % 2 ? sd * SWING : 0);   // swung time for hats, melody, arp
    // fade over ~2 bars either way (each 16th moves 4% of the remaining distance)
    this.level += (clamp(s.presence ?? 1, 0, 1) - this.level) * 0.04;
    const lv = this.level;
    if (this.master) this.master.gain.setTargetAtTime(0.35 + 0.45 * lv, t, 0.5);
    const inten = clamp(s.intensity ?? 0.3, 0, 1) * (0.3 + 0.7 * lv);
    if (i16 === 0) {  // mood (key) and chord change only on the bar line: always musical
      this.bar.mood = MOODS[s.mood] ? s.mood : this.bar.mood;
      this.bar.chord = Math.floor(step / 16) % 4;
      this.bar.fill = this.fillPending; this.fillPending = false;
      // breakdown and quiet backing close the master filter: the band sounds "next door"
      const cut = s.breakdown ? 1400 : lv < 0.5 ? 2600 : 18000;
      this.tone.frequency.setTargetAtTime(cut, t, cut > 5000 ? 0.6 : 1.2);
      this.dl.delayTime.setTargetAtTime(sd * 3, t, 0.05);       // dotted 8th
      this.dr.delayTime.setTargetAtTime(sd * 3, t, 0.05);
    }
    const mood = MOODS[this.bar.mood];
    const chord = mood.chords[this.bar.chord].map((c) => mood.root + c);

    // pad + bass
    if (i16 === 0) this.voicing = this.pad(chord, t, sd * 16, s.breakdown ? 0.05 : 0.032, inten);
    if (!s.breakdown) {
      const r = chord[0] - 24;
      if (i16 === 0) this.bass(r, t, sd * 3.5, inten);
      else if (lv > 0.3 && i16 === 8) this.bass(r, t, sd * 3, inten);
      else if (inten > 0.5 && (i16 === 6 || i16 === 14)) this.bass(i16 === 14 && inten > 0.7 ? r + 12 : r + 7, ts, sd * 1.5, inten);
      else if (inten > 0.8 && i16 === 11) this.bass(r, ts, sd, inten);
    }

    // drums (Nicla's part)
    // nobody there: quiet backing = heartbeat-only kick, whatever the camera motion says
    const pat = DRUMS[lv < 0.5 ? 0 : clamp(s.pattern ?? 1, 0, 3)];
    const vel = (0.55 + 0.45 * inten) * (0.5 + 0.5 * lv);
    this.onStep?.({ step, i16, t, dur: sd, pattern: s.breakdown ? 4 : lv < 0.5 ? 0 : clamp(s.pattern ?? 1, 0, 3),
      fill: !!this.bar.fill, energy: inten, mood: this.bar.mood });
    if (!s.breakdown) {
      if (this.bar.fill && i16 >= 12) { this.snare(ts, vel * (0.5 + (i16 - 12) * 0.15), (i16 - 13.5) * 0.25); if (i16 === 15) this.snare(ts + sd / 2, vel, 0.4); }
      else {
        if (pat.k.includes(i16)) this.kick(t, human(vel));
        if (pat.s.includes(i16)) this.snare(t, human(vel));
        if (pat.o.includes(i16)) this.hat(ts, human(vel) * 0.8, true);
        else if (pat.h.includes(i16)) this.hat(ts, human(vel) * (i16 % 4 === 2 ? 1 : 0.55));
      }
      if (this.bar.fill && i16 === 0) this.crash(t);
    }

    // arpeggio on the pad's chord tones: only when the band is busy, quiet, into the echo
    if (!s.breakdown && lv > 0.5 && inten > 0.45 && (s.pattern ?? 1) >= 2 && i16 % 2 === 0 && this.voicing) {
      const v = this.voicing, k = (i16 / 2) % (v.length * 2 - 2 || 1);
      const idx = k < v.length ? k : v.length * 2 - 2 - k;     // up and back down
      this.arp(v[idx] + 12, ts, 0.5 + 0.5 * inten, idx % 2 ? 0.35 : -0.35);
    }

    // melody (UNO Q's part): movement = how many notes, tilt = which way it climbs
    let p = lv * (i16 % 2 === 0 ? 0.12 + 0.6 * inten : inten > 0.6 ? (inten - 0.6) * 1.2 : 0);
    if (step % 32 >= 28) p *= 0.25;           // breathe at the end of every two bars
    if (Math.random() < p) {
      const [tx, ty] = s.tilt || [0, 0];
      const move = Math.round((Math.random() * 2 - 1) * 2 + tx * 1.5);
      this.melodyIdx = clamp(this.melodyIdx + move, 0, 16);
      let deg = this.melodyIdx;
      const semi = (d) => mood.scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
      if (i16 % 4 === 0) {  // strong beat: snap to the nearest chord tone
        const tones = chord.map((c) => c - mood.root);
        const pc = (x) => ((x % 12) + 12) % 12;
        for (let k = 0; k < 4; k++) {
          const try1 = deg + k, try2 = deg - k;
          if (tones.some((c) => pc(c) === pc(semi(try1)))) { deg = try1; break; }
          if (tones.some((c) => pc(c) === pc(semi(try2)))) { deg = try2; break; }
        }
      }
      const oct = ty > 0.4 ? 12 : ty < -0.4 ? -12 : 0;
      let note = mood.root + semi(deg) + oct;
      if (note === this.lastNote && i16 % 4 !== 0 && Math.random() < 0.6) note = mood.root + semi(deg + (Math.random() < 0.5 ? 1 : -1)) + oct;
      this.lastNote = note;
      const accent = i16 % 4 === 0 ? 1 : 0.8;
      this.lead(s.instrument, note, ts, human((0.4 + 0.5 * inten) * accent));
      this.onNote(note, ts, s.instrument);
    }
  }

  // ---- building blocks -------------------------------------------------------
  // a gain for one note, panned, with optional reverb/echo sends, into a group bus
  voice(pan = 0, { verb = 0, echo = 0, bus = this.music } = {}) {
    const ctx = this.ctx, g = ctx.createGain();
    g.gain.value = 0;
    let n = g;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); n = p; }
    n.connect(bus);
    if (verb) { const s = ctx.createGain(); s.gain.value = verb; n.connect(s).connect(this.verbIn); }
    if (echo) { const s = ctx.createGain(); s.gain.value = echo; n.connect(s).connect(this.echoIn); }
    return g;
  }

  env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  osc(type, freq, t, dur, out, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    o.connect(out); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  filter(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  }

  // the kick pushes the music bus down for a moment: the groove "breathes"
  duck(t, depth) {
    const p = this.music.gain;
    p.setTargetAtTime(1 - depth, t, 0.004);
    p.setTargetAtTime(1, t + 0.03, 0.09);
  }

  // smooth voice leading: pick the inversion closest to the last voicing, around middle C
  voiceLead(chord) {
    const base = [...chord].sort((a, b) => a - b), mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    const prev = this.voicing;
    const cost = (v) => prev && prev.length === v.length ? v.reduce((s, n, i) => s + Math.abs(n - prev[i]), 0) : Math.abs(mean(v) - 61) * v.length;
    let best = null;
    for (let k = 0; k < base.length; k++) {
      const v = base.map((n, i) => (i < k ? n + 12 : n)).sort((a, b) => a - b);
      const sh = Math.round((61 - mean(v)) / 12) * 12, c = v.map((n) => n + sh);
      if (!best || cost(c) < cost(best)) best = c;
    }
    return best;
  }

  // ---- voices -------------------------------------------------------------
  lead(inst, note, t, vel) {
    const ctx = this.ctx, f = mtof(note), pan = (Math.random() * 2 - 1) * 0.3;
    if (inst === "pluck") {
      const g = this.voice(pan, { verb: 0.2, echo: 0.35 }), lp = this.filter("lowpass", 5000, 3);
      lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(400, t + 0.3);
      lp.connect(g); this.osc("sawtooth", f, t, 0.45, lp); this.osc("square", f, t, 0.45, lp, 7);
      this.env(g, t, 0.004, 0.16 * vel, 0.45);
    } else if (inst === "lead") {
      const g = this.voice(pan, { verb: 0.2, echo: 0.25 }), lp = this.filter("lowpass", 2600);
      lp.connect(g);
      const vib = ctx.createOscillator(), depth = ctx.createGain();
      vib.frequency.value = 5.5; depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(7, t + 0.2);
      vib.connect(depth);
      for (const d of [-6, 6]) depth.connect(this.osc("square", f, t, 0.38, lp, d).detune);
      vib.start(t); vib.stop(t + 0.45);
      this.env(g, t, 0.01, 0.07 * vel, 0.38);
    } else if (inst === "choir") {
      const g = this.voice(pan, { verb: 0.6 }), mix = ctx.createGain();
      for (const [fq, q, a] of [[730, 5, 1], [1100, 6, 0.6], [2450, 8, 0.25]]) {   // "ah" formants
        const bp = this.filter("bandpass", fq, q), ga = ctx.createGain(); ga.gain.value = a * 2.5;
        mix.connect(bp).connect(ga).connect(g);
      }
      for (const d of [-10, 0, 10]) this.osc("sawtooth", f, t, 1.0, mix, d);
      this.env(g, t, 0.15, 0.08 * vel, 1.0);
    } else {  // glass: a small FM bell
      const g = this.voice(pan, { verb: 0.35, echo: 0.3 });
      const car = this.osc("sine", f, t, 1.4, g);
      const mod = ctx.createOscillator(), idx = ctx.createGain();
      mod.frequency.value = f * 3.5;
      idx.gain.setValueAtTime(f * 1.6, t); idx.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.8);
      mod.connect(idx).connect(car.frequency); mod.start(t); mod.stop(t + 1.45);
      this.osc("sine", f * 2, t, 0.5, g);
      this.env(g, t, 0.003, 0.2 * vel, 1.4);
    }
  }

  arp(note, t, vel, pan) {
    const g = this.voice(pan, { echo: 0.4, verb: 0.15 }), lp = this.filter("lowpass", 3200, 1);
    lp.connect(g);
    this.osc("triangle", mtof(note), t, 0.22, lp);
    this.osc("sine", mtof(note) * 2, t, 0.12, lp);
    this.env(g, t, 0.003, 0.045 * vel, 0.22);
  }

  // two detuned saws per chord tone, spread left/right, through slowly breathing lowpasses
  pad(chord, t, dur, vol, inten) {
    const ctx = this.ctx, v = this.voiceLead(chord), end = t + dur, stop = end + 1.6;
    const cut = 500 + 1500 * inten;
    const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.15; lfoAmt.gain.value = cut * 0.35; lfo.connect(lfoAmt);
    lfo.start(t); lfo.stop(stop);
    for (const [pan, det] of [[-0.55, -8], [0.55, 8]]) {
      const g = this.voice(pan, { verb: 0.55 }), lp = this.filter("lowpass", cut, 0.8);
      lfoAmt.connect(lp.frequency); lp.connect(g);
      for (const n of v) this.osc("sawtooth", mtof(n), t, stop - t, lp, det);
      this.osc("triangle", mtof(v[0] - 12), t, stop - t, lp, det / 2);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.6);
      g.gain.setValueAtTime(vol, end);
      g.gain.setTargetAtTime(0, end, 0.35);   // rings into the next bar's chord: no gaps
    }
    return v;
  }

  bass(note, t, dur, inten = 0.5) {
    const ctx = this.ctx, g = this.voice(0), lp = this.filter("lowpass", 200, 6), f = mtof(note);
    const peak = 220 + 1300 * inten;
    lp.frequency.setValueAtTime(peak, t); lp.frequency.exponentialRampToValueAtTime(160, t + 0.22);
    lp.connect(g);
    this.osc("sawtooth", f, t, dur, lp);
    const sub = ctx.createGain(); sub.gain.value = 0.8; sub.connect(g);
    this.osc("sine", f, t, dur, sub);
    this.env(g, t, 0.006, 0.34, dur);
  }

  kick(t, vel) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = this.voice(0, { bus: this.drums });
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.07);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.35);
    o.connect(g); o.start(t); o.stop(t + 0.5);
    this.env(g, t, 0.002, 1.0 * vel, 0.45);
    this.noiseHit(t, 0.012, 0.25 * vel, "highpass", 2500);   // beater click
    this.duck(t, 0.35 + 0.2 * vel);
  }

  noiseHit(t, dur, vol, type, freq, { q = 0.7, pan = 0, verb = 0 } = {}) {
    const src = this.ctx.createBufferSource(), f = this.filter(type, freq, q);
    const g = this.voice(pan, { verb, bus: this.drums });
    src.buffer = this.noise;
    src.connect(f).connect(g);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    this.env(g, t, 0.001, vol, dur);
  }

  snare(t, vel, pan = 0) {
    const body = this.voice(pan, { verb: 0.2, bus: this.drums });
    const o = this.osc("triangle", 200, t, 0.12, body);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    this.osc("triangle", 330, t, 0.06, body);
    this.env(body, t, 0.001, 0.3 * vel, 0.12);
    this.noiseHit(t, 0.22, 0.38 * vel, "bandpass", 2200, { q: 0.8, pan, verb: 0.3 });
    this.noiseHit(t, 0.1, 0.15 * vel, "highpass", 6500, { pan });
  }

  hat(t, vel, open = false) {
    const pan = ((this.step % 4) - 1.5) * 0.15 + 0.2;
    this.noiseHit(t, open ? 0.3 : 0.04, (open ? 0.07 : 0.1) * vel, "highpass", open ? 7000 : 8500, { pan, verb: open ? 0.15 : 0 });
  }

  crash(t) {
    this.noiseHit(t, 1.8, 0.11, "highpass", 5000, { pan: -0.3, verb: 0.5 });
    this.noiseHit(t, 1.6, 0.09, "bandpass", 8000, { pan: 0.3, q: 0.5, verb: 0.5 });
  }

  // a real heartbeat, played the moment it arrives: low "lub", softer "dub"
  heart() {
    if (!this.ctx || !this.timer) return;
    const t = this.ctx.currentTime + 0.01;
    for (const [dt, v] of [[0, 0.5], [0.14, 0.3]]) {
      const o = this.ctx.createOscillator(), g = this.voice(0, { bus: this.drums });
      o.frequency.setValueAtTime(70, t + dt); o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.12);
      o.connect(g); o.start(t + dt); o.stop(t + dt + 0.25);
      this.env(g, t + dt, 0.004, v, 0.2);
    }
  }
}
