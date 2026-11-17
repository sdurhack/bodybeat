// Webcam pulse (rPPG) with the POS method: Wang, den Brinker, Stuijk, de Haan,
// "Algorithmic Principles of Remote PPG", IEEE TBME 2017. The same method is one of the
// options in prouast/heartbeat-js (GPL-3.0); this is our own implementation from the paper,
// not a copy of that code.
//
// Feed it the mean R, G, B of the skin (forehead + cheeks) once per video frame with the
// frame time. It resamples to a steady rate, runs POS over 1.6 s windows, and finds the
// strongest frequency between 42 and 180 BPM. `quality` is the share of the band's power
// in that peak; below MIN_QUALITY the reading is reported but not trusted.
// Pure JS, no DOM: tests/test_web_live.mjs runs it in Node.

export const FS = 30;            // resample rate, Hz
export const WINDOW_S = 10;      // seconds of signal used per estimate
export const MIN_QUALITY = 0.35; // peak share of band power needed to trust a reading
const POS_WIN = Math.round(1.6 * FS);
const LO_HZ = 0.7, HI_HZ = 3.0;  // 42..180 BPM

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) || 1e-9; };

// [t_seconds, r, g, b] samples at uneven times -> evenly spaced arrays at FS
export function resample(samples, fs = FS) {
  if (samples.length < 2) return null;
  const t0 = samples[0][0], t1 = samples[samples.length - 1][0];
  const n = Math.floor((t1 - t0) * fs);
  if (n < 2) return null;
  const out = [[], [], []];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fs;
    while (j < samples.length - 2 && samples[j + 1][0] < t) j++;
    const a = samples[j], b = samples[j + 1];
    const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    for (let c = 0; c < 3; c++) out[c].push(a[c + 1] + (b[c + 1] - a[c + 1]) * k);
  }
  return out;
}

// POS: project the normalised colour change onto the plane orthogonal to skin tone.
export function pos([R, G, B]) {
  const n = R.length, h = new Array(n).fill(0);
  for (let s = 0; s + POS_WIN <= n; s++) {
    const r = R.slice(s, s + POS_WIN), g = G.slice(s, s + POS_WIN), b = B.slice(s, s + POS_WIN);
    const mr = mean(r), mg = mean(g), mb = mean(b);
    const s1 = [], s2 = [];
    for (let i = 0; i < POS_WIN; i++) {
      const rn = r[i] / mr, gn = g[i] / mg, bn = b[i] / mb;
      s1.push(gn - bn);
      s2.push(gn + bn - 2 * rn);
    }
    const alpha = std(s1) / std(s2);
    const seg = s1.map((v, i) => v + alpha * s2[i]);
    const m = mean(seg);
    for (let i = 0; i < POS_WIN; i++) h[s + i] += seg[i] - m;  // overlap-add
  }
  return h;
}

// Power at each candidate frequency (direct DFT over 0.7..3.0 Hz in 1/60 Hz steps:
// fine resolution without needing a long FFT). Hann window first.
export function spectrum(x, fs = FS) {
  const n = x.length, m = mean(x);
  const w = x.map((v, i) => (v - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  const out = [];
  for (let f = LO_HZ; f <= HI_HZ + 1e-9; f += 1 / 60) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * f * i) / fs; re += w[i] * Math.cos(a); im -= w[i] * Math.sin(a); }
    out.push([f, re * re + im * im]);
  }
  return out;
}

export function estimate(samples, fs = FS) {
  const rgb = resample(samples, fs);
  if (!rgb || rgb[0].length < WINDOW_S * fs * 0.6) return null;   // need ~6 s before a first guess
  const h = pos(rgb);
  const spec = spectrum(h, fs);
  let best = spec[0], total = 0;
  for (const p of spec) { total += p[1]; if (p[1] > best[1]) best = p; }
  // peak share: power within +-0.1 Hz of the peak over all band power
  let peak = 0;
  for (const p of spec) if (Math.abs(p[0] - best[0]) <= 0.1) peak += p[1];
  const quality = total > 0 ? peak / total : 0;
  return { bpm: best[0] * 60, quality, trusted: quality >= MIN_QUALITY };
}

// Rolling buffer for the live page.
export class Pulse {
  constructor() { this.samples = []; this.last = null; }
  add(t, r, g, b) {
    this.samples.push([t, r, g, b]);
    while (this.samples.length && t - this.samples[0][0] > WINDOW_S) this.samples.shift();
  }
  reset() { this.samples = []; this.last = null; }
  update() { this.last = estimate(this.samples); return this.last; }
}
