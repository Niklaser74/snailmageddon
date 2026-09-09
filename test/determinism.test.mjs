// Determinism tests for the simulation. Runs headless in Node: no canvas, no DOM.
//   node test/determinism.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, RULES_VERSION, SUPPORTED_RULES, weaponsFor } from '../js/game.js';
import { dailyConfig, seedFor, weaponFor, dayKey } from '../js/daily.js';
import { unlockedFor, normalizeLook, SHELLS, HATS } from '../js/cosmetics.js';
import { tierFor, elo, seasonKey, daysLeft, TIERS } from '../js/season.js';
import { themeFor, THEME_IDS } from '../js/themes.js';

const cfg = (seed) => ({
  seed,
  snailsPerTeam: 2,
  teams: [
    { name: 'Slemligan', color: '#e2453c', ai: true },
    { name: 'Skalbaggarna', color: '#3b82f6', ai: true },
  ],
});

// Play `ticks` ticks (or until the match ends). Returns the game and the
// state hash at every turn change plus the final one.
function run(game, ticks) {
  const hashes = [];
  let lastTurn = game.turnCount;
  for (let i = 0; i < ticks; i++) {
    game.tick();
    if (game.turnCount !== lastTurn) { hashes.push(game.stateHash()); lastTurn = game.turnCount; }
    if (game.phase === 'over') break;
  }
  hashes.push(game.stateHash());
  return hashes;
}

const TICKS = 60 * 240; // four minutes of match time
let failed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

test('same seed and same AI produce identical state at every turn', () => {
  const a = new Game(null, cfg(1234));
  const b = new Game(null, cfg(1234));
  const ha = run(a, TICKS), hb = run(b, TICKS);
  assert.equal(ha.length, hb.length, 'different number of turns');
  ha.forEach((h, i) => assert.equal(h, hb[i], `hash differs at turn ${i}`));
  assert.ok(a.turnCount >= 5, `expected several turns, got ${a.turnCount}`);
  assert.deepEqual(a.recording.inputs, b.recording.inputs, 'recordings differ');
});

test('a recording replays to the same state without running the AI', () => {
  const live = new Game(null, cfg(777));
  const hl = run(live, TICKS);
  const rec = JSON.parse(JSON.stringify(live.recording)); // as it would come back from a server
  assert.equal(rec.rulesVersion, RULES_VERSION);
  const rep = Game.fromRecording(null, rec);
  assert.equal(rep.ai, null, 'AI must be off during replay');
  const hr = run(rep, live.tickCount);
  assert.equal(hl.length, hr.length, 'different number of turns in replay');
  hl.forEach((h, i) => assert.equal(h, hr[i], `replay diverged at turn ${i}`));
  assert.equal(rep.tickCount, live.tickCount);
  const bytes = JSON.stringify(rec).length;
  console.log(`     recording: ${rec.inputs.length} input changes over ${live.tickCount} ticks, ${bytes} bytes as JSON`);
});

test('different seeds produce different matches', () => {
  const a = new Game(null, cfg(1)), b = new Game(null, cfg(2));
  assert.notEqual(a.stateHash(), b.stateHash());
});

test('terrain and spawn are decided before the first tick', () => {
  const a = new Game(null, cfg(99)), b = new Game(null, cfg(99));
  assert.equal(a.stateHash(), b.stateHash());
  assert.equal(a.snails.length, 4);
  for (const s of a.snails) assert.ok(a.terrain.solid(s.x, s.y) || a.terrain.solid(s.x - 5, s.y) || a.terrain.solid(s.x + 5, s.y), `${s.name} is not standing on ground`);
});

test('human-style scripted input is recorded and replayed', () => {
  const c = cfg(4242);
  c.teams[0].ai = false;
  const live = new Game(null, c);
  // walk right for a second, aim up, charge for half a second, release
  const script = (g, t) => {
    const inp = g.input;
    inp.left = inp.right = inp.up = inp.down = inp.fire = false;
    if (t < 60) inp.right = true;
    else if (t < 80) inp.up = true;
    else if (t === 85) inp.weapon = 'granat';
    else if (t >= 90 && t < 120) inp.fire = true;
    else if (t === 130) inp.jump = true;
  };
  for (let t = 0; t < 60 * 20; t++) { if (!live.ai) script(live, t); live.tick(); }
  const rep = Game.fromRecording(null, JSON.parse(JSON.stringify(live.recording)));
  for (let t = 0; t < live.tickCount; t++) rep.tick();
  assert.equal(rep.stateHash(), live.stateHash(), 'scripted replay diverged');
  assert.ok(live.turnCount >= 2, 'the scripted shot should have ended the turn');
});

test('crates: health heals, weapon crates add ammo, blasts set them off', () => {
  const c = cfg(31337);
  c.teams[0].ai = false;
  const g = new Game(null, c);
  const s = g.active;
  const team = g.teams[s.team];
  s.hp = 50;
  g.crates.push({ x: s.x, y: s.y, vy: 0, type: 'health', weapon: null, landed: true, chute: true });
  g.tick();
  assert.equal(g.crates.length, 0, 'health crate not picked up');
  assert.equal(s.hp, 85);
  const before = team.ammo.saltregn;
  g.crates.push({ x: s.x, y: s.y, vy: 0, type: 'weapon', weapon: 'saltregn', landed: true, chute: true });
  g.tick();
  assert.equal(team.ammo.saltregn, before + 1, 'weapon crate did not add ammo');
  // a crate far from everyone, blown up by an explosion next to it
  const cx = 300, cy = g.terrain.groundBelow(300, 0) - 1;
  g.crates.push({ x: cx, y: cy, vy: 0, type: 'health', weapon: null, landed: true, chute: true });
  g.explosion(cx + 20, cy - 10, 20, 10, null);
  assert.equal(g.crates.length, 0, 'crate survived a blast');
  assert.equal(g.pendingBooms.length, 1, 'crate blast not queued');
  const solidBefore = g.terrain.solid(cx, cy + 3);
  g.tick();
  assert.equal(g.pendingBooms.length, 0);
  assert.ok(solidBefore && !g.terrain.solid(cx, cy + 3), 'crate explosion did not dig');
});

test('ammo: limited weapons count down and cannot be selected when empty', () => {
  const c = cfg(555);
  c.teams[0].ai = false;
  const g = new Game(null, c);
  const team = g.teams[g.active.team];
  team.ammo.dynamit = 1;
  g.input.weapon = 'dynamit';
  g.tick();
  assert.equal(g.weaponId, 'dynamit');
  g.input.fire = true; g.tick(); g.input.fire = false; g.tick();
  assert.equal(team.ammo.dynamit, 0);
  assert.equal(g.projectiles.filter((p) => p.type === 'dynamit').length, 1);
  // next turn for this team: dynamite must not be selectable
  for (let i = 0; i < 60 * 40 && !(g.active && g.active.team === team.index && g.phase === 'aim' && g.turnCount > 1); i++) g.tick();
  assert.equal(g.active.team, team.index);
  g.input.weapon = 'dynamit';
  g.tick();
  assert.equal(g.weaponId, 'bazooka', 'empty weapon was selected');
});

test('slime sticks where it lands and explodes after its fuse', () => {
  const c = cfg(909);
  c.teams[0].ai = false;
  const g = new Game(null, c);
  g.input.weapon = 'slem'; g.tick();
  g.active.aim = 0.8;
  g.input.fire = true; for (let i = 0; i < 25; i++) g.tick(); g.input.fire = false; g.tick();
  const p = g.projectiles.find((q) => q.type === 'slem');
  assert.ok(p, 'no slime ball in flight');
  let landedTick = -1;
  for (let i = 0; i < 60 * 6; i++) {
    g.tick();
    if (p.rest && landedTick < 0) landedTick = g.tickCount;
    if (!g.projectiles.includes(p)) break;
  }
  assert.ok(landedTick > 0, 'slime never came to rest');
  assert.ok(!g.projectiles.includes(p), 'slime never exploded');
  assert.ok(g.tickCount - landedTick <= 60 * 2 + 2, 'fuse longer than 2 s after landing');
});

test('salt rain: marker moves with left/right and five crystals fall and burst', () => {
  const c = cfg(2024);
  c.teams[0].ai = false;
  const g = new Game(null, c);
  const s = g.active;
  g.input.weapon = 'saltregn'; g.tick();
  assert.equal(g.weaponId, 'saltregn');
  const m0 = g.markerX, x0 = s.x;
  g.input.right = true; for (let i = 0; i < 30; i++) g.tick(); g.input.right = false;
  assert.ok(g.markerX > m0 + 100, 'marker did not move');
  assert.equal(s.x, x0, 'snail moved while aiming the marker');
  g.input.fire = true; g.tick(); g.input.fire = false;
  const drops = g.projectiles.filter((p) => p.type === 'saltregn');
  assert.equal(drops.length, 5);
  const solidBefore = g.terrain.mask.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 60 * 8 && g.projectiles.length; i++) g.tick();
  assert.equal(g.projectiles.length, 0, 'crystals still in the air');
  const solidAfter = g.terrain.mask.reduce((a, b) => a + b, 0);
  assert.ok(solidAfter < solidBefore, 'salt rain did not scar the ground');
  assert.equal(g.teams[s.team].ammo.saltregn, 0);
});

test('a snail drowned by sudden death ends the turn and the match at once', () => {
  const c = cfg(77);
  c.teams[0].ai = false; c.snailsPerTeam = 1;
  const g = new Game(null, c);
  // put the active snail on the water line; the next tick drowns it
  const s = g.active;
  s.y = g.waterY + 10;
  g.tick();
  assert.equal(s.alive, false, 'snail should have drowned');
  assert.notEqual(g.phase, 'aim', 'turn kept running with a dead active snail');
  for (let i = 0; i < 60 * 3 && g.phase !== 'over'; i++) g.tick();
  assert.equal(g.phase, 'over', 'match did not end within 3 s');
  assert.equal(g.winner.index, 1, 'the other team should win');
});

test('Snigelpost: a turn played on one device resumes exactly on the other', () => {
  const cfg = { seed: 555, snailsPerTeam: 2, teams: [{ name: 'A', color: '#e2453c', ai: false }, { name: 'B', color: '#3b82f6', ai: false }] };
  const shoot = (g) => {
    g.input.up = true; for (let i = 0; i < 10; i++) g.tick(); g.input.up = false;
    g.input.fire = true; for (let i = 0; i < 25; i++) g.tick(); g.input.fire = false;
    for (let i = 0; i < 60 * 40 && !g.paused && g.phase !== 'over'; i++) g.tick();
  };
  // device A (host) plays turn 1 and pauses when it becomes B's turn
  const waits = [];
  const a = new Game(null, cfg, { onWaitTurn: (g, team) => waits.push({ team, tick: g.tickCount, hash: g.stateHash() }) }, { localTeams: [0] });
  assert.equal(a.paused, false);
  shoot(a);
  assert.equal(a.paused, true, 'host did not pause at the turn boundary');
  assert.equal(waits.length, 1); assert.equal(waits[0].team, 1);
  // the hook sees the finished tick: same tick count and hash as afterwards
  assert.equal(waits[0].tick, a.tickCount);
  assert.equal(waits[0].hash, a.stateHash());
  const turn1 = { start: 0, end: a.tickCount, inputs: a.inputsSince(0), hash: a.stateHash() };
  assert.ok(turn1.inputs.length > 2 && turn1.inputs.every(([t]) => t < turn1.end));
  // device B (guest): replay turn 1, verify, play turn 2
  const rec1 = { rulesVersion: RULES_VERSION, seed: 555, teams: cfg.teams, snailsPerTeam: 2, inputs: turn1.inputs };
  const b = new Game(null, cfg, {}, { replay: rec1, liveAfter: turn1.end, localTeams: [1] });
  while (b.tickCount < turn1.end) b.tick();
  assert.equal(b.stateHash(), turn1.hash, 'guest state differs after replaying the host turn');
  assert.equal(b.paused, false, 'guest paused on its own turn');
  assert.equal(b.active.team, 1);
  shoot(b);
  assert.equal(b.paused, true);
  const turn2 = { start: turn1.end, end: b.tickCount, inputs: b.inputsSince(turn1.end), hash: b.stateHash() };
  assert.ok(turn2.inputs.every(([t]) => t >= turn2.start && t < turn2.end), 'turn 2 inputs outside its tick range');
  // device A again: replay both turns, must land on B's hash with A to play
  const rec2 = { ...rec1, inputs: [...turn1.inputs, ...turn2.inputs] };
  const a2 = new Game(null, cfg, {}, { replay: rec2, liveAfter: turn2.end, localTeams: [0] });
  while (a2.tickCount < turn2.end) a2.tick();
  assert.equal(a2.stateHash(), turn2.hash, 'host state differs after replaying both turns');
  assert.equal(a2.paused, false);
  assert.equal(a2.active.team, 0);
  // and it keeps recording from there
  shoot(a2);
  assert.ok(a2.inputsSince(turn2.end).length > 0);
  assert.ok(a2.paused || a2.phase === 'over');
});

test('shell shove: snails right in front take damage and fly, nothing else moves', () => {
  const c = cfg(31);
  c.teams[0].ai = false; c.teams[1].ai = false;
  const g = new Game(null, c);
  const s = g.active;
  // park an enemy right in front, and a friend far away
  const enemy = g.snails.find((o) => o.team !== s.team);
  enemy.x = s.x + s.facing * 20; enemy.y = s.y; enemy.vx = 0; enemy.vy = 0;
  const far = g.snails.find((o) => o !== s && o !== enemy);
  const farHp = far.hp;
  g.input.weapon = 'skalstot'; g.tick();
  assert.equal(g.weaponId, 'skalstot');
  g.input.fire = true; g.tick(); g.input.fire = false; g.tick();
  assert.equal(enemy.hp, 100 - 22, 'enemy in front should take shove damage');
  assert.ok(enemy.airborne && Math.sign(enemy.vx) === s.facing && enemy.vy < 0, 'enemy should fly away in the facing direction');
  assert.equal(far.hp, farHp, 'a snail out of reach was hit');
  assert.equal(g.phase, 'retreat');
  assert.equal(g.teams[s.team].ammo.skalstot, Infinity);
});

test('snail hop: teleports to the marker on dry ground and ends the turn, refuses water', () => {
  const c = cfg(32);
  c.teams[0].ai = false; c.teams[1].ai = false;
  const g = new Game(null, c);
  const s = g.active, team = g.teams[s.team];
  team.ammo.snigelhopp = 1;
  g.input.weapon = 'snigelhopp'; g.tick();
  assert.equal(g.weaponId, 'snigelhopp');
  // find a dry column and steer the marker there
  let target = null;
  for (let x = 100; x < g.W - 100 && !target; x += 25) if (g.teleportSpot(x) && Math.abs(x - g.markerX) > 40) target = g.teleportSpot(x);
  assert.ok(target, 'no dry spot on the map');
  for (let i = 0; i < 60 * 8 && Math.abs(g.markerX - target.x) > 3; i++) { g.input.left = g.markerX > target.x; g.input.right = g.markerX < target.x; g.tick(); }
  g.input.left = g.input.right = false;
  const spot = g.teleportSpot(g.markerX);
  assert.ok(spot, 'marker should be on a valid spot');
  g.input.fire = true; g.tick(); g.input.fire = false; g.tick();
  assert.equal(s.x, spot.x); assert.equal(s.y, spot.y);
  assert.equal(team.ammo.snigelhopp, 0);
  assert.equal(g.phase, 'retreat');
  assert.ok(g.timer <= 1, 'the hop should end the turn quickly');
  // a spot occupied by another snail is refused, and so is the sea
  const other = g.snails.find((o) => o !== s && o.alive);
  assert.equal(g.teleportSpot(other.x), null, 'landing on a snail should be refused');
  g.waterY = 0; // flood everything: no dry ground anywhere
  assert.equal(g.teleportSpot(spot.x), null, 'a flooded column should be refused');
  const h1 = new Game(null, c);
  h1.teams[h1.active.team].ammo.snigelhopp = 1;
  h1.input.weapon = 'snigelhopp'; h1.tick();
  h1.markerX = 20; // outside the terrain near the left edge: usually water
  if (!h1.teleportSpot(20)) {
    h1.input.fire = true; h1.tick(); h1.input.fire = false; h1.tick();
    assert.equal(h1.phase, 'aim', 'firing at water should not end the turn');
    assert.equal(h1.teams[h1.active.team].ammo.snigelhopp, 1, 'ammo must not be spent on a refused hop');
  }
});

test('AI levels: recorded with the match, replay the same, and play differently', () => {
  const mk = (lvl) => ({ ...cfg(2026), teams: cfg(2026).teams.map((t) => ({ ...t, ai: lvl })) });
  const easy = new Game(null, mk('easy')), hard = new Game(null, mk('hard')), old = new Game(null, mk(true));
  assert.deepEqual(easy.recording.teams.map((t) => t.ai), ['easy', 'easy']);
  assert.deepEqual(old.recording.teams.map((t) => t.ai), ['normal', 'normal'], 'true should mean normal');
  assert.equal(easy.ai.level.aimStep, 10); assert.equal(hard.ai.level.aimStep, 3);
  run(easy, 60 * 90); run(hard, 60 * 90);
  assert.notEqual(easy.stateHash(), hard.stateHash(), 'easy and hard played the same match');
  const rep = Game.fromRecording(null, JSON.parse(JSON.stringify(hard.recording)));
  run(rep, hard.tickCount);
  assert.equal(rep.stateHash(), hard.stateHash(), 'hard AI recording did not replay');
});

// Golden fixtures: recordings made by the code of each rules version, with the
// hash at every turn. If any of them diverge, the simulation changed for that
// version, which is only allowed as a new rules version (docs/REGELVERSIONER.md).
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
for (const v of SUPPORTED_RULES) {
  test(`rules v${v}: golden recordings replay hash for hash`, () => {
    const file = path.join(fixtureDir, `rules-v${v}.json`);
    assert.ok(fs.existsSync(file), `missing fixture ${file}: run node test/make-fixture.mjs . > ${file} when introducing v${v}`);
    const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fx.rulesVersion, v);
    for (const m of fx.matches) {
      const g = Game.fromRecording(null, m.recording);
      assert.equal(g.rulesVersion, v);
      assert.equal(g.weapons.length, weaponsFor(v).length);
      for (const [tick, hash] of m.hashes) {
        while (g.tickCount < tick) g.tick();
        assert.equal(g.stateHash(), hash, `${m.name}: v${v} simulation diverged at tick ${tick}`);
      }
      assert.equal(g.phase, m.phase);
    }
  });
}
test('current rules version has a fixture and unsupported versions are refused', () => {
  assert.ok(SUPPORTED_RULES.includes(RULES_VERSION));
  assert.ok(fs.existsSync(path.join(fixtureDir, `rules-v${RULES_VERSION}.json`)), 'the current version needs its golden fixture');
  assert.throws(() => new Game(null, { ...cfg(1), rulesVersion: 1 }), /not supported/);
  assert.throws(() => Game.fromRecording(null, { ...new Game(null, cfg(1)).recording, rulesVersion: 99 }), /regelversion/);
  // the previous version still plays, and the recording says which version it is
  const old = new Game(null, { ...cfg(5), rulesVersion: 3, wind: 'storm' });
  assert.equal(old.weapons.length, 8);
  assert.equal(old.recording.rulesVersion, 3);
  assert.equal(old.recording.wind, 'storm', 'the rule is recorded even when v3 ignores it');
  assert.equal(old.hudState().windLevel, 'normal', 'v3 plays with normal wind whatever the config says');
});

test('shot of the day: same map for everyone, one shot, score is the damage, replayable', () => {
  assert.equal(seedFor('2026-09-05'), seedFor('2026-09-05'));
  assert.notEqual(seedFor('2026-09-05'), seedFor('2026-09-06'));
  assert.notEqual(weaponFor('2026-09-05'), weaponFor('2026-09-06'));
  assert.match(dayKey(new Date('2026-09-05T23:59:00Z')), /^2026-09-05$/);
  const names = { me: 'Du', targets: 'Mål' };
  const g = new Game(null, dailyConfig('2026-09-05', 'cartoon', names));
  assert.equal(g.stateHash(), new Game(null, dailyConfig('2026-09-05', 'cartoon', names)).stateHash());
  assert.deepEqual(g.snails.map((s) => s.team), [0, 1, 1, 1], 'one shooter, three targets');
  assert.equal(g.weaponId, weaponFor('2026-09-05'));
  const ammo = g.teams[0].ammo;
  assert.equal(ammo[g.weaponId], 1);
  assert.ok(Object.entries(ammo).every(([id, n]) => id === g.weaponId || n === 0), 'only the weapon of the day has ammo');
  // no shot within the turn: the day is over with 0 points
  const idle = new Game(null, dailyConfig('2026-09-05', 'cartoon', names));
  for (let i = 0; i < 60 * 50 && idle.phase !== 'over'; i++) idle.tick();
  assert.equal(idle.phase, 'over'); assert.equal(idle.daily.score, 0);
  assert.equal(idle.turnCount, 1, 'the targets must never get a turn');
  // a direct hit on a target: damage becomes points, a kill counts 150
  const hit = new Game(null, dailyConfig('2026-09-05', 'cartoon', names));
  const target = hit.teams[1].snails[0];
  target.hp = 30;
  hit.explosion(target.x, target.y - 10, 36, 48, null);
  hit.input.fire = true; hit.tick(); hit.input.fire = false; // the shot itself may or may not hit; the kill is already pending
  for (let i = 0; i < 60 * 60 && hit.phase !== 'over'; i++) hit.tick();
  assert.equal(hit.phase, 'over');
  assert.ok(hit.daily.score >= 150, `expected at least the kill, got ${hit.daily.score}`);
  assert.equal(hit.recording.mode, 'daily');
  assert.deepEqual(hit.recording.teamSizes, [1, 3]);
  // the recording replays to the same score (the server keeps it for verification)
  const rep = Game.fromRecording(null, JSON.parse(JSON.stringify(idle.recording)));
  while (rep.tickCount < idle.tickCount) rep.tick();
  assert.equal(rep.daily.score, idle.daily.score);
  assert.equal(rep.stateHash(), idle.stateHash());
});

test('cosmetics: unlock rules match the server, looks never touch the simulation', () => {
  assert.deepEqual(unlockedFor({}), ['spiral', 'stripes', 'dots', 'none', 'cap', 'party']);
  assert.ok(unlockedFor({ wins: 5 }).includes('flame') && !unlockedFor({ wins: 4 }).includes('flame'));
  assert.ok(unlockedFor({ wins: 10 }).includes('crown'));
  assert.ok(unlockedFor({ dailyBest: 250 }).includes('stars') && unlockedFor({ dailyBest: 350 }).includes('viking'));
  assert.ok(!unlockedFor({ wins: 999, dailyBest: 450 }).includes('gold'), 'premium is not unlockable yet');
  assert.deepEqual(normalizeLook({ shell: 'flame', hat: 'crown' }, unlockedFor({})), { shell: 'spiral', hat: 'none' });
  assert.deepEqual(normalizeLook({ shell: 'dots', hat: 'nonsense' }), { shell: 'dots', hat: 'none' });
  assert.ok(SHELLS.every((s) => s.free || s.need || s.premium || s.award) && HATS.every((h) => h.free || h.need || h.premium || h.award));
  // bought and awarded items come from the server as extras; unknown ids are dropped
  assert.deepEqual(unlockedFor({}, ['laurel', 'gold', 'bogus']).slice(-2), ['laurel', 'gold']);
  assert.deepEqual(normalizeLook({ shell: 'confetti', hat: 'laurel' }, unlockedFor({}, ['laurel'])), { shell: 'spiral', hat: 'laurel' });
  // a look on a team changes nothing in the state hash or the recording inputs
  const c = cfg(64);
  c.teams[0].look = { shell: 'gold', hat: 'tophat' };
  const a = new Game(null, c), b = new Game(null, cfg(64));
  assert.equal(a.teams[0].look.hat, 'tophat');
  run(a, 60 * 60); run(b, 60 * 60);
  assert.equal(a.stateHash(), b.stateHash(), 'a look leaked into the simulation');
  assert.equal(JSON.stringify(a.recording.teams), JSON.stringify(b.recording.teams), 'the recording must not carry looks');
});

test('season: quarter keys, Elo mirror of the server, tiers', () => {
  assert.equal(seasonKey(new Date('2026-09-05T12:00:00Z')), '2026-Q3');
  assert.equal(seasonKey(new Date('2026-10-01T00:00:00Z')), '2026-Q4');
  assert.equal(daysLeft(new Date('2026-09-05T12:00:00Z')), 26);
  assert.deepEqual(elo(1000, 1000, 0), { host: 1016, guest: 984 }); // same numbers the server produced
  assert.deepEqual(elo(1000, 1000, 1), { host: 984, guest: 1016 });
  assert.deepEqual(elo(1000, 1000, null), { host: 1000, guest: 1000 });
  assert.ok(elo(1200, 1000, 0).host - 1200 < 16, 'a favourite gains less');
  assert.equal(tierFor(1000), 'garden'); assert.equal(tierFor(900), 'slug'); assert.equal(tierFor(1300), 'giant');
  assert.ok(TIERS.every((x, i) => i === 0 || x.min > TIERS[i - 1].min));
});

test('terrain themes: picked from the seed, never part of the simulation', () => {
  assert.deepEqual(THEME_IDS, ['garden', 'beach', 'jungle']);
  assert.equal(themeFor(1234).id, themeFor(1234).id);
  assert.equal(themeFor(0).id, 'garden'); assert.equal(themeFor(1).id, 'beach'); assert.equal(themeFor(2).id, 'jungle');
  assert.equal(themeFor(1234, 'beach').id, 'beach');
  assert.equal(themeFor(1234, 'nonsense').id, themeFor(1234).id);
  const a = new Game(null, { ...cfg(99), theme: 'jungle' }), b = new Game(null, { ...cfg(99), theme: 'beach' });
  assert.equal(a.theme.id, 'jungle'); assert.equal(b.theme.id, 'beach');
  run(a, 60 * 60); run(b, 60 * 60);
  assert.equal(a.stateHash(), b.stateHash(), 'the theme changed the simulation');
  assert.equal(a.recording.theme, undefined);
});

test('turn time and sudden death are match rules that travel with the recording', () => {
  const base = cfg(99);
  const std = new Game(null, base);
  assert.deepEqual(std.rules, { turnTime: 45, suddenDeath: 16, wind: 'normal' }, 'defaults');
  assert.equal(std.timer, 45);
  const fast = new Game(null, { ...base, turnTime: 20, suddenDeath: 0 });
  assert.equal(fast.timer, 20);
  assert.equal(fast.recording.turnTime, 20);
  assert.equal(fast.recording.suddenDeath, 0);
  // unknown values fall back to the defaults, so a tampered config cannot desync a match
  assert.deepEqual(new Game(null, { ...base, turnTime: 7, suddenDeath: 'x', wind: 'hurricane' }).rules, { turnTime: 45, suddenDeath: 16, wind: 'normal' });
  // sudden death off: the water never rises, however long the match runs
  const water0 = fast.waterY;
  run(fast, TICKS);
  assert.ok(fast.turnCount > 16, `expected more than 16 turns, got ${fast.turnCount}`);
  assert.equal(fast.waterY, water0, 'water rose with sudden death off');
  assert.ok(std.waterY === water0, 'water should not have moved before the match ran');
  // a replay of the fast game uses the fast rules and lands on the same state
  const rec = JSON.parse(JSON.stringify(fast.recording));
  const rep = Game.fromRecording(null, rec);
  assert.deepEqual(rep.rules, { turnTime: 20, suddenDeath: 0, wind: 'normal' });
  run(rep, fast.tickCount);
  assert.equal(rep.stateHash(), fast.stateHash(), 'replay with rules diverged');
  // the timer is part of the state hash, so two devices with different rules notice at once
  assert.notEqual(new Game(null, { ...base, turnTime: 20 }).stateHash(), new Game(null, base).stateHash(), 'turn time not in the hash');
});

test('wind rule (v4): storm bends every throw, hard only the wind weapons, v3 ignores the rule', () => {
  // fire one shot with a fixed wind and compare where the projectile is a second later
  const shoot = (weapon, wind, extra = {}) => {
    const g = new Game(null, { ...cfg(31), teams: [{ name: 'A', color: '#f00', ai: false }, { name: 'B', color: '#00f', ai: false }], ...extra });
    g.wind = 1; // deterministic: full wind to the right
    g.rules.wind = wind; // set after construction so the match seed and terrain are identical
    g.input.weapon = weapon; g.tick();
    g.active.aim = 0.9;
    g.input.fire = true; run(g, 25); g.input.fire = false; g.tick();
    const p = g.projectiles.find((q) => q.type === weapon);
    assert.ok(p, `${weapon} should be in the air`);
    run(g, 30);
    return p.x;
  };
  const gb = shoot('bazooka', 'normal'), hb = shoot('bazooka', 'hard'), sb = shoot('bazooka', 'storm');
  assert.ok(gb != null && hb != null && sb != null, 'bazooka should still be in the air');
  assert.ok(hb > gb && sb > hb, `bazooka should drift more with stronger wind: ${gb} ${hb} ${sb}`);
  const gg = shoot('granat', 'normal'), hg = shoot('granat', 'hard'), sg = shoot('granat', 'storm');
  assert.equal(hg, gg, 'hard wind must not touch the grenade');
  assert.ok(sg > gg, `storm must drift the grenade: ${gg} ${sg}`);
  // rules version 3 never reads the wind rule, whatever the config says
  assert.equal(shoot('bazooka', 'storm', { rulesVersion: 3 }), shoot('bazooka', 'normal', { rulesVersion: 3 }));
  // the rule travels with the recording and the replay lands on the same state
  const g = new Game(null, { ...cfg(32), wind: 'storm' });
  assert.equal(g.recording.wind, 'storm');
  run(g, TICKS);
  const rep = Game.fromRecording(null, JSON.parse(JSON.stringify(g.recording)));
  assert.equal(rep.rules.wind, 'storm');
  run(rep, g.tickCount);
  assert.equal(rep.stateHash(), g.stateHash(), 'storm replay diverged');
});

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nall tests passed');
