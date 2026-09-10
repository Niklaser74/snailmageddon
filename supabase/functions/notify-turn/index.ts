// Sends "your turn" push notifications for a Snigelpost match.
// Called by the client right after it has submitted a turn (or joined).
// The gateway verifies the caller's JWT; this function checks that the caller
// is in the match and notifies the other player only.
import { sendPush, b64url, b64urlDecode } from './webpush.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SITE = 'https://snails.se'; // also the VAPID subject: keep it the origin
const GAME = `${SITE}/snailmageddon`;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

type Kind = 'turn' | 'joined' | 'finished' | 'resigned' | 'timeout' | 'rematch';
function texts(lang: string | null, name: string): Record<Kind, string> {
  return lang === 'en'
    ? { turn: `${name} has played. Your turn!`, joined: `${name} joined your match.`, finished: `The match against ${name} is over.`,
        resigned: `${name} gave up. You won!`, timeout: `${name} claimed the win after 14 days of silence.`, rematch: `${name} wants a rematch!` }
    : { turn: `${name} har spelat. Din tur!`, joined: `${name} gick med i din match.`, finished: `Matchen mot ${name} är slut.`,
        resigned: `${name} gav upp. Du vann!`, timeout: `${name} tog hem vinsten efter 14 dagars tystnad.`, rematch: `${name} vill ha revansch!` };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /i, '');
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(token.split('.')[1] || '')));
    const uid = claims.sub as string;
    if (!uid) return json({ error: 'not signed in' }, 401);
    const { match_id, event } = await req.json();
    if (typeof match_id !== 'string') return json({ error: 'match_id required' }, 400);

    const rows = await (await rest(`snails_matches?id=eq.${encodeURIComponent(match_id)}&select=id,host,guest,names,status,turn_team,series_id`)).json();
    const m = rows[0];
    if (!m) return json({ error: 'no such match' }, 404);
    const me = m.host === uid ? 0 : m.guest === uid ? 1 : null;
    if (me === null) return json({ error: 'not your match' }, 403);
    const other = me === 0 ? m.guest : m.host;
    if (!other) return json({ sent: 0, reason: 'no opponent yet' });
    const kind: Kind = ['joined', 'resigned', 'timeout', 'rematch'].includes(event) ? event : m.status === 'finished' ? 'finished' : 'turn';
    if (kind === 'turn' && m.turn_team === me) return json({ sent: 0, reason: 'still your turn' });

    const subs = await (await rest(`snails_push_subscriptions?user_id=eq.${other}&select=endpoint,p256dh,auth,lang`)).json();
    if (!subs.length) return json({ sent: 0, reason: 'no subscriptions' });

    const jwkText = await (await rest('rpc/snails_vapid_private', { method: 'POST', body: '{}' })).json();
    if (!jwkText) return json({ error: 'vapid key missing' }, 500);
    const jwk = typeof jwkText === 'string' ? JSON.parse(jwkText) : jwkText;
    const publicKey = b64url(new Uint8Array([4, ...b64urlDecode(jwk.x), ...b64urlDecode(jwk.y)]));
    const vapid = { publicKey, jwk };

    // Series (best of 3/5): add the score from the receiver's point of view and open the current match.
    let score = '', url = `${GAME}/?match=${m.id}`;
    if (m.series_id) {
      const srows = await (await rest(`snails_series?id=eq.${m.series_id}&select=host,best_of,wins_host,wins_guest,status,current_match`)).json();
      const s = srows[0];
      if (s) {
        const otherIsHost = s.host === other;
        const [wm, wt] = otherIsHost ? [s.wins_host, s.wins_guest] : [s.wins_guest, s.wins_host];
        if (s.best_of > 1 || wm + wt > 0) score = ` (${wm}–${wt})`;
        if (s.status !== 'finished' && s.current_match) url = `${GAME}/?match=${s.current_match}`;
      }
    }

    const myName = m.names?.[String(me)] || 'Motståndaren';
    let sent = 0;
    const dead: string[] = [];
    for (const s of subs) {
      const t = texts(s.lang, myName);
      const payload = { title: s.lang === 'en' ? 'Snailmageddon' : 'Snäckmageddon', body: t[kind] + (kind === 'joined' ? '' : score), url, tag: m.series_id ? `series-${m.series_id}` : `match-${m.id}` };
      const status = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, vapid, SITE).catch(() => 0);
      if (status === 201 || status === 200) sent++;
      else if (status === 404 || status === 410) dead.push(s.endpoint);
    }
    for (const e of dead) await rest(`snails_push_subscriptions?endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    return json({ sent, dead: dead.length });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
