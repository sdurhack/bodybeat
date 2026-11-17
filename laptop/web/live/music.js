// BodyBeats web: the Music card. Three levels (Warm-up, Steady, High energy) from your heart
// rate, with BPM ranges you pick and Demo buttons that force a heart rate in a range.
// Generated band (default, always works) or Spotify (the user's own playlist per level). Spotify plays on one of the user's Connect devices;
// the generated band keeps its clock (MIDI out, UNO Q sync) but is muted while Spotify is actually
// playing, and comes back on its own the moment Spotify stops, fails or is paused. Never mixed.
import { SpotifyClient, IntensityTracker, decide, toSpotifyUri, INTENSITIES, INTENSITY_NAMES } from "./spotify.js";

const $ = (id) => document.getElementById(id);
const pct = (x) => (x == null || !Number.isFinite(x) ? "--" : Math.round(x * 100) + "%");
const LS = {
  get: (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} },
};

// engine: the generated band. getState: latest Brain.update() output. log / setStatus: from app.js
// brain: fusion Brain (demo mode lives there, so the tempo follows it too)
export function initMusic({ engine, brain, getState, log, setStatus }) {
  const now = () => performance.now();
  const redirectUri = location.origin + location.pathname;
  const tracker = new IntensityTracker({ steadyHr: +LS.get("bb.sp.lo") || 100, highHr: +LS.get("bb.sp.hi") || 135 });
  let mode = LS.get("bb.mode") === "spotify" ? "spotify" : "generated";
  let sp = null, trk = tracker.update(getState(), now()), playback = null, spWhy = "", lastSwitchT = -1e12, polling = false;

  const playlistFor = (int) => toSpotifyUri(LS.get("bb.sp.pl." + int));
  const target = () => (mode === "spotify" && $("sp-override").value) || trk.intensity || "warmup";
  const device = () => $("sp-device").value || undefined;
  const spPlaying = () => mode === "spotify" && !!playback?.is_playing;

  function updateMute() {
    engine.setMuted(spPlaying());
    const m = mode === "generated" ? "Generated band: the synth plays from your body, no account needed."
      : spPlaying() ? "Spotify is playing on " + (playback.device?.name || "your device") + ". The generated band is muted and keeps time."
      : "Spotify mode, but Spotify isn't playing: the generated band plays meanwhile.";
    setStatus("st-music", m, mode === "spotify" ? spPlaying() || null : null);
  }

  function spError(e) {
    setStatus("st-sp", e.message, false);
    if (e.kind === "auth") { playback = null; showConnected(); }
    if (e.kind === "premium" || e.kind === "no-device") playback = null;
    log("Spotify: " + e.message);
    updateMute();
  }

  function showConnected() {
    const on = !!sp?.connected;
    $("sp-login").hidden = on;
    $("sp-redirect").hidden = on;
    for (const id of ["sp-refresh", "sp-disconnect", "sp-play", "sp-pause", "sp-device"]) $(id).disabled = !on;
    if (!on) setStatus("st-sp", "not connected: paste your app's Client ID, then Connect");
  }

  // ---- this browser tab as a Spotify device (Web Playback SDK, Premium) ----
  // Default device. Its id changes every page load, so the saved choice is the word "browser".
  let player = null, browserDevice = null, sdk = null;
  const BROWSER_NAME = "BodyBeats (this browser)";
  function loadSdk() {
    sdk ??= new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
      const s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      s.onerror = () => { sdk = null; reject(new Error("couldn't load Spotify's browser player (offline?)")); };
      document.head.append(s);
    });
    return sdk;
  }
  async function startBrowserPlayer() {
    if (player || !sp?.connected) return;
    if (!sp.hasScope("streaming")) {
      return setStatus("st-sp", "to play in this browser: click Disconnect, then Connect once more (one new permission)", false);
    }
    let Spotify;
    try { Spotify = await loadSdk(); } catch (e) { return log("Spotify: " + e.message); }
    player = new Spotify.Player({
      name: BROWSER_NAME, volume: 0.8,
      getOAuthToken: (cb) => sp.accessToken().then(cb, spError),
    });
    player.addListener("ready", ({ device_id }) => { browserDevice = device_id; log("Spotify: this browser is now a Spotify device"); refreshDevices(); });
    player.addListener("not_ready", () => { browserDevice = null; log("Spotify: browser player went offline"); });
    player.addListener("initialization_error", ({ message }) => spError({ kind: "api", message: "browser player can't start here: " + message }));
    player.addListener("authentication_error", ({ message }) => spError({ kind: "auth", message: "browser player sign-in failed: " + message }));
    player.addListener("account_error", () => spError({ kind: "premium", message: "playing in the browser needs Spotify Premium" }));
    player.addListener("playback_error", ({ message }) => log("Spotify browser player: " + message));
    player.addListener("autoplay_failed", () => setStatus("st-sp", "the browser blocked autoplay: press Play", false));
    player.addListener("player_state_changed", () => setTimeout(poll, 300));
    if (!(await player.connect())) log("Spotify: browser player failed to connect");
  }
  function stopBrowserPlayer() { player?.disconnect(); player = null; browserDevice = null; }

  async function refreshDevices() {
    if (!sp?.connected) return;
    try {
      const list = await sp.devices(), sel = $("sp-device"), want = LS.get("bb.sp.dev", "browser");
      // the API can list the new browser device a few seconds late: show it straight away
      if (browserDevice && !list.some((d) => d.id === browserDevice)) list.unshift({ id: browserDevice, name: BROWSER_NAME, type: "Computer" });
      sel.innerHTML = "";
      for (const d of list) sel.add(new Option(d.id === browserDevice ? BROWSER_NAME : `${d.name} (${String(d.type).toLowerCase()})${d.is_active ? " · active" : ""}`, d.id));
      if (!list.length) {
        sel.add(new Option(player ? "(starting the browser player...)" : "(no device: open Spotify somewhere, then Refresh)", ""));
        return setStatus("st-sp", player ? "connected · starting the browser player..." : "connected · no Spotify device found", player ? null : false);
      }
      sel.value = want === "browser" && browserDevice ? browserDevice : list.some((d) => d.id === want) ? want
        : browserDevice || (list.find((d) => d.is_active) || list[0]).id;
      setStatus("st-sp", `connected · playing to ${sel.value === browserDevice ? "this browser" : sel.selectedOptions[0]?.text}`, true);
    } catch (e) { spError(e); }
  }

  async function startPlaylist(uri, why) {
    const dev = device();
    if ($("sp-shuffle").checked) await sp.shuffle(true, dev).catch(() => {});   // harmless before a device is active
    await sp.play(dev, uri);
    lastSwitchT = Date.now();
    log("Spotify: " + why);
    setTimeout(poll, 900);
  }

  async function poll() {
    if (mode !== "spotify" || !sp?.connected || polling) return;
    polling = true;
    try {
      playback = await sp.player();
      const want = target(), uri = playlistFor(want), byHand = !!$("sp-override").value;
      const ready = byHand || (trk.reliable && trk.intensity);
      const d = decide({ targetUri: uri, playback, auto: $("sp-auto").checked && !!ready, now: Date.now(), lastSwitchT });
      spWhy = $("sp-auto").checked && !ready ? "waiting for a steady heart rate or movement" : d.why;
      if (d.play) await startPlaylist(uri, `${INTENSITY_NAMES[want]} playlist (${d.why})`);
      if ($("st-sp").classList.contains("bad")) setStatus("st-sp", "connected", true);
    } catch (e) { spError(e); }
    finally { polling = false; showPlayback(); updateMute(); }
  }

  function showPlayback() {
    const it = playback?.item;
    $("sp-now").textContent = it ? `${it.name} · ${(it.artists || []).map((a) => a.name).join(", ") || it.show?.name || ""}` : "--";
    const ctxInt = INTENSITIES.find((i) => playback?.context?.uri && playlistFor(i) === playback.context.uri);
    $("sp-ctx").textContent = !playback ? "nothing playing" : `${playback.is_playing ? "playing" : "paused"} on ${playback.device?.name || "?"} · `
      + (ctxInt ? `your ${INTENSITY_NAMES[ctxInt]} playlist` : "not one of your BodyBeats playlists");
  }

  const LEVEL_COLOR = { warmup: "#4a8cff", steady: "#4fd18b", high: "#ffd23f" };
  function showLevel() {
    const want = target(), h = getState().heart, byHand = mode === "spotify" && $("sp-override").value;
    $("hero-level").textContent = INTENSITY_NAMES[want] + (byHand ? " (by hand)" : trk.intensity ? "" : " (to start)");
    $("hero-level").style.setProperty("--lc", LEVEL_COLOR[want]);
    const sig = trk.source === "heart" ? `heart ${Math.round(trk.value)} BPM${h?.from === "demo" ? " (demo)" : h?.from ? " · " + h.from : ""}`
      : trk.source === "movement" ? `movement ${pct(trk.value)} (no pulse yet)` : "no heart rate yet: finger on the sensor, or press a Demo";
    $("hero-why").textContent = `${sig}${trk.reliable && trk.why !== "in range" ? " · " + trk.why : ""}`;
    for (const i of INTENSITIES) $("lv-" + i).classList.toggle("cur", i === want);
    for (const b of document.querySelectorAll("button.demo")) b.classList.toggle("on", demoLevel === b.dataset.demo);
    $("demo-live").classList.toggle("on", !demoLevel);
    if (mode === "spotify" && spWhy) $("lv-why").textContent = "Spotify: " + spWhy;
  }

  // ---- ranges and demo ----
  let demoLevel = null;
  const demoBpm = (lvl) => { const { steadyHr: lo, highHr: hi } = tracker.cfg;
    return lvl === "warmup" ? Math.max(60, lo - 15) : lvl === "steady" ? Math.round((lo + hi) / 2) : Math.min(150, hi + 12); };
  function showRanges() {
    const { steadyHr: lo, highHr: hi } = tracker.cfg;
    $("rng-warm").textContent = lo; $("rng-steady").textContent = hi - 1;
    for (const b of document.querySelectorAll("button.demo")) b.querySelector("span").textContent = demoBpm(b.dataset.demo);
    if (demoLevel) brain.setDemo(demoBpm(demoLevel));
  }
  function setDemo(lvl) {
    demoLevel = lvl;
    brain.setDemo(lvl ? demoBpm(lvl) : null);
    log(lvl ? `demo: heart forced to ${demoBpm(lvl)} BPM (${INTENSITY_NAMES[lvl]})` : "demo off: back to your real pulse");
    showLevel();
  }

  function setMode(m) {
    const was = mode;
    mode = m; LS.set("bb.mode", m);
    for (const b of $("mode").children) b.classList.toggle("on", b.dataset.mode === m);
    $("sp").hidden = m !== "spotify";
    $("music").classList.toggle("gen", m !== "spotify");
    if (m === "spotify") { startBrowserPlayer(); refreshDevices(); poll(); }
    else if (was === "spotify" && playback?.is_playing)   // back to the synth: don't leave Spotify playing on top
      sp.pause(device()).then(() => log("Spotify paused: generated band is back"), spError).finally(() => { playback = null; updateMute(); });
    updateMute();
  }

  // ---- controls ----
  $("sp-client").value = LS.get("bb.sp.client");
  $("sp-redirect").innerHTML = "In your Spotify app's dashboard, add the redirect URI <code></code>.";
  $("sp-redirect").querySelector("code").textContent = redirectUri;
  for (const inp of document.querySelectorAll("input[data-int]")) {
    inp.value = LS.get("bb.sp.pl." + inp.dataset.int);
    const check = () => { inp.style.borderColor = !inp.value.trim() || toSpotifyUri(inp.value) ? "" : "var(--bad)"; };
    inp.oninput = () => { LS.set("bb.sp.pl." + inp.dataset.int, inp.value.trim()); check(); };
    check();
  }
  // range pickers: Steady starts at 70..130, High energy at 100..170 (always at least 10 above)
  for (let v = 70; v <= 130; v += 5) $("sp-lo").add(new Option(v + "", v));
  for (let v = 100; v <= 170; v += 5) $("sp-hi").add(new Option(v + "", v));
  $("sp-lo").value = tracker.cfg.steadyHr; $("sp-hi").value = tracker.cfg.highHr;
  $("sp-lo").onchange = $("sp-hi").onchange = (e) => {
    let lo = +$("sp-lo").value, hi = +$("sp-hi").value;
    if (hi < lo + 10) { if (e.target.id === "sp-lo") hi = Math.min(170, lo + 10); else lo = Math.max(70, hi - 10); }
    $("sp-lo").value = lo; $("sp-hi").value = hi;
    tracker.cfg.steadyHr = lo; tracker.cfg.highHr = hi; LS.set("bb.sp.lo", lo); LS.set("bb.sp.hi", hi);
    showRanges(); log(`levels: Warm-up under ${lo}, Steady ${lo}-${hi - 1}, High energy ${hi}+ BPM`);
  };
  for (const b of document.querySelectorAll("button.demo")) b.onclick = () => { player?.activateElement(); setDemo(demoLevel === b.dataset.demo ? null : b.dataset.demo); };   // click again = off
  $("demo-live").onclick = () => setDemo(null);
  showRanges();
  for (const b of $("mode").children) b.onclick = () => setMode(b.dataset.mode);
  $("sp-connect").onclick = async () => {
    const id = $("sp-client").value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) return setStatus("st-sp", "that doesn't look like a Client ID (32 letters and digits)", false);
    if (location.protocol === "file:") return setStatus("st-sp", "open the page through conductor.py: http://127.0.0.1:8000/live.html", false);
    if (location.hostname === "localhost")
      return setStatus("st-sp", `Spotify doesn't accept "localhost" redirects: open http://127.0.0.1:${location.port || 80}${location.pathname} instead`, false);
    LS.set("bb.sp.client", id); LS.set("bb.mode", "spotify");
    sp = new SpotifyClient({ clientId: id, redirectUri });
    setStatus("st-sp", "opening Spotify sign-in...");
    location.assign(await sp.authorizeUrl());   // the page reloads: connect the Nicla etc. after you come back
  };
  $("sp-disconnect").onclick = () => { stopBrowserPlayer(); sp?.disconnect(); playback = null; showConnected(); showPlayback(); updateMute(); log("Spotify disconnected"); };
  $("sp-refresh").onclick = refreshDevices;
  $("sp-device").onchange = () => LS.set("bb.sp.dev", $("sp-device").value === browserDevice ? "browser" : $("sp-device").value);
  $("sp-play").onclick = async () => {
    player?.activateElement();   // inside the click, before any await: lets the browser play sound
    const want = target(), uri = playlistFor(want);
    try {
      if (uri) await startPlaylist(uri, `${INTENSITY_NAMES[want]} playlist (Play pressed)`);
      else {   // no playlist for this intensity yet: carry on with whatever was playing, on the chosen device
        await sp.play(device());
        log(`Spotify: resumed (paste a ${INTENSITY_NAMES[want]} playlist link to let your body choose)`);
        setTimeout(poll, 900);
      }
    } catch (e) { spError(e); }
  };
  $("sp-pause").onclick = async () => { try { await sp.pause(device()); log("Spotify paused"); setTimeout(poll, 500); } catch (e) { spError(e); } };
  $("sp-override").onchange = async () => {   // a hand-picked intensity switches straight away
    player?.activateElement();
    const want = target(), uri = playlistFor(want);
    if (uri && playback?.is_playing && playback.context?.uri !== uri) {
      try { await startPlaylist(uri, `${INTENSITY_NAMES[want]} playlist (picked by hand)`); } catch (e) { spError(e); }
    }
  };

  // ---- start: finish a sign-in redirect if we're coming back from Spotify ----
  (async () => {
    const id = LS.get("bb.sp.client");
    if (id) {
      sp = new SpotifyClient({ clientId: id, redirectUri });
      try { if (await sp.handleRedirect(location.href)) { log("Spotify connected"); mode = "spotify"; } }
      catch (e) { spError(e); }
      if (/[?&](code|error|state)=/.test(location.search)) history.replaceState(null, "", location.pathname);
    }
    showConnected();
    setMode(mode);
    setInterval(poll, 3000);
    setInterval(() => {
      trk = tracker.update(getState(), now());
      if (trk.changed) { log(`level: ${INTENSITY_NAMES[trk.intensity]}`); poll(); }   // new range: switch now
      showLevel();
    }, 250);
  })();

  return {
    updateMute, tracker,
    level: () => target(),                    // the level the music and lights follow
    spotifyPlaying: spPlaying,
    demo: () => demoLevel,
    debug: () => ({ mode, sp, playback, trk, demoLevel }),
  };
}
