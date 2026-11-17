// Body Beat web: Spotify mode. Plays the user's own playlists on one of their Spotify Connect
// devices (phone, desktop app, speaker) and picks the playlist from how hard they're working.
// See docs/spotify-api-integration-plan.md.
//
//   SpotifyClient      Authorization Code + PKCE (no client secret anywhere), token refresh,
//                      the handful of Web API calls we need, errors turned into plain reasons
//   IntensityTracker   fused state (heart rate, movement) -> warmup / steady / high / recovery,
//                      smoothed, with hysteresis, a dwell time and a cooldown between changes
//   decide()           when to actually switch playlist: only while Spotify is playing, never
//                      over a manual pause, at the end of a track unless "mid-track" is allowed
//
// The tracker and decide() are pure (no DOM, no network): tests/test_web_live.mjs runs them in Node.
// Spotify's playback controls need Spotify Premium. Recorded music is never routed through Web
// Audio, mixed or modified here: Spotify plays it on its own device.

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
export const SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
  // the Web Playback SDK (this browser tab as a Spotify device) needs these three
  "streaming", "user-read-email", "user-read-private"];
export const INTENSITIES = ["warmup", "steady", "high"];
export const INTENSITY_NAMES = { warmup: "Warm-up", steady: "Steady", high: "High energy" };

// "https://open.spotify.com/playlist/37i9...?si=x", "spotify:playlist:37i9...", album links too
export function toSpotifyUri(text) {
  const s = String(text || "").trim();
  let m = /^spotify:(playlist|album|artist):([A-Za-z0-9]{10,})$/.exec(s);
  if (m) return `spotify:${m[1]}:${m[2]}`;
  m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:user\/[^/]+\/)?(playlist|album|artist)\/([A-Za-z0-9]{10,})/.exec(s);
  return m ? `spotify:${m[1]}:${m[2]}` : null;
}

// ---- PKCE ----------------------------------------------------------------------------------
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function randomString(n = 64) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join("");
}
export async function challenge(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export class SpotifyError extends Error {
  // kind: auth (connect again) | premium | no-device | rate-limit | network | api
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

export class SpotifyClient {
  static KEY = "bb.spotify.token";
  static PKCE = "bb.spotify.pkce";

  constructor({ clientId, redirectUri, store = globalThis.sessionStorage, fetchFn = (...a) => fetch(...a) }) {
    this.clientId = clientId; this.redirectUri = redirectUri; this.store = store; this.fetch = fetchFn;
    try { this.tok = JSON.parse(store?.getItem(SpotifyClient.KEY) || "null"); } catch { this.tok = null; }
    this.backoffUntil = 0;
  }

  get connected() { return !!(this.tok && (this.tok.refresh || this.tok.access)); }
  save(tok) { this.tok = tok; try { tok ? this.store.setItem(SpotifyClient.KEY, JSON.stringify(tok)) : this.store.removeItem(SpotifyClient.KEY); } catch {} }
  disconnect() { this.save(null); }

  async authorizeUrl() {
    const verifier = randomString(64), state = randomString(16);
    try { this.store.setItem(SpotifyClient.PKCE, JSON.stringify({ verifier, state })); } catch {}
    const q = new URLSearchParams({
      client_id: this.clientId, response_type: "code", redirect_uri: this.redirectUri,
      scope: SCOPES.join(" "), state, code_challenge_method: "S256", code_challenge: await challenge(verifier),
    });
    return AUTH_URL + "?" + q;
  }

  // Back from accounts.spotify.com: ?code=...&state=... (or ?error=access_denied)
  // Returns null if the URL isn't a Spotify redirect, else true / throws.
  async handleRedirect(href) {
    const u = new URL(href), code = u.searchParams.get("code"), err = u.searchParams.get("error");
    if (!code && !err) return null;
    let saved = null;
    try { saved = JSON.parse(this.store.getItem(SpotifyClient.PKCE) || "null"); this.store.removeItem(SpotifyClient.PKCE); } catch {}
    if (err) throw new SpotifyError("auth", "Spotify sign-in was cancelled (" + err + ")");
    if (!saved || saved.state !== u.searchParams.get("state")) throw new SpotifyError("auth", "Spotify sign-in did not match this tab: try Connect again");
    await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, code_verifier: saved.verifier });
    return true;
  }

  async tokenRequest(params) {
    let r;
    try {
      r = await this.fetch(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.clientId, ...params }),
      });
    } catch (e) { throw new SpotifyError("network", "can't reach Spotify: " + e.message); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (params.grant_type === "refresh_token") this.save(null);   // revoked or expired: sign in again
      throw new SpotifyError("auth", "Spotify sign-in failed: " + (j.error_description || j.error || r.status));
    }
    this.save({
      access: j.access_token, refresh: j.refresh_token || this.tok?.refresh,   // refresh tokens may rotate
      expires: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope ?? this.tok?.scope ?? "",
    });
  }

  // tokens from before a scope was added don't have it: the user has to connect once more
  hasScope(s) { return (this.tok?.scope || "").split(" ").includes(s); }

  async accessToken() {
    if (!this.tok) throw new SpotifyError("auth", "not connected to Spotify");
    if (!this.tok.access || Date.now() > this.tok.expires - 60000) {
      if (!this.tok.refresh) { this.save(null); throw new SpotifyError("auth", "Spotify session expired: connect again"); }
      await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.tok.refresh });
    }
    return this.tok.access;
  }

  async api(method, path, { body, query, retried = false } = {}) {
    if (Date.now() < this.backoffUntil) throw new SpotifyError("rate-limit", "Spotify asked us to slow down", { retryAt: this.backoffUntil });
    const url = API + path + (query ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)) : "");
    let r;
    try {
      r = await this.fetch(url, {
        method, headers: { Authorization: "Bearer " + (await this.accessToken()), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { if (e instanceof SpotifyError) throw e; throw new SpotifyError("network", "can't reach Spotify: " + e.message); }
    if (r.status === 204 || r.status === 202) return null;
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (r.ok) return j;
    const reason = j?.error?.reason, msg = j?.error?.message || "HTTP " + r.status;
    if (r.status === 401 && !retried && this.tok?.refresh) {
      this.tok.expires = 0;   // force a refresh, then one retry
      return this.api(method, path, { body, query, retried: true });
    }
    if (r.status === 401) { this.save(null); throw new SpotifyError("auth", "Spotify session expired: connect again"); }
    if (r.status === 429) {
      const s = +(r.headers.get?.("Retry-After") || 5);
      this.backoffUntil = Date.now() + Math.min(120, s) * 1000;
      throw new SpotifyError("rate-limit", `Spotify rate limit: waiting ${s} s`, { retryAt: this.backoffUntil });
    }
    if (r.status === 403 && (reason === "PREMIUM_REQUIRED" || /premium/i.test(msg)))
      throw new SpotifyError("premium", "Spotify playback control needs a Premium account");
    if (r.status === 404 && (reason === "NO_ACTIVE_DEVICE" || /device/i.test(msg)))
      throw new SpotifyError("no-device", "no Spotify device: open Spotify on your phone or laptop, then Refresh");
    throw new SpotifyError("api", "Spotify: " + msg, { status: r.status, reason });
  }

  async devices() { return (await this.api("GET", "/me/player/devices"))?.devices || []; }
  player() { return this.api("GET", "/me/player"); }            // null when nothing is active
  play(deviceId, contextUri) { return this.api("PUT", "/me/player/play", { query: { device_id: deviceId }, body: contextUri ? { context_uri: contextUri } : undefined }); }
  pause(deviceId) { return this.api("PUT", "/me/player/pause", { query: { device_id: deviceId } }); }
  shuffle(on, deviceId) { return this.api("PUT", "/me/player/shuffle", { query: { state: !!on, device_id: deviceId } }); }
}

// ---- exercise level ------------------------------------------------------------------------
// Three levels. Entering a new BPM range switches straight away (after a short confirm so one
// noisy reading can't flip the music), with a small hysteresis so sitting on a boundary
// doesn't flap between two playlists.
export const TRACKER_DEFAULTS = {
  steadyHr: 100, highHr: 135, hrMargin: 3,     // BPM: up at the threshold, down `margin` below it
  steadyMove: 0.3, highMove: 0.6, moveMargin: 0.06,
  minHrQuality: 0.4,
  smoothMs: 2500,                               // time constant of the smoothing (demo: none)
  confirmMs: 3000,                              // a new range must hold this long (demo: 1 s)
  holdMs: 20000,                                // no usable signal for this long = stop automating
};

export class IntensityTracker {
  constructor(cfg = {}) {
    this.cfg = { ...TRACKER_DEFAULTS, ...cfg };
    this.stable = null; this.cand = null; this.candT = 0;
    this.lastGoodT = -1e12; this.src = null; this.value = null; this.lastT = null;
  }

  // the BPM ranges as the page shows them
  ranges() {
    const { steadyHr: lo, highHr: hi } = this.cfg;
    return { warmup: [0, lo - 1], steady: [lo, hi - 1], high: [hi, 999] };
  }

  // one reading -> level, given the current level (hysteresis on the way down)
  classify(v, lo, hi, m) {
    const cur = this.stable;
    if (v >= hi) return "high";
    if (cur === "high" && v >= hi - m) return "high";
    if (v >= lo) return "steady";
    if (cur === "steady" && v >= lo - m) return "steady";
    return "warmup";
  }

  // fused = Brain.update() output: { heart: {bpm, from, quality} | null, movement: 0..1 | null }
  update(fused, now) {
    const c = this.cfg, h = fused?.heart;
    let src = null, raw = null;
    if (h && Number.isFinite(h.bpm) && (h.quality ?? 1) >= c.minHrQuality) { src = "heart"; raw = h.bpm; }
    else if (Number.isFinite(fused?.movement)) { src = "movement"; raw = fused.movement; }
    const demo = h?.from === "demo";

    const dt = this.lastT == null ? 0 : now - this.lastT;
    this.lastT = now;
    if (src) {
      if (src !== this.src || this.value == null || demo) this.value = raw;   // new source or demo: no lag
      else this.value += (raw - this.value) * (1 - Math.exp(-dt / c.smoothMs));
      this.src = src; this.lastGoodT = now;
    }
    const reliable = now - this.lastGoodT < c.holdMs;
    const out = (extra) => ({ intensity: this.stable, candidate: this.cand, source: this.src, value: this.value, reliable, changed: false, ...extra });
    if (!reliable) { this.cand = null; return out({ why: "no reliable signal: holding" }); }
    if (!src) return out({ why: "signal lost: holding" });

    const v = this.value;
    const band = this.src === "heart" ? this.classify(v, c.steadyHr, c.highHr, c.hrMargin) : this.classify(v, c.steadyMove, c.highMove, c.moveMargin);
    if (band === this.stable) { this.cand = null; return out({ why: "in range" }); }
    if (band !== this.cand) { this.cand = band; this.candT = now; }
    const need = demo ? 1000 : this.stable == null ? 1500 : c.confirmMs;
    if (now - this.candT < need) return out({ why: `entering ${band}...` });
    this.stable = band; this.cand = null;
    return out({ changed: true, why: "entered " + band });
  }
}

// ---- when to switch ----------------------------------------------------------------------------
// playback = GET /me/player (or null). Returns {play: bool, why}. A new level switches at once
// unless "wait for the track to end" is asked for. Never over a pause, never twice in a row.
export function decide({ targetUri, playback, auto = true, midTrack = true, now, lastSwitchT = -1e12, boundaryMs = 12000, minGapMs = 3000 }) {
  if (!auto) return { play: false, why: "automatic switching is off" };
  if (!targetUri) return { play: false, why: "no playlist set for this level" };
  if (!playback || !playback.item) return { play: false, why: "Spotify isn't playing: press Play" };
  if (!playback.is_playing) return { play: false, why: "paused: your pause wins" };
  if (playback.context?.uri === targetUri) return { play: false, why: "on the right playlist" };
  if (now - lastSwitchT < minGapMs) return { play: false, why: "just switched" };
  if (midTrack) return { play: true, why: "new level" };
  const left = (playback.item.duration_ms ?? 0) - (playback.progress_ms ?? 0);
  if (left <= boundaryMs) return { play: true, why: "end of the track" };
  return { play: false, why: `switching at the end of this track (${Math.round(left / 1000)} s)` };
}
