// In-memory stand-in for the Supabase endpoints the game uses, with the same
// rules as supabase/migrations/*.sql. Installed on a Playwright page with
// page.route so browser tests never touch the network.
export function createFakeSupabase() {
  const users = new Map(); // token -> user id
  const accounts = new Map(); // user id -> { email, pendingEmail }
  const mails = []; // e-mails Supabase would have sent: { to, kind, uid }
  const google = { owner: null, email: 'player@gmail.com', rateLimited: false }; // the one Google identity the fake knows about
  const supportedRules = [3, 4]; // mirrors snails_rules on the server
  const dailyRows = new Map(); // `${day}/${uid}` -> row
  const profiles = new Map(); // uid -> { name, look }
  const purchases = new Map(); // uid -> Set(item)
  const checkouts = []; // calls to the buy function
  const awards = []; // { season, uid, kind, place, item, value }
  const ratings = new Map(); // `${season}/${uid}` -> { rating, games, wins, losses, draws, updated }
  const seasonKey = () => { const d = new Date(); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
  const rateMatch = (m) => {
    if (m.rated || m.status !== 'finished' || !m.guest) return;
    const k = (u) => `${seasonKey()}/${u}`;
    for (const u of [m.host, m.guest]) if (!ratings.has(k(u))) ratings.set(k(u), { uid: u, rating: 1000, games: 0, wins: 0, losses: 0, draws: 0, updated: 0 });
    const h = ratings.get(k(m.host)), g = ratings.get(k(m.guest));
    const eh = 1 / (1 + Math.pow(10, (g.rating - h.rating) / 400));
    const sh = m.winner === 0 ? 1 : m.winner === 1 ? 0 : 0.5;
    const d = Math.round(32 * (sh - eh));
    h.rating += d; g.rating -= d; h.games++; g.games++; h.updated = g.updated = ++seq;
    if (m.winner === 0) { h.wins++; g.losses++; } else if (m.winner === 1) { g.wins++; h.losses++; } else { h.draws++; g.draws++; }
    m.rated = true;
  };
  const FREE = ['spiral', 'stripes', 'dots', 'none', 'cap', 'party'];
  const statsFor = (uid) => {
    const fin = [...matches.values()].filter((m) => m.status === 'finished' && m.guest && (m.host === uid || m.guest === uid));
    const wins = fin.filter((m) => (m.host === uid && m.winner === 0) || (m.guest === uid && m.winner === 1)).length;
    const losses = fin.filter((m) => (m.host === uid && m.winner === 1) || (m.guest === uid && m.winner === 0)).length;
    const mine = [...dailyRows.values()].filter((r) => r.uid === uid);
    return { matches: fin.length, wins, losses, dailyBest: Math.max(0, ...mine.map((r) => r.score)), dailyPlays: mine.reduce((a, r) => a + r.attempts, 0) };
  };
  const unlockedFor = (uid) => { const st = statsFor(uid), u = [...FREE]; if (st.dailyBest >= 250) u.push('stars'); if (st.wins >= 5) u.push('flame'); if (st.wins >= 10) u.push('crown'); if (st.dailyBest >= 350) u.push('viking'); return u.concat([...(purchases.get(uid) || [])], awards.filter((a) => a.uid === uid).map((a) => a.item)); };
  const cleanLook = (look, u) => ({ shell: u.includes(look?.shell) ? look.shell : 'spiral', hat: u.includes(look?.hat) ? look.hat : 'none' });
  const myLook = (uid) => profiles.get(uid)?.look || {};
  const matches = new Map();
  const turns = new Map(); // match id -> [turns]
  const events = [];
  const pushes = []; // saved subscriptions
  const notifies = []; // calls to the notify-turn function
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const err = (message, status = 400) => ({ status, body: { message } });
  const view = (m, uid) => ({ ...m, turns: undefined, my_team: m.host === uid ? 0 : m.guest === uid ? 1 : null });

  const series = new Map();
  const seriesView = (sid, uid) => {
    const s = series.get(sid); if (!s) return null;
    const me = s.host === uid;
    return { id: s.id, best_of: s.best_of, match_no: s.match_no, status: s.status, current_match: s.current_match,
      won_by_me: !!s.winner_user && s.winner_user === uid, wins_me: me ? s.wins_host : s.wins_guest, wins_them: me ? s.wins_guest : s.wins_host };
  };
  const mview = (m, uid) => ({ ...view(m, uid), looks: m.looks || {}, match_no: m.match_no || 1, series: m.series_id ? seriesView(m.series_id, uid) : null });
  const newMatch = (fields) => { const m = { id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), turn_team: 0, turn_count: 0, tick_count: 0, winner: null, last_hash: null, guest: null, status: 'open', match_no: 1, series_id: null, ...fields }; matches.set(m.id, m); turns.set(m.id, []); return m; };
  const nextMatch = (s, prev) => {
    const n = newMatch({ rules_version: prev.rules_version, seed: 4321 + s.match_no, config: prev.config, names: { 0: prev.names[1], 1: prev.names[0] }, looks: { 0: prev.looks?.[1] || {}, 1: prev.looks?.[0] || {} }, host: prev.guest, guest: prev.host, status: 'playing', series_id: s.id, match_no: s.match_no + 1 });
    s.match_no = n.match_no; s.current_match = n.id; s.updated_at = new Date().toISOString();
    return n;
  };
  const afterFinish = (m) => {
    rateMatch(m);
    const s = series.get(m.series_id); if (!s || s.status === 'finished' || s.current_match !== m.id) return;
    if (m.winner != null) { const w = m.winner === 0 ? m.host : m.guest; if (w === s.host) s.wins_host++; else s.wins_guest++; }
    const needed = Math.floor(s.best_of / 2) + 1;
    if (s.wins_host >= needed || s.wins_guest >= needed || (m.winner == null && s.best_of === 1)) {
      s.status = 'finished'; s.winner_user = s.wins_host >= needed ? s.host : s.wins_guest >= needed ? s.guest : null;
    } else nextMatch(s, m);
    s.updated_at = new Date().toISOString();
  };
  const myTeam = (m, uid) => (m.host === uid ? 0 : m.guest === uid ? 1 : null);

  const rpc = {
    snails_supported_rules() { return supportedRules; },
    snails_profile(uid) { const p = profiles.get(uid); const r = ratings.get(`${seasonKey()}/${uid}`); return { name: p?.name || '', look: p?.look || {}, stats: { ...statsFor(uid), rating: r?.rating ?? 1000, seasonGames: r?.games ?? 0, season: seasonKey() }, unlocked: unlockedFor(uid), canBuy: !!accounts.get(uid)?.email, purchases: [...(purchases.get(uid) || [])], awards: awards.filter((a) => a.uid === uid).map((a) => ({ season: a.season, kind: a.kind, place: a.place, item: a.item, value: a.value })) }; },
    snails_season(uid) {
      const sk = seasonKey();
      const rows = [...ratings.values()].filter((r, i, all) => [...ratings.keys()][i].startsWith(sk + '/')).sort((a, b) => b.rating - a.rating || a.updated - b.updated);
      const me = rows.find((r) => r.uid === uid);
      const byUser = new Map();
      for (const d of dailyRows.values()) { const e = byUser.get(d.uid) || { uid: d.uid, name: d.name, pts: 0, days: 0 }; e.pts += d.score; e.days++; e.name = d.name; byUser.set(d.uid, e); }
      const drows = [...byUser.values()].sort((a, b) => b.pts - a.pts);
      const dme = drows.find((r) => r.uid === uid);
      return {
        season: sk, ends_at: '2026-10-01', days_left: 26,
        rank: { total: rows.length, top: rows.slice(0, 10).map((r) => ({ name: profiles.get(r.uid)?.name || 'Snäcka', rating: r.rating, games: r.games, me: r.uid === uid })),
          me: me ? { rating: me.rating, games: me.games, wins: me.wins, losses: me.losses, draws: me.draws, rank: rows.indexOf(me) + 1 } : null },
        daily: { total: drows.length, top: drows.slice(0, 10).map((r) => ({ name: r.name, points: r.pts, days: r.days, me: r.uid === uid })),
          me: dme ? { points: dme.pts, days: dme.days, rank: drows.indexOf(dme) + 1 } : null },
        last: { season: '2026-Q2', awards: awards.filter((a) => a.season === '2026-Q2').map((a) => ({ kind: a.kind, place: a.place, name: profiles.get(a.uid)?.name || a.uid, value: a.value, me: a.uid === uid })) },
      };
    },
    snails_profile_set(uid, a) {
      const look = cleanLook(a.p_look, unlockedFor(uid));
      profiles.set(uid, { name: (a.p_name || 'Snäcka').slice(0, 24), look });
      for (const m of matches.values()) if (m.status !== 'finished') { if (m.host === uid) m.looks = { ...(m.looks || {}), 0: look }; if (m.guest === uid) m.looks = { ...(m.looks || {}), 1: look }; }
      return rpc.snails_profile(uid);
    },
    snails_daily_submit(uid, a) {
      if (!supportedRules.includes(a.p_rules_version)) throw new Error('rules version not supported');
      if (a.p_score < 0 || a.p_score > 450) throw new Error('score out of range');
      const k = `${a.p_day}/${uid}`;
      const cur = dailyRows.get(k);
      const now = Date.now();
      if (!cur) dailyRows.set(k, { day: a.p_day, uid, name: a.p_name || 'Snäcka', score: a.p_score, weapon: a.p_weapon, recording: a.p_recording, attempts: 1, updated: now });
      else { cur.attempts++; cur.name = a.p_name || cur.name; if (a.p_score > cur.score) { cur.score = a.p_score; cur.recording = a.p_recording; cur.updated = now; } }
      const row = dailyRows.get(k);
      const rows = [...dailyRows.values()].filter((r) => r.day === a.p_day).sort((x, y) => y.score - x.score || x.updated - y.updated);
      return { score: a.p_score, best: row.score, attempts: row.attempts, rank: rows.indexOf(row) + 1, total: rows.length, improved: row.score === a.p_score };
    },
    snails_daily_board(uid, a) {
      const rows = [...dailyRows.values()].filter((r) => r.day === a.p_day).sort((x, y) => y.score - x.score || x.updated - y.updated);
      const mine = rows.find((r) => r.uid === uid);
      return { day: a.p_day, total: rows.length, top: rows.slice(0, 10).map((r) => ({ name: r.name, score: r.score, me: r.uid === uid })), me: mine ? { score: mine.score, attempts: mine.attempts, rank: rows.indexOf(mine) + 1 } : null };
    },
    snails_create_match(uid, a) {
      if (!supportedRules.includes(a.p_rules_version)) throw Object.assign(new Error(`rules version ${a.p_rules_version} is not supported`), { status: 400, body: { message: `rules version ${a.p_rules_version} is not supported` } });
      const s = { id: uuid(), host: uid, guest: null, names: { 0: a.p_name || 'Värd' }, best_of: a.p_best_of ?? 3, wins_host: 0, wins_guest: 0, match_no: 1, current_match: null, status: 'open', winner_user: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      series.set(s.id, s);
      const m = newMatch({ rules_version: a.p_rules_version, seed: a.p_seed, config: a.p_config, names: { ...s.names }, host: uid, looks: { 0: myLook(uid) }, series_id: s.id });
      s.current_match = m.id;
      return mview(m, uid);
    },
    snails_join_match(uid, a) {
      const m = matches.get(a.p_match); if (!m) throw err('no such match');
      if (m.host === uid || m.guest === uid) return mview(m, uid);
      if (m.guest) throw err('match is full');
      const nm = a.p_name || 'Gäst';
      m.guest = uid; m.looks = { ...(m.looks || {}), 1: myLook(uid) }; m.status = 'playing'; m.names = { ...m.names, 1: nm }; m.updated_at = new Date().toISOString();
      const s = series.get(m.series_id); if (s && !s.guest) { s.guest = uid; s.status = 'playing'; s.names = { ...s.names, 1: nm }; }
      return mview(m, uid);
    },
    snails_get_match(uid, a) {
      const m = matches.get(a.p_match); if (!m) throw err('no such match');
      if (m.status !== 'open' && m.host !== uid && m.guest !== uid) throw err('not your match');
      return { ...mview(m, uid), turns: turns.get(m.id).map((t) => ({ ...t })) };
    },
    snails_my_matches(uid) {
      return [...matches.values()].filter((m) => (m.host === uid || m.guest === uid) && (!m.series_id || series.get(m.series_id)?.current_match === m.id)).map((m) => mview(m, uid));
    },
    snails_submit_turn(uid, a) {
      const m = matches.get(a.p_match); if (!m) throw err('no such match');
      const my = myTeam(m, uid);
      if (my == null) throw err('not your match');
      if (m.status === 'finished') throw err('match is finished');
      if (m.status === 'open' && !(my === 0 && a.p_turn_no === 1)) throw err('waiting for an opponent');
      if (m.turn_team !== my) throw err('not your turn');
      if (a.p_turn_no !== m.turn_count + 1) throw err('turn out of order');
      if (a.p_start_tick !== m.tick_count) throw err('wrong start tick');
      if (a.p_end_tick <= a.p_start_tick) throw err('bad tick range');
      turns.get(m.id).push({ turn_no: a.p_turn_no, team: my, start_tick: a.p_start_tick, end_tick: a.p_end_tick, inputs: a.p_inputs, state_hash: a.p_state_hash });
      m.turn_count = a.p_turn_no; m.tick_count = a.p_end_tick; m.turn_team = 1 - my; m.last_hash = a.p_state_hash;
      if (a.p_finished) { m.status = 'finished'; m.winner = a.p_winner; }
      m.updated_at = new Date().toISOString();
      if (a.p_finished) afterFinish(m);
      return mview(m, uid);
    },
    snails_resign(uid, a) {
      const m = matches.get(a.p_match); if (!m) throw err('no such match');
      const my = myTeam(m, uid); if (my == null) throw err('not your match');
      if (m.status === 'finished') return mview(m, uid);
      if (m.status === 'open') { series.delete(m.series_id); matches.delete(m.id); turns.delete(m.id); return null; }
      m.status = 'finished'; m.winner = 1 - my; m.updated_at = new Date().toISOString();
      afterFinish(m);
      return mview(m, uid);
    },
    snails_claim_timeout(uid, a) {
      const m = matches.get(a.p_match); if (!m) throw err('no such match');
      const my = myTeam(m, uid); if (my == null) throw err('not your match');
      if (m.status !== 'playing') throw err('match is not in play');
      if (m.turn_team === my) throw err('it is your turn');
      if (Date.now() - new Date(m.updated_at).getTime() < 14 * 86400000) throw err('opponent still has time');
      m.status = 'finished'; m.winner = my; m.updated_at = new Date().toISOString();
      afterFinish(m);
      return mview(m, uid);
    },
    snails_rematch(uid, a) {
      const m = matches.get(a.p_match); if (!m) throw err('no such match');
      const my = myTeam(m, uid); if (my == null) throw err('not your match');
      const s = m.series_id ? series.get(m.series_id) : null;
      if (s && s.status !== 'finished') return mview(matches.get(s.current_match), uid);
      if (!s && m.status !== 'finished') throw err('match is not finished');
      const other = my === 0 ? m.guest : m.host; if (!other) throw err('no opponent');
      const names = { 0: m.names[my], 1: m.names[1 - my] };
      const ns = { id: uuid(), host: uid, guest: other, names, best_of: s ? s.best_of : 1, wins_host: 0, wins_guest: 0, match_no: 1, current_match: null, status: 'playing', winner_user: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      series.set(ns.id, ns);
      const n = newMatch({ rules_version: a.p_rules_version, seed: 4321, config: m.config, names, host: uid, looks: { 0: myLook(uid), 1: myLook(other) }, guest: other, status: 'playing', series_id: ns.id });
      ns.current_match = n.id;
      return mview(n, uid);
    },
    snails_extend_series(uid, a) {
      const m = matches.get(a.p_match); if (!m || !m.series_id) throw err('no such match');
      if (myTeam(m, uid) == null) throw err('not your match');
      const s = series.get(m.series_id);
      if (s.status !== 'finished') throw err('series is not finished');
      if (s.best_of >= a.p_best_of) throw err('series is already that long');
      const needed = Math.floor(a.p_best_of / 2) + 1;
      if (s.wins_host >= needed || s.wins_guest >= needed) throw err('series would already be decided');
      s.best_of = a.p_best_of; s.status = 'playing'; s.winner_user = null;
      const n = nextMatch(s, matches.get(s.current_match));
      return mview(n, uid);
    },
    snails_delete_match(uid, a) {
      const m = matches.get(a.p_match); if (!m || (m.host !== uid && m.guest !== uid)) return null;
      if (m.series_id) { for (const [id, x] of matches) if (x.series_id === m.series_id) { matches.delete(id); turns.delete(id); } series.delete(m.series_id); }
      else { matches.delete(m.id); turns.delete(m.id); }
      return null;
    },
    snails_save_push(uid, a) { pushes.push({ uid, endpoint: a.p_endpoint, lang: a.p_lang }); return null; },
    snails_remove_push(uid, a) { const i = pushes.findIndex((p) => p.endpoint === a.p_endpoint && p.uid === uid); if (i >= 0) pushes.splice(i, 1); return null; },
  };

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Cache-Control': 'no-store' };
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    try {
      if (url.pathname.startsWith('/auth/v1/')) {
        const token = (req.headers()['authorization'] || '').replace('Bearer ', '');
        const uid = users.get(token);
        const sub = url.pathname.slice('/auth/v1/'.length);
        const body = JSON.parse(req.postData() || '{}');
        const session = (id) => { const tok = 'tok-' + id + '-' + (++seq); users.set(tok, id); return { access_token: tok, refresh_token: 'ref-' + id, expires_in: 3600, user: { id } }; };
        if (sub === 'signup' && req.method() === 'POST') { const id = uuid(); accounts.set(id, { email: null, pendingEmail: null }); return json(200, session(id)); }
        if (sub.startsWith('token') && req.method() === 'POST') { const id = String(body.refresh_token || '').replace(/^ref-/, ''); if (!accounts.has(id)) return json(400, { error: 'invalid refresh token' }); return json(200, session(id)); }
        if (sub === 'user' && req.method() === 'GET') { if (!uid) return json(401, { msg: 'not signed in' }); const a = accounts.get(uid); return json(200, { id: uid, email: a.email || undefined, new_email: a.pendingEmail || undefined, is_anonymous: !a.email, identities: a.provider ? [{ provider: a.provider }] : [] }); }
        // Google: the browser is sent to a fake consent page that comes straight back with the result
        const back = (redirect, frag) => route.fulfill({ status: 302, headers: { ...cors, Location: redirect + frag } });
        if (sub.startsWith('user/identities/authorize') && req.method() === 'GET') {
          if (!uid) return json(401, { msg: 'not signed in' });
          return json(200, { url: `${url.origin}/auth/v1/fake-google?link=${uid}&redirect_to=${encodeURIComponent(url.searchParams.get('redirect_to'))}` });
        }
        // (a redirect hop to another supabase URL is not routed by Playwright, so /authorize answers directly)
        if ((sub.startsWith('authorize') || sub.startsWith('fake-google')) && req.method() === 'GET') {
          const redirect = url.searchParams.get('redirect_to'), link = url.searchParams.get('link');
          if (link) {
            if (google.owner && google.owner !== link) return back(redirect, '#error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked+to+another+user');
            // Supabase refuses to link when the Google e-mail belongs to another user, and puts the error in the query string
            const other = [...accounts.entries()].find(([id, a]) => id !== link && a.email === google.email);
            if (other) return route.fulfill({ status: 302, headers: { ...cors, Location: redirect + '?error=invalid_request&error_code=email_exists&error_description=A+user+with+this+email+address+has+already+been+registered' } });
            const a = accounts.get(link); a.email = google.email; a.provider = 'google'; google.owner = link;
            const tok = 'tok-' + link + '-' + (++seq); users.set(tok, link);
            return back(redirect, `#access_token=${tok}&refresh_token=ref-${link}&expires_in=3600&token_type=bearer`);
          }
          if (!google.owner) {
            const existing = [...accounts.entries()].find(([, a]) => a.email === google.email);
            if (existing) { existing[1].provider = 'google'; google.owner = existing[0]; }
            else { const id = uuid(); accounts.set(id, { email: google.email, pendingEmail: null, provider: 'google' }); google.owner = id; }
          }
          const tok = 'tok-' + google.owner + '-' + (++seq); users.set(tok, google.owner);
          return back(redirect, `#access_token=${tok}&refresh_token=ref-${google.owner}&expires_in=3600&token_type=bearer`);
        }
        if (sub === 'verify' && req.method() === 'POST') {
          const mail = mails.find((m) => m.tokenHash === body.token_hash && m.kind === body.type && !m.spent);
          if (!mail) return json(403, { msg: 'Email link is invalid or has expired', error_code: 'otp_expired' });
          mail.spent = true;
          const a = accounts.get(mail.uid);
          if (mail.kind === 'email_change') { a.email = a.pendingEmail; a.pendingEmail = null; }
          return json(200, session(mail.uid));
        }
        if (sub.startsWith('user') && req.method() === 'PUT') {
          if (!uid) return json(401, { msg: 'not signed in' });
          if ([...accounts.values()].some((a) => a.email === body.email)) return json(422, { msg: 'A user with this email address has already been registered' });
          if (google.rateLimited) return json(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
          accounts.get(uid).pendingEmail = body.email; mails.push({ to: body.email, kind: 'email_change', uid, redirect: url.searchParams.get('redirect_to'), tokenHash: 'th-' + (++seq) });
          return json(200, { id: uid, new_email: body.email, is_anonymous: true });
        }
        if (sub.startsWith('otp') && req.method() === 'POST') {
          const owner = [...accounts.entries()].find(([, a]) => a.email === body.email);
          if (!owner) return json(422, { msg: 'Signups not allowed for otp' });
          if (google.rateLimited) return json(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
          mails.push({ to: body.email, kind: 'magiclink', uid: owner[0], redirect: url.searchParams.get('redirect_to'), tokenHash: 'th-' + (++seq) });
          return json(200, {});
        }
        return json(404, { msg: 'no such auth endpoint ' + sub });
      }
      if (url.pathname === '/rest/v1/snails_events') { events.push(...JSON.parse(req.postData() || '[]')); return json(201, []); }
      if (url.pathname === '/functions/v1/buy') {
        const token = (req.headers()['authorization'] || '').replace('Bearer ', '');
        const uid = users.get(token);
        if (!uid) return json(401, { error: 'not signed in' });
        const { item } = JSON.parse(req.postData() || '{}');
        if (!['gold', 'tophat'].includes(item)) return json(400, { error: 'unknown item' });
        if (!accounts.get(uid)?.email) return json(403, { error: 'email required' });
        checkouts.push({ uid, item });
        // Checkout comes straight back to the page's own path (the buy function uses its GAME URL for this)
        const back = new URL(req.headers()['referer'] || req.headers()['origin'] || 'http://localhost');
        return json(200, { url: `${back.origin}${back.pathname.replace(/[^/]*$/, '')}?bought=${item}`, id: 'cs_test_' + checkouts.length });
      }
      if (url.pathname === '/functions/v1/notify-turn') {
        const token = (req.headers()['authorization'] || '').replace('Bearer ', '');
        if (!users.get(token)) return json(401, { error: 'not signed in' });
        notifies.push({ uid: users.get(token), ...JSON.parse(req.postData() || '{}') });
        return json(200, { sent: 1 });
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').pop();
        const token = (req.headers()['authorization'] || '').replace('Bearer ', '');
        const uid = users.get(token);
        if (!uid) return json(401, { message: 'not signed in' });
        if (!rpc[name]) return json(404, { message: 'no such function ' + name });
        const args = JSON.parse(req.postData() || '{}');
        return json(200, rpc[name](uid, args));
      }
      return json(404, { message: 'unhandled ' + url.pathname });
    } catch (e) {
      if (e.status) return json(e.status, e.body);
      return json(500, { message: String(e.message || e) });
    }
  }

  // What the link in an e-mail does: confirms the address (email_change) or signs in (magiclink).
  // Returns the URL fragment Supabase would redirect the browser back with.
  function clickMail(mail) {
    const a = accounts.get(mail.uid);
    if (mail.kind === 'email_change') { a.email = a.pendingEmail; a.pendingEmail = null; }
    const tok = 'tok-' + mail.uid + '-' + (++seq); users.set(tok, mail.uid);
    return `#access_token=${tok}&refresh_token=ref-${mail.uid}&expires_in=3600&token_type=bearer&type=${mail.kind}`;
  }
  return { handle, matches, turns, series, events, pushes, notifies, accounts, mails, clickMail, google, dailyRows, profiles, ratings, purchases, checkouts, awards, grant: (uid, item) => { if (!purchases.has(uid)) purchases.set(uid, new Set()); purchases.get(uid).add(item); }, install: (page) => page.route('**/*.supabase.co/**', handle) };
}
