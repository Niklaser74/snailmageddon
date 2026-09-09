import { Terrain } from './terrain.js';
import { themeFor } from './themes.js';
import { drawSnail, shade } from './snails.js';
import { sfx } from './audio.js';
import { mulberry32, shuffle, Hasher } from './rng.js';
import { dsin, dcos, dhypot, datan2 } from './dmath.js';

// Bump when physics or rules change so old recordings are not replayed with
// new rules.
// ---------- rules versioning ----------
// Every match (recording, Snigelpost row) carries the rules version it was
// started with. The simulation can run every version in SUPPORTED_RULES, so a
// rule change never breaks a match in progress; older versions are retired
// after a sunset period (see docs/REGELVERSIONER.md).
//   1: first Snigelpost rules
//   2: crates, slime ball, salt rain, ammo
//   3: shell shove, snail hop (weapons with since: 3)
//   4: wind strength rule (normal / hard / storm)
export const RULES_VERSION = 4;
export const SUPPORTED_RULES = [3, 4];
export function rulesSupported(v) { return SUPPORTED_RULES.includes(v); }
// Fixed simulation step. The sim only ever advances by exactly this much.
export const TICK = 1 / 60;

// ammo: shots per team and match (Infinity = unlimited). Crates add more.
// contact: explodes on first contact. sticky: stops where it lands. marker: aimed with a ground marker.
export const WEAPONS = [
  { id: 'bazooka', name: 'Bazooka', icon: '🚀', radius: 36, dmg: 48, wind: true, charge: true, speed: 900, contact: true, ammo: Infinity },
  { id: 'granat', name: 'Granat', icon: '💣', radius: 32, dmg: 42, fuse: 3, bounce: 0.45, charge: true, speed: 760, ammo: Infinity },
  { id: 'salt', name: 'Saltspruta', icon: '🧂', pellets: 3, range: 240, dmg: 13, radius: 9, charge: false, ammo: Infinity },
  { id: 'dynamit', name: 'Dynamit', icon: '🧨', fuse: 4, radius: 52, dmg: 75, charge: false, ammo: 2 },
  { id: 'slem', name: 'Slemklot', icon: '🟢', radius: 30, dmg: 40, fuse: 2, charge: true, speed: 700, sticky: true, ammo: 3 },
  { id: 'saltregn', name: 'Saltregn', icon: '🌧️', radius: 13, dmg: 12, drops: 5, wind: true, charge: false, contact: true, marker: true, ammo: 1 },
  // melee: shoves every snail right in front of you, hard. No terrain damage, unlimited.
  { id: 'skalstot', name: 'Skalstöt', icon: '🐚', range: 34, dmg: 22, push: 380, lift: 230, charge: false, melee: true, ammo: Infinity, since: 3 },
  // teleport: aimed with the ground marker, the snail hops there and the turn ends
  { id: 'snigelhopp', name: 'Snigelhopp', icon: '✨', charge: false, marker: true, teleport: true, ammo: 1, since: 3 },
];
export const CRATE_WEAPONS = ['dynamit', 'slem', 'saltregn', 'snigelhopp'];
// The weapons that exist in a rules version, in fixed order (the order is hashed).
export function weaponsFor(version) { return WEAPONS.filter((w) => (w.since || 1) <= version); }

// AI difficulty. Everything the AI does goes through the input snapshot and
// its own rng, so a level only changes which inputs get recorded.
export const AI_LEVELS = {
  easy: { think: 1.2, aimStep: 10, powerStep: 0.15, error: 0.14, fireDist: 70, specials: false, repick: false, weakest: false },
  normal: { think: 0.7, aimStep: 5, powerStep: 0.1, error: 0.03, fireDist: 34, specials: true, repick: true, weakest: false },
  hard: { think: 0.5, aimStep: 3, powerStep: 0.05, error: 0, fireDist: 26, specials: true, repick: true, weakest: true, pickBest: true, smart: true, fireValue: 30 },
};
// team.ai may be false, true (old saves: normal) or a level name
export function aiLevel(v) { return v === true ? 'normal' : AI_LEVELS[v] ? v : false; }
export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

export const SNAIL_NAMES = [
  'Sniglinda', 'Slemuel', 'Skalman', 'Slidde', 'Snorkel', 'Turbo', 'Krypa', 'Gastropodde',
  'Slöa', 'Gunnar Slem', 'Achatina', 'Sniglas', 'Blötis', 'Skalle', 'Kladdis', 'Glidaren',
  'Fru Sav', 'Slemhild', 'Snigge', 'Klibban', 'Saltina', 'Molluska', 'Slajm-Olle', 'Skalbritt',
];

const G = 900; // px/s²
const WALK = 62; // px/s – snails are not fast
const CLIMB = 8;
const HEAD_H = 30;
const SNAIL_SCALE = 1.2;
const WIND_FORCE = 140;
// Rules a match can change in the menu. They are part of the recording and of
// a Snigelpost match's config, so every device plays by the same rules.
export const DEFAULT_RULES = { turnTime: 45, suddenDeath: 16, wind: 'normal' }; // suddenDeath = turn after which the water rises, 0 = never
export const TURN_TIMES = [20, 30, 45, 60, 90];
export const SUDDEN_DEATHS = [0, 8, 12, 16, 24];
// Wind rule (rules version 4+): force multiplier, and whether every airborne
// projectile drifts (storm) or only the ones flagged wind: true (bazooka, salt rain).
export const WINDS = ['normal', 'hard', 'storm'];
export const WIND_LEVELS = { normal: { force: 1, all: false }, hard: { force: 1.8, all: false }, storm: { force: 2.5, all: true } };
export function normalizeRules(cfg) {
  const tt = +cfg?.turnTime, sd = +cfg?.suddenDeath, wd = cfg?.wind;
  return {
    turnTime: TURN_TIMES.includes(tt) ? tt : DEFAULT_RULES.turnTime,
    suddenDeath: SUDDEN_DEATHS.includes(sd) ? sd : DEFAULT_RULES.suddenDeath,
    wind: WINDS.includes(wd) ? wd : DEFAULT_RULES.wind,
  };
}
const RETREAT_TIME = 4;
const SLOWMO_TIME = 1.1; // seconds of real time the kill shot is shown slowed down

const PHASES = ['init', 'aim', 'retreat', 'settle', 'over'];
const INPUT_KEYS = ['left', 'right', 'up', 'down', 'fire', 'jump', 'weapon'];
export function emptyInput() {
  return { left: false, right: false, up: false, down: false, fire: false, jump: false, weapon: 'bazooka' };
}
function sameInput(a, b) {
  for (const k of INPUT_KEYS) if (a[k] !== b[k]) return false;
  return true;
}
// unit vectors around a circle, for surface-normal sampling (engine-independent)
const RING16 = Array.from({ length: 16 }, (_, a) => {
  const ang = (a / 16) * 6.283185307179586;
  return { x: dcos(ang), y: dsin(ang) };
});
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// camera punch timing in seconds: zoom in, hold, ease back out
const PUNCH_IN = 0.18, PUNCH_HOLD = 0.9, PUNCH_OUT = 1.8;
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const lerp = (a, b, k) => a + (b - a) * k;

export class Game {
  // canvas may be null: the game then runs headless (Node, tests, server).
  // opts.replay: a recording from game.recording; inputs are taken from it and
  // the AI is disabled, so the match plays back exactly as it was played.
  constructor(canvas, config, hooks = {}, opts = {}) {
    this.canvas = canvas || null;
    this.headless = !canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.config = config;
    this.hooks = hooks;
    this.W = 1800;
    this.H = 800;
    this.style = config.style || 'cartoon';
    this.rules = normalizeRules(config);
    this.replay = opts.replay || null;
    this.rulesVersion = this.replay ? this.replay.rulesVersion : (config.rulesVersion ?? RULES_VERSION);
    if (!rulesSupported(this.rulesVersion)) throw new Error(`rules version ${this.rulesVersion} is not supported (${SUPPORTED_RULES.join(', ')})`);
    this.weapons = weaponsFor(this.rulesVersion);
    this.weaponIds = new Set(this.weapons.map((w) => w.id));
    // Shot of the day: one snail, one weapon, one shot at a row of targets. The
    // match ends when the shot has settled; the score is the damage done.
    const src = this.replay || config;
    this.daily = src.mode === 'daily' ? { weapon: this.weaponIds.has(src.dailyWeapon) ? src.dailyWeapon : 'bazooka', score: null } : null;
    this.crateWeapons = CRATE_WEAPONS.filter((id) => this.weaponIds.has(id));
    // Snigelpost: replay the recorded ticks, then hand control to the local player.
    // liveAfter = first tick that is played live; localTeams = team indices this client controls.
    this.replayUntil = this.replay ? (opts.liveAfter ?? Infinity) : 0;
    this.localTeams = opts.localTeams || null;
    this.paused = false;
    this.waitingFor = null; // team index whose turn it is on another device
    this.deferred = []; // hooks fired after the current tick has fully completed
    this.seed = (this.replay ? this.replay.seed : (config.seed ?? (Math.random() * 1e9))) | 0;
    this.rng = mulberry32(this.seed); // simulation only
    this.airng = mulberry32(this.seed ^ 0x2545f491); // AI decisions (recorded as inputs, never touches the sim rng)
    this.vrng = mulberry32(this.seed ^ 0x5bd1e995); // visuals only
    this.theme = themeFor(this.seed, config.theme); // visual only
    this.terrain = new Terrain(this.W, this.H, this.rng, { headless: this.headless, theme: this.theme });
    this.waterY = this.H - 42;
    this.time = 0;
    this.tickCount = 0;
    this.turnCount = 0;
    this.input = emptyInput(); // live input, written by the UI or the AI
    this.frame = emptyInput(); // the snapshot the simulation reads this tick
    this.prevFire = false;
    this.recording = {
      rulesVersion: this.rulesVersion,
      seed: this.seed,
      teams: config.teams.map((t) => ({ name: t.name, color: t.color, ai: aiLevel(t.ai) })),
      snailsPerTeam: config.snailsPerTeam || 3,
      turnTime: this.rules.turnTime,
      suddenDeath: this.rules.suddenDeath,
      wind: this.rules.wind,
      teamSizes: config.teamSizes || undefined,
      mode: this.daily ? 'daily' : undefined,
      dailyWeapon: this.daily ? this.daily.weapon : undefined,
      inputs: [],
    };
    this.lastRecorded = null;
    this.replayIdx = 0;
    if (this.replay && this.replayUntil !== Infinity) this.recording.inputs = this.replay.inputs.map(([t, f]) => [t, { ...f }]);
    this.projectiles = [];
    this.crates = [];
    this.pendingBooms = [];
    this.markerX = 0;
    this.particles = [];
    this.trail = []; // slime left by crawling snails (visual only)
    this.trailLast = {}; // snail id -> last trail point
    this.popups = [];
    this.shake = 0;
    this.slowmo = 0; // seconds of slow motion left (visual only, never hashed)
    this.cam = { x: this.W / 2, y: this.H / 2, zoom: 1, manual: false, target: null };
    this.phase = 'init';
    this.message = '';
    this.messageTimer = 0;
    this.clouds = Array.from({ length: 8 }, () => ({
      x: this.vrng() * this.W, y: 40 + this.vrng() * 220, s: 0.6 + this.vrng() * 0.9, v: 4 + this.vrng() * 8,
    }));
    this.buildTeams();
    this.startTurn();
  }

  static fromRecording(canvas, rec, hooks = {}, style = 'cartoon') {
    if (!rulesSupported(rec.rulesVersion)) throw new Error(`Inspelningen har regelversion ${rec.rulesVersion}, spelet stöder ${SUPPORTED_RULES.join(', ')}`);
    return new Game(canvas, { teams: rec.teams, snailsPerTeam: rec.snailsPerTeam, teamSizes: rec.teamSizes, turnTime: rec.turnTime, suddenDeath: rec.suddenDeath, wind: rec.wind, mode: rec.mode, dailyWeapon: rec.dailyWeapon, style }, hooks, { replay: rec });
  }

  // ---------- fixed-step driver ----------
  // One simulation step. Every input passes through here, so a match can be
  // recorded as (tick, input) pairs and replayed bit for bit.
  tick() {
    if (this.paused) return;
    if (this.replay && this.tickCount >= this.replayUntil) {
      // end of the recorded part: from here on this device plays live
      this.lastRecorded = { ...this.frame };
      this.replay = null;
    }
    if (this.replay) {
      this.frame = this.replayInputAt(this.tickCount);
    } else {
      if (this.ai && (this.phase === 'aim' || this.phase === 'retreat')) this.updateAI(TICK);
      this.frame = { ...this.input };
      this.record(this.frame);
    }
    this.update(TICK);
    this.tickCount++;
    // hooks that need the finished tick (state hash, tick count) run here
    const fns = this.deferred;
    this.deferred = [];
    for (const fn of fns) fn();
  }

  record(frame) {
    if (this.lastRecorded && sameInput(this.lastRecorded, frame)) return;
    this.recording.inputs.push([this.tickCount, { ...frame }]);
    this.lastRecorded = { ...frame };
  }

  // The recorded inputs from a tick onwards (one turn, for Snigelpost).
  inputsSince(tick) {
    return this.recording.inputs.filter(([t]) => t >= tick).map(([t, f]) => [t, { ...f }]);
  }

  // Is the current turn played on this device?
  isLocalTurn() {
    return !this.localTeams || !this.active || this.localTeams.includes(this.active.team);
  }

  replayInputAt(tick) {
    const list = this.replay.inputs;
    let f = this.frame;
    while (this.replayIdx < list.length && list[this.replayIdx][0] <= tick) {
      f = { ...list[this.replayIdx][1] };
      this.replayIdx++;
    }
    return f;
  }

  // Hash of everything the simulation depends on. Two games with the same
  // seed and inputs must produce the same hash at every tick.
  stateHash() {
    const h = new Hasher();
    h.int(this.tickCount).int(this.turnCount).int(this.teamIndex).byte(PHASES.indexOf(this.phase) + 1);
    h.num(this.wind ?? 0).num(this.timer ?? 0).num(this.waterY).num(this.power ?? 0);
    h.byte(this.charging ? 1 : 0).byte(this.hasFired ? 1 : 0).byte(this.weapons.findIndex((w) => w.id === this.weaponId) + 1);
    for (const s of this.snails) {
      h.num(s.x).num(s.y).num(s.vx).num(s.vy).int(s.hp).byte(s.alive ? 1 : 0).byte(s.facing + 2).num(s.aim).byte(s.airborne ? 1 : 0).num(s.walkAcc);
    }
    for (const p of this.projectiles) h.num(p.x).num(p.y).num(p.vx).num(p.vy).num(p.age).byte(p.rest ? 1 : 0);
    for (const c of this.crates) h.num(c.x).num(c.y).num(c.vy).byte(c.landed ? 1 : 0).byte(c.type === 'health' ? 1 : 2);
    h.num(this.markerX);
    for (const t of this.teams) for (const w of this.weapons) h.int(t.ammo[w.id] === Infinity ? -1 : t.ammo[w.id]);
    h.bytes(this.terrain.mask);
    return h.hex();
  }

  buildTeams() {
    const names = shuffle([...SNAIL_NAMES], this.rng);
    let ni = 0;
    this.teams = this.config.teams.map((t, ti) => ({
      index: ti, name: t.name, color: t.color, ai: aiLevel(t.ai), look: t.look || null, nextSnail: 0, // look is visual only
      snails: [], ammo: Object.fromEntries(this.weapons.map((w) => [w.id, w.ammo])),
    }));
    if (this.daily) for (const t of this.teams) for (const w of this.weapons) t.ammo[w.id] = w.id === this.daily.weapon ? 1 : 0;
    this.snails = [];
    const per = this.config.snailsPerTeam || 3;
    const sizes = this.config.teamSizes || this.teams.map(() => per); // uneven teams (shot of the day)
    const total = sizes.reduce((a, b) => a + b, 0);
    // spread spawn columns across the map, shuffled, then alternate teams
    const slots = [];
    for (let i = 0; i < total; i++) slots.push(((i + 0.5) / total) * (this.W - 160) + 80);
    shuffle(slots, this.rng);
    let si = 0;
    for (let k = 0; k < Math.max(...sizes); k++) {
      for (const team of this.teams) {
        if (k >= sizes[team.index]) continue;
        const x = Math.round(slots[si++] + (this.rng() - 0.5) * 30);
        const gy = this.terrain.groundBelow(x, 0);
        const s = {
          id: this.snails.length, name: names[ni++ % names.length], team: team.index, color: team.color,
          x, y: gy > 0 ? gy : this.terrain.heights[x] | 0, vx: 0, vy: 0, hp: 100, alive: true,
          facing: this.rng() < 0.5 ? 1 : -1, aim: 0.3, airborne: false, walking: false, restTime: 0,
          walkAcc: 0, deathPending: false,
        };
        team.snails.push(s);
        this.snails.push(s);
      }
    }
    this.teamIndex = -1;
    this.weaponId = this.daily ? this.daily.weapon : 'bazooka';
  }

  // ---------- turns ----------
  livingTeams() { return this.teams.filter((t) => t.snails.some((s) => s.alive)); }

  startTurn() {
    if (this.daily && this.turnCount >= 1) { this.dailyOver(); return; }
    const living = this.livingTeams();
    if (living.length <= 1) { this.gameOver(living[0]); return; }
    let ti = this.teamIndex;
    for (let i = 0; i < this.teams.length; i++) {
      ti = (ti + 1) % this.teams.length;
      if (this.teams[ti].snails.some((s) => s.alive)) break;
    }
    this.teamIndex = ti;
    const team = this.teams[ti];
    let s = null;
    for (let i = 0; i < team.snails.length; i++) {
      const cand = team.snails[(team.nextSnail + i) % team.snails.length];
      if (cand.alive) { s = cand; team.nextSnail = (team.nextSnail + i + 1) % team.snails.length; break; }
    }
    this.active = s;
    this.turnCount++;
    this.wind = Math.round((this.rng() * 2 - 1) * 10) / 10;
    const crate = this.turnCount > 1 && this.rng() < 0.4 ? this.spawnCrate() : null;
    this.timer = this.rules.turnTime;
    this.phase = 'aim';
    this.power = 0;
    this.charging = false;
    this.hasFired = false;
    this.weaponId = this.daily ? this.daily.weapon : 'bazooka';
    this.ai = team.ai && !this.replay ? { state: 'think', t: 0, plan: null, walkT: 0, tries: 0, level: AI_LEVELS[team.ai] } : null;
    Object.assign(this.input, emptyInput());
    this.prevFire = false;
    // Snigelpost: the other player's turn is played on their device
    if (this.localTeams && !this.localTeams.includes(ti) && this.tickCount >= this.replayUntil - 1) {
      this.paused = true;
      this.waitingFor = ti;
      this.deferred.push(() => this.hooks.onWaitTurn?.(this, ti));
    }
    this.cam.manual = false;
    this.cam.target = s;
    if (this.rules.suddenDeath > 0 && this.turnCount > this.rules.suddenDeath) {
      this.waterY -= 7;
      this.say({ key: 'msg.sudden', team: team.name, name: s.name }, 2.5);
      sfx.sudden();
    } else if (crate) {
      this.say({ key: crate.type === 'health' ? 'msg.crateHealth' : 'msg.crateWeapon' }, 2.5);
    } else {
      this.say({ key: 'msg.turn', team: team.name, name: s.name }, 2);
    }
    sfx.turn();
    this.hooks.onTurn?.(this);
  }

  // ---------- crates ----------
  spawnCrate() {
    const type = this.rng() < 0.5 ? 'health' : 'weapon';
    const x = Math.round(60 + this.rng() * (this.W - 120));
    const weapon = this.crateWeapons[Math.floor(this.rng() * this.crateWeapons.length)];
    const c = { x, y: -20, vy: 0, type, weapon, landed: false, chute: true };
    this.crates.push(c);
    return c;
  }

  updateCrates(dt) {
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (c.landed) {
        if (!this.terrain.solid(c.x, c.y + 1)) { c.landed = false; c.chute = false; c.vy = 0; }
        continue;
      }
      c.vy = c.chute ? Math.min(c.vy + G * dt, 70) : c.vy + G * dt;
      const ny = c.y + c.vy * dt;
      if (ny > this.waterY) { this.crates.splice(i, 1); sfx.splash(); continue; }
      let y = Math.floor(c.y);
      let hit = false;
      for (; y <= Math.ceil(ny); y++) if (this.terrain.solid(c.x, y)) { hit = true; break; }
      if (hit) { c.y = y - 1; c.landed = true; c.vy = 0; } else c.y = ny;
    }
  }

  // A snail standing on or walking into a landed crate picks it up.
  checkCrates(s) {
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (!c.landed) continue;
      if (Math.abs(s.x - c.x) < 16 && s.y > c.y - 30 && s.y < c.y + 24) {
        this.crates.splice(i, 1);
        const team = this.teams[s.team];
        if (c.type === 'health') {
          s.hp = Math.min(100, s.hp + 35);
          this.say({ key: 'msg.heal', name: s.name }, 1.6);
          if (!this.headless) this.popups.push({ x: s.x, y: s.y - 40, text: '+35', life: 1.3, color: '#6cc25a' });
        } else {
          team.ammo[c.weapon] += 1;
          this.say({ key: 'msg.found', name: s.name, weapon: c.weapon }, 1.8);
          if (!this.headless) this.popups.push({ x: s.x, y: s.y - 40, text: WEAPON_BY_ID[c.weapon].icon, life: 1.3, color: '#fff' });
        }
        sfx.crate();
      }
    }
  }

  // Shot of the day is over: damage to the targets is the score, a cracked shell counts extra.
  dailyScore() {
    let score = 0;
    for (const s of this.teams[1].snails) score += s.alive ? 100 - s.hp : 150;
    return score;
  }
  dailyOver() {
    this.daily.score = this.dailyScore();
    this.gameOver(this.daily.score > 0 ? this.teams[0] : null);
  }

  gameOver(winner) {
    this.phase = 'over';
    this.active = null;
    this.winner = winner || null;
    if (this.daily) this.say({ key: 'msg.daily', score: this.daily.score }, 99);
    else this.say(winner ? { key: 'msg.win', name: winner.name } : { key: 'msg.draw' }, 99);
    sfx.win();
    this.deferred.push(() => this.hooks.onGameOver?.(winner));
  }

  // Messages are { key, ...params } objects; the UI translates them (js/i18n.js).
  say(msg, t = 2) { this.message = msg; this.messageTimer = t; }

  // UI weapon choice. It becomes an input and is applied by the simulation.
  selectWeapon(id) {
    if (this.ai || this.replay) return;
    if (this.weaponIds.has(id)) this.input.weapon = id;
  }

  // ---------- update ----------
  update(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    if (this.messageTimer > 0) this.messageTimer -= dt;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 30);
    for (const c of this.clouds) { c.x += c.v * dt; if (c.x > this.W + 200) c.x = -200; }

    if (this.phase === 'aim' || this.phase === 'retreat') {
      this.handleControl(dt);
    }
    if (this.phase === 'aim') {
      const before = Math.ceil(this.timer);
      this.timer -= dt;
      // countdown clicks for the last five seconds (audio only)
      if (this.timer > 0 && Math.ceil(this.timer) < before && before <= 5 && this.isLocalTurn() && !this.replay) sfx.tickLow();
      if (this.timer <= 0) { this.timer = 0; this.phase = 'settle'; this.settleTimer = 0; }
    } else if (this.phase === 'retreat') {
      this.timer -= dt;
      if (this.timer <= 0) { this.phase = 'settle'; this.settleTimer = 0; }
    }

    for (const s of this.snails) this.updateSnail(s, dt);
    // the active snail died mid-turn (rising water, fall, own blast): end the turn now
    if ((this.phase === 'aim' || this.phase === 'retreat') && this.active && !this.active.alive) {
      this.charging = false;
      this.phase = 'settle';
      this.settleTimer = 0;
    }
    this.updateProjectiles(dt);
    this.updateCrates(dt);
    for (const s of this.snails) if (s.alive) this.checkCrates(s);
    while (this.pendingBooms.length) { const b = this.pendingBooms.shift(); this.explosion(b.x, b.y, b.r, b.dmg, null, 0.6); }
    this.updateParticles(dt);

    if (this.phase === 'settle') {
      const busy = this.projectiles.length > 0 || this.pendingBooms.length > 0 || this.snails.some((s) => s.alive && (s.airborne || Math.abs(s.vx) > 1));
      if (busy) {
        this.settleTimer = 0;
      } else {
        // process deaths one at a time (chain reactions)
        const dying = this.snails.find((s) => s.alive && s.hp <= 0);
        if (dying) {
          this.settleTimer += dt;
          if (this.settleTimer > 0.5) {
            this.killSnail(dying);
            this.settleTimer = 0;
          }
        } else {
          this.settleTimer += dt;
          if (this.settleTimer > 0.9) this.startTurn();
        }
      }
    }
    this.updateCamera(dt);
    this.prevFire = this.frame.fire;
  }

  // A glossy dab of slime under a crawling snail every few pixels (visual only).
  leaveSlime(s) {
    const last = this.trailLast[s.id];
    if (last && Math.abs(last.x - s.x) < 4 && Math.abs(last.y - s.y) < 4) return;
    const p = { x: s.x, y: s.y + 1, life: 9, w: 5 + (s.id % 3) };
    this.trail.push(p);
    this.trailLast[s.id] = p;
    if (this.trail.length > 700) this.trail.shift();
  }

  killSnail(s) {
    s.alive = false;
    s.hp = 0;
    this.say({ key: 'msg.cracked', name: s.name }, 1.5);
    sfx.cracked();
    // the shell breaks into shards that fly off (visual only)
    if (!this.headless) for (let i = 0; i < 8; i++) {
      const a = -Math.PI * (0.15 + this.vrng() * 0.7), sp = 140 + this.vrng() * 220;
      this.particles.push({ x: s.x - 6, y: s.y - 15, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1.1 + this.vrng() * 0.6, grav: 1, fade: true,
        shard: 4 + this.vrng() * 5, rot: this.vrng() * 6.28, spin: (this.vrng() - 0.5) * 14, color: s.color });
    }
    this.explosion(s.x, s.y - 8, 30, 28, null);
    this.cam.target = s;
  }

  handleControl(dt) {
    const s = this.active;
    if (!s || !s.alive) return;
    const inp = this.frame;
    const team = this.teams[s.team];
    const aiming = this.phase === 'aim' && !this.hasFired;
    // the weapon choice is an input; apply it first so the rest of the tick sees it
    if (aiming && !this.charging && inp.weapon !== this.weaponId && this.weaponIds.has(inp.weapon) && team.ammo[inp.weapon] > 0) {
      this.weaponId = inp.weapon;
      if (WEAPON_BY_ID[inp.weapon].marker) this.markerX = clamp(s.x + s.facing * 160, 20, this.W - 20);
    }
    const marker = aiming && !!WEAPON_BY_ID[this.weaponId].marker;
    s.walking = false;
    if (!s.airborne) {
      if (inp.left || inp.right) {
        const dir = inp.right ? 1 : -1;
        if (marker) {
          // marker weapons: left/right move the target marker instead of the snail
          this.markerX = clamp(this.markerX + dir * 320 * dt, 20, this.W - 20);
        } else {
          s.facing = dir;
          if (!this.charging) {
            s.walking = true;
            s.walkAcc += WALK * dt;
            while (s.walkAcc >= 1) { s.walkAcc -= 1; if (!this.stepSnail(s, dir)) { s.walkAcc = 0; break; } }
            if (!this.headless) this.leaveSlime(s);
          }
        }
      }
      if (inp.jump && !this.charging) {
        inp.jump = false; // one-shot: consumed here…
        if (!this.replay) this.input.jump = false; // …and cleared in the live input so the recording agrees
        s.airborne = true;
        s.vy = -310;
        s.vx = s.facing * 130;
        s.y -= 1;
        sfx.jump();
      }
    }
    if (inp.up) s.aim = clamp(s.aim + 1.6 * dt, -1.45, 1.45);
    if (inp.down) s.aim = clamp(s.aim - 1.6 * dt, -1.45, 1.45);

    if (aiming) {
      const w = WEAPON_BY_ID[this.weaponId];
      const pressed = inp.fire && !this.prevFire;
      const released = !inp.fire && this.prevFire;
      if (w.charge) {
        if (pressed) { this.charging = true; this.power = 0; }
        if (this.charging) {
          this.power = Math.min(1, this.power + dt / 1.1);
          if (released || this.power >= 1) { this.fire(w, Math.max(0.15, this.power)); }
        }
      } else if (pressed) {
        // the hop needs solid, dry ground under the marker; otherwise nothing happens
        if (w.teleport && !this.teleportSpot(this.markerX)) sfx.tickLow();
        else this.fire(w, 1);
      }
    }
  }

  stepSnail(s, dir) {
    const t = this.terrain;
    const nx = s.x + dir;
    let r = s.y - CLIMB;
    if (t.solid(nx, r)) return false; // wall too high
    while (r <= s.y + CLIMB && !t.solid(nx, r)) r++;
    if (r > s.y + CLIMB) {
      // walked off an edge
      s.x = nx; s.airborne = true; s.vx = dir * 20; s.vy = 0; return true;
    }
    // head clearance
    if (t.solid(nx, r - 12) || t.solid(nx, r - HEAD_H)) return false;
    s.x = nx; s.y = r;
    return true;
  }

  onGround(s) {
    const t = this.terrain;
    return t.solid(s.x, s.y) || t.solid(s.x - 5, s.y) || t.solid(s.x + 5, s.y);
  }

  updateSnail(s, dt) {
    if (!s.alive) return;
    if (!s.airborne && !this.onGround(s)) { s.airborne = true; s.vy = 0; }
    if (s.airborne) {
      s.vy += G * dt;
      s.vx *= 1 - 0.4 * dt;
      const steps = Math.ceil(Math.max(Math.abs(s.vx), Math.abs(s.vy)) * dt / 2) || 1;
      const sx = (s.vx * dt) / steps, sy = (s.vy * dt) / steps;
      const t = this.terrain;
      for (let i = 0; i < steps; i++) {
        // horizontal
        const nx = s.x + sx;
        if (t.solid(nx + Math.sign(sx) * 6, s.y - 4) || t.solid(nx + Math.sign(sx) * 6, s.y - 16)) {
          s.vx = -s.vx * 0.35;
        } else s.x = nx;
        // vertical
        const ny = s.y + sy;
        if (sy > 0) {
          const g = t.solid(s.x, Math.ceil(ny)) || t.solid(s.x - 5, Math.ceil(ny)) || t.solid(s.x + 5, Math.ceil(ny));
          if (g) {
            // land
            let ly = Math.floor(s.y);
            while (ly < Math.ceil(ny) && !(t.solid(s.x, ly) || t.solid(s.x - 5, ly) || t.solid(s.x + 5, ly))) ly++;
            s.y = ly;
            s.airborne = false;
            if (s.vy > 420) {
              const dmg = Math.round((s.vy - 420) / 9);
              this.damage(s, dmg, 'fall');
            }
            s.vx = 0; s.vy = 0;
            break;
          } else s.y = ny;
        } else if (sy < 0) {
          if (t.solid(s.x, ny - HEAD_H)) { s.vy = 0; } else s.y = ny;
        }
      }
      s.x = clamp(s.x, 4, this.W - 4);
      if (s.y > this.waterY + 10) this.drown(s);
    } else if (s.y > this.waterY + 4) {
      this.drown(s);
    }
  }

  drown(s) {
    if (!s.alive) return;
    s.alive = false; s.hp = 0; s.airborne = false;
    this.say({ key: 'msg.drowned', name: s.name }, 1.6);
    sfx.splash();
    if (this.headless) return;
    for (let i = 0; i < 18; i++) this.particles.push({
      x: s.x + (this.vrng() - 0.5) * 20, y: this.waterY, vx: (this.vrng() - 0.5) * 200, vy: -150 - this.vrng() * 250,
      life: 0.7 + this.vrng() * 0.5, r: 2 + this.vrng() * 3, color: '#a8d8ff', grav: 1,
    });
  }

  damage(s, amount, kind) {
    if (!s.alive || amount <= 0) return;
    const wasUp = s.hp > 0;
    s.hp = Math.max(0, s.hp - amount);
    if (!this.headless) this.popups.push({ x: s.x, y: s.y - 40, text: `-${amount}`, life: 1.3, color: s.color });
    sfx.hurt();
    // a kill shot on a snail that was still standing: show it in slow motion (visual only)
    if (wasUp && s.hp <= 0 && kind === 'blast' && !this.headless && !this.replay && this.slowmo <= 0) {
      this.slowmo = SLOWMO_TIME;
      this.cam.target = s;
      sfx.slowmo();
    }
  }

  // ---------- weapons ----------
  headPos(s) { return { x: s.x + s.facing * 14, y: s.y - 21 }; }
  aimDir(s) { return { x: dcos(s.aim) * s.facing, y: -dsin(s.aim) }; }

  fire(w, power) {
    const s = this.active;
    this.charging = false;
    this.hasFired = true;
    this.phase = 'retreat';
    this.timer = RETREAT_TIME;
    this.cam.manual = false;
    const h = this.headPos(s), d = this.aimDir(s);
    const team = this.teams[s.team];
    if (team.ammo[w.id] !== Infinity) team.ammo[w.id] = Math.max(0, team.ammo[w.id] - 1);
    if (w.speed) {
      const p = {
        type: w.id, x: h.x + d.x * 18, y: h.y + d.y * 18, vx: d.x * w.speed * power, vy: d.y * w.speed * power,
        fuse: w.fuse ?? 0, age: 0, owner: s, rot: 0, rest: false,
      };
      this.projectiles.push(p);
      this.cam.target = p;
      sfx.shoot();
    } else if (w.id === 'salt') {
      this.fireSalt(s, h, d, w);
    } else if (w.id === 'dynamit') {
      const p = { type: 'dynamit', x: s.x + s.facing * 10, y: s.y - 6, vx: 0, vy: 0, fuse: w.fuse, age: 0, owner: s, rot: 0, rest: false };
      this.projectiles.push(p);
      this.cam.target = s;
    } else if (w.id === 'saltregn') {
      this.fireSaltRain(this.markerX, w);
    } else if (w.melee) {
      this.shove(s, w);
    } else if (w.teleport) {
      this.teleport(s, this.markerX);
    }
    this.hooks.onFire?.(this);
  }

  // Shell shove: every snail right in front of the active one takes a hit and flies.
  shove(s, w) {
    sfx.shove();
    this.cam.target = s;
    for (const o of this.snails) {
      if (!o.alive || o === s) continue;
      const dx = (o.x - s.x) * s.facing;
      if (dx < -6 || dx > w.range || Math.abs(o.y - s.y) > 34) continue;
      this.damage(o, w.dmg, 'blast');
      o.vx += s.facing * w.push;
      o.vy -= w.lift;
      o.airborne = true;
      o.y -= 2;
      if (!this.headless) this.popups.push({ x: o.x, y: o.y - 56, text: '💥', life: 0.8, color: '#fff' });
    }
    if (!this.headless) this.particles.push({ x: s.x + s.facing * 20, y: s.y - 14, vx: s.facing * 60, vy: 0, life: 0.22, r: 12, color: 'rgba(255,255,255,0.7)', grow: 2, fade: true });
  }

  // Where a snail lands if it hops to x: the top surface there, if it is dry and has headroom.
  teleportSpot(x) {
    x = Math.round(clamp(x, 20, this.W - 20));
    const gy = this.terrain.groundBelow(x, 0);
    if (gy <= 0 || gy > this.waterY - 4) return null;
    for (let y = gy - 4; y > gy - HEAD_H; y -= 4) if (this.terrain.solid(x, y)) return null;
    if (this.snailAt(x, gy - 10, this.active)) return null;
    return { x, y: gy };
  }

  teleport(s, x) {
    const spot = this.teleportSpot(x);
    if (spot) {
      if (!this.headless) this.sparkle(s.x, s.y - 14);
      s.x = spot.x; s.y = spot.y; s.vx = 0; s.vy = 0; s.airborne = false; s.walkAcc = 0;
      if (!this.headless) this.sparkle(s.x, s.y - 14);
      sfx.teleport();
    }
    this.cam.target = s;
    this.timer = 1; // the hop is the turn
  }

  sparkle(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = this.vrng() * Math.PI * 2, sp = 30 + this.vrng() * 90;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.4 + this.vrng() * 0.4, r: 2 + this.vrng() * 2, color: this.vrng() < 0.5 ? '#c8ff6a' : '#ffffff', fade: true });
    }
  }

  // Salt rain: a handful of salt crystals fall from the sky around the marker.
  fireSaltRain(x, w) {
    for (let i = 0; i < w.drops; i++) {
      const dx = (i - (w.drops - 1) / 2) * 24 + (this.rng() - 0.5) * 10;
      const p = { type: 'saltregn', x: clamp(x + dx, 2, this.W - 2), y: -30 - i * 18, vx: 0, vy: 160, fuse: 0, age: 0, owner: null, rot: 0, rest: false };
      this.projectiles.push(p);
    }
    this.cam.target = this.projectiles[this.projectiles.length - 1];
    sfx.shoot();
  }

  fireSalt(s, h, d, w) {
    sfx.salt();
    const spread = [-0.07, 0, 0.07];
    for (const sp of spread) {
      // rotate the aim vector by the spread angle (no atan2 needed)
      const cs = dcos(sp), sn = dsin(sp);
      const dx = d.x * cs - d.y * sn, dy = d.x * sn + d.y * cs;
      let x = h.x + dx * 14, y = h.y + dy * 14;
      let hit = false;
      for (let i = 0; i < w.range; i += 2) {
        x += dx * 2; y += dy * 2;
        if (this.terrain.solid(x, y) || this.snailAt(x, y, s)) { hit = true; break; }
      }
      // tracer
      if (!this.headless) this.particles.push({ x: h.x, y: h.y, x2: x, y2: y, life: 0.12, line: true, color: '#fff' });
      if (hit) this.explosion(x, y, w.radius, w.dmg, s, 0.4);
      else if (!this.headless) this.particles.push({ x, y, vx: 0, vy: 0, life: 0.2, r: 3, color: '#fff' });
    }
  }

  snailAt(x, y, exclude) {
    for (const s of this.snails) {
      if (!s.alive || s === exclude) continue;
      if (Math.abs(x - s.x) < 13 && y < s.y + 2 && y > s.y - 32) return s;
    }
    return null;
  }

  // One physics step for a projectile. Returns 'explode' | 'remove' | null.
  // `sim` = dry run for the AI (no terrain damage, no sound).
  stepProjectile(p, dt, sim = false) {
    const w = WEAPON_BY_ID[p.type];
    p.age += dt;
    if (p.rest) {
      if (p.stuckTo) { p.x = p.stuckTo.x + p.dx; p.y = p.stuckTo.y + p.dy; }
      if (p.fuse && p.age >= p.fuse) return 'explode';
      return null;
    }
    const wl = this.rulesVersion >= 4 ? WIND_LEVELS[this.rules.wind] : WIND_LEVELS.normal;
    if (w.wind || wl.all) p.vx += this.wind * WIND_FORCE * wl.force * dt;
    p.vy += G * dt;
    const steps = Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy)) * dt / 2) || 1;
    const sx = (p.vx * dt) / steps, sy = (p.vy * dt) / steps;
    for (let i = 0; i < steps; i++) {
      const nx = p.x + sx, ny = p.y + sy;
      if (ny > this.waterY + 6) return 'remove';
      if (nx < -200 || nx > this.W + 200 || ny > this.H + 200) return 'remove';
      const hitSnail = p.age > 0.12 || p.type !== 'bazooka' ? this.snailAt(nx, ny, p.age < 0.25 ? p.owner : null) : null;
      if (this.terrain.solid(nx, ny) || ((w.contact || w.sticky) && hitSnail)) {
        if (w.contact) { p.x = nx; p.y = ny; return 'explode'; }
        if (w.sticky) {
          // slime sticks where it lands, or to the snail it hits (and follows it)
          if (hitSnail) { p.stuckTo = hitSnail; p.dx = p.x - hitSnail.x; p.dy = p.y - hitSnail.y; }
          p.rest = true; p.vx = 0; p.vy = 0;
          if (!sim) sfx.splat();
          break;
        }
        // bounce: estimate surface normal
        let nxs = 0, nys = 0;
        for (const u of RING16) {
          const px = nx + u.x * 4, py = ny + u.y * 4;
          if (this.terrain.solid(px, py) || (hitSnail && Math.abs(px - hitSnail.x) < 13 && py < hitSnail.y + 2 && py > hitSnail.y - 32)) { nxs -= u.x; nys -= u.y; }
        }
        const len = dhypot(nxs, nys) || 1;
        nxs /= len; nys /= len;
        if (len < 0.01) { nxs = 0; nys = -1; }
        const dot = p.vx * nxs + p.vy * nys;
        p.vx = (p.vx - 2 * dot * nxs) * w.bounce;
        p.vy = (p.vy - 2 * dot * nys) * w.bounce;
        p.vx *= 0.85;
        // push out
        p.x += nxs * 2; p.y += nys * 2;
        if (!sim) sfx.bounce();
        if (dhypot(p.vx, p.vy) < 25) { p.rest = true; p.vx = 0; p.vy = 0; }
        break;
      }
      p.x = nx; p.y = ny;
    }
    p.rot = Math.atan2(p.vy, p.vx);
    if (p.fuse && p.age >= p.fuse) return 'explode';
    return null;
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (p.type === 'dynamit') {
        // dynamite just sits (and falls if ground vanishes)
        if (!this.terrain.solid(p.x, p.y + 1)) { p.vy += G * dt; p.y += p.vy * dt; } else p.vy = 0;
        p.age += dt;
        if (p.y > this.waterY + 6) { this.projectiles.splice(i, 1); continue; }
        if (p.age >= p.fuse) {
          const w = WEAPON_BY_ID.dynamit;
          this.projectiles.splice(i, 1);
          this.explosion(p.x, p.y - 4, w.radius, w.dmg, null);
        }
        continue;
      }
      if (p.type === 'bazooka' && !this.headless && this.tickCount % 3 === 0) {
        this.particles.push({ x: p.x, y: p.y, vx: (this.vrng() - 0.5) * 20, vy: -20, life: 0.5, r: 3, color: 'rgba(200,200,200,0.7)', grow: 1 });
      }
      const res = this.stepProjectile(p, dt);
      if (res === 'explode') {
        const w = WEAPON_BY_ID[p.type];
        this.projectiles.splice(i, 1);
        this.explosion(p.x, p.y, w.radius, w.dmg, null);
      } else if (res === 'remove') {
        this.projectiles.splice(i, 1);
        if (p.y > this.waterY) {
          sfx.splash();
          this.say({ key: 'msg.splash' }, 1);
          if (!this.headless) for (let k = 0; k < 10; k++) this.particles.push({ x: p.x, y: this.waterY, vx: (this.vrng() - 0.5) * 150, vy: -100 - this.vrng() * 200, life: 0.6, r: 2 + this.vrng() * 2, color: '#a8d8ff', grav: 1 });
        }
      }
    }
  }

  explosion(x, y, r, dmg, shooter, sizeMul = 1) {
    this.terrain.explode(x, y, r);
    this.shake = Math.min(20, r * 0.35);
    if (r >= 20) this.cameraPunch(x, y, r);
    sfx.explode(sizeMul);
    // crates in the blast go off next tick
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (dhypot(c.x - x, c.y - 8 - y) < r + 10) { this.crates.splice(i, 1); this.pendingBooms.push({ x: c.x, y: c.y - 8, r: 22, dmg: 20 }); }
    }
    const reach = r * 1.5;
    for (const s of this.snails) {
      if (!s.alive) continue;
      const cx = s.x, cy = s.y - 10;
      const d = dhypot(cx - x, cy - y);
      if (d > reach) continue;
      const k = 1 - d / reach;
      const amount = Math.round(dmg * clamp(k * 1.25, 0, 1));
      this.damage(s, amount, 'blast');
      const nx = (cx - x) / (d || 1), ny = (cy - y) / (d || 1);
      const push = k * 330 * (0.6 + 0.4 * sizeMul);
      s.vx += nx * push;
      s.vy += ny * push - 90 * k;
      s.airborne = true;
      s.y -= 2;
    }
    // particles (visual only)
    if (this.headless) return;
    const n = Math.round(r * 0.9);
    for (let i = 0; i < n; i++) {
      const a = this.vrng() * Math.PI * 2, sp = this.vrng() * r * 8;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 100, life: 0.5 + this.vrng() * 0.7,
        r: 2 + this.vrng() * 4, color: this.vrng() < 0.5 ? '#6e4324' : '#3a2210', grav: 1,
      });
    }
    for (let i = 0; i < 8; i++) {
      const a = this.vrng() * Math.PI * 2, sp = this.vrng() * 60;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.6 + this.vrng() * 0.5,
        r: r * 0.25, color: 'rgba(255,190,80,0.8)', grow: 2, fade: true,
      });
    }
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.25, flash: r, color: '#fff' });
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      if (p.line || p.flash) continue;
      if (p.grav) p.vy += G * 0.6 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grow) p.r += p.grow * 8 * dt;
      if (p.shard) { p.rot += p.spin * dt; if (this.terrain.solid(p.x, p.y)) { p.vx *= 0.5; p.vy = -Math.abs(p.vy) * 0.3; p.spin *= 0.5; p.y -= 1; } }
    }
    if (!this.headless) for (let i = this.trail.length - 1; i >= 0; i--) { this.trail[i].life -= dt; if (this.trail[i].life <= 0) this.trail.splice(i, 1); }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= dt; p.y -= 30 * dt;
      if (p.life <= 0) this.popups.splice(i, 1);
    }
  }

  // Camera "punch": zoom in quickly on an explosion, hold, then ease back out
  // slowly. Called from explosion(); purely visual.
  cameraPunch(x, y, r) {
    const cam = this.cam;
    if (!this.canvas || cam.manual) return;
    if (!cam.punch) cam.punch = { base: cam.zoom, x, y, t: 0, amount: 0 };
    else { cam.punch.x = x; cam.punch.y = y; cam.punch.t = Math.min(cam.punch.t, PUNCH_IN); }
    cam.punch.amount = Math.max(cam.punch.amount, Math.min(0.7, 0.25 + r * 0.007));
  }

  updateCamera(dt) {
    if (!this.canvas) return;
    const cam = this.cam;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const minZoom = Math.max(cw / this.W, ch / this.H);
    let punchK = 0;
    if (cam.punch) {
      const p = cam.punch;
      p.t += dt;
      if (cam.manual || p.t > PUNCH_IN + PUNCH_HOLD + PUNCH_OUT) {
        if (!cam.manual) cam.zoom = p.base;
        cam.punch = null;
      } else {
        if (p.t < PUNCH_IN) punchK = easeOut(p.t / PUNCH_IN);
        else if (p.t < PUNCH_IN + PUNCH_HOLD) punchK = 1;
        else punchK = 1 - easeInOut((p.t - PUNCH_IN - PUNCH_HOLD) / PUNCH_OUT);
        cam.zoom = p.base * (1 + p.amount * punchK);
      }
    }
    cam.zoom = clamp(cam.zoom, minZoom, 3);
    if (!cam.manual) {
      let tgt = cam.target;
      if (this.projectiles.length) tgt = this.projectiles[this.projectiles.length - 1];
      else if (this.phase === 'aim' && this.active && !this.hasFired && WEAPON_BY_ID[this.weaponId].marker) tgt = { x: this.markerX, y: this.active.y - 80 };
      else if (this.phase === 'aim' || this.phase === 'retreat') tgt = this.active;
      if (cam.punch && punchK > 0) {
        // while zoomed in, look at the explosion instead of the next target
        const t2 = tgt ? { x: lerp(tgt.x, cam.punch.x, punchK), y: lerp(tgt.y - 40, cam.punch.y, punchK) } : { x: cam.punch.x, y: cam.punch.y };
        const k = 1 - Math.pow(0.001, dt);
        cam.x = lerp(cam.x, t2.x, k);
        cam.y = lerp(cam.y, t2.y, k);
      } else if (tgt) {
        // slower glide back after a punch, snappier otherwise
        const k = 1 - Math.pow(cam.punch ? 0.1 : 0.02, dt);
        cam.x = lerp(cam.x, tgt.x, k);
        cam.y = lerp(cam.y, tgt.y - 40, k);
      }
    }
    const hw = cw / cam.zoom / 2, hh = ch / cam.zoom / 2;
    cam.x = clamp(cam.x, hw, this.W - hw);
    cam.y = clamp(cam.y, hh, this.H - hh);
  }

  // ---------- AI ----------
  simulateShot(weaponId, s, aim, power, facing) {
    const w = WEAPON_BY_ID[weaponId];
    const h = { x: s.x + facing * 14, y: s.y - 21 };
    const d = { x: dcos(aim) * facing, y: -dsin(aim) };
    const p = { type: weaponId, x: h.x + d.x * 18, y: h.y + d.y * 18, vx: d.x * w.speed * power, vy: d.y * w.speed * power, fuse: w.fuse ?? 0, age: 0, owner: s, rest: false };
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 7; i++) {
      const r = this.stepProjectile(p, dt, true);
      if (r === 'explode') return { x: p.x, y: p.y };
      if (r === 'remove') return null;
    }
    return null;
  }

  // Points along the predicted path for the current aim/power (human aiming aid).
  previewPath(s, weaponId, power) {
    const w = WEAPON_BY_ID[weaponId];
    const h = this.headPos(s), d = this.aimDir(s);
    const pts = [];
    if (weaponId === 'salt') {
      pts.push({ x: h.x + d.x * 14, y: h.y + d.y * 14 });
      let x = h.x + d.x * 14, y = h.y + d.y * 14;
      for (let i = 0; i < w.range; i += 2) {
        x += d.x * 2; y += d.y * 2;
        if (this.terrain.solid(x, y) || this.snailAt(x, y, s)) break;
      }
      pts.push({ x, y });
      return pts;
    }
    if (!w.speed) return pts;
    const p = { type: weaponId, x: h.x + d.x * 18, y: h.y + d.y * 18, vx: d.x * w.speed * power, vy: d.y * w.speed * power, fuse: 0, age: 0, owner: s, rest: false };
    const dt = 1 / 60;
    const maxSteps = weaponId === 'granat' ? 75 : 110;
    for (let i = 0; i < maxSteps; i++) {
      if (i % 3 === 0) pts.push({ x: p.x, y: p.y });
      const r = this.stepProjectile(p, dt, true);
      if (r === 'explode' || (w.fuse && (p.rest || Math.abs(p.vx) + Math.abs(p.vy) < 60 && i > 5))) { pts.push({ x: p.x, y: p.y, hit: true }); break; }
      if (r === 'remove') break;
    }
    return pts;
  }

  planShot(s, target, forceFacing = 0, level = AI_LEVELS.normal) {
    const facing = forceFacing || Math.sign(target.x - s.x) || s.facing;
    const team = this.teams[s.team];
    let best = null;
    for (const wid of ['bazooka', 'granat', 'slem']) {
      const w = WEAPON_BY_ID[wid];
      if (!(team.ammo[wid] > 0)) continue;
      for (let ai = -60; ai <= 80; ai += level.aimStep) {
        const aim = (ai * Math.PI) / 180;
        for (let pw = 0.3; pw <= 1.001; pw += level.powerStep) {
          const hit = this.simulateShot(wid, s, aim, pw, facing);
          if (!hit) continue;
          const dself = dhypot(hit.x - s.x, hit.y - (s.y - 10));
          if (dself < w.radius * 1.6) continue;
          const dt = dhypot(hit.x - target.x, hit.y - (target.y - 10));
          // prefer hits that also don't splash friends
          let friendly = 0;
          for (const o of this.snails) if (o.alive && o.team === s.team && o !== s) {
            const df = dhypot(hit.x - o.x, hit.y - (o.y - 10));
            if (df < w.radius * 1.5) friendly += 40;
          }
          let score = dt + friendly + (wid === 'granat' ? 8 : wid === 'slem' ? 4 : 0);
          let value = 0;
          if (level.smart) {
            // hard: judge a shot by the damage it would do to everyone, kills and friends included
            value = this.blastValue(hit.x, hit.y, w, s.team);
            score = -value + (wid === 'granat' ? 3 : wid === 'slem' ? 2 : 0);
          }
          if (!best || score < best.score) best = { weapon: wid, aim, power: pw, facing, score, dist: dt, value };
        }
      }
    }
    return best;
  }

  // Expected damage of a blast at (x, y): enemies count, a kill counts extra,
  // friends count against. Mirrors explosion()'s falloff.
  blastValue(x, y, w, myTeam) {
    let v = 0;
    const reach = w.radius * 1.5;
    for (const o of this.snails) {
      if (!o.alive) continue;
      const d = dhypot(o.x - x, o.y - 10 - y);
      if (d > reach) continue;
      const dmg = Math.round(w.dmg * clamp((1 - d / reach) * 1.25, 0, 1));
      if (o.team === myTeam) v -= dmg * 1.5;
      else v += dmg + (dmg >= o.hp ? 45 : 0) + (o.y > this.waterY - 60 ? 10 : 0);
    }
    return v;
  }

  updateAI(dt) {
    const ai = this.ai, s = this.active;
    if (!ai || !s || !s.alive || this.hasFired) return;
    const inp = this.input;
    inp.left = inp.right = inp.up = inp.down = false;
    ai.t += dt;
    const enemies = this.snails.filter((o) => o.alive && o.team !== s.team);
    if (!enemies.length) return;
    const lvl = ai.level || AI_LEVELS.normal;
    // nearest enemy, or (hard) the one that is easiest to finish off
    if (!ai.target) ai.target = enemies.reduce((a, b) => {
      const da = dhypot(a.x - s.x, a.y - s.y), db = dhypot(b.x - s.x, b.y - s.y);
      if (lvl.weakest) return a.hp + da * 0.15 <= b.hp + db * 0.15 ? a : b;
      return da < db ? a : b;
    });
    const tgt = ai.target;
    const dist = dhypot(tgt.x - s.x, tgt.y - s.y);
    // Turning is a one-tick tap sideways (moves 1 px), so only turn where the
    // ground continues; otherwise plan with the current facing.
    const wantFacing = Math.sign(tgt.x - s.x) || s.facing;
    const canTurn = wantFacing === s.facing || this.terrain.groundBelow(s.x + wantFacing, s.y - CLIMB, CLIMB * 2 + 1) > 0;

    if (ai.state === 'think') {
      if (ai.t < lvl.think) return;
      ai.t = 0;
      // close-range options first
      const team = this.teams[s.team];
      if (canTurn && this.weaponIds.has('skalstot') && dist < WEAPON_BY_ID.skalstot.range + 4 && Math.abs(tgt.y - s.y) < 30 && lvl.specials) {
        ai.plan = { weapon: 'skalstot', facing: wantFacing, aim: s.aim, power: 1 };
        ai.state = 'aim'; return;
      }
      if (canTurn && dist < 60 && Math.abs(tgt.y - s.y) < 30 && team.ammo.dynamit > 0 && lvl.specials) {
        ai.plan = { weapon: 'dynamit', facing: wantFacing, aim: 0, power: 1 };
        ai.state = 'aim'; return;
      }
      if (lvl.specials && team.ammo.saltregn > 0 && this.openToSky(tgt) && !this.snails.some((o) => o.alive && o.team === s.team && Math.abs(o.x - tgt.x) < 80 && Math.abs(o.y - tgt.y) < 60)) {
        ai.plan = { weapon: 'saltregn', markerX: tgt.x, facing: s.facing, aim: s.aim, power: 1 };
        ai.state = 'aim'; return;
      }
      if (canTurn && dist < 200 && this.lineOfSight(s, tgt)) {
        const aim = datan2(-(tgt.y - 12 - (s.y - 18)), Math.abs(tgt.x - s.x));
        ai.plan = { weapon: 'salt', facing: wantFacing, aim: clamp(aim, -1.45, 1.45), power: 1 };
        ai.state = 'aim'; return;
      }
      let plan = this.planShot(s, tgt, canTurn ? 0 : s.facing, lvl);
      // hard: shoot whichever enemy the best shot reaches, not just the nearest
      if (lvl.pickBest) {
        for (const e of enemies) {
          if (e === tgt) continue;
          const p2 = this.planShot(s, e, canTurn ? 0 : s.facing, lvl);
          if (p2 && (!plan || p2.score < plan.score)) { plan = p2; ai.target = e; }
        }
      }
      const good = plan && (lvl.smart ? plan.value >= lvl.fireValue : plan.dist < lvl.fireDist);
      if (plan && (good || ai.tries >= 2 || this.timer < 12)) {
        // weaker levels wobble a little around the plan
        if (lvl.error > 0) {
          plan.aim = clamp(plan.aim + (this.airng() * 2 - 1) * lvl.error, -1.45, 1.45);
          plan.power = clamp(plan.power * (1 + (this.airng() * 2 - 1) * lvl.error), 0.15, 1);
          plan.noisy = true;
        }
        ai.plan = plan; ai.state = 'aim'; return;
      }
      // no good shot from here: a hop to a better spot beats walking (hard/normal, once per match per crate)
      if (lvl.specials && ai.tries >= 1 && team.ammo.snigelhopp > 0) {
        const spot = this.hopSpotNear(s, tgt);
        if (spot) { ai.plan = { weapon: 'snigelhopp', markerX: spot.x, facing: s.facing, aim: s.aim, power: 1 }; ai.state = 'aim'; return; }
      }
      ai.bestPlan = plan;
      ai.tries++;
      ai.state = 'walk'; ai.walkT = 1.2 + this.airng() * 1.5;
      ai.walkDir = Math.sign(tgt.x - s.x) || 1;
      if (this.airng() < 0.3) ai.walkDir *= -1;
      return;
    }
    if (ai.state === 'walk') {
      ai.walkT -= dt;
      // don't walk off cliffs into the water
      const aheadGround = this.terrain.groundBelow(s.x + ai.walkDir * 6, s.y - CLIMB, 60);
      const safe = aheadGround > 0 && aheadGround < this.waterY - 20 && !this.terrain.solid(s.x + ai.walkDir * 6, s.y - CLIMB);
      if (!safe || ai.walkT <= 0 || s.airborne) {
        ai.state = 'think'; ai.t = 0.4;
        if (!safe && ai.walkT > 0.3) ai.tries++;
        return;
      }
      if (ai.walkDir > 0) inp.right = true; else inp.left = true;
      return;
    }
    if (ai.state === 'aim') {
      // Everything goes through inputs so the recording reproduces the turn.
      const plan = ai.plan;
      inp.weapon = plan.weapon;
      if (WEAPON_BY_ID[plan.weapon].marker) {
        if (this.weaponId !== plan.weapon) return; // wait for the sim to apply the weapon and place the marker
        const d = plan.markerX - this.markerX;
        if (Math.abs(d) > 4) { if (d > 0) inp.right = true; else inp.left = true; return; }
        ai.state = 'charge'; ai.t = 0;
        inp.fire = true;
        return;
      }
      if (s.facing !== plan.facing) { if (plan.facing > 0) inp.right = true; else inp.left = true; return; }
      const diff = plan.aim - s.aim;
      if (Math.abs(diff) > 0.015) { if (diff > 0) inp.up = true; else inp.down = true; return; }
      // the aim lands within one step of the plan; re-pick the power for the actual angle
      if (WEAPON_BY_ID[plan.weapon].speed && ai.target && (ai.level?.repick ?? true) && !plan.noisy) {
        let best = null;
        for (let pw = 0.15; pw <= 1.001; pw += 0.05) {
          const hit = this.simulateShot(plan.weapon, s, s.aim, pw, s.facing);
          if (!hit) continue;
          const d = dhypot(hit.x - ai.target.x, hit.y - (ai.target.y - 10));
          if (dhypot(hit.x - s.x, hit.y - (s.y - 10)) < WEAPON_BY_ID[plan.weapon].radius * 1.6) continue;
          if (!best || d < best.d) best = { d, pw };
        }
        if (best) plan.power = best.pw;
      }
      ai.state = 'charge'; ai.t = 0;
      inp.fire = true;
      return;
    }
    if (ai.state === 'charge') {
      const w = WEAPON_BY_ID[this.weaponId];
      if (!w.charge) { inp.fire = false; ai.state = 'done'; return; }
      if (this.power >= plan_power(ai) - 0.02) { inp.fire = false; ai.state = 'done'; }
      return;
    }
    if (ai.state === 'done') {
      inp.fire = false;
      // retreat a little after dynamite
      if (ai.plan?.weapon === 'dynamit') { if (ai.plan.facing > 0) inp.left = true; else inp.right = true; }
    }
  }

  // A dry spot within hopping distance that has a clear line of sight to the target.
  hopSpotNear(s, tgt) {
    let best = null;
    for (let dx = -300; dx <= 300; dx += 40) {
      const x = tgt.x + dx;
      if (Math.abs(dx) < 90 || x < 30 || x > this.W - 30) continue;
      const spot = this.teleportSpot(x);
      if (!spot || !this.lineOfSight({ x: spot.x, y: spot.y }, tgt)) continue;
      const score = Math.abs(Math.abs(dx) - 170) + (spot.y > tgt.y ? 40 : 0); // mid range, preferably higher up
      if (!best || score < best.score) best = { ...spot, score };
    }
    return best;
  }

  // Nothing solid between the sky and the snail's head.
  openToSky(t) {
    for (let y = t.y - 34; y >= 0; y -= 4) if (this.terrain.solid(t.x, y)) return false;
    return true;
  }

  lineOfSight(a, b) {
    const x0 = a.x, y0 = a.y - 14, x1 = b.x, y1 = b.y - 14;
    const n = Math.ceil(dhypot(x1 - x0, y1 - y0) / 3);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      if (this.terrain.solid(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)) return false;
    }
    return true;
  }

  // ---------- render ----------
  render() {
    if (!this.ctx) return;
    const { ctx, canvas, cam } = this;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // sky
    const th = this.theme;
    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, th.sky[0]);
    sky.addColorStop(0.6, th.sky[1]);
    sky.addColorStop(1, th.sky[2]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);
    // sun
    ctx.fillStyle = th.sun;
    ctx.beginPath(); ctx.arc(cw * 0.82, ch * 0.16, 36, 0, Math.PI * 2); ctx.fill();

    const shx = this.shake ? (this.vrng() - 0.5) * this.shake : 0;
    const shy = this.shake ? (this.vrng() - 0.5) * this.shake : 0;
    const ox = cw / 2 - cam.x * cam.zoom + shx, oy = ch / 2 - cam.y * cam.zoom + shy;

    // parallax hills
    this.drawHills(ctx, cw, ch, ox * 0.25, oy * 0.25, th.hills[0], 0.5);
    this.drawHills(ctx, cw, ch, ox * 0.5, oy * 0.5, th.hills[1], 0.62);
    // clouds
    ctx.fillStyle = th.cloud;
    for (const c of this.clouds) {
      const x = c.x * cam.zoom * 0.6 + ox * 0.6, y = c.y * cam.zoom * 0.6 + oy * 0.6;
      const r = 18 * c.s * cam.zoom;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.arc(x + r, y + r * 0.3, r * 0.8, 0, Math.PI * 2);
      ctx.arc(x - r, y + r * 0.3, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.drawImage(this.terrain.canvas, 0, 0);

    // slime trail: glossy dabs that dry out over a few seconds
    for (const p of this.trail) {
      const a = Math.min(1, p.life / 4) * 0.5;
      ctx.fillStyle = `rgba(${th.slime},${a})`;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.w, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${a * 0.6})`;
      ctx.beginPath(); ctx.ellipse(p.x - p.w * 0.3, p.y - 0.8, p.w * 0.35, 0.8, 0, 0, Math.PI * 2); ctx.fill();
    }
    // snails
    for (const s of this.snails) {
      if (!s.alive) { drawSnail(ctx, this.style, { x: s.x, y: s.y, facing: s.facing, color: s.color, t: this.time, dead: true, scale: SNAIL_SCALE }); continue; }
      drawSnail(ctx, this.style, { x: s.x, y: s.y, facing: s.facing, color: s.color, t: this.time + s.id, walking: s.walking, aim: s === this.active ? s.aim : 0, scale: SNAIL_SCALE, look: this.teams[s.team].look, hp: s.hp });
      // label
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const label = s.name;
      const tw = ctx.measureText(label).width + 10;
      const ly = s.y - 50;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, s.x - tw / 2, ly - 9, tw, 12, 4); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, s.x, ly);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, s.x - 16, ly + 4, 32, 9, 3); ctx.fill();
      ctx.fillStyle = s.color;
      roundRect(ctx, s.x - 15, ly + 5, 30 * (s.hp / 100), 7, 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 7px system-ui, sans-serif';
      ctx.fillText(s.hp, s.x, ly + 11);
      if (s === this.active && this.phase !== 'over') {
        const by = ly - 22 + Math.sin(this.time * 6) * 3;
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.moveTo(s.x - 6, by - 8); ctx.lineTo(s.x + 6, by - 8); ctx.lineTo(s.x, by); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // crates
    for (const c of this.crates) {
      ctx.save();
      ctx.translate(c.x, c.y);
      if (!c.landed && c.chute) {
        ctx.fillStyle = c.type === 'health' ? '#ff8a80' : '#ffd54f';
        ctx.beginPath(); ctx.arc(0, -38, 17, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-17, -38); ctx.lineTo(-8, -16); ctx.moveTo(17, -38); ctx.lineTo(8, -16); ctx.moveTo(0, -38); ctx.lineTo(0, -16); ctx.stroke();
      }
      ctx.fillStyle = '#c48a4a';
      ctx.fillRect(-9, -16, 18, 16);
      ctx.strokeStyle = '#6e4324'; ctx.lineWidth = 1.5;
      ctx.strokeRect(-9, -16, 18, 16);
      ctx.beginPath(); ctx.moveTo(-9, -8); ctx.lineTo(9, -8); ctx.moveTo(0, -16); ctx.lineTo(0, 0); ctx.stroke();
      if (c.type === 'health') {
        ctx.fillStyle = '#e2453c';
        ctx.fillRect(-2, -13, 4, 10); ctx.fillRect(-5, -10, 10, 4);
      } else {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('?', 0, -4);
      }
      ctx.restore();
    }

    // aim crosshair + trajectory preview
    const a = this.active;
    if (a && a.alive && this.phase === 'aim' && !this.hasFired && WEAPON_BY_ID[this.weaponId].teleport) {
      // landing marker for the snail hop: green where it works, red where it does not
      const mx = this.markerX, spot = this.teleportSpot(mx), gy = spot ? spot.y : this.terrain.groundBelow(mx, 0);
      const ly = gy > 0 ? gy : this.waterY;
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = spot ? 'rgba(200,255,106,0.9)' : 'rgba(255,90,60,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mx, ly - 70); ctx.lineTo(mx, ly - 4); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.ellipse(mx, ly, 18, 6, 0, 0, Math.PI * 2); ctx.stroke();
      if (!spot) { ctx.beginPath(); ctx.moveTo(mx - 8, ly - 44); ctx.lineTo(mx + 8, ly - 28); ctx.moveTo(mx + 8, ly - 44); ctx.lineTo(mx - 8, ly - 28); ctx.stroke(); }
    } else if (a && a.alive && this.phase === 'aim' && !this.hasFired && WEAPON_BY_ID[this.weaponId].marker) {
      // ground marker for salt rain
      const mx = this.markerX;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, this.H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath(); ctx.moveTo(mx + i * 24, 12 + Math.abs(i) * 6); ctx.lineTo(mx + i * 24 - 5, 2 + Math.abs(i) * 6); ctx.lineTo(mx + i * 24 + 5, 2 + Math.abs(i) * 6); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,90,60,0.9)';
      ctx.beginPath(); ctx.moveTo(mx - 10, this.terrain.groundBelow(mx, 0)); ctx.lineTo(mx + 10, this.terrain.groundBelow(mx, 0)); ctx.stroke();
    } else if (a && a.alive && this.phase === 'aim' && !this.hasFired) {
      const h = this.headPos(a), d = this.aimDir(a);
      if (!this.ai) {
        const pw = this.charging ? Math.max(0.15, this.power) : 0.65;
        const pts = this.previewPath(a, this.weaponId, pw);
        if (this.weaponId === 'salt' && pts.length === 2) {
          ctx.setLineDash([4, 6]);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const n = pts.length;
          pts.forEach((pt, i) => {
            const k = 1 - i / Math.max(1, n);
            if (pt.hit) {
              ctx.strokeStyle = 'rgba(255,90,60,0.9)';
              ctx.lineWidth = 1.5;
              ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.stroke();
              return;
            }
            ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.6 * k).toFixed(2)})`;
            ctx.beginPath(); ctx.arc(pt.x, pt.y, 1.8 + 1.2 * k, 0, Math.PI * 2); ctx.fill();
          });
        }
      }
      const cx = h.x + d.x * 48, cy = h.y + d.y * 48;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,60,60,0.9)';
      ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.stroke();
      if (this.charging) {
        // power bar along the aim line
        const len = 44 * this.power;
        ctx.strokeStyle = `hsl(${120 - this.power * 120},90%,50%)`;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(h.x + d.x * 8, h.y + d.y * 8); ctx.lineTo(h.x + d.x * (8 + len), h.y + d.y * (8 + len)); ctx.stroke();
      }
    }

    // projectiles
    for (const p of this.projectiles) {
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.type === 'bazooka') {
        ctx.rotate(p.rot);
        ctx.fillStyle = '#ff9a3c';
        ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(-16 - this.vrng() * 6, -3); ctx.lineTo(-16 - this.vrng() * 6, 3); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#444';
        roundRect(ctx, -9, -3.5, 16, 7, 3); ctx.fill();
        ctx.fillStyle = '#c33';
        ctx.beginPath(); ctx.moveTo(7, -3.5); ctx.lineTo(12, 0); ctx.lineTo(7, 3.5); ctx.closePath(); ctx.fill();
      } else if (p.type === 'granat') {
        ctx.fillStyle = '#3a6b3a';
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#1f3a1f'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#888'; ctx.fillRect(-2, -9, 4, 4);
        this.fuseLabel(ctx, p);
      } else if (p.type === 'slem') {
        ctx.fillStyle = '#7ccf3a';
        ctx.strokeStyle = '#3f7a1c'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(-4, 6 + (p.rest ? 2 : 0), 2.5, 0, Math.PI * 2); ctx.arc(5, 5, 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(-2, -3, 2, 0, Math.PI * 2); ctx.fill();
        this.fuseLabel(ctx, p, -13);
      } else if (p.type === 'saltregn') {
        ctx.rotate(0.6 + p.age * 3);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(120,140,160,0.9)'; ctx.lineWidth = 1;
        ctx.fillRect(-4, -4, 8, 8); ctx.strokeRect(-4, -4, 8, 8);
      } else if (p.type === 'dynamit') {
        ctx.fillStyle = '#c62828';
        roundRect(ctx, -4, -14, 8, 14, 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(-4, -9, 8, 3);
        const flick = this.vrng();
        ctx.fillStyle = flick < 0.5 ? '#ffd54f' : '#ff7043';
        ctx.beginPath(); ctx.arc(0, -16, 2.5, 0, Math.PI * 2); ctx.fill();
        this.fuseLabel(ctx, p, -22);
      }
      ctx.restore();
    }

    // particles
    for (const p of this.particles) {
      if (p.line) {
        ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x2, p.y2); ctx.stroke();
        continue;
      }
      if (p.flash) {
        ctx.fillStyle = `rgba(255,255,220,${p.life * 3})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.flash * (1.3 - p.life * 2), 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.globalAlpha = p.fade ? Math.min(1, p.life) : 1;
      ctx.fillStyle = p.color;
      if (p.shard) {
        // a piece of shell: a small triangle with a cream inside
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath(); ctx.moveTo(-p.shard, p.shard * 0.6); ctx.lineTo(p.shard, p.shard * 0.4); ctx.lineTo(0, -p.shard); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#4a2e1c'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#fff3d6'; ctx.beginPath(); ctx.moveTo(-p.shard * 0.4, p.shard * 0.3); ctx.lineTo(p.shard * 0.4, p.shard * 0.2); ctx.lineTo(0, -p.shard * 0.4); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // water
    this.drawWater(ctx);

    // popups
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.fillStyle = '#000'; ctx.fillText(p.text, p.x + 1, p.y + 1);
      ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  fuseLabel(ctx, p, dy = -14) {
    const left = Math.max(0, Math.ceil(p.fuse - p.age));
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(left, 0, dy);
  }

  drawHills(ctx, cw, ch, ox, oy, color, base) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, ch);
    for (let x = 0; x <= cw; x += 8) {
      const wx = (x - ox) / this.cam.zoom;
      const y = ch * base + oy * 0.3 + Math.sin(wx * 0.004) * 50 + Math.sin(wx * 0.011 + 1) * 25;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(cw, ch);
    ctx.closePath();
    ctx.fill();
  }

  drawWater(ctx) {
    const y0 = this.waterY;
    for (let layer = 0; layer < 2; layer++) {
      ctx.fillStyle = this.theme.water[layer];
      ctx.beginPath();
      ctx.moveTo(-50, this.H + 50);
      for (let x = -50; x <= this.W + 50; x += 12) {
        const y = y0 + layer * 5 + Math.sin(x * 0.02 + this.time * (1.5 + layer) + layer) * 3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(this.W + 50, this.H + 50);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Summary for the DOM HUD.
  hudState() {
    return {
      phase: this.phase,
      team: this.active ? this.teams[this.active.team] : null,
      snail: this.active,
      timer: this.timer,
      wind: this.wind,
      windLevel: this.rulesVersion >= 4 ? this.rules.wind : 'normal',
      weapon: this.weaponId,
      power: this.power,
      charging: this.charging,
      message: this.messageTimer > 0 ? this.message : null,
      teams: this.teams.map((t) => ({ name: t.name, color: t.color, hp: t.snails.reduce((a, s) => a + (s.alive ? s.hp : 0), 0), alive: t.snails.filter((s) => s.alive).length, total: t.snails.length })),
      ai: this.ai && this.active ? this.teams[this.active.team].ai : false,
      turn: this.turnCount,
      ammo: this.active ? this.teams[this.active.team].ammo : null,
      crates: this.crates.length,
    };
  }
}

function plan_power(ai) { return ai.plan?.power ?? 1; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
export { shade };
