// The series' account: one Supabase client for everything on snails.se.
//
// This file is owned by the hub (Niklaser74.github.io) and vendored unchanged
// into every game that talks to Supabase (`npm run sync:account` in the game
// repo copies it to js/account.js; the game's js/supa.js re-exports it). It
// imports ./config.js, which every repo has, so the file needs no edits.
//
// Everything on snails.se shares one origin and one Supabase project, so the
// session is shared on purpose: a player signed in at snails.se/account/ is
// signed in in every game. The key is `snails.session`; the first load moves a
// session left by the old per-game key (`snackmageddon.session`, used by the
// games until 2026-09-14) so nobody is signed out by the change.
//
// Minimal by design: anonymous auth, refresh, RPC and edge-function calls,
// Google and e-mail linking. No library.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const LS_SESSION = 'snails.session';
const LS_LEGACY = 'snackmageddon.session';
let session = null;
let userCache = null;
let pendingToken = null;
let held = null; // a callback waiting for the player to confirm it

function store() { try { return globalThis.localStorage; } catch { return null; } }
function tabStore() { try { return globalThis.sessionStorage; } catch { return null; } }
// A redirect is only accepted if this browser started one. Without it any link
// with #access_token= signs the player into whichever account the link carries —
// the attacker's — and a later Google link moves that identity there too.
// sessionStorage, so the attempt dies with the tab and never leaks to another.
const SS_PENDING = 'snails.pendingAuth';
const PENDING_MAX_AGE = 15 * 60 * 1000;
function markAuthStarted() {
  const ss = tabStore();
  try { ss?.setItem(SS_PENDING, JSON.stringify({ at: Date.now(), uid: loadSession()?.user_id || null })); } catch { /* blocked */ }
}
// Reading it also spends it: one attempt, one callback. Returns 'no-storage'
// when the browser blocks sessionStorage: refusing there would lock those
// players out of Google altogether, and localStorage is blocked with it, so the
// session they would get could not be stored anyway.
function takeAuthStarted() {
  const ss = tabStore();
  if (!ss) return 'no-storage';
  let p = null;
  try { p = JSON.parse(ss.getItem(SS_PENDING) || 'null'); } catch { p = null; }
  try { ss.removeItem(SS_PENDING); } catch { /* blocked */ }
  if (!p || typeof p.at !== 'number' || Date.now() - p.at > PENDING_MAX_AGE) return null;
  return p;
}
function loadSession() {
  if (session) return session;
  const ls = store();
  if (!ls) return null;
  try {
    session = JSON.parse(ls.getItem(LS_SESSION) || 'null');
    if (!session) {
      const legacy = JSON.parse(ls.getItem(LS_LEGACY) || 'null');
      if (legacy?.access_token) { session = legacy; ls.setItem(LS_SESSION, JSON.stringify(legacy)); }
    }
  } catch { session = null; }
  return session;
}
function saveSession(s) {
  session = s;
  const ls = store();
  if (!ls) return;
  try {
    if (s) ls.setItem(LS_SESSION, JSON.stringify(s));
    else { ls.removeItem(LS_SESSION); ls.removeItem(LS_LEGACY); } // signing out must not resurrect the old copy
  } catch { /* private mode */ }
}
function jwtSub(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || null; } catch { return null; }
}
async function authFetch(path, method, body, token) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, { method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.msg || data.error_description || data.error || data.message || `auth ${res.status}`);
    err.code = res.status === 429 ? 'rate_limit' : (data.error_code || data.code || null);
    err.status = res.status;
    throw err;
  }
  return data;
}
function sessionFrom(data) {
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000, user_id: data.user?.id || jwtSub(data.access_token) };
}
async function authRequest(path, body) {
  return sessionFrom(await authFetch(path, 'POST', body));
}

export const online = {
  available() { return !!(SUPABASE_URL && SUPABASE_KEY); },
  userId() { return loadSession()?.user_id || null; },
  // true when this browser already has a session — reading it never talks to the server
  signedIn() { return !!loadSession()?.access_token; },

  // A valid access token, signing in anonymously the first time and refreshing when needed.
  async token() {
    const s = loadSession();
    if (s && s.expires_at - Date.now() > 60000) return s.access_token;
    return this.refreshOnce();
  },
  // several callers at start-up must share one sign-in, not create one account each
  refreshOnce() {
    if (!pendingToken) pendingToken = this.freshToken().finally(() => { pendingToken = null; });
    return pendingToken;
  },
  async freshToken() {
    let s = loadSession();
    if (s?.refresh_token) {
      try { s = await authRequest('token?grant_type=refresh_token', { refresh_token: s.refresh_token }); saveSession(s); return s.access_token; }
      catch { saveSession(null); }
    }
    s = await authRequest('signup', {}); // anonymous sign-in (enabled in the project)
    if (!s.user_id) throw new Error('anonymous sign-in is disabled');
    saveSession(s);
    return s.access_token;
  },
  // One authenticated request. A 401 means the stored access token is no longer
  // accepted (expired early, or issued elsewhere): refresh once and try again.
  async authed(run) {
    let res = await run(await this.token());
    if (res.status === 401 && loadSession()?.refresh_token) res = await run(await this.refreshOnce());
    return res;
  },

  // `keepalive` lets a call survive the page being closed (Snail Story sends its schedule then).
  async rpc(name, args = {}, { keepalive = false } = {}) {
    const res = await this.authed((token) => fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      keepalive,
    }));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && (data.message || data.hint || data.error)) || `rpc ${name} ${res.status}`);
    return data;
  },
  // Call an edge function as the signed-in user.
  async fn(name, body = {}) {
    const res = await this.authed((token) => fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `${name} ${res.status}`);
    return data;
  },

  signOut() { saveSession(null); userCache = null; },

  // ---------- who am I ----------
  async user(fresh = false) {
    if (userCache && !fresh) return userCache;
    let u;
    try { u = await authFetch('user', 'GET', undefined, await this.token()); }
    catch (e) {
      if (e.status !== 401 || !loadSession()?.refresh_token) throw e;
      u = await authFetch('user', 'GET', undefined, await this.refreshOnce());
    }
    const provider = (u.identities || []).map((i) => i.provider).find((p) => p && p !== 'email') || u.app_metadata?.provider || null;
    userCache = { id: u.id, email: u.email || null, pendingEmail: u.new_email || null, anonymous: u.is_anonymous !== false && !u.email, provider: provider === 'email' ? null : provider };
    return userCache;
  },
  // ---------- Google ----------
  // link=true: the signed-in (anonymous) account gets a Google identity and keeps
  // its id and everything tied to it ("Allow manual linking" is on in the project).
  // link=false: sign in as whichever account owns the Google identity.
  // Returns the URL to send the browser to; Supabase comes back to redirectTo
  // with the session in the fragment, exactly like an e-mail link.
  async googleUrl(redirectTo, link) {
    const q = `provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
    if (!link) return `${SUPABASE_URL}/auth/v1/authorize?${q}`;
    const token = await this.token();
    const data = await authFetch(`user/identities/authorize?${q}&skip_http_redirect=true`, 'GET', undefined, token);
    if (!data.url) throw new Error('no authorize url');
    return data.url;
  },
  // ---------- e-mail ----------
  // Scanner-proof links: the mail carries ?token_hash=…&type=… and the session is
  // only created when the player presses a button.
  async verifyToken(tokenHash, type) {
    const data = await authFetch('verify', 'POST', { type, token_hash: tokenHash });
    saveSession(sessionFrom(data));
    userCache = null;
    return { type };
  },
  // The anonymous account gets an e-mail address; Supabase mails a confirmation.
  async linkEmail(email, redirectTo) {
    const token = await this.token();
    await authFetch(`user?redirect_to=${encodeURIComponent(redirectTo)}`, 'PUT', { email }, token);
    userCache = null;
  },
  // Login link for an existing account. Never creates a user, so a typo cannot start a new account.
  async sendLoginLink(email, redirectTo) {
    await authFetch(`otp?redirect_to=${encodeURIComponent(redirectTo)}`, 'POST', { email, create_user: false });
  },
  // Supabase sends the browser back with the session in the URL fragment
  // (#access_token=…&type=magiclink|email_change). Store it and clean the URL.
  // Returns { type }, { type: 'error', code, message }, or null when there was nothing.
  handleRedirect() {
    const h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    let q = new URLSearchParams(h);
    const qs = new URLSearchParams(location.search);
    if (!q.get('access_token') && !q.get('error') && qs.get('error')) q = new URLSearchParams(qs);
    if (!q.get('access_token') && !q.get('error')) return null;
    for (const k of ['error', 'error_code', 'error_description']) qs.delete(k);
    history.replaceState(null, '', location.pathname + ([...qs].length ? '?' + qs : ''));
    if (q.get('error')) return { type: 'error', code: q.get('error_code') || null, message: (q.get('error_description') || q.get('error')).replace(/\+/g, ' ') };
    const access = q.get('access_token');
    const type = q.get('type') || 'oauth'; // OAuth returns carry no type
    const incoming = { access_token: access, refresh_token: q.get('refresh_token'), expires_at: Date.now() + (+q.get('expires_in') || 3600) * 1000, user_id: jwtSub(access) };
    const started = takeAuthStarted();
    // Google always starts in this browser, so a callback without an attempt is
    // someone else's link. Drop it; the URL is already cleaned above.
    if (type === 'oauth' && !started) return { type: 'error', code: 'unsolicited', message: 'no sign-in was started here' };
    // A mail link may legitimately be opened on another device, where no attempt
    // exists. Hold the session instead of dropping it, and let the player say yes.
    if (!started) { held = incoming; return { type, needsConfirm: true, userId: incoming.user_id }; }
    saveSession(incoming);
    userCache = null;
    return { type };
  },
  // Adopt a session that handleRedirect held for confirmation. Nothing happens
  // until this is called, so an unexpected mail link cannot swap the account.
  confirmHeld() {
    if (!held) return null;
    const s = held;
    held = null;
    saveSession(s);
    userCache = null;
    return { type: 'confirmed', userId: s.user_id };
  },
  heldUserId() { return held?.user_id || null; },
  // Call before sending the browser to Google or asking for a mail link.
  startAuth() { markAuthStarted(); },
  // userId() may be unknown right after a redirect (no JWT payload); ask the server once
  async ensureUserId() {
    const s = loadSession();
    if (s && !s.user_id) { const u = await this.user(true); s.user_id = u.id; saveSession(s); }
    return loadSession()?.user_id || null;
  },
};
