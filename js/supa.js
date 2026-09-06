// Minimal Supabase client: anonymous auth + RPC calls, no library.
// The session (access/refresh token) lives in localStorage; the user is an
// anonymous Supabase Auth user that can later be linked to an e-mail address.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const LS_SESSION = 'snackmageddon.session';
let session = null;

function loadSession() {
  if (session) return session;
  try { session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch { session = null; }
  return session;
}
function saveSession(s) {
  session = s;
  try { if (s) localStorage.setItem(LS_SESSION, JSON.stringify(s)); else localStorage.removeItem(LS_SESSION); } catch { /* ignore */ }
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
function jwtSub(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || null; } catch { return null; }
}
let userCache = null;
let pendingToken = null;

export const online = {
  available() { return !!(SUPABASE_URL && SUPABASE_KEY); },
  userId() { return loadSession()?.user_id || null; },

  // Returns a valid access token, signing in anonymously the first time and
  // refreshing when needed.
  async token() {
    const s = loadSession();
    if (s && s.expires_at - Date.now() > 60000) return s.access_token;
    // several callers at start-up must share one sign-in, not create one account each
    if (!pendingToken) pendingToken = this.freshToken().finally(() => { pendingToken = null; });
    return pendingToken;
  },
  async freshToken() {
    let s = loadSession();
    if (s?.refresh_token) {
      try { s = await authRequest('token?grant_type=refresh_token', { refresh_token: s.refresh_token }); saveSession(s); return s.access_token; }
      catch { saveSession(null); }
    }
    s = await authRequest('signup', {}); // anonymous sign-in (must be enabled in the project's auth settings)
    if (!s.user_id) throw new Error('anonymous sign-in is disabled');
    saveSession(s);
    return s.access_token;
  },

  async rpc(name, args = {}) {
    const token = await this.token();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && (data.message || data.hint || data.error)) || `rpc ${name} ${res.status}`);
    return data;
  },

  // Call an edge function as the signed-in user.
  async fn(name, body = {}) {
    const token = await this.token();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `${name} ${res.status}`);
    return data;
  },

  signOut() { saveSession(null); userCache = null; },

  // ---------- e-mail linking ----------
  // The anonymous account gets an e-mail address (Supabase sends a confirmation
  // link). Once confirmed the account is permanent and can be signed into on
  // any device with a login link to the same address.
  async user(fresh = false) {
    if (userCache && !fresh) return userCache;
    const token = await this.token();
    const u = await authFetch('user', 'GET', undefined, token);
    const provider = (u.identities || []).map((i) => i.provider).find((p) => p && p !== 'email') || u.app_metadata?.provider || null;
    userCache = { id: u.id, email: u.email || null, pendingEmail: u.new_email || null, anonymous: u.is_anonymous !== false && !u.email, provider: provider === 'email' ? null : provider };
    return userCache;
  },
  // ---------- Google ----------
  // link=true: the signed-in (anonymous) account gets a Google identity and keeps
  // its id and matches ("Allow manual linking" must be on in the project).
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
  // Scanner-proof e-mail links: the mail carries ?token_hash=…&type=… to the game,
  // and the session is only created when the player presses a button.
  async verifyToken(tokenHash, type) {
    const data = await authFetch('verify', 'POST', { type, token_hash: tokenHash });
    saveSession(sessionFrom(data));
    userCache = null;
    return { type };
  },
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
  // Returns the link type, 'error' with a message, or null when there was nothing.
  handleRedirect() {
    const h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    let q = new URLSearchParams(h);
    // OAuth errors come in the query string (sometimes in both); the session only in the fragment
    const qs = new URLSearchParams(location.search);
    if (!q.get('access_token') && !q.get('error') && qs.get('error')) q = new URLSearchParams(qs);
    if (!q.get('access_token') && !q.get('error')) return null;
    for (const k of ['error', 'error_code', 'error_description']) qs.delete(k);
    history.replaceState(null, '', location.pathname + ([...qs].length ? '?' + qs : ''));
    if (q.get('error')) return { type: 'error', code: q.get('error_code') || null, message: (q.get('error_description') || q.get('error')).replace(/\+/g, ' ') };
    const access = q.get('access_token');
    saveSession({ access_token: access, refresh_token: q.get('refresh_token'), expires_at: Date.now() + (+q.get('expires_in') || 3600) * 1000, user_id: jwtSub(access) });
    userCache = null;
    return { type: q.get('type') || 'oauth' }; // OAuth returns carry no type
  },
  // userId() may be unknown right after a redirect (no JWT payload); ask the server once
  async ensureUserId() {
    const s = loadSession();
    if (s && !s.user_id) { const u = await this.user(true); s.user_id = u.id; saveSession(s); }
    return loadSession()?.user_id || null;
  },
};
