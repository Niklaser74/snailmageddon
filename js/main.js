import { Game, WEAPONS, TICK, RULES_VERSION, rulesSupported, DEFAULT_RULES, TURN_TIMES, SUDDEN_DEATHS, normalizeRules } from './game.js';
import { snigelpost } from './online.js';
import { online } from './supa.js';
import { daily, dailyConfig, dayKey, weaponFor } from './daily.js';
import { SHELLS, HATS, unlockedFor, normalizeLook } from './cosmetics.js';
import { season, tierFor } from './season.js';
import { pollGamepad } from './gamepad.js';
import { push } from './push.js';
import { SNAIL_STYLES, TEAM_COLORS, drawSnail } from './snails.js';
import { unlockAudio, sfx } from './audio.js';
import { LANGS, t, fmt, setLang, getLang, detectLang, applyDom } from './i18n.js';
import { initAnalytics, track, setAnalyticsLang, installErrorReporting } from './analytics.js';
import { platform } from './platform.js';
import { setMuted, isMuted, setVolume } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const hud = $('hud');
const menu = $('menu');
const help = $('help');
const gameover = $('gameover');

const LS_KEY = 'snackmageddon.settings';

let game = null;
let lastTs = 0;
let hudLast = 0;
let tutorial = null; // active first-match guide, see startTutorial()
let onlineMatch = null; // Snigelpost: { id, myTeam, startTick, match, pending }
let replayUntil = 0; // >0 while the opponent's turn is being shown at speed
let pollTimer = null;
let renderAccount = () => {}; // set up once Snigelpost is available
let dailyGame = null; // { key } while the shot of the day is being played
let profileState = { unlocked: [], stats: {}, online: false, canBuy: false }; // filled in once settings are loaded
const waiting = $('waiting');

// ---------- settings ----------
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
const DEFAULT_STYLE = 'cartoon'; // vald standarddesign: Tecknad (Worms-stil)
const settings = Object.assign({ teams: 2, per: 3, style: DEFAULT_STYLE, rows: [], lang: null, tutorialDone: false, ...DEFAULT_RULES, volume: 0.8, muted: false }, loadSettings());
Object.assign(settings, normalizeRules(settings));
settings.look = normalizeLook(settings.look);
if (!['auto', 'garden', 'beach', 'jungle'].includes(settings.theme)) settings.theme = 'auto';
settings.stats = settings.stats || {}; // last known stats from the server, for unlocks when offline
profileState = { unlocked: unlockedFor(settings.stats, settings.extraUnlocked || []), stats: settings.stats, online: false };

// ---------- sound ----------
setVolume(settings.volume);
setMuted(settings.muted);
const muteBtn = $('btn-mute');
function renderMute() {
  muteBtn.textContent = settings.muted ? '🔇' : '🔊';
  muteBtn.classList.toggle('off', settings.muted);
  muteBtn.setAttribute('aria-label', t(settings.muted ? 'aria.unmute' : 'aria.mute'));
}
function toggleMute() {
  settings.muted = !settings.muted;
  setMuted(settings.muted);
  saveSettings(settings);
  renderMute();
}
muteBtn.addEventListener('click', toggleMute);
$('opt-volume').value = Math.round(settings.volume * 100);
$('opt-volume').addEventListener('input', () => {
  settings.volume = +$('opt-volume').value / 100;
  setVolume(settings.volume);
  if (settings.muted && settings.volume > 0) { settings.muted = false; setMuted(false); renderMute(); }
  saveSettings(settings);
});
$('opt-volume').addEventListener('change', () => { unlockAudio(); sfx.crate(); });

// ---------- language ----------
setLang(settings.lang || detectLang());
const langSel = $('opt-lang');
for (const [id, name] of Object.entries(LANGS)) {
  const o = document.createElement('option');
  o.value = id; o.textContent = name;
  langSel.appendChild(o);
}
langSel.value = getLang();

const defaultTeamName = (i, lang = getLang()) => {
  const cur = getLang();
  setLang(lang);
  const name = t('team.' + i);
  setLang(cur);
  return name;
};
const isDefaultTeamName = (name, i) => Object.keys(LANGS).some((l) => defaultTeamName(i, l) === name);

const styleSel = $('opt-style');
function renderStyleOptions() {
  const cur = styleSel.value || settings.style;
  if (document.getElementById('pick-shell')) queueMicrotask(renderProfile);
  styleSel.innerHTML = '';
  for (const st of SNAIL_STYLES) {
    const o = document.createElement('option');
    o.value = st.id; o.textContent = t('style.' + st.id);
    styleSel.appendChild(o);
  }
  styleSel.value = cur;
}

function applyLanguage() {
  applyDom();
  document.title = t('app.name');
  renderStyleOptions();
  renderRuleOptions();
  renderMute();
  renderAccount();
  renderDaily();
  renderProfile();
  renderSeason();
  // team names that are still the default of some language follow the language switch
  document.querySelectorAll('.team-row').forEach((row, i) => {
    const input = row.querySelector('input');
    if (isDefaultTeamName(input.value.trim(), i)) input.value = defaultTeamName(i);
    row.querySelector('input').setAttribute('aria-label', t('menu.teamName'));
    const sel = row.querySelector('select');
    sel.setAttribute('aria-label', t('menu.player'));
    PLAYER_KINDS.forEach((k, j) => { sel.options[j].textContent = t('menu.player.' + k); });
  });
  for (const b of $('weapons').children) b.title = t('weapon.' + b.dataset.id);
  if ($('offline-hint').dataset.ready) $('offline-hint').textContent = t('menu.offline');
  renderTutorial();
}
langSel.addEventListener('change', () => {
  settings.lang = langSel.value;
  setLang(settings.lang);
  setAnalyticsLang(settings.lang);
  saveSettings(settings);
  applyLanguage();
});

// ---------- usage counter (see supabase/README.md) ----------
initAnalytics(getLang());
installErrorReporting();
track('app_open', {
  installed: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  touch: matchMedia('(pointer: coarse)').matches,
  w: innerWidth, h: innerHeight,
  platform: platform.id,
});
let matchStats = null; // { t0, weapons } for the running match

// ---------- menu ----------
$('opt-teams').value = settings.teams;
$('opt-per').value = settings.per;
$('opt-theme').value = settings.theme;
$('opt-theme').addEventListener('change', () => { settings.theme = $('opt-theme').value; saveSettings(settings); });
// rules: turn time and sudden death
for (const v of TURN_TIMES) $('opt-turntime').append(new Option(t('menu.seconds', { n: v }), v));
for (const v of SUDDEN_DEATHS) $('opt-sudden').append(new Option(v === 0 ? t('menu.suddenOff') : t('menu.suddenAfter', { n: v }), v));
$('opt-turntime').value = settings.turnTime;
$('opt-sudden').value = settings.suddenDeath;
function renderRuleOptions() {
  [...$('opt-turntime').options].forEach((o) => { o.textContent = t('menu.seconds', { n: +o.value }); });
  [...$('opt-sudden').options].forEach((o) => { o.textContent = +o.value === 0 ? t('menu.suddenOff') : t('menu.suddenAfter', { n: +o.value }); });
}
function readRules() {
  const r = normalizeRules({ turnTime: $('opt-turntime').value, suddenDeath: $('opt-sudden').value });
  Object.assign(settings, r);
  return r;
}
renderStyleOptions();
styleSel.value = settings.style;

const PLAYER_KINDS = ['human', 'easy', 'normal', 'hard'];
const playerOptions = () => PLAYER_KINDS.map((k) => `<option value="${k}">${t('menu.player.' + k)}</option>`).join('');
function renderTeamRows() {
  const n = +$('opt-teams').value;
  const box = $('team-rows');
  box.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const saved = settings.rows[i] || {};
    const row = document.createElement('div');
    row.className = 'team-row';
    const name = saved.name && !isDefaultTeamName(saved.name, i) ? saved.name : defaultTeamName(i);
    row.innerHTML = `
      <div class="swatch" style="background:${TEAM_COLORS[i].hex}"></div>
      <input type="text" maxlength="16" aria-label="${t('menu.teamName')}">
      <select aria-label="${t('menu.player')}">${playerOptions()}</select>`;
    row.querySelector('input').value = name;
    row.querySelector('select').value = saved.ai === true ? 'normal' : saved.ai || (i === 0 ? 'human' : 'normal');
    box.appendChild(row);
  }
}
renderTeamRows();
applyLanguage();
$('opt-teams').addEventListener('change', renderTeamRows);

function readConfig() {
  const rows = [...document.querySelectorAll('.team-row')].map((r, i) => ({
    name: r.querySelector('input').value.trim() || defaultTeamName(i),
    color: TEAM_COLORS[i].hex,
    ai: r.querySelector('select').value === 'human' ? false : r.querySelector('select').value,
  }));
  settings.teams = +$('opt-teams').value;
  settings.per = +$('opt-per').value;
  settings.style = styleSel.value;
  settings.rows = rows;
  const rules = readRules();
  saveSettings(settings);
  for (const r of rows) if (!r.ai) r.look = settings.look;
  return { teams: rows, snailsPerTeam: settings.per, style: settings.style, theme: settings.theme, ...rules };
}

let starting = false;
async function startGame() {
  if (starting) return;
  starting = true;
  try {
    // portals show an ad between matches; audio is muted meanwhile
    if (game || platform.id !== 'web') {
      const wasMuted = isMuted();
      await platform.commercialBreak(() => setMuted(true), () => setMuted(wasMuted));
    }
  } finally { starting = false; }
  unlockAudio();
  const cfg = readConfig();
  // ?seed=1234 gives a reproducible map and match (used by tests and for sharing)
  const seedParam = new URLSearchParams(location.search).get('seed');
  if (seedParam !== null && seedParam !== '') cfg.seed = Number(seedParam) | 0;
  if (game && game.phase !== 'over') reportAbandon();
  dailyGame = null;
  $('go-daily').hidden = true;
  $('btn-again').textContent = t('go.again');
  matchStats = { t0: Date.now(), weapons: {} };
  game = new Game(canvas, cfg, {
    onGameOver: (winner) => {
      track('match_end', {
        turns: game.turnCount,
        durationSec: Math.round((Date.now() - matchStats.t0) / 1000),
        winner: winner ? (winner.ai ? 'ai' : 'human') : 'draw',
        weapons: matchStats.weapons,
      });
      matchStats = null;
      platform.gameplayStop();
      setTimeout(() => {
        $('go-title').textContent = winner ? t('go.win', { name: winner.name }) : t('go.draw');
        gameover.hidden = false;
      }, 2000);
    },
    onTurn: () => { camDrag.active = false; },
    onFire: (g) => { if (matchStats) matchStats.weapons[g.weaponId] = (matchStats.weapons[g.weaponId] || 0) + 1; },
  });
  track('match_start', { teams: cfg.teams.length, per: cfg.snailsPerTeam, humans: cfg.teams.filter((tm) => !tm.ai).length, style: cfg.style });
  platform.gameplayStart();
  window.__game = game;
  buildWeaponBar();
  menu.hidden = true;
  gameover.hidden = true;
  hud.hidden = false;
  lastTs = performance.now();
  acc = 0;
  if (!settings.tutorialDone && cfg.teams.some((tm) => !tm.ai)) startTutorial(); else endTutorial(false);
  tryFullscreen();
}

// ---------- shot of the day ----------
function dailyKey() { return new URLSearchParams(location.search).get('day') || dayKey(); }
function startDaily() {
  unlockAudio();
  const key = dailyKey();
  if (game && game.phase !== 'over' && !dailyGame) reportAbandon();
  matchStats = null;
  dailyGame = { key, t0: Date.now() };
  const cfg = dailyConfig(key, settings.style, { me: playerName() === t('online.defaultName') ? t('daily.you') : playerName(), targets: t('daily.targets') });
  cfg.teams[0].look = settings.look;
  cfg.theme = settings.theme;
  game = new Game(canvas, cfg, {
    onGameOver: async () => {
      const score = game.daily.score;
      track('daily', { day: key, score, weapon: game.daily.weapon, durationSec: Math.round((Date.now() - dailyGame.t0) / 1000) });
      platform.gameplayStop();
      $('go-title').textContent = t('daily.title') + ': ' + t('daily.result', { score });
      $('go-series').hidden = true;
      $('go-daily').hidden = false;
      $('go-daily').textContent = daily.available() ? '…' : t('daily.offline');
      $('btn-again').textContent = t('daily.again');
      $('btn-again').hidden = false;
      setTimeout(() => { gameover.hidden = false; }, 1500);
      if (!daily.available()) return;
      try {
        const r = await daily.submit(key, game, playerName());
        $('go-daily').textContent = (r.improved ? t('daily.improved') + ' ' : '') + t('daily.rank', { rank: r.rank, total: r.total, best: r.best });
        renderDaily();
      } catch (e) { $('go-daily').textContent = t('daily.notSent', { msg: e.message }); }
    },
    onTurn: () => { camDrag.active = false; },
  });
  platform.gameplayStart();
  window.__game = game;
  buildWeaponBar();
  menu.hidden = true; gameover.hidden = true; waiting.hidden = true; help.hidden = true;
  hud.hidden = false;
  lastTs = performance.now(); acc = 0;
  endTutorial(false);
  tryFullscreen();
}
async function renderDaily() {
  const key = dailyKey();
  $('daily-day').textContent = key;
  $('daily-blurb').textContent = t('daily.blurb', { wpn: t('weapon.' + weaponFor(key)).toLowerCase() });
  const board = $('daily-board'), me = $('daily-me'), st = $('daily-status');
  if (!daily.available()) { st.textContent = t('daily.offline'); return; }
  try {
    const b = await daily.board(key);
    board.innerHTML = '';
    b.top.forEach((row) => {
      const li = document.createElement('li');
      li.className = row.me ? 'me' : '';
      li.innerHTML = `<span class="bname"></span><span class="bscore"></span>`;
      li.querySelector('.bname').textContent = row.name;
      li.querySelector('.bscore').textContent = row.score;
      board.appendChild(li);
    });
    me.textContent = b.me ? t('daily.me', { score: b.me.score, rank: b.me.rank, total: b.total }) + ' ' + t('daily.attempts', { n: b.me.attempts }) : '';
    st.textContent = b.total ? '' : t('daily.none');
  } catch (e) { st.textContent = t('online.error', { msg: e.message }); }
}
$('btn-daily').addEventListener('click', startDaily);
if (new URLSearchParams(location.search).get('daily') === '1') { history.replaceState(null, '', location.pathname); setTimeout(startDaily, 0); } // app shortcut; after the module has finished setting up

// ---------- season ----------
function fillBoard(id, rows, render) {
  const box = $(id);
  box.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = r.me ? 'me' : '';
    li.innerHTML = '<span class="bname"></span><span class="bscore"></span>';
    li.querySelector('.bname').textContent = r.name;
    li.querySelector('.bscore').textContent = render(r);
    box.appendChild(li);
  }
}
async function renderSeason() {
  const st = $('season-status');
  if (!season.available()) { st.textContent = t('season.offline'); return; }
  try {
    const s = await season.get();
    $('season-key').textContent = s.season;
    $('season-blurb').textContent = t('season.blurb', { end: s.ends_at, days: s.days_left });
    fillBoard('season-rank', s.rank.top, (r) => `${r.rating} · ${t('tier.' + tierFor(r.rating))}`);
    fillBoard('season-daily', s.daily.top, (r) => `${r.points} p`);
    $('season-rank-me').textContent = s.rank.me ? t('season.rankMe', { tier: t('tier.' + tierFor(s.rank.me.rating)), rating: s.rank.me.rating, rank: s.rank.me.rank, total: s.rank.total, games: s.rank.me.games }) : (s.rank.top.length ? t('season.rankNone') : t('season.empty'));
    $('season-daily-me').textContent = s.daily.me ? t('season.dailyMe', { points: s.daily.me.points, days: s.daily.me.days, rank: s.daily.me.rank, total: s.daily.total }) : (s.daily.top.length ? t('season.dailyNone') : t('season.empty'));
    const last = $('season-last');
    last.innerHTML = '';
    if (s.last?.awards?.length) {
      last.append(t('season.last', { season: s.last.season }) + ' ');
      for (const a of s.last.awards) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = `${a.place === 1 ? '🏆' : a.place === 2 ? '🥈' : '🥉'} ${a.name} · ${t(a.kind === 'rank' ? 'season.kindRank' : 'season.kindDaily')} ${a.value}`; last.appendChild(b); }
    } else if (s.last) last.textContent = t('season.lastNone', { season: s.last.season });
    st.textContent = '';
  } catch (e) { st.textContent = t('online.error', { msg: e.message }); }
}

// ---------- profile: stats and look ----------
function needText(c) {
  if (c.premium) return t('cos.premium');
  if (c.award) return t(c.award === 'rank' ? 'cos.awardRank' : 'cos.awardDaily');
  if (c.need?.wins) return t('cos.needWins', { n: c.need.wins });
  if (c.need?.dailyBest) return t('cos.needDaily', { n: c.need.dailyBest });
  return '';
}
function renderPicker(boxId, items, kind) {
  const box = $(boxId);
  box.innerHTML = '';
  for (const c of items) {
    const locked = !profileState.unlocked.includes(c.id);
    // premium: a buy button when the account can pay (linked e-mail, web build, online)
    const buyable = locked && c.premium && profileState.online && platform.allowPayments;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = c.id;
    b.className = (settings.look[kind] === c.id ? 'sel' : '') + (locked ? ' locked' : '') + (buyable && profileState.canBuy ? ' buy' : '');
    b.disabled = locked && !(buyable && profileState.canBuy);
    b.title = t(`cos.${kind}.${c.id}`) + (locked ? ' – ' + (buyable ? (profileState.canBuy ? t('cos.buy') : t('cos.buyNeedsEmail')) : needText(c)) : '');
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 88;
    const ctx = cv.getContext('2d');
    const look = { ...settings.look, [kind]: c.id };
    if (kind === 'hat') look.shell = 'spiral';
    drawSnail(ctx, settings.style, { x: 46, y: 74, facing: 1, color: TEAM_COLORS[0].hex, t: 0, scale: 1.7, look });
    const label = document.createElement('span');
    label.textContent = locked ? (buyable ? (profileState.canBuy ? '🛒 ' + t('cos.buy') : '🔒 ' + t('cos.buyNeedsEmail')) : '🔒 ' + needText(c)) : t(`cos.${kind}.${c.id}`);
    b.append(cv, label);
    if (!locked) b.addEventListener('click', () => setLook({ ...settings.look, [kind]: c.id }));
    else if (buyable && profileState.canBuy) b.addEventListener('click', () => buyItem(c.id, b));
    box.appendChild(b);
  }
}
function renderProfile() {
  const st = profileState.stats || {};
  const rank = profileState.online && st.rating ? t('profile.rank', { tier: t('tier.' + tierFor(st.rating)), rating: st.rating }) + ' ' : '';
  $('profile-stats').textContent = (profileState.online ? t('profile.stats', { wins: st.wins || 0, losses: st.losses || 0, best: st.dailyBest || 0, plays: st.dailyPlays || 0 }) + ' ' + rank : '') + t('profile.local');
  const aw = $('profile-awards'), awards = profileState.awards || [];
  aw.hidden = !awards.length;
  aw.innerHTML = '';
  if (awards.length) {
    aw.append(t('profile.awards') + ' ');
    for (const a of awards) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = (a.place === 1 ? '🏆 ' : a.place === 2 ? '🥈 ' : '🥉 ') + t(a.kind === 'rank' ? 'award.rank' : 'award.daily', { season: a.season, place: a.place, value: a.value }); aw.appendChild(b); }
  }
  renderPicker('pick-shell', SHELLS, 'shell');
  renderPicker('pick-hat', HATS, 'hat');
}
async function loadProfile() {
  if (!snigelpost.available()) { renderProfile(); return; }
  try {
    const p = await snigelpost.profile();
    profileState = { unlocked: p.unlocked, stats: p.stats, online: true, canBuy: !!p.canBuy, awards: p.awards || [] };
    settings.stats = p.stats;
    settings.extraUnlocked = p.unlocked.filter((id) => !unlockedFor(p.stats).includes(id)); // bought and awarded, for offline
    if (p.name && !settings.playerName) { settings.playerName = p.name; $('opt-name').value = p.name; }
    // the server's copy wins when it has one; otherwise push the local look up
    if (p.look && p.look.shell) settings.look = normalizeLook(p.look, p.unlocked);
    else await snigelpost.profileSet(playerName(), settings.look).catch(() => {});
    saveSettings(settings);
  } catch { /* offline or not signed in: local look only */ }
  renderProfile();
}
let saveLookTimer = null;
function setLook(look) {
  settings.look = normalizeLook(look, profileState.unlocked);
  saveSettings(settings);
  renderProfile();
  if (!snigelpost.available()) return;
  clearTimeout(saveLookTimer);
  saveLookTimer = setTimeout(() => snigelpost.profileSet(playerName(), settings.look).then((p) => { profileState = { ...profileState, unlocked: p.unlocked, stats: p.stats, online: true, canBuy: !!p.canBuy }; }).catch(() => {}), 300);
}
// ---------- buying premium cosmetics (Stripe Checkout via the buy edge function) ----------
async function buyItem(item, btn) {
  const msg = $('profile-msg');
  btn.disabled = true;
  msg.textContent = t('cos.buying');
  track('buy', { item, step: 'start' });
  try {
    const r = await online.fn('buy', { item, lang: settings.lang || 'sv' });
    if (!r.url) throw new Error('no url');
    location.href = r.url;
  } catch (e) {
    msg.textContent = /not enabled|503/.test(e.message) ? t('cos.buyOff') : t('cos.buyError', { msg: e.message });
    btn.disabled = false;
  }
}
// back from Checkout: ?bought=<item> (the webhook may take a moment) or ?cancelled=<item>
async function afterCheckout() {
  const q = new URLSearchParams(location.search);
  const bought = q.get('bought'), cancelled = q.get('cancelled');
  if (!bought && !cancelled) return;
  history.replaceState(null, '', location.pathname);
  const msg = $('profile-msg');
  if (cancelled) { msg.textContent = t('cos.cancelled'); track('buy', { item: cancelled, step: 'cancelled' }); return; }
  track('buy', { item: bought, step: 'done' });
  const kind = SHELLS.some((s) => s.id === bought) ? 'shell' : 'hat';
  for (let i = 0; i < 8; i++) {
    await loadProfile();
    if (profileState.unlocked.includes(bought)) {
      setLook({ ...settings.look, [kind]: bought });
      msg.textContent = t('cos.bought', { item: t(`cos.${kind}.${bought}`) });
      return;
    }
    msg.textContent = t('cos.boughtWait');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function reportAbandon() {
  if (!game || !matchStats) return;
  track('match_abandon', { turns: game.turnCount, durationSec: Math.round((Date.now() - matchStats.t0) / 1000) });
  matchStats = null;
}

function toMenu() {
  if (game && game.phase !== 'over' && !onlineMatch && !dailyGame) { reportAbandon(); platform.gameplayStop(); }
  if (dailyGame) { dailyGame = null; renderDaily(); }
  if (snigelpost.available()) { renderSeason(); loadProfile(); }
  stopPolling();
  onlineMatch = null;
  replayUntil = 0;
  $('replaybar').hidden = true;
  waiting.hidden = true;
  $('btn-again').hidden = false;
  for (const id of ['btn-go-rematch', 'btn-go-next', 'btn-go-extend3', 'btn-go-extend5']) $(id).hidden = true;
  gameover.hidden = true;
  hud.hidden = true;
  menu.hidden = false;
  game = null;
  window.__game = null;
  refreshMatchList();
}
$('btn-start').addEventListener('click', startGame);
$('btn-help').addEventListener('click', () => (help.hidden = false));
$('btn-help-close').addEventListener('click', () => (help.hidden = true));
$('btn-guide').addEventListener('click', () => { settings.tutorialDone = false; saveSettings(settings); help.hidden = true; });
$('btn-again').addEventListener('click', () => (dailyGame ? startDaily() : startGame()));
$('btn-tomenu').addEventListener('click', toMenu);
$('btn-menu').addEventListener('click', toMenu);

function tryFullscreen() {
  const el = document.documentElement;
  if (matchMedia('(pointer: coarse)').matches && el.requestFullscreen && !document.fullscreenElement) {
    el.requestFullscreen().catch(() => {});
  }
}

// ---------- tutorial ----------
// A four-step guide shown during the player's first match. Each step completes
// when the player actually does the thing.
function startTutorial() {
  tutorial = { step: 1, x0: null, aim0: null, snail: null, turnAt4: null };
  renderTutorial();
}
function endTutorial(done, how = 'done') {
  if (done) {
    settings.tutorialDone = true;
    saveSettings(settings);
    track(how === 'skip' ? 'tutorial_skip' : 'tutorial_done', { step: tutorial?.step ?? 0 });
  }
  tutorial = null;
  $('tutorial').hidden = true;
}
function renderTutorial() {
  const box = $('tutorial');
  if (!tutorial) { box.hidden = true; return; }
  $('tut-step').textContent = t('tut.step', { n: tutorial.step });
  $('tut-text').textContent = t('tut.' + tutorial.step);
  $('tut-skip').textContent = tutorial.step === 4 ? t('tut.done') : t('tut.skip');
}
$('tut-skip').addEventListener('click', () => endTutorial(true, tutorial?.step === 4 ? 'done' : 'skip'));
function updateTutorial() {
  if (!tutorial || !game) return;
  const s = game.active;
  const box = $('tutorial');
  if (!s || game.ai || game.phase === 'over') { box.hidden = true; return; }
  if (tutorial.snail !== s) { tutorial.snail = s; tutorial.x0 = s.x; tutorial.aim0 = s.aim; }
  const before = tutorial.step;
  if (tutorial.step === 1 && Math.abs(s.x - tutorial.x0) > 30) tutorial.step = 2;
  else if (tutorial.step === 2 && Math.abs(s.aim - tutorial.aim0) > 0.25) tutorial.step = 3;
  else if (tutorial.step === 3 && game.hasFired) { tutorial.step = 4; tutorial.turnAt4 = game.turnCount; }
  else if (tutorial.step === 4 && game.turnCount > tutorial.turnAt4 && game.phase === 'aim') { endTutorial(true); return; }
  if (tutorial.step !== before || box.hidden) { box.hidden = false; renderTutorial(); }
}

// ---------- Snigelpost ----------
function playerName() { return (settings.playerName || '').trim() || t('online.defaultName'); }
function notice(text, ms = 6000) {
  const el = $('notice');
  el.textContent = text; el.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { el.hidden = true; }, ms);
}
function seriesText(m) {
  const s = m.series;
  if (!s || (s.best_of === 1 && !s.wins_me && !s.wins_them)) return '';
  const label = t('online.bestOf' + s.best_of);
  return t('online.score', { me: s.wins_me, them: s.wins_them, label, no: s.match_no });
}
// buttons that continue or extend a series; shared by the waiting and game-over overlays
function seriesButtons(prefix, m) {
  const s = m.series;
  const next = snigelpost.nextMatchId(m);
  const decided = (bo) => s && (s.wins_me >= Math.floor(bo / 2) + 1 || s.wins_them >= Math.floor(bo / 2) + 1);
  const finishedSeries = m.status === 'finished' && (!s || s.status === 'finished');
  $(prefix + 'next').hidden = !next;
  $(prefix + 'rematch').hidden = !(finishedSeries && m.guest);
  $(prefix + 'extend3').hidden = !(finishedSeries && s && m.guest && s.best_of < 3 && !decided(3));
  $(prefix + 'extend5').hidden = !(finishedSeries && s && m.guest && s.best_of === 3 && !decided(5));
}
function matchLabel(m) {
  const opp = m.names?.[m.my_team === 0 ? '1' : '0'];
  const st = seriesText(m);
  if (m.status === 'finished') {
    const base = m.winner == null ? t('online.draw') : m.winner === m.my_team ? t('online.won') : t('online.lost');
    return st ? `${base} · ${st}` : base;
  }
  if (m.status === 'open' && m.my_team === 0) return t('online.open');
  return m.turn_team === m.my_team ? t('online.yourTurn') : t('online.theirTurn', { name: opp || '…' });
}
async function refreshMatchList() {
  if (!snigelpost.available()) return;
  const box = $('online-list');
  const status = $('online-status');
  try {
    const list = await snigelpost.list();
    box.innerHTML = '';
    if (!list.length) { status.textContent = t('online.none'); return; }
    status.textContent = '';
    for (const m of list) {
      const opp = m.names?.[m.my_team === 0 ? '1' : '0'];
      const mine = m.status !== 'finished' && m.turn_team === m.my_team && !(m.status === 'open' && m.turn_count >= 1);
      const row = document.createElement('div');
      row.className = 'mrow' + (mine ? ' turn' : '');
      const sub = m.status === 'finished' ? matchLabel(m) : [matchLabel(m), seriesText(m)].filter(Boolean).join(' · ');
      row.innerHTML = `<div><div class="mname">${escapeHtml(t('online.vs', { name: opp || '…' }))}</div><div class="mstate">${escapeHtml(sub)}</div></div>
        <button class="${mine ? 'play' : ''}">${mine ? t('online.play') : t('online.show')}</button><button class="del" title="${t('online.delete')}">✕</button>`;
      row.querySelector('button').addEventListener('click', () => openMatch(m.id));
      row.querySelector('.del').addEventListener('click', async () => { await snigelpost.remove(m.id).catch(() => {}); refreshMatchList(); });
      box.appendChild(row);
    }
  } catch (e) {
    status.textContent = /anonymous|signup|sign-in|disabled/i.test(e.message) ? t('online.disabled') : t('online.error', { msg: e.message });
  }
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function openMatch(id) {
  const status = $('online-status');
  status.textContent = t('online.loading');
  try {
    let m = await snigelpost.get(id);
    if (m.my_team == null) { await snigelpost.join(id, playerName()); m = await snigelpost.get(id); push.notify(id, 'joined'); }
    if (!rulesSupported(m.rules_version)) { status.textContent = t(m.rules_version < RULES_VERSION ? 'online.rulesOld' : 'online.rulesNew'); return; }
    status.textContent = '';
    startOnlineGame(m);
  } catch (e) {
    status.textContent = /anonymous|signup|sign-in|disabled/i.test(e.message) ? t('online.disabled') : t('online.error', { msg: e.message });
  }
}

function isMyTurn(m) {
  return m.status !== 'finished' && m.turn_team === m.my_team && !(m.status === 'open' && m.turn_count >= 1);
}

function startOnlineGame(m) {
  unlockAudio();
  stopPolling();
  matchStats = null;
  const hooks = {
    onWaitTurn: (g) => {
      if (!onlineMatch) return;
      if (g.tickCount <= onlineMatch.startTick) { showWaiting(); return; } // nothing new was played on this device
      submitTurn(false, null);
    },
    onGameOver: (winner) => {
      if (!onlineMatch) return;
      if (game.tickCount > onlineMatch.startTick) submitTurn(true, winner ? winner.index : null);
      else setTimeout(() => showGameOverOnline(), 1500);
    },
    onTurn: () => { camDrag.active = false; },
  };
  const { game: g, myTeam, replayFrom } = snigelpost.buildGame(canvas, m, hooks, settings.style, settings.theme);
  onlineMatch = { id: m.id, myTeam, startTick: m.tick_count, match: m, pending: null };
  game = g;
  window.__game = g;
  buildWeaponBar();
  menu.hidden = true; gameover.hidden = true; waiting.hidden = true; help.hidden = true;
  hud.hidden = false;
  $('btn-again').hidden = true;
  lastTs = performance.now(); acc = 0;
  endTutorial(false);
  const mine = isMyTurn(m);
  // fast-forward silently to the part worth watching
  const showFrom = mine ? replayFrom : m.tick_count;
  while (g.tickCount < showFrom && !g.paused && g.phase !== 'over') g.tick();
  if (mine && replayFrom < m.tick_count) { replayUntil = m.tick_count; $('replaybar').hidden = false; }
  else { replayUntil = 0; afterReplay(); }
  if (m.status === 'open' && m.turn_count === 0) showWaiting(); // show the invite link before the first turn
  if (waiting.hidden) startPolling(); // a resignation or claimed win by the opponent should show up even mid-turn
  track('match_start', { teams: 2, per: m.config.snailsPerTeam, humans: 2, style: settings.style, online: true });
}

function afterReplay() {
  $('replaybar').hidden = true;
  replayUntil = 0;
  const o = onlineMatch;
  if (!o) return;
  const m = o.match, g = game;
  if (g.tickCount >= m.tick_count && m.last_hash && g.stateHash() !== m.last_hash) notice(t('online.desync'), 9000);
  if (m.status === 'finished') { showGameOverOnline(); return; }
  if (!isMyTurn(m)) showWaiting();
}
$('btn-skip-replay').addEventListener('click', () => {
  if (!replayUntil || !game) return;
  while (game.tickCount < replayUntil && !game.paused) game.tick();
  afterReplay();
});

function showGameOverOnline() {
  const m = onlineMatch?.match;
  if (!m) return;
  const s = m.series;
  let title = m.winner == null ? t('online.draw') : m.winner === m.my_team ? t('online.won') : t('online.lost');
  if (s && s.best_of > 1) {
    const p = { me: s.wins_me, them: s.wins_them };
    if (s.status === 'finished') title = s.won_by_me ? t('online.seriesWon', p) : s.wins_me === s.wins_them ? t('online.draw') : t('online.seriesLost', p);
    else title = m.winner === m.my_team ? t('online.matchWon', p) : m.winner == null ? t('online.draw') : t('online.matchLost', p);
  }
  $('go-title').textContent = title;
  const stx = seriesText(m);
  $('go-series').hidden = !stx;
  $('go-series').textContent = stx;
  $('btn-again').hidden = true;
  seriesButtons('btn-go-', m);
  waiting.hidden = true;
  gameover.hidden = false;
}

async function submitTurn(finished, winnerTeam) {
  const o = onlineMatch, g = game;
  if (!o || !g) return;
  o.pending = { finished, winnerTeam };
  showWaiting();
  $('wait-status').textContent = t('online.sending');
  try {
    const m = await snigelpost.submit(o.match, g, o.startTick, finished, winnerTeam);
    o.match = { ...o.match, ...m, turns: undefined };
    o.startTick = m.tick_count;
    o.pending = null;
    $('wait-status').textContent = t('online.sent');
    push.notify(o.id, finished ? 'finished' : 'turn');
    track('match_end', { turns: g.turnCount, durationSec: 0, winner: finished ? (winnerTeam === o.myTeam ? 'human' : winnerTeam == null ? 'draw' : 'human') : 'pending', weapons: {}, online: true });
    renderWaiting();
    if (finished) setTimeout(() => showGameOverOnline(), 1500);
  } catch (e) {
    $('wait-status').textContent = t('online.error', { msg: e.message });
    $('btn-wait-refresh').textContent = t('online.retry');
  }
}

function showWaiting() {
  if (!onlineMatch) return;
  waiting.hidden = false;
  // my own turn is on hold while the overlay is up (invite link before turn 1)
  if (game && isMyTurn(onlineMatch.match) && game.tickCount <= onlineMatch.startTick) game.paused = true;
  renderWaiting();
  startPolling();
}
function renderWaiting() {
  const o = onlineMatch;
  if (!o) return;
  const m = o.match;
  const opp = m.names?.[o.myTeam === 0 ? '1' : '0'];
  const invite = $('wait-invite');
  const mine = isMyTurn(m) && !o.pending && game && game.tickCount <= o.startTick;
  const days = snigelpost.silentDays(m);
  $('btn-wait-play').hidden = !mine;
  $('btn-wait-refresh').hidden = mine || m.status === 'finished';
  renderPushBox(m);
  $('btn-wait-refresh').textContent = o.pending ? t('online.retry') : t('online.refresh');
  $('btn-wait-resign').hidden = m.status === 'finished' || !!o.pending;
  $('btn-wait-resign').textContent = t('online.resign');
  resignArmed = false;
  $('btn-wait-claim').hidden = !(days >= 14);
  seriesButtons('btn-wait-', m);
  const stx = seriesText(m);
  $('wait-series').hidden = !stx;
  $('wait-series').textContent = stx;
  if (m.status === 'open') {
    $('wait-title').textContent = t('online.inviteTitle');
    $('wait-text').textContent = t('online.inviteText');
    invite.hidden = false;
    $('wait-link').value = snigelpost.inviteLink(m.id);
    $('btn-share').hidden = !navigator.share;
  } else if (m.status === 'finished') {
    $('wait-title').textContent = t('online.finished');
    $('wait-text').textContent = matchLabel(m);
    invite.hidden = true;
  } else {
    $('wait-title').textContent = t('online.theirTurn', { name: opp || '…' });
    $('wait-text').textContent = days >= 14 ? t('online.silent', { name: opp || '…', days }) : t('online.waitText', { name: opp || '…' });
    invite.hidden = true;
  }
}
let resignArmed = false;
$('btn-wait-resign').addEventListener('click', async () => {
  const o = onlineMatch;
  if (!o) return;
  if (!resignArmed) { resignArmed = true; $('btn-wait-resign').textContent = t('online.resignConfirm'); return; }
  try {
    const m = await snigelpost.resign(o.id);
    if (!m) { toMenu(); return; } // an invitation nobody joined was simply deleted
    o.match = { ...o.match, ...m, turns: undefined };
    push.notify(o.id, 'resigned');
    $('wait-status').textContent = t('online.resigned');
    renderWaiting();
  } catch (e) { $('wait-status').textContent = t('online.error', { msg: e.message }); }
});
$('btn-wait-claim').addEventListener('click', async () => {
  const o = onlineMatch;
  if (!o) return;
  try {
    const m = await snigelpost.claimTimeout(o.id);
    o.match = { ...o.match, ...m, turns: undefined };
    push.notify(o.id, 'timeout');
    $('wait-status').textContent = t('online.claimed');
    renderWaiting();
  } catch (e) { $('wait-status').textContent = t('online.error', { msg: e.message }); }
});
async function startRematch() {
  const o = onlineMatch;
  if (!o) return;
  try {
    const n = await snigelpost.rematch(o.id);
    push.notify(n.id, 'rematch');
    notice(t('online.rematchMade'));
    await openMatch(n.id);
  } catch (e) { notice(t('online.error', { msg: e.message })); }
}
$('btn-wait-rematch').addEventListener('click', startRematch);
$('btn-go-rematch').addEventListener('click', startRematch);
function openNext() { const id = snigelpost.nextMatchId(onlineMatch?.match); if (id) openMatch(id); }
$('btn-wait-next').addEventListener('click', openNext);
$('btn-go-next').addEventListener('click', openNext);
async function extendSeries(bestOf) {
  const o = onlineMatch;
  if (!o) return;
  try {
    const n = await snigelpost.extend(o.id, bestOf);
    push.notify(n.id, 'rematch');
    await openMatch(n.id);
  } catch (e) { notice(t('online.error', { msg: e.message })); }
}
for (const p of ['btn-wait-', 'btn-go-']) {
  $(p + 'extend3').addEventListener('click', () => extendSeries(3));
  $(p + 'extend5').addEventListener('click', () => extendSeries(5));
}
// "notify me" box in the waiting overlay
let pushSub = undefined; // undefined = not checked yet
async function renderPushBox(m) {
  const box = $('wait-push'), btn = $('btn-push'), hint = $('push-hint');
  const usable = push.supported() && platform.useServiceWorker && m.status !== 'finished';
  box.hidden = !usable;
  if (!usable) return;
  if (pushSub === undefined) { pushSub = null; pushSub = await push.current(); }
  if (push.needsInstall()) { btn.hidden = true; hint.textContent = t('online.pushIos'); return; }
  if (push.permission() === 'denied') { btn.hidden = true; hint.textContent = t('online.pushDenied'); return; }
  if (pushSub) { btn.hidden = true; hint.textContent = t('online.pushOn'); return; }
  btn.hidden = false; hint.textContent = '';
}
$('btn-push').addEventListener('click', async () => {
  const btn = $('btn-push');
  btn.disabled = true;
  try {
    pushSub = await push.subscribe(getLang());
    track('push_on', {});
  } catch (e) {
    $('push-hint').textContent = push.permission() === 'denied' ? t('online.pushDenied') : t('online.pushFail');
  }
  btn.disabled = false;
  if (onlineMatch) renderPushBox(onlineMatch.match);
});

$('btn-copy').addEventListener('click', async () => {
  const link = $('wait-link').value;
  try { await navigator.clipboard.writeText(link); $('wait-status').textContent = t('online.copied'); }
  catch { $('wait-link').select(); }
});
$('btn-share').addEventListener('click', () => navigator.share?.({ title: t('app.name'), url: $('wait-link').value }).catch(() => {}));
$('btn-wait-refresh').addEventListener('click', () => { if (onlineMatch?.pending) submitTurn(onlineMatch.pending.finished, onlineMatch.pending.winnerTeam); else pollMatch(true); });
$('btn-wait-menu').addEventListener('click', () => toMenu());
$('btn-wait-play').addEventListener('click', () => { waiting.hidden = true; stopPolling(); if (game) { game.paused = false; lastTs = performance.now(); acc = 0; } });

function startPolling() { stopPolling(); pollTimer = setInterval(() => pollMatch(false), 8000); }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
async function pollMatch(manual) {
  const o = onlineMatch;
  if (!o || o.pending || replayUntil) return;
  try {
    const m = await snigelpost.get(o.id);
    if (m.turn_count > o.match.turn_count || m.status !== o.match.status || (m.guest && !o.match.guest)) {
      stopPolling();
      startOnlineGame(m);
    } else {
      // nothing new, but keep timestamps fresh (silent days, claim button) and confirm on a manual refresh
      o.match = { ...o.match, ...m, turns: undefined };
      if (!waiting.hidden) renderWaiting();
      if (manual) $('wait-status').textContent = matchLabel(m);
    }
  } catch (e) { if (manual) $('wait-status').textContent = t('online.error', { msg: e.message }); }
}
addEventListener('visibilitychange', () => { if (!document.hidden) pollMatch(false); });

if (snigelpost.available()) {
  $('online').hidden = false;
  $('opt-name').value = settings.playerName || '';
  $('opt-name').addEventListener('change', () => { settings.playerName = $('opt-name').value.trim().slice(0, 24); saveSettings(settings); snigelpost.profileSet(playerName(), settings.look).catch(() => {}); });
  loadProfile().then(afterCheckout);
  $('btn-online-create').addEventListener('click', async () => {
    const b = $('btn-online-create');
    b.disabled = true;
    settings.playerName = $('opt-name').value.trim().slice(0, 24); saveSettings(settings);
    try { const rules = readRules(); saveSettings(settings); const m = await snigelpost.create({ snailsPerTeam: +$('opt-per').value, ...rules }, playerName(), +$('opt-bestof').value); await openMatch(m.id); }
    catch (e) { $('online-status').textContent = /anonymous|signup|sign-in|disabled/i.test(e.message) ? t('online.disabled') : t('online.error', { msg: e.message }); }
    b.disabled = false;
  });
  // ---------- account: e-mail linking ----------
  const redirectTo = () => location.origin + location.pathname;
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  renderAccount = async function () {
    const st = $('account-status'), row = $('account-row'), out = $('btn-logout');
    try {
      const u = await online.user(true);
      if (u.email && !u.anonymous) { st.textContent = t(u.provider === 'google' ? 'account.linkedVia' : 'account.linked', { email: u.email }); row.hidden = true; out.hidden = false; }
      else if (u.pendingEmail) { st.textContent = t('account.pending', { email: u.pendingEmail }); row.hidden = false; out.hidden = true; }
      else { st.textContent = t('account.anonymous'); row.hidden = false; out.hidden = true; }
    } catch { st.textContent = t('online.accountHint'); row.hidden = true; out.hidden = true; }
  };
  const accountAction = (btn, fn) => btn.addEventListener('click', async () => {
    const email = $('opt-email').value.trim().toLowerCase();
    if (!emailOk(email)) { $('account-msg').textContent = t('account.invalid'); return; }
    btn.disabled = true;
    try { $('account-msg').textContent = await fn(email); track('account', { action: btn.id }); }
    catch (e) { $('account-msg').textContent = accountError(e); }
    btn.disabled = false;
    renderAccount();
  });
  const accountError = (e) => {
    if (e.code === 'rate_limit') return t('account.rateLimited');
    if (e.code === 'email_exists' || /already been registered/i.test(e.message)) return t('account.emailTaken');
    if (/signups? not allowed|not found|otp_disabled/i.test(e.message)) return t('account.noAccount');
    return t('account.error', { msg: e.message });
  };
  // Google: an anonymous account is linked (keeps its id and matches); with no
  // usable session at all we sign in as the account that owns the Google identity.
  const LS_BEFORE = 'snackmageddon.beforeOauth';
  const goGoogle = async (link) => {
    try {
      try { sessionStorage.setItem(LS_BEFORE, online.userId() || ''); } catch { /* ignore */ }
      const url = await online.googleUrl(redirectTo(), link);
      track('account', { action: link ? 'google-link' : 'google-login' });
      location.assign(url);
    } catch (e) { $('account-msg').textContent = accountError(e); }
  };
  $('btn-google').addEventListener('click', () => goGoogle(!!online.userId()));
  $('btn-google-login').addEventListener('click', () => goGoogle(false));
  accountAction($('btn-link-email'), async (email) => { await online.linkEmail(email, redirectTo()); return t('account.linkSent', { email }); });
  accountAction($('btn-login-email'), async (email) => { await online.sendLoginLink(email, redirectTo()); return t('account.loginSent', { email }); });
  $('btn-logout').addEventListener('click', () => { online.signOut(); location.reload(); });
  // coming back from a confirmation link, a login link or Google
  const afterAuth = async (back) => {
    if (back.type === 'error') {
      if (back.code === 'identity_already_exists' || back.code === 'email_exists') {
        // the Google account (or its e-mail) already has a player account: with nothing
        // on this device worth keeping, just sign in as it; otherwise let the player decide
        const mine = await snigelpost.list().catch(() => [{}]);
        if (!mine.length) return goGoogle(false);
        $('account-msg').textContent = t('account.googleTaken'); $('btn-google-login').hidden = false;
      } else $('account-msg').textContent = t('account.error', { msg: back.message });
    } else {
      const now = await online.ensureUserId().catch(() => null);
      let before = null;
      try { before = sessionStorage.getItem(LS_BEFORE); sessionStorage.removeItem(LS_BEFORE); } catch { /* ignore */ }
      const sameAccount = back.type === 'email_change' || (back.type === 'oauth' && !!before && before === now);
      $('account-msg').textContent = t(sameAccount ? 'account.welcomeLinked' : 'account.welcomeLogin');
      if (!sameAccount) refreshMatchList();
    }
    track('account', { action: back.type });
    renderAccount();
  };
  const back = online.handleRedirect();
  if (back) afterAuth(back);
  // scanner-proof e-mail link: ?token_hash=…&type=… needs a press before it is spent
  const q = new URLSearchParams(location.search);
  if (q.get('token_hash') && q.get('type')) {
    const tokenHash = q.get('token_hash'), type = q.get('type');
    q.delete('token_hash'); q.delete('type');
    history.replaceState(null, '', location.pathname + ([...q].length ? '?' + q : ''));
    $('account-msg').textContent = t('account.confirmHint');
    $('btn-confirm-link').hidden = false;
    $('btn-confirm-link').addEventListener('click', async () => {
      $('btn-confirm-link').disabled = true;
      try { afterAuth(await online.verifyToken(tokenHash, type)); $('btn-confirm-link').hidden = true; }
      catch (e) { $('account-msg').textContent = accountError(e); $('btn-confirm-link').disabled = false; }
    });
  }
  renderAccount();

  refreshMatchList();
  const joinId = new URLSearchParams(location.search).get('match');
  if (joinId && platform.id !== 'poki') openMatch(joinId);
}

// ---------- weapons bar ----------
function buildWeaponBar() {
  const box = $('weapons');
  box.innerHTML = '';
  (game ? game.weapons : WEAPONS).forEach((w, i) => {
    const b = document.createElement('button');
    b.dataset.id = w.id;
    b.innerHTML = `${w.icon}<small>${i + 1}</small><span class="ammo"></span>`;
    b.title = t('weapon.' + w.id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); game?.selectWeapon(w.id); });
    box.appendChild(b);
  });
}

// ---------- input ----------
const keyMap = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  Space: 'fire', Enter: 'jump', ShiftLeft: 'jump', ShiftRight: 'jump',
};
addEventListener('keydown', (e) => {
  if (!game || !menu.hidden) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = keyMap[e.code];
  if (k) { if (!game.ai) game.input[k] = true; e.preventDefault(); }
  if (e.code === 'Escape') { toMenu(); return; }
  if (game.ai || game.replay) return;
  if (/^Digit[1-9]$/.test(e.code) && game.weapons[+e.code[5] - 1]) game.selectWeapon(game.weapons[+e.code[5] - 1].id);
  if (e.code === 'Tab') { e.preventDefault(); cycleWeapon(e.shiftKey ? -1 : 1); }
});
// next/previous weapon that has ammo
function cycleWeapon(dir) {
  if (!game || game.ai || game.replay) return;
  const ammo = game.active ? game.teams[game.active.team].ammo : {};
  const ws = game.weapons;
  let i = ws.findIndex((w) => w.id === (game.input.weapon || game.weaponId)); // from the pending choice, so quick presses chain
  for (let k = 0; k < ws.length; k++) {
    i = (i + dir + ws.length) % ws.length;
    if (ammo[ws[i].id] > 0) { game.selectWeapon(ws[i].id); break; }
  }
}
addEventListener('keyup', (e) => {
  if (!game) return;
  const k = keyMap[e.code];
  if (k && !game.ai) game.input[k] = false;
});
addEventListener('blur', () => { if (game) for (const k in game.input) if (k !== 'weapon') game.input[k] = false; });

// touch buttons
for (const b of document.querySelectorAll('.tbtn')) {
  const key = b.dataset.key;
  const down = (e) => { e.preventDefault(); b.classList.add('down'); if (game && !game.ai) game.input[key] = true; unlockAudio(); };
  const up = (e) => { e.preventDefault(); b.classList.remove('down'); if (game && !game.ai) game.input[key] = false; };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}

// camera drag / pinch / wheel
const camDrag = { active: false, id: null, lx: 0, ly: 0, pinch: null };
const pointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  if (!game) return;
  unlockAudio();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 1) { camDrag.active = true; camDrag.lx = e.clientX; camDrag.ly = e.clientY; }
  else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    camDrag.pinch = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!game || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const cam = game.cam;
  if (pointers.size === 2 && camDrag.pinch) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    cam.zoom *= d / camDrag.pinch;
    camDrag.pinch = d;
    cam.manual = true;
    cam.punch = null;
  } else if (camDrag.active) {
    const dx = e.clientX - camDrag.lx, dy = e.clientY - camDrag.ly;
    if (Math.abs(dx) + Math.abs(dy) > 2) cam.manual = true;
    cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
    camDrag.lx = e.clientX; camDrag.ly = e.clientY;
  }
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) camDrag.pinch = null; if (pointers.size === 0) camDrag.active = false; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  if (!game) return;
  e.preventDefault();
  game.cam.zoom *= e.deltaY < 0 ? 1.1 : 0.9;
  game.cam.manual = true;
  game.cam.punch = null;
}, { passive: false });

// ---------- HUD ----------
const windFill = $('wind-fill');
function updateHud(now) {
  if (!game || now - hudLast < 80) return;
  hudLast = now;
  const st = game.hudState();
  const team = $('hud-team');
  if (st.team) { team.textContent = `${st.team.name} · ${st.snail?.name ?? ''}${st.ai ? ' ' + t('hud.ai.' + st.ai) : ''}`; team.style.background = st.team.color; }
  const timer = $('hud-timer');
  timer.textContent = st.phase === 'aim' || st.phase === 'retreat' ? Math.ceil(st.timer) : '·';
  timer.classList.toggle('low', st.phase === 'aim' && st.timer < 10);
  $('hud-message').textContent = fmt(st.message);
  const w = Math.abs(st.wind) * 45;
  windFill.style.width = w + 'px';
  windFill.style.left = st.wind >= 0 ? '50%' : `calc(50% - ${w}px)`;
  const rows = $('hud-teams');
  if (rows.childElementCount !== st.teams.length) {
    rows.innerHTML = st.teams.map(() => '<div class="trow"><span class="tname"></span><div class="tbar"><div></div></div><span class="tcount"></span></div>').join('');
  }
  st.teams.forEach((tm, i) => {
    const r = rows.children[i];
    r.classList.toggle('dead', tm.alive === 0);
    r.querySelector('.tname').textContent = tm.name;
    const bar = r.querySelector('.tbar > div');
    bar.style.width = (100 * tm.hp) / (100 * (tm.total || game.config.snailsPerTeam || 3)) + '%';
    bar.style.background = tm.color;
    r.querySelector('.tcount').textContent = `${tm.alive}`;
  });
  for (const b of $('weapons').children) {
    const a = st.ammo ? st.ammo[b.dataset.id] : Infinity;
    b.classList.toggle('sel', b.dataset.id === st.weapon);
    b.querySelector('.ammo').textContent = a === Infinity ? '' : a;
    b.disabled = st.phase !== 'aim' || st.ai || !(a > 0);
  }
  updateTutorial();
}

// ---------- loop ----------
// Fixed-step simulation: the game only ever advances in whole ticks of TICK
// seconds, however fast the display runs. Rendering happens once per frame.
let acc = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  handleGamepad();
  if (!game) return;
  const real = Math.min(0.25, (ts - lastTs) / 1000);
  lastTs = ts;
  // slow motion after a kill shot: the simulation still advances in whole
  // ticks, it just gets fewer of them per real second, so nothing desyncs
  if (game.slowmo > 0 && !replayUntil) { acc += real * 0.3; game.slowmo -= real; }
  else acc += real;
  let n = 0;
  // window.__manualTick lets tests drive game.tick() themselves
  if (replayUntil) {
    // showing the opponent's turn at triple speed
    for (let i = 0; i < 3 && game.tickCount < replayUntil; i++) game.tick();
    acc = 0;
    if (game.tickCount >= replayUntil) afterReplay();
  } else if (!window.__manualTick) {
    while (acc >= TICK && n < 6) { game.tick(); acc -= TICK; n++; }
    if (n === 6) acc = 0; // tab was hidden or the device is too slow: drop time instead of spiralling
  }
  game.render();
  updateHud(ts);
}
requestAnimationFrame(frame);

// ---------- gamepad ----------
function handleGamepad() {
  const playing = !!game && menu.hidden && gameover.hidden && waiting.hidden && help.hidden;
  const canControl = playing && !game.ai && !game.replay && !replayUntil && game.isLocalTurn();
  const ev = pollGamepad(game, canControl);
  if (ev.justConnected) notice(t('pad.connected'), 4000);
  if (ev.any) unlockAudio();
  if (ev.mute) toggleMute();
  if (playing) {
    if (ev.prevWeapon) cycleWeapon(-1);
    if (ev.nextWeapon) cycleWeapon(1);
    if (ev.menu) { toMenu(); return; }
    if (ev.camX || ev.camY) { game.cam.manual = true; game.cam.punch = null; game.cam.x += ev.camX * 14 / game.cam.zoom; game.cam.y += ev.camY * 14 / game.cam.zoom; }
  } else if (ev.menu) {
    if (!gameover.hidden) $('btn-again').click();
    else if (!menu.hidden && !dailyGame && !onlineMatch) startGame();
  }
}

// ---------- platform ----------
if (!platform.allowExternalLinks) {
  for (const a of document.querySelectorAll('a[href]')) a.hidden = true;
  $('btn-install').hidden = true;
}
// Portals that forbid links out and accounts elsewhere: no Snigelpost invitations,
// no e-mail linking, no purchases. Local play, shot of the day and the season stay.
if (platform.id === 'poki') {
  for (const id of ['online-title', 'online-blurb', 'opt-bestof-label', 'btn-online-create', 'online-list', 'account']) $(id)?.setAttribute('hidden', '');
  document.body.classList.add('portal');
}
window.__platformReady = platform.init().then(() => platform.loaded());

// ---------- PWA ----------
let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (platform.id === 'web') $('btn-install').hidden = false;
});
$('btn-install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('btn-install').hidden = true;
});
if (platform.useServiceWorker && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(() => {
      $('offline-hint').dataset.ready = '1';
      $('offline-hint').textContent = t('menu.offline');
    }).catch(() => {});
  });
}
