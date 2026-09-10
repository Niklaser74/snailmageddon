#!/usr/bin/env node
// Moves Snäckmageddon's data from the shared Supabase project (nissebus) to the
// snails project. Selective: accounts that carry play data (matches, daily
// shots, ratings, purchases, awards, push) or are linked to an e-mail/Google
// identity are copied with the same ids AND their sessions/refresh tokens, so
// those devices stay signed in. Empty anonymous accounts are left behind (the
// client quietly makes a new one). Analytics events are copied too.
//
//   OLD_DB_URL=postgres://postgres.<ref>:...@...pooler.supabase.com:5432/postgres \
//   NEW_DB_URL=postgres://...                                                     \
//   node scripts/migrate-supabase.mjs [--dry-run] [--verify] [--skip-events]
//
// Connection strings: Supabase dashboard → Connect → Session pooler, user
// postgres. They are read from the environment and never printed. The VAPID
// private key is moved Vault → Vault inside this process and never printed.
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const verifyOnly = args.has('--verify');
const skipEvents = args.has('--skip-events');
const OLD = process.env.OLD_DB_URL, NEW = process.env.NEW_DB_URL;
if (!OLD || !NEW) { console.error('Set OLD_DB_URL and NEW_DB_URL (see the header of this file).'); process.exit(2); }

const conn = (url) => new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const old = conn(OLD), neu = conn(NEW);

// Which users travel: referenced by play data, or linked (not anonymous) with a snails profile.
const PLAYERS_SQL = `
  with players as (
    select host as u from public.snails_matches union select guest from public.snails_matches
    union select host from public.snails_series union select guest from public.snails_series union select winner_user from public.snails_series
    union select player from public.snails_turns
    union select user_id from public.snails_daily
    union select user_id from public.snails_ratings
    union select user_id from public.snails_purchases
    union select user_id from public.snails_season_awards
    union select user_id from public.snails_push_subscriptions
    union select p.user_id from public.snails_profiles p join auth.users u on u.id = p.user_id where not u.is_anonymous
  )
  select array_agg(distinct u) as ids from players where u is not null`;

// Copy order follows the foreign keys: users → identities/sessions → refresh
// tokens; series → matches → turns. `where` may use $1 = the player ids
// (uuid[]; text[] for refresh_tokens, whose user_id column is varchar).
const TABLES = [
  { t: 'auth.users', where: 'id = any($1::uuid[])' },
  { t: 'auth.identities', where: 'user_id = any($1::uuid[])' },
  { t: 'auth.sessions', where: 'user_id = any($1::uuid[])' },
  { t: 'auth.refresh_tokens', where: 'user_id = any($1::text[]) and revoked = false' },
  { t: 'public.snails_profiles', where: 'user_id = any($1::uuid[])' },
  { t: 'public.snails_series', where: 'true' },
  { t: 'public.snails_matches', where: 'true' },
  { t: 'public.snails_turns', where: 'true' },
  { t: 'public.snails_daily', where: 'true' },
  { t: 'public.snails_ratings', where: 'true' },
  { t: 'public.snails_purchases', where: 'true' },
  { t: 'public.snails_season_awards', where: 'true' },
  { t: 'public.snails_push_subscriptions', where: 'true' },
  { t: 'public.snails_events', where: 'true', skip: skipEvents },
];
const BATCH = 500;

// Columns a table has, minus identity/serial/generated ones (the target assigns those).
async function columns(client, table) {
  const [schema, name] = table.split('.');
  const { rows } = await client.query(
    `select column_name, data_type, is_identity, is_generated, column_default from information_schema.columns
      where table_schema = $1 and table_name = $2 order by ordinal_position`, [schema, name]);
  return rows
    .filter((r) => r.is_identity !== 'YES' && r.is_generated === 'NEVER' && !(r.column_default || '').startsWith('nextval('))
    .map((r) => ({ name: r.column_name, json: r.data_type === 'json' || r.data_type === 'jsonb' }));
}
const q = (c) => `"${c}"`;
// node-postgres would send a JS array as a Postgres array, which is wrong for a
// jsonb column holding a JSON array (snails_turns.inputs) — so JSON columns are
// always serialised by hand.
const param = (col, v) => (v === null || v === undefined ? null : col.json ? JSON.stringify(v) : v);

async function copyTable({ t, where, skip }, players) {
  if (skip) return console.log(`${t.padEnd(34)} skipped`);
  const args = where.includes('$1') ? [players] : [];
  const oldCols = await columns(old, t);
  const newCols = new Set((await columns(neu, t)).map((c) => c.name));
  const cols = oldCols.filter((c) => newCols.has(c.name));
  const names = cols.map((c) => q(c.name)).join(', ');
  const { rows } = await old.query(`select ${names} from ${t} where ${where}`, args);
  if (dryRun) return console.log(`${t.padEnd(34)} ${String(rows.length).padStart(6)} rows would be copied (${cols.length} columns)`);
  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [], ph = [];
    chunk.forEach((r, k) => {
      ph.push(`(${cols.map((_, j) => `$${k * cols.length + j + 1}`).join(', ')})`);
      cols.forEach((c) => values.push(param(c, r[c.name])));
    });
    const res = await neu.query(`insert into ${t} (${names}) values ${ph.join(', ')} on conflict do nothing`, values);
    copied += res.rowCount;
  }
  console.log(`${t.padEnd(34)} ${String(copied).padStart(6)} / ${rows.length} rows copied`);
}

async function moveVapidKey() {
  const { rows } = await old.query(`select decrypted_secret from vault.decrypted_secrets where name = 'snails_vapid_private'`);
  if (!rows.length) return console.log('vault: snails_vapid_private not found in the old project (nothing moved)');
  const { rows: existing } = await neu.query(`select 1 from vault.secrets where name = 'snails_vapid_private'`);
  if (existing.length) return console.log('vault: snails_vapid_private already exists in the new project (left as is)');
  if (dryRun) return console.log('vault: snails_vapid_private would be created in the new project');
  await neu.query(`select vault.create_secret($1, 'snails_vapid_private', 'VAPID private key (JWK) for Snigelpost push')`, [rows[0].decrypted_secret]);
  console.log('vault: snails_vapid_private created in the new project');
}

async function verify(players) {
  let bad = 0;
  for (const { t, where, skip } of TABLES) {
    if (skip) continue;
    const args = where.includes('$1') ? [players] : [];
    const a = (await old.query(`select count(*)::int as n from ${t} where ${where}`, args)).rows[0].n;
    const b = (await neu.query(`select count(*)::int as n from ${t} where ${where}`, args)).rows[0].n;
    const ok = b >= a;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'DIFF'} ${t.padEnd(34)} old ${String(a).padStart(6)}  new ${String(b).padStart(6)}`);
  }
  const { rows: [{ n }] } = await neu.query(`select count(*)::int as n from vault.secrets where name = 'snails_vapid_private'`);
  console.log(`${n ? 'ok  ' : 'DIFF'} vault.snails_vapid_private ${n ? 'present' : 'MISSING'}`);
  if (!n) bad++;
  return bad;
}

let neuOpen = false;
try {
  console.log('connecting to the old project…');
  await old.connect();
  console.log('connecting to the new project…');
  await neu.connect();
  neuOpen = true;
  await old.query('begin isolation level repeatable read read only'); // one consistent snapshot of the old project
  const { rows: [{ ids }] } = await old.query(PLAYERS_SQL);
  const players = ids || [];
  console.log(`${players.length} accounts travel (play data or linked identity)`);
  if (verifyOnly) {
    const bad = await verify(players);
    await old.query('rollback');
    process.exit(bad ? 1 : 0);
  }
  if (!dryRun) await neu.query('begin');
  for (const spec of TABLES) await copyTable(spec, players);
  await moveVapidKey();
  if (!dryRun) { await neu.query('commit'); console.log('committed'); }
  await old.query('rollback');
} catch (e) {
  if (neuOpen) { try { await neu.query('rollback'); } catch { /* not in a transaction */ } }
  console.error('FAILED, nothing committed in the new project:', e.code ? `[${e.code}]` : '', e.message || (e.errors || []).map((x) => x.message).join('; '));
  process.exitCode = 1;
} finally {
  await old.end().catch(() => {});
  await neu.end().catch(() => {});
}
