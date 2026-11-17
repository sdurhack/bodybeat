// node tests/test_web_live.mjs   (no dependencies)
// Tests the browser brain (live/fusion.js) and webcam pulse (live/rppg.js) without a browser.
import assert from "node:assert/strict";
import { estimate, Pulse } from "../laptop/web/live/rppg.js";
import { Brain, KeyVote } from "../laptop/web/live/fusion.js";
import { toSpotifyUri, IntensityTracker, decide, challenge, SpotifyClient } from "../laptop/web/live/spotify.js";
import { createHash } from "node:crypto";
import { stepHits, LightShow } from "../laptop/web/live/lights.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// synthetic skin: steady tone + a tiny pulse mostly in green, plus camera noise, uneven frame times
function skin(bpm, seconds, { noise = 0.15, pulse = 0.6, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const out = [];
  for (let t = 0; t < seconds; t += 1 / 28 + rnd() * 0.01) {
    const p = Math.sin(2 * Math.PI * (bpm / 60) * t);
    out.push([t, 150 + 0.3 * pulse * p + noise * rnd(), 110 + pulse * p + noise * rnd(), 90 + 0.5 * pulse * p + noise * rnd()]);
  }
  return out;
}

test("rppg finds a 72 BPM pulse in noisy uneven frames", () => {
  const e = estimate(skin(72, 10));
  assert.ok(Math.abs(e.bpm - 72) < 3, "got " + e.bpm);
  assert.ok(e.trusted, "quality " + e.quality);
});

test("rppg finds 110 BPM too", () => {
  const e = estimate(skin(110, 10, { seed: 7 }));
  assert.ok(Math.abs(e.bpm - 110) < 3, "got " + e.bpm);
});

test("rppg does not trust pure noise", () => {
  const e = estimate(skin(72, 10, { pulse: 0, noise: 2, seed: 3 }));
  assert.ok(!e.trusted, "noise was trusted, quality " + e.quality);
});

test("rppg waits for enough signal", () => {
  assert.equal(estimate(skin(72, 3)), null);
  const p = new Pulse();
  for (const [t, r, g, b] of skin(72, 15)) p.add(t, r, g, b);
  assert.ok(p.samples.length < 15 * 30, "buffer should keep only the last 10 s");
});

test("tempo: finger pulse beats webcam pulse beats UNO Q clock beats hold", () => {
  const b = new Brain();
  let now = 1000;
  for (let i = 0; i < 100; i++) { b.onCamPulse({ bpm: 100, trusted: true }, now); b.update((now += 100)); }  // 10 s easing
  assert.equal(b.tempoFrom, "webcam pulse");
  assert.ok(b.bpm > 90, "eased to " + b.bpm);
  b.onUnoq({ bpm: 66, tempo_source: "heart" }, now);
  b.update((now += 100));
  assert.equal(b.tempoFrom, "finger pulse (UNO Q)");
  assert.equal(b.bpm, 66);
  assert.ok(b.followUnoq);
});

test("tempo: holds the last value when every source goes quiet", () => {
  const b = new Brain();
  let now = 0;
  b.onCamPulse({ bpm: 120, trusted: true }, now);
  for (let i = 0; i < 60; i++) b.update((now += 100));           // pulse goes stale after 5 s
  assert.equal(b.tempoFrom, "held");
  const held = b.bpm;
  assert.ok(held > 80, "moved toward the pulse first: " + held);
  for (let i = 0; i < 100; i++) b.update((now += 100));
  assert.equal(b.bpm, held);
});

test("tempo: an untrusted webcam reading is ignored", () => {
  const b = new Brain();
  b.onCamPulse({ bpm: 140, trusted: false }, 0);
  b.update(100);
  assert.equal(b.tempoFrom, "default");
  assert.equal(b.bpm, 80);
});

test("key: face-api decides; unsure frames ignored", () => {
  const b = new Brain();
  let now = 0;
  b.onFace({ angry: 0.28, happy: 0.21, neutral: 0.46, sad: 0.04 }, now);
  assert.equal(b.key.mood, null, "a 46% neutral frame must not set the key");
  for (let i = 0; i < 8; i++) b.onFace({ happy: 0.9, neutral: 0.1 }, (now += 200));
  assert.equal(b.update(now).mood, "day");
  assert.match(b.keyFrom, /webcam/);
  for (let i = 0; i < 12; i++) b.onFace({ sad: 0.6, angry: 0.3, neutral: 0.1 }, (now += 200));
  assert.equal(b.update(now).mood, "night");
});

test("key: web build ignores mood scores from a Nicla (no on-board model here)", () => {
  const b = new Brain();
  let now = 0;
  for (let i = 0; i < 20; i++) b.onNicla({ energy: 0.5, mood_scores: { sad: 0.9, angry: 0.1 } }, (now += 200), "usb");
  const s = b.update(now);
  assert.equal(b.key.mood, null);
  assert.equal(s.mood, "dusk");
  assert.equal(b.keyFrom, "default");
  assert.equal(b.nicla.d.energy, 0.5, "motion still used");
});

test("key: one odd frame cannot flip the song", () => {
  const k = new KeyVote();
  for (let i = 0; i < 10; i++) k.add({ neutral: 0.9 }, i);
  k.add({ happy: 0.95 }, 11);
  assert.equal(k.mood, "dusk");
});

test("drums: claps/sound and motion raise the pattern, with hysteresis", () => {
  const b = new Brain();
  let now = 0;
  b.pattern = 0;
  for (let i = 0; i < 10; i++) { b.onMic(0.8, 0.3, now); b.update((now += 100)); }
  assert.equal(b.pattern, 3);
  assert.equal(b.drumsFrom, "sound");
  for (let i = 0; i < 5; i++) { b.onMic(0.3, 0.3, now); b.update((now += 100)); }
  assert.ok(b.pattern >= 2, "should not drop straight away");
});

test("presence: band goes quiet when the webcam sees no face for 10 s", () => {
  const b = new Brain();
  b.onCamStarted(0);
  b.onFace({ neutral: 1 }, 1000);
  assert.equal(b.update(5000).presence, 1);
  assert.equal(b.update(12000).presence, 0);
  b.onFace({ neutral: 1 }, 12100);
  assert.equal(b.update(12200).presence, 1);
});

test("melody: UNO Q Movement/Knob win; without it, intensity follows motion", () => {
  const b = new Brain();
  let now = 0;
  for (let i = 0; i < 10; i++) { b.onCamMotion(0.9, now); b.update((now += 100)); }
  assert.ok(b.update(now).intensity > 0.7);
  b.onUnoq({ intensity: 0.2, instrument: "choir", tilt: [1, 0], breakdown: true }, now);
  const s = b.update((now += 100));
  assert.equal(s.intensity, 0.2); assert.equal(s.instrument, "choir"); assert.equal(s.breakdown, true);
});

// ---- Spotify mode (live/spotify.js) ----
test("fusion reports the measured pulse and movement for Spotify mode", () => {
  const b = new Brain();
  assert.equal(b.update(0).heart, null);
  b.onUnoq({ heart_live: true, heart_bpm: 118, intensity: 0.4 }, 0);
  let s = b.update(100);
  assert.equal(s.heart.bpm, 118); assert.equal(s.heart.from, "finger pulse (UNO Q)"); assert.ok(s.movement >= 0.4);
  b.onCamPulse({ bpm: 90, trusted: true, quality: 0.6 }, 5000);
  s = b.update(5100);   // UNO Q went stale: the webcam pulse takes over
  assert.equal(s.heart.bpm, 90); assert.equal(s.heart.from, "webcam pulse");
  assert.equal(b.update(20000).heart, null);
});

test("spotify: playlist links and URIs are understood, junk is not", () => {
  assert.equal(toSpotifyUri("https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP?si=abc"), "spotify:playlist:37i9dQZF1DX76Wlfdnj7AP");
  assert.equal(toSpotifyUri("https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy"), "spotify:album:4aawyAB9vmqN3uQ7FjRGTy");
  assert.equal(toSpotifyUri(" spotify:playlist:37i9dQZF1DX76Wlfdnj7AP "), "spotify:playlist:37i9dQZF1DX76Wlfdnj7AP");
  assert.equal(toSpotifyUri("https://example.com/playlist/37i9dQZF1DX76Wlfdnj7AP"), null);
  assert.equal(toSpotifyUri(""), null);
});

test("spotify: PKCE challenge is base64url(SHA-256(verifier)), no padding", async () => {
  const v = "dBjftJeZ4CVP-mJ92K9qXmkdMw2tA3zxR4u81ufzRDsrnYw";
  const want = createHash("sha256").update(v).digest("base64url");
  assert.equal(await challenge(v), want);
  assert.ok(!/[+/=]/.test(await challenge("x".repeat(64))));
});

// heart rate held at `bpm` for `sec` seconds, one reading every 250 ms
const ride = (tr, bpm, sec, from = 0, extra = {}) => { let r; for (let i = 0; i < sec * 4; i++) r = tr.update({ heart: { bpm, quality: 1, ...extra }, movement: 0.2 }, (from += 250)); return [r, from]; };

test("levels: three ranges, entering a new one switches within a few seconds", () => {
  const tr = new IntensityTracker();
  let [r, t] = ride(tr, 85, 3);
  assert.equal(r.intensity, "warmup");
  [r, t] = ride(tr, 118, 3, t);
  assert.notEqual(r.intensity, "steady", "switched on the first reading");
  [r, t] = ride(tr, 118, 4, t);
  assert.equal(r.intensity, "steady");
  [r, t] = ride(tr, 142, 8, t);
  assert.equal(r.intensity, "high");
  [r, t] = ride(tr, 90, 10, t);
  assert.equal(r.intensity, "warmup");
  assert.deepEqual(tr.ranges(), { warmup: [0, 99], steady: [100, 134], high: [135, 999] });
});

test("levels: hysteresis on a boundary, a blip never switches, no signal holds", () => {
  const tr = new IntensityTracker();
  let [r, t] = ride(tr, 138, 6);
  assert.equal(r.intensity, "high");
  [r, t] = ride(tr, 133, 20, t);                      // 2 BPM under 135: inside the 3 BPM margin
  assert.equal(r.intensity, "high", "flapped on the boundary");
  [r, t] = ride(tr, 110, 1, t);                       // one second dip
  [r, t] = ride(tr, 140, 10, t);
  assert.equal(r.intensity, "high");
  for (let i = 0; i < 100; i++) r = tr.update({ heart: null, movement: null }, (t += 250));
  assert.equal(r.intensity, "high"); assert.equal(r.reliable, false);
});

test("levels: ranges are configurable; a demo heart rate switches at once (no smoothing)", () => {
  const tr = new IntensityTracker({ steadyHr: 90, highHr: 120 });
  let [r, t] = ride(tr, 80, 3);
  assert.equal(r.intensity, "warmup");
  [r, t] = ride(tr, 126, 1.25, t, { from: "demo" });
  assert.equal(r.intensity, "high", "demo took more than ~1 s");
});

test("levels: low-quality pulse is ignored, movement stands in", () => {
  const tr = new IntensityTracker();
  let r, t = 0;
  for (let i = 0; i < 20; i++) r = tr.update({ heart: { bpm: 160, quality: 0.1 }, movement: 0.7 }, (t += 250));
  assert.equal(r.source, "movement"); assert.equal(r.intensity, "high");
});

test("demo mode: forced heart rate drives tempo and the level, then hands back", () => {
  const b = new Brain();
  b.onUnoq({ heart_live: true, heart_bpm: 75, tempo_source: "heart", bpm: 75 }, 0);
  b.setDemo(140);
  let s;
  for (let t = 100; t <= 20000; t += 100) { b.onUnoq({}, t); s = b.update(t); }
  assert.equal(s.heart.from, "demo"); assert.equal(s.heart.bpm, 140);
  assert.equal(b.tempoFrom, "demo mode");
  assert.ok(Math.abs(s.bpm - 140) < 3, "tempo " + s.bpm);
  b.setDemo(null);
  s = b.update(20100);
  assert.equal(s.heart.bpm, 75); assert.equal(b.tempoFrom, "finger pulse (UNO Q)");
});

test("light show: kick lights the yellow centre, snare the blues, hats the greens", () => {
  const leds = (i16, p) => stepHits(i16, { pattern: 2, level: 1, src: 0, fill: false, mood: 1, ...p }).map(([l]) => l);
  assert.ok(leds(0).includes(2));                           // kick on the 1
  assert.ok(leds(4).includes(0) && leds(4).includes(1));    // snare on the 2
  assert.ok(leds(2).some((l) => l >= 3));                   // hat
  assert.deepEqual(leds(13, { fill: true }).sort(), [1, 2]); // fill scanner
  assert.equal(stepHits(3, { pattern: 4, level: 1, src: 0 }).length, 0);   // breakdown: no drums
  // Spotify: the level picks the pattern (High = busy: hats on every 16th)
  assert.ok(leds(1, { src: 1, level: 2, pattern: 0 }).some((l) => l >= 3));
  assert.ok(!leds(1, { src: 1, level: 0, pattern: 3 }).some((l) => l >= 3));
});

test("light show: the page mirror decays hits and breathes when idle", () => {
  const ls = new LightShow();
  ls.step(0, 0, 1000, 125, { pattern: 2, level: 1, src: 0, playing: true });
  let b = ls.frame(1000);
  assert.ok(b[2] > 0.95, "kick " + b[2]);
  b = ls.frame(1600);
  assert.ok(b[2] < 0.3, "no decay " + b[2]);
  ls.p.playing = false;
  const idle = [0, 1000, 2000].map((ms) => ls.frame(5000 + ms)[2]);
  assert.ok(Math.max(...idle) - Math.min(...idle) > 0.05, "idle yellow does not breathe");
});

test("spotify decide: switches on a new level, respects pause, the off switch and track-end mode", () => {
  const pb = (o) => ({ is_playing: true, context: { uri: "spotify:playlist:A" }, item: { duration_ms: 200000 }, progress_ms: 60000, ...o });
  const base = { targetUri: "spotify:playlist:B", now: 1e6 };
  assert.equal(decide({ ...base, playback: pb() }).play, true);
  assert.equal(decide({ ...base, playback: pb(), midTrack: false }).play, false);
  assert.match(decide({ ...base, playback: pb(), midTrack: false }).why, /end of this track/);
  assert.equal(decide({ ...base, playback: pb({ progress_ms: 192000 }), midTrack: false }).play, true);
  assert.equal(decide({ ...base, playback: pb({ is_playing: false }) }).play, false);
  assert.equal(decide({ ...base, playback: pb({ context: { uri: "spotify:playlist:B" } }) }).play, false);
  assert.equal(decide({ ...base, playback: pb(), auto: false }).play, false);
  assert.equal(decide({ ...base, playback: pb(), lastSwitchT: 1e6 - 1000 }).play, false);
  assert.equal(decide({ ...base, playback: null }).play, false);
});

function fakeStore() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
const reply = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (h) => headers[h] }, json: async () => body, text: async () => (body == null ? "" : JSON.stringify(body)) });

test("spotify client: PKCE sign-in, refresh on expiry, errors become plain reasons", async () => {
  const calls = [];
  let tokenN = 0, playStatus = 204;
  const fetchFn = async (url, opt) => {
    calls.push([url, opt]);
    if (url.includes("/api/token")) { tokenN++; return reply(200, { access_token: "A" + tokenN, refresh_token: "R" + tokenN, expires_in: 3600 }); }
    if (url.includes("/me/player/play")) return playStatus === 204 ? reply(204, null)
      : reply(playStatus, { error: { status: playStatus, message: "x", reason: playStatus === 403 ? "PREMIUM_REQUIRED" : "NO_ACTIVE_DEVICE" } });
    if (url.includes("/me/player/devices")) return reply(200, { devices: [{ id: "d1", name: "Phone", type: "Smartphone", is_active: true }] });
    if (url.includes("/me/player/pause")) return reply(429, { error: { status: 429 } }, { "Retry-After": "7" });
    return reply(404, null);
  };
  const store = fakeStore(), redirect = "http://127.0.0.1:8000/live.html";
  const c = new SpotifyClient({ clientId: "c".repeat(32), redirectUri: redirect, store, fetchFn });
  const auth = new URL(await c.authorizeUrl());
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("redirect_uri"), redirect);
  assert.ok(auth.searchParams.get("scope").split(" ").includes("streaming"), "browser player scope");
  await assert.rejects(c.handleRedirect(redirect + "?code=X&state=wrong"), (e) => e.kind === "auth");
  await c.authorizeUrl();
  const st = JSON.parse(store.getItem(SpotifyClient.PKCE)).state;
  assert.equal(await c.handleRedirect(`${redirect}?code=X&state=${st}`), true);
  assert.ok(c.connected);
  assert.equal(c.hasScope("streaming"), false);   // fake token reply carries no scope: page asks to reconnect
  const body = new URLSearchParams(calls.at(-1)[1].body);
  assert.equal(body.get("grant_type"), "authorization_code"); assert.ok(body.get("code_verifier").length >= 43);
  assert.equal(body.get("client_secret"), null);
  assert.equal((await c.devices())[0].name, "Phone");
  c.tok.expires = Date.now();                 // expired: refreshes first, then calls
  await c.play("d1", "spotify:playlist:B");
  assert.equal(c.tok.access, "A2"); assert.equal(c.tok.refresh, "R2");
  assert.equal(JSON.parse(calls.at(-1)[1].body).context_uri, "spotify:playlist:B");
  assert.ok(calls.at(-1)[0].includes("device_id=d1"));
  playStatus = 403; await assert.rejects(c.play("d1"), (e) => e.kind === "premium");
  playStatus = 404; await assert.rejects(c.play("d1"), (e) => e.kind === "no-device");
  await assert.rejects(c.pause("d1"), (e) => e.kind === "rate-limit");
  await assert.rejects(c.devices(), (e) => e.kind === "rate-limit");   // backs off without calling
  assert.equal(await c.handleRedirect(redirect), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok", name); } catch (e) { failed++; console.log("FAIL", name, "-", e.message); }
}
if (failed) { console.log(failed + " failed"); process.exit(1); }
