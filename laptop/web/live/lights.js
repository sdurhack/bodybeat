// Body Beat web: the breadboard light show. Five LEDs in a row, a "sandwich":
//     D2 blue · D3 blue · D4 yellow · D5 green · D6 green
// The same choreography runs on the UNO Q's MCU (unoq/sketch/sketch.ino, lightStep/lightAmbient)
// so the page mirror and the real LEDs agree. Keep the two in step if you change one.
//
//   kick      yellow centre flash, rippling out to the blues and greens
//   snare     both blues
//   hats      greens, alternating; open hat = both greens, longer
//   downbeat  sweep out from the centre (Steady and High energy)
//   fill      a scanner runs across all five, then everything flashes
//   High      extra shimmer chasing on the off-beats
//   always    a soft wave travelling along the row: slow in Warm-up, per beat in Steady,
//             twice per beat in High; tinted by the key (minor = blues, major = yellow/greens)
//   Spotify   no drum data from recorded music, so the level picks the pattern
//             (Warm-up = light, Steady = groove, High = busy), on the band clock (your heart)

export const LEDS = [
  { pin: "D2", color: "#4a8cff", role: "snare" },
  { pin: "D3", color: "#4a8cff", role: "snare" },
  { pin: "D4", color: "#ffd23f", role: "kick" },
  { pin: "D5", color: "#4fd18b", role: "hats" },
  { pin: "D6", color: "#4fd18b", role: "hats" },
];
const B1 = 0, B2 = 1, Y = 2, G1 = 3, G2 = 4;
const DRUMS = [   // same steps as engine.js
  { k: [0], s: [], h: [], o: [] },
  { k: [0, 8], s: [], h: [4, 12], o: [] },
  { k: [0, 8], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], o: [14] },
  { k: [0, 6, 8, 11], s: [4, 12], h: [...Array(16).keys()], o: [6, 14] },
];
export const MOOD_INDEX = { night: 0, dusk: 1, day: 2 };

// p = { pattern 0..3 (4 = breakdown: no drums), level 0..2, src 0 generated / 1 Spotify, fill, mood 0..2 }
// -> [[led, value 0..1, decay ms, delay ms], ...]
export function stepHits(i16, p) {
  const out = [], hit = (led, v, tau, delay = 0) => out.push([led, v, tau, delay]);
  const pat = p.src === 1 ? [1, 2, 3][p.level] ?? 2 : p.pattern;
  if (pat === 4) {   // breakdown: one slow swell per bar from the centre
    if (i16 === 0) { hit(Y, 0.8, 900); hit(B2, 0.5, 900, 150); hit(G1, 0.5, 900, 150); }
    return out;
  }
  if (p.fill && i16 === 0) for (let i = 0; i < 5; i++) hit(i, 1, 500);
  if (p.fill && i16 >= 12) { const k = i16 - 12; hit(k, 1, 110); hit(k + 1, 1, 110); return out; }
  const d = DRUMS[Math.max(0, Math.min(3, pat))];
  if (d.k.includes(i16)) {
    hit(Y, 1, 170); hit(B2, 0.6, 140, 35); hit(G1, 0.6, 140, 35);
    if (p.level >= 1) { hit(B1, 0.3, 120, 70); hit(G2, 0.3, 120, 70); }
  }
  if (d.s.includes(i16)) { hit(B1, 1, 150); hit(B2, 0.85, 150); if (p.level === 2) hit(Y, 0.5, 90, 20); }
  if (d.o.includes(i16)) { hit(G1, 0.85, 280); hit(G2, 0.85, 280); }
  else if (d.h.includes(i16)) hit((i16 >> 1) & 1 ? G2 : G1, i16 % 4 === 2 ? 0.7 : 0.4, 60);
  if (i16 === 0 && p.level >= 1 && !p.fill) { hit(B1, 0.7, 220, 90); hit(G2, 0.7, 220, 90); }
  if (p.level === 2 && i16 % 2 === 1) hit([B1, B2, Y, G1, G2][(i16 >> 1) % 5], 0.3, 50);
  return out;
}

// the travelling wave under the hits. beats = position in beats (fractional), ms = wall clock
export function ambient(beats, ms, p) {
  const out = [0, 0, 0, 0, 0];
  if (!p.playing) {   // idle: the yellow breathes slowly
    out[Y] = 0.15 * (0.5 + 0.5 * Math.sin((2 * Math.PI * ms) / 4000));
    return out;
  }
  const speed = [0.5, 1, 2][p.level] ?? 1, amp = p.pattern === 4 && p.src !== 1 ? 0.25 : 0.05 + 0.12 * (p.energy ?? 0.5);
  const tint = p.mood === 0 ? [1.5, 1.5, 0.8, 0.6, 0.6] : p.mood === 2 ? [0.6, 0.6, 1.4, 1.3, 1.3] : [1, 1, 1, 1, 1];
  for (let i = 0; i < 5; i++) out[i] = amp * tint[i] * (0.5 + 0.5 * Math.sin(2 * Math.PI * beats * speed - i * 1.1));
  return out;
}

// Runs the show in the page: feed it 16th steps (with their wall-clock time), read frame().
export class LightShow {
  constructor() {
    this.env = new Float32Array(5); this.tau = new Float32Array(5).fill(100);
    this.queue = [];           // [atMs, led, value, tau]
    this.p = { pattern: 1, level: 1, src: 0, fill: false, mood: 1, playing: false, energy: 0.4 };
    this.beatAt = null;        // {ms, beats, msPerBeat}: where the band clock was last seen
    this.lastMs = null;
  }
  // one 16th of the band, sounding at wall-clock `atMs`
  step(i16, step, atMs, msPer16, p) {
    Object.assign(this.p, p);
    this.beatAt = { ms: atMs, beats: step / 4, msPerBeat: msPer16 * 4 };
    for (const [led, v, tau, delay] of stepHits(i16, this.p)) this.queue.push([atMs + delay, led, v, tau]);
  }
  frame(ms) {
    const dt = this.lastMs == null ? 0 : ms - this.lastMs;
    this.lastMs = ms;
    for (let i = 0; i < 5; i++) this.env[i] *= Math.exp(-dt / this.tau[i]);
    this.queue = this.queue.filter(([at, led, v, tau]) => {
      if (at > ms) return true;
      if (v >= this.env[led]) { this.env[led] = v; this.tau[led] = tau; }
      return false;
    });
    const b = this.beatAt, beats = b ? b.beats + (ms - b.ms) / b.msPerBeat : ms / 750;
    const amb = ambient(beats, ms, this.p);
    return Array.from(this.env, (e, i) => Math.min(1, Math.max(e, amb[i])));
  }
}
