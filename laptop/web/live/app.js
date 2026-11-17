// BodyBeats web: wires every sensor into the browser brain and the existing sound engine.
// Open http://localhost:8000/live.html (served by laptop/conductor.py). Chrome or Edge:
// Web Serial is Chromium-only.
import * as faceapi from "./vendor/face-api.esm.js";
import { Engine, MOODS } from "../engine.js";
import { Brain, EMOTION_TO_MOOD } from "./fusion.js";
import { OwnExpressionNet } from "./expression.js";
import { Pulse, MIN_QUALITY } from "./rppg.js";
import { initMusic } from "./music.js";
import { LightShow, LEDS, MOOD_INDEX } from "./lights.js";

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const pct = (x) => (x == null || !Number.isFinite(x) ? "--" : Math.round(x * 100) + "%");
const brain = new Brain();
let state = brain.update(now());
const engine = new Engine(() => state);

function log(msg) {
  const d = document.createElement("div");
  d.textContent = new Date().toLocaleTimeString() + "  " + msg;
  $("log").prepend(d);
  while ($("log").children.length > 8) $("log").lastChild.remove();
}
function fill(why) { engine.fill(); log("drum fill: " + why); }
const setStatus = (id, text, ok) => { const el = $(id); el.textContent = text; el.className = "st " + (ok ? "ok" : ok === false ? "bad" : ""); };

// ---- UNO Q (breadboard) and WiFi Nicla, through the conductor ---------------------------
function connectConductor() {
  if (location.protocol === "file:") { setStatus("st-unoq", "open via the conductor for the UNO Q", false); return; }
  const es = new EventSource("events");
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.from === "unoq") {
      if (m.type === "state") brain.onUnoq(m, now());
      else if (m.type === "beat") { unoqBeatT = now(); if (brain.followUnoq) { brain.onUnoq({ bpm: m.bpm }, now()); engine.syncBeat(m.beat); } lightsOnBeat(m); }
      else if (m.type === "heart") engine.heart();
    } else if (m.from === "nicla" && !serialNicla) {    // USB wins over WiFi if both are on
      if (m.type === "state") brain.onNicla(m, now(), "wifi");
      else if (m.type === "fill") fill("Nicla " + (m.source || "gesture"));
    }
  };
}

// ---- face-api: loaded once, shared by the Nicla camera and the laptop webcam -------------------
let faceReady = null;
function loadFaceModel() {
  faceReady ??= (async () => {
    // GPU (WebGL) when the browser has it, else plain CPU (slower but always works)
    const tf = faceapi.tf;
    if (!(await tf.setBackend("webgl").catch(() => false))) await tf.setBackend("cpu");
    await tf.ready();
    log("face model backend: " + tf.getBackend());
    await faceapi.nets.tinyFaceDetector.loadFromUri("live/vendor/model");
    await faceapi.nets.faceExpressionNet.loadFromUri("live/vendor/model");
    if (exprMode !== "faceapi") await ensureOwn();
  })();
  return faceReady;
}
const faceOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });
const topExpr = (ex) => Object.entries(ex).sort((a, b) => b[1] - a[1])[0];

// ---- which expression model: face-api's, the custom one (live/expression.js), or both side by side
// face-api always finds the face. The custom model is the default; face-api answers until it has loaded, and
// takes over for good if our files are missing or fail their self-check. "compare": face-api
// decides the key, and the custom model runs on the same face box and is shown next to it.
let exprMode = "ours";
try { const m = localStorage.getItem("bb.exprModel"); if (["faceapi", "ours", "compare"].includes(m)) exprMode = m; } catch {}
let ownNet = null, ownLoad = null;
const cmp = { n: 0, same: 0, ms: 0, timed: 0 };
function ensureOwn() {
  ownLoad ??= new OwnExpressionNet(faceapi.tf).load().then((net) => {
    const c = net.check, r = net.info && net.info["ours (exported, 8-bit)"];
    if (c && !c.ok) throw new Error(`self-check failed (off by ${c.maxDiff.toFixed(3)})`);
    ownNet = net;
    log("custom expression model loaded" + (c ? ", self-check ok" : "") +
        (r ? `, test accuracy ${pct(r.acc7)} on 7 expressions, ${pct(r.acc3)} on the 3 keys` : ""));
    return net;
  }).catch((e) => {
    // fall back for this visit only (not saved), so fixed files are picked up on the next reload
    ownLoad = null; ownNet = null; exprMode = "faceapi"; $("exprmodel").value = "faceapi"; showCmp();
    log("custom expression model not used, face-api instead: " + e.message);
  });
  return ownLoad;
}
function setExprMode(m) {
  exprMode = m; $("exprmodel").value = m;
  try { localStorage.setItem("bb.exprModel", m); } catch {}
  Object.assign(cmp, { n: 0, same: 0, ms: 0, timed: 0 }); showCmp();
  if (m !== "faceapi" && faceReady) ensureOwn();
}
const keyOf = (ex) => {
  const v = {};
  for (const [k, p] of Object.entries(ex)) { const g = EMOTION_TO_MOOD[k]; if (g) v[g] = (v[g] || 0) + p; }
  return Object.entries(v).sort((a, b) => b[1] - a[1])[0]?.[0];
};
function showCmp() {
  const parts = [];
  if (exprMode === "compare") parts.push(cmp.n ? `same key as face-api on ${pct(cmp.same / cmp.n)} of ${cmp.n} faces` : "waiting for a face...");
  if (exprMode !== "faceapi" && cmp.timed) parts.push(`custom model ${cmp.ms.toFixed(1)} ms per face`);
  $("exprcmp").textContent = parts.join(" · ");
}
// one face: face-api finds it; face-api and/or the custom model read the expression
async function readFace(input, opts) {
  const ours = exprMode !== "faceapi" && ownNet;
  let box = null, fa = null;
  if (exprMode === "ours" && ours) box = (await faceapi.detectSingleFace(input, opts))?.box ?? null;
  else { const r = await faceapi.detectSingleFace(input, opts).withFaceExpressions(); box = r?.detection.box ?? null; fa = r?.expressions ?? null; }
  if (!box) return null;
  let own = null;
  if (ours) {
    const t0 = now();
    own = await ownNet.predict(input, box);
    cmp.ms += (now() - t0 - cmp.ms) * (cmp.timed++ ? 0.1 : 1);
    if (fa) { cmp.n++; if (keyOf(fa) === keyOf(own)) cmp.same++; }
    showCmp();
  }
  const use = exprMode === "ours" && own ? own : fa ?? own;
  const say = (ex) => { const t = topExpr(ex); return `${t[0]} ${pct(t[1])}`; };
  const text = fa && own ? `face-api ${say(fa)} · custom ${say(own)}` : (own ? "custom: " : "") + say(use);
  return { box, expressions: use, text };
}

// ---- Nicla over USB: Web Serial ------------------------------------------------------------
// The sketch sends text lines (JSON state, fills) and, each time we write "P", one picture:
// a line "IMG <w> <h> rgb565 <n>" followed by n raw bytes. So the stream is read as bytes.
// Pull, not push: the board never leaves a big picture half-sent (that jams its USB serial).
let serialNicla = false, niclaFrames = 0, niclaFaceBox = null, niclaFaceT = -1e9;
async function connectNicla() {
  if (!("serial" in navigator)) return setStatus("st-nicla", "Web Serial needs Chrome or Edge", false);
  let port;
  try { port = await navigator.serial.requestPort(); await port.open({ baudRate: 115200, bufferSize: 1 << 20 }); }
  catch (e) { return setStatus("st-nicla", "not connected: " + e.message, false); }
  serialNicla = true;
  setStatus("st-nicla", "USB connected", true);
  log("Nicla connected over USB");
  loadFaceModel().then(() => { brain.onCamStarted(now()); niclaFaceLoop(); }, (e) => log("face model failed: " + e.message));
  const reader = port.readable.getReader(), dec = new TextDecoder();
  const writer = port.writable && port.writable.getWriter();
  let asked = 0;
  const ask = () => { asked = now(); writer?.write(new Uint8Array([80])).catch(() => {}); };   // "P"
  const keepAsking = setInterval(() => { if (now() - asked > 1000) ask(); }, 500);         // lost reply: ask again
  ask();
  let buf = new Uint8Array(1 << 19), len = 0, img = null;   // img = {w, h, n} while reading picture bytes
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (len + value.length > buf.length) {
        const nb = new Uint8Array(Math.max(buf.length * 2, len + value.length));
        nb.set(buf.subarray(0, len)); buf = nb;
      }
      buf.set(value, len); len += value.length;
      let pos = 0;
      for (;;) {
        if (img) {
          if (len - pos < img.n) break;
          gotPicture(buf.subarray(pos, pos + img.n), img.w, img.h);
          pos += img.n; img = null;
          ask();
          continue;
        }
        const nl = buf.subarray(0, len).indexOf(10, pos);
        if (nl < 0) { if (len - pos > 4096) pos = len; break; }   // no newline in 4 KB: junk
        const line = dec.decode(buf.subarray(pos, nl)).trim();
        pos = nl + 1;
        const m = /^IMG (\d+) (\d+) rgb565 (\d+)$/.exec(line);
        if (m) img = { w: +m[1], h: +m[2], n: +m[3] };
        else if (line) niclaLine(line);
      }
      buf.copyWithin(0, pos, len); len -= pos;
    }
  } catch (e) { log("Nicla USB: " + e.message); }
  clearInterval(keepAsking);
  serialNicla = false;
  setStatus("st-nicla", "USB disconnected", false);
}
function niclaLine(line) {
  const j = line.indexOf("{");
  if (j < 0) { if (/^(camera|mic|nicla|wifi)/.test(line)) log("Nicla: " + line); return; }
  let m; try { m = JSON.parse(line.slice(j)); } catch { return; }
  if (m.type === "state") { brain.onNicla(m, now(), "usb"); toUnoq(m); }
  else if (m.type === "fill") { fill("Nicla " + (m.source || "gesture")); toUnoq(m); }
}

// The UNO Q only hears the Nicla over WiFi, which this build doesn't use. So the page passes the
// Nicla's USB state on (conductor -> UNO Q), with face-api's scores in the UNO Q's 5 labels, so its
// D6 LED shows "Nicla fresh" and its key agrees with this page.
const TO_UNOQ_LABEL = { happy: "happy", surprised: "surprise", neutral: "neutral", sad: "sad", angry: "angry", fearful: "angry", disgusted: "angry" };
let niclaExpr = null;
function toUnoq(m) {
  if (location.protocol === "file:") return;
  const msg = { ...m };
  if (m.type === "state") {
    const t = now();
    if (faceReady) msg.mood_scores = null;   // face-api decides; no face = UNO Q holds the key, like this page
    if (niclaExpr && t - niclaFaceT < 1000) {
      const sc = {};
      for (const [k, v] of Object.entries(niclaExpr)) { const l = TO_UNOQ_LABEL[k]; if (l) sc[l] = (sc[l] || 0) + v; }
      msg.mood_scores = sc;
    }
    if (faceReady) msg.person_present = t - niclaFaceT < 10000;
  }
  fetch("api/nicla", { method: "POST", body: JSON.stringify(msg) }).catch(() => {});
}

// RGB565 (high byte first) -> the Nicla canvas, turned upright; face-api reads that canvas.
// The Nicla is mounted sideways, so the picture is rotated (Rotate button, remembered per browser).
const niclaCanvas = $("niclacam");
let niclaImg = null, lastFpsT = now(), fpsCount = 0, niclaFps = 0;
let niclaRot = 90;
try { const r = +localStorage.getItem("bb.niclaRot"); if ([0, 90, 180, 270].includes(r) && localStorage.getItem("bb.niclaRot") !== null) niclaRot = r; } catch {}
function rotateNicla() {
  niclaRot = (niclaRot + 90) % 360;
  try { localStorage.setItem("bb.niclaRot", String(niclaRot)); } catch {}
  log("Nicla picture rotated to " + niclaRot + "°");
}
function gotPicture(bytes, w, h) {
  const side = niclaRot === 90 || niclaRot === 270, W = side ? h : w, H = side ? w : h;
  if (niclaCanvas.width !== W || niclaCanvas.height !== H) {
    niclaCanvas.width = W; niclaCanvas.height = H; niclaImg = null;
    $("niclawrap").style.width = (side ? 240 : 320) + "px";
  }
  const g = niclaCanvas.getContext("2d", { willReadFrequently: true });
  niclaImg ??= g.createImageData(W, H);
  const d = niclaImg.data;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    // source (x, y) -> destination, turned clockwise by niclaRot
    const dx = niclaRot === 90 ? h - 1 - y : niclaRot === 180 ? w - 1 - x : niclaRot === 270 ? y : x;
    const dy = niclaRot === 90 ? x : niclaRot === 180 ? h - 1 - y : niclaRot === 270 ? w - 1 - x : y;
    const k = (dy * W + dx) * 4, hb = bytes[i * 2], lb = bytes[i * 2 + 1];
    d[k] = hb & 0xf8; d[k + 1] = ((hb & 7) << 5) | ((lb & 0xe0) >> 3); d[k + 2] = (lb & 0x1f) << 3; d[k + 3] = 255;
  }
  g.putImageData(niclaImg, 0, 0);
  niclaFrames++; fpsCount++;
  const t = now();
  if (t - lastFpsT > 1000) { niclaFps = fpsCount * 1000 / (t - lastFpsT); fpsCount = 0; lastFpsT = t; }
  drawFaceBox();
}
function drawFaceBox() {
  const o = $("niclabox"), g = o.getContext("2d");
  o.width = niclaCanvas.width; o.height = niclaCanvas.height;
  if (!niclaFaceBox || now() - niclaFaceT > 1500) return;
  const b = niclaFaceBox;
  g.strokeStyle = "#4fd18b"; g.lineWidth = 3; g.strokeRect(b.x, b.y, b.width, b.height);
}

// face-api on the Nicla's picture, as fast as it keeps up (it skips pictures, never queues)
async function niclaFaceLoop() {
  log("face-api is reading the Nicla camera");
  let seen = -1;
  while (serialNicla) {
    if (niclaFrames === seen) { await new Promise((r) => setTimeout(r, 30)); continue; }
    seen = niclaFrames;
    let r = null;   // face-api tasks are thenables, not Promises: no .catch()
    try { r = await readFace(niclaCanvas, faceOpts()); }
    catch (e) { $("niclaface").textContent = "face model error: " + e.message; }
    if (r) {
      niclaFaceBox = r.box; niclaFaceT = now(); niclaExpr = r.expressions;
      brain.onFace(r.expressions, now(), "Nicla camera");
      $("niclaface").textContent = r.text;
    } else $("niclaface").textContent = "no face";
    await new Promise((res) => setTimeout(res, 100));
  }
}

// ---- laptop webcam: face-api expressions + POS pulse + motion --------------------------------
const pulse = new Pulse();
let faceBox = null, lastPulseCalc = 0;
async function startWebcam() {
  setStatus("st-cam", "loading face model...");
  try { await loadFaceModel(); } catch (e) { return setStatus("st-cam", "face model failed: " + e.message, false); }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 30 } }); }
  catch (e) { return setStatus("st-cam", "camera blocked: " + e.message, false); }
  const v = $("video");
  v.srcObject = stream;
  await v.play();
  brain.onCamStarted(now());
  setStatus("st-cam", "running", true);
  log("webcam on: face-api expressions + webcam pulse");

  const work = document.createElement("canvas"), wg = work.getContext("2d", { willReadFrequently: true });
  work.width = 160; work.height = 120;
  let prev = null;
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

  // face + expressions ~5x a second (the model is the slow part)
  (async function faceLoop() {
    for (;;) {
      let r = null;   // face-api tasks are thenables, not Promises: no .catch()
      try { r = await readFace(v, opts); } catch (e) { $("camface").textContent = "face model error: " + e.message; }
      if (r) {
        const b = r.box, sx = 160 / v.videoWidth;
        faceBox = { x: b.x * sx, y: b.y * sx, w: b.width * sx, h: b.height * sx };
        brain.onFace(r.expressions, now(), "webcam");
        $("camface").textContent = r.text;
      } else { faceBox = null; $("camface").textContent = "no face"; }
      await new Promise((res) => setTimeout(res, 200));
    }
  })();

  // every frame: skin colour for the pulse, frame difference for motion
  const frame = () => {
    wg.drawImage(v, 0, 0, 160, 120);
    const px = wg.getImageData(0, 0, 160, 120).data;
    const t = now();
    if (faceBox) {
      // forehead + both cheeks: skin with few edges, away from eyes and mouth
      const { x, y, w, h } = faceBox, rois = [[x + 0.3 * w, y + 0.08 * h, 0.4 * w, 0.17 * h],
        [x + 0.15 * w, y + 0.5 * h, 0.2 * w, 0.18 * h], [x + 0.65 * w, y + 0.5 * h, 0.2 * w, 0.18 * h]];
      let r = 0, g = 0, b = 0, n = 0;
      for (const [rx, ry, rw, rh] of rois)
        for (let yy = Math.max(0, ry | 0); yy < Math.min(120, ry + rh); yy++)
          for (let xx = Math.max(0, rx | 0); xx < Math.min(160, rx + rw); xx++) {
            const k = (yy * 160 + xx) * 4; r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
          }
      if (n > 20) pulse.add(t / 1000, r / n, g / n, b / n);
    } else if (pulse.samples.length && t / 1000 - pulse.samples.at(-1)[0] > 1) pulse.reset();  // face lost: start over
    if (t - lastPulseCalc > 1000) {
      lastPulseCalc = t;
      const e = pulse.update();
      brain.onCamPulse(e, t);
      $("campulse").textContent = e ? `${Math.round(e.bpm)} BPM · quality ${pct(e.quality)}${e.trusted ? "" : " (not trusted, need " + pct(MIN_QUALITY) + ")"}` : faceBox ? "measuring... keep still" : "--";
    }
    // motion: mean abs difference of a grey 40x30 thumbnail
    const grey = new Uint8Array(1200);
    for (let ty = 0; ty < 30; ty++) for (let tx = 0; tx < 40; tx++) {
      const k = ((ty * 4 + 2) * 160 + tx * 4 + 2) * 4;
      grey[ty * 40 + tx] = (px[k] * 77 + px[k + 1] * 150 + px[k + 2] * 29) >> 8;
    }
    if (prev) { let d = 0; for (let i = 0; i < 1200; i++) d += Math.abs(grey[i] - prev[i]); brain.onCamMotion(Math.min(1, d / 1200 / 25), t); }
    prev = grey;
    v.requestVideoFrameCallback ? v.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  };
  frame();
}

// ---- light show: the breadboard LEDs (UNO Q MCU renders it) and the mirror on this page -------
// The page sends what's playing ~5x a second (conductor -> UNO Q). The board fills in the 16ths
// on its own beat clock; the mirror here runs the same choreography (live/lights.js) on the
// engine's own steps, so it lines up with the sound you hear.
const lights = new LightShow();
const LEVEL_INDEX = { warmup: 0, steady: 1, high: 2 };
let unoqBeatT = -1e9, lastPattern = 1;
function showParams() {
  const sp = music.spotifyPlaying();
  return { playing: engine.playing || sp, src: sp ? 1 : 0, level: LEVEL_INDEX[music.level()] ?? 1,
    energy: Math.max(0, Math.min(1, state.intensity ?? 0.4)), mood: MOOD_INDEX[state.mood] ?? 1 };
}
engine.onStep = (st) => {
  const ctx = engine.ctx, lag = ctx.outputLatency || ctx.baseLatency || 0;
  const atMs = performance.now() + (st.t - ctx.currentTime + lag) * 1000;
  lastPattern = st.pattern;
  lights.step(st.i16, st.step, atMs, st.dur * 1000, { ...showParams(), pattern: st.pattern, fill: st.fill, mood: MOOD_INDEX[st.mood] ?? 1 });
};
// Spotify playing without the generated band started: the mirror follows the UNO Q's beats
function lightsOnBeat(m) {
  if (engine.playing || !music.spotifyPlaying() || !Number.isFinite(m.bpm)) return;
  const ms16 = 60000 / m.bpm / 4, b = ((m.beat % 4) + 4) % 4;
  for (let k = 0; k < 4; k++) lights.step(b * 4 + k, m.beat * 4 + k, now() + k * ms16, ms16, { ...showParams(), fill: false });
}
setInterval(() => {   // -> UNO Q light show (and demo mode's heart rate)
  if (location.protocol === "file:") return;
  const p = showParams();
  const msg = { playing: p.playing ? 1 : 0, pattern: engine.playing ? lastPattern : state.pattern, level: p.level, src: p.src,
    energy: Math.round(p.energy * 100), mood: p.mood, fill: engine.playing && engine.bar.fill ? 1 : 0, demo: brain.demo };
  fetch("api/show", { method: "POST", body: JSON.stringify(msg) }).catch(() => {});
}, 200);
const bulbs = LEDS.map((_, i) => $("bulb" + i));
function drawLights() {
  Object.assign(lights.p, showParams());
  const b = lights.frame(now());
  let top = 0;
  bulbs.forEach((el, i) => { el.style.setProperty("--b", b[i].toFixed(3)); if (b[i] > b[top]) top = i; });
  $("strip").style.setProperty("--g", Math.max(...b).toFixed(3));
  $("strip").style.setProperty("--glow", LEDS[top].color);
  requestAnimationFrame(drawLights);
}
requestAnimationFrame(drawLights);   // first frame after this module (and `music` below) has loaded

// ---- UI loop ---------------------------------------------------------------------------------
setInterval(() => {
  const t = now();
  state = brain.update(t);
  $("bpm").textContent = Math.round(state.bpm);
  $("tempofrom").textContent = brain.tempoFrom;
  const u = brain.unoq.d, n = brain.nicla.d;
  if (brain.unoq.t > -1e9) setStatus("st-unoq", brain.unoqOnline(t) ? `online · pulse ${u.heart_live ? Math.round(u.heart_bpm) + " BPM" : (u.pulse && u.pulse.status) || "searching"} · moving ${pct(u.intensity)}` : "offline: using its last values", brain.unoqOnline(t));
  else if (location.protocol !== "file:") setStatus("st-unoq", "waiting for the UNO Q (conductor running?)");
  if (brain.nicla.t > -1e9) $("niclaline").textContent = `motion ${pct(n.energy)} · sound ${pct(n.sound_level)} · claps ${n.claps ?? "--"}${brain.niclaOnline(t) ? "" : " (stale)"}`;
  const sp = music.spotifyPlaying();
  $("strip-cap").textContent = sp ? "Spotify: songs carry no drum data, so the lights groove to your level on your heart's beat."
    : engine.playing ? "Kick = yellow, snare = blues, hats = greens, the wave follows your level. The breadboard plays the same show."
    : "The breadboard light show, mirrored. Press Start the band.";
  if (serialNicla) setStatus("st-nicla", `USB connected · camera ${niclaFps.toFixed(1)} pictures/s`, niclaFps > 0.5 ? true : null);
}, 100);

function showPlaying() {
  const on = engine.playing;
  $("start").disabled = on;
  $("start").textContent = on ? "band playing" : engine.ctx ? "Play again" : "Start the band";
  $("stop").disabled = !on;
}
$("start").onclick = async () => {
  $("start").disabled = true;
  if (engine.ctx) { engine.play(); log("band playing again"); }
  else {
    try { await engine.start(); } catch (e) { showPlaying(); return log("sound failed to start: " + e.message); }
    log("band started (audio " + engine.ctx.state + ", " + engine.ctx.sampleRate + " Hz)");
  }
  music.updateMute();
  showPlaying();
};
$("stop").onclick = () => { engine.stop(); log("band stopped"); showPlaying(); };
window.bodyband = { engine, brain, music: () => music.debug(), nicla: () => ({ frames: niclaFrames, fps: niclaFps, face: niclaFaceBox }) };   // for debugging in the console
$("b-nicla").onclick = connectNicla;
$("b-rot").onclick = rotateNicla;
$("exprmodel").value = exprMode;
$("exprmodel").onchange = (e) => setExprMode(e.target.value);
$("b-cam").onclick = (e) => { e.currentTarget.disabled = true; startWebcam(); };
connectConductor();
const music = initMusic({ engine, brain, getState: () => state, log, setStatus });
