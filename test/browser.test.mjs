// Browser tests with Playwright. Serves the repo over HTTP, plays through the
// real UI and cross-checks the browser simulation against a headless Node run.
//   npm run test:browser
// Screenshots land in test-results/.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Game } from '../js/game.js';
import { createFakeSupabase } from './fake-supabase.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test-results');
fs.mkdirSync(outDir, { recursive: true });

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json', '.md': 'text/markdown',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const launchOpts = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const browser = await chromium.launch(launchOpts);
// every page talks to an in-memory Supabase so tests are offline and deterministic
const fake = createFakeSupabase();
let failed = 0;

async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack || e.message}`); }
}

// A page that collects console errors and page errors.
async function open(url, viewport = { width: 1280, height: 720 }, extra = {}) {
  const page = await browser.newPage({ viewport, ...extra });
  page.setDefaultTimeout(20000);
  await fake.install(page);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base + url);
  await page.evaluate(() => { window.__manualTick = true; });
  return { page, errors };
}

// Poll a Node-side condition (e.g. something the fake server recorded) for up to 5 s.
async function until(cond, msg) {
  for (let i = 0; i < 100; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(msg);
}
const ticks = (page, n) => page.evaluate((n) => { const g = window.__game; for (let i = 0; i < n; i++) g.tick(); return { tick: g.tickCount, turn: g.turnCount, phase: g.phase, hash: g.stateHash() }; }, n);

await test('menu and design page load without errors', async () => {
  const { page, errors } = await open('/');
  await page.waitForSelector('#btn-start');
  assert.equal(await page.locator('#opt-style option').count(), 5, 'five snail styles in the menu');
  await page.screenshot({ path: path.join(outDir, 'menu.png') });
  await page.goto(base + '/design/snails.html');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('canvas').count(), 5);
  await page.click('#back');
  await page.waitForSelector('#btn-start');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('keyboard: walk, aim, pick grenade, charge and fire', async () => {
  const { page, errors } = await open('/?seed=4242');
  await page.selectOption('.team-row:nth-child(2) select', 'normal');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  const before = await page.evaluate(() => ({ x: __game.active.x, aim: __game.active.aim, w: __game.weaponId }));
  await page.keyboard.down('ArrowRight'); await ticks(page, 60); await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowUp'); await ticks(page, 20); await page.keyboard.up('ArrowUp');
  assert.equal(await page.locator('#weapons button').count(), 8, 'eight weapon buttons');
  await page.keyboard.press('Digit7'); await ticks(page, 2);
  assert.equal(await page.evaluate(() => __game.weaponId), 'skalstot');
  await page.keyboard.press('Digit2'); await ticks(page, 2);
  await page.keyboard.down('Space'); await ticks(page, 30);
  await page.screenshot({ path: path.join(outDir, 'charging.png') });
  const charging = await page.evaluate(() => ({ charging: __game.charging, power: __game.power, w: __game.weaponId }));
  await page.keyboard.up('Space'); await ticks(page, 2);
  const after = await page.evaluate(() => ({ x: __game.active.x, aim: __game.active.aim, phase: __game.phase, proj: __game.projectiles.map((p) => p.type) }));
  assert.ok(after.x > before.x, 'snail walked right');
  assert.ok(after.aim > before.aim, 'aim moved up');
  assert.equal(charging.w, 'granat');
  assert.ok(charging.charging && charging.power > 0.3, 'was charging');
  assert.equal(after.phase, 'retreat');
  assert.deepEqual(after.proj, ['granat']);
  // camera punch: zoomed in right after the blast, back to normal a few seconds later
  const base = await page.evaluate(() => __game.cam.zoom);
  let peak = 0;
  for (let i = 0; i < 60 * 4; i += 5) {
    await ticks(page, 5);
    const z = await page.evaluate(() => __game.cam.zoom);
    peak = Math.max(peak, z);
    if (peak > base * 1.15) break;
  }
  assert.ok(peak > base * 1.15, `camera did not zoom in on the explosion (peak ${peak}, base ${base})`);
  await ticks(page, 30);
  const stillIn = await page.evaluate(() => __game.cam.zoom);
  assert.ok(stillIn > base * 1.1, 'camera zoomed out too soon');
  await ticks(page, 60 * 3);
  const back = await page.evaluate(() => __game.cam.zoom);
  assert.ok(Math.abs(back - base) < 0.01, `camera did not ease back (now ${back}, base ${base})`);
  await ticks(page, 60 * 2);
  await page.screenshot({ path: path.join(outDir, 'after-shot.png') });
  const later = await page.evaluate(() => ({ turn: __game.turnCount, proj: __game.projectiles.length }));
  assert.equal(later.proj, 0, 'grenade exploded');
  assert.ok(later.turn >= 2, 'turn passed to the AI');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('visuals: slime trail while crawling, cracks with damage, shards when a shell breaks', async () => {
  const { page, errors } = await open('/?seed=4242');
  assert.equal(await page.inputValue('#opt-theme'), 'auto');
  await page.selectOption('#opt-theme', 'beach');
  await page.selectOption('.team-row:nth-child(2) select', 'easy');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  await page.click('#tut-skip').catch(() => {});
  assert.equal(await page.evaluate(() => __game.theme.id), 'beach');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('snackmageddon.settings'))).theme, 'beach');
  assert.equal(await page.evaluate(() => __game.trail.length), 0);
  await page.keyboard.down('ArrowRight'); await ticks(page, 90); await page.keyboard.up('ArrowRight');
  const trail = await page.evaluate(() => __game.trail.length);
  assert.ok(trail >= 3, `expected slime after crawling, got ${trail}`);
  // cracks: rendering a damaged snail must not throw, and the shell shows cracks below 70
  await page.evaluate(() => { __game.active.hp = 20; __game.render(); });
  // a kill sends shards flying (visual particles), the state hash stays what the simulation says
  const before = await page.evaluate(() => __game.stateHash());
  const shards = await page.evaluate(() => { const g = __game; const v = g.snails.find((s) => s.alive && s !== g.active); g.killSnail(v); return g.particles.filter((p) => p.shard).length; });
  assert.equal(shards, 8);
  await page.evaluate(() => __game.render());
  assert.notEqual(await page.evaluate(() => __game.stateHash()), before, 'the kill itself is simulation');
  const nodeHash = await page.evaluate(() => { const g = __game; for (let i = 0; i < 120; i++) g.tick(); return g.stateHash(); });
  assert.ok(nodeHash.length > 0);
  await page.screenshot({ path: path.join(outDir, 'visuals.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

await test('gamepad: stick and buttons drive the input, shoulder buttons switch weapons, Start opens the menu', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(20000);
  await fake.install(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // a fake standard-mapping pad the test can drive
  await page.addInitScript(() => {
    const pad = { id: 'Test Pad', index: 0, connected: false, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    window.__press = (i, on = true) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
    navigator.getGamepads = () => [pad];
  });
  await page.goto(base + '/?seed=4242');
  await page.selectOption('.team-row:nth-child(2) select', 'easy');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => { window.__manualTick = true; });
  await page.click('#tut-skip').catch(() => {});
  await page.evaluate(() => { __pad.connected = true; });
  // an idle pad must not block the keyboard or the touch buttons, and must not announce itself
  await page.waitForTimeout(150);
  assert.doesNotMatch(await page.evaluate(() => document.getElementById('notice').textContent), /Gamepad connected|Handkontroll ansluten/, 'a listed but unused pad is not announced');
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => __game.input.left), true, 'keyboard works while an idle pad is listed');
  await page.keyboard.up('ArrowLeft');
  await page.waitForFunction(() => !__game.input.left);
  await page.locator('.tbtn[data-key="fire"]').dispatchEvent('pointerdown');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => __game.input.fire), true, 'touch buttons work while an idle pad is listed');
  await page.locator('.tbtn[data-key="fire"]').dispatchEvent('pointerup');
  await page.waitForFunction(() => !__game.input.fire);
  // left stick right + d-pad up: the first real input announces the pad
  await page.evaluate(() => { __pad.axes[0] = 0.9; __press(12); });
  await page.waitForFunction(() => __game.input.right && __game.input.up && !__game.input.left);
  await page.waitForFunction(() => /Gamepad connected|Handkontroll ansluten/.test(document.getElementById('notice').textContent));
  await page.evaluate(() => { __pad.axes[0] = 0; __press(12, false); });
  await page.waitForFunction(() => !__game.input.right && !__game.input.up);
  // RB then LB cycle the weapon, edge-triggered (holding does not keep cycling)
  const w0 = await page.evaluate(() => __game.weaponId);
  await page.evaluate(() => __press(5));
  await page.waitForFunction((w) => __game.input.weapon !== w, w0);
  const w1 = await page.evaluate(() => __game.input.weapon);
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => __game.input.weapon), w1, 'holding RB must not keep cycling');
  await page.evaluate(() => { __press(5, false); __press(4); });
  await page.waitForFunction((w) => __game.input.weapon === w, w0);
  await page.evaluate(() => __press(4, false));
  // A fires: the input is held while the button is
  await page.evaluate(() => __press(0));
  await page.waitForFunction(() => __game.input.fire);
  await page.evaluate(() => __press(0, false));
  await page.waitForFunction(() => !__game.input.fire);
  // B jumps (one shot), right stick pans the camera
  await page.evaluate(() => __press(1));
  await page.waitForFunction(() => __game.input.jump);
  await page.evaluate(() => { __press(1, false); __pad.axes[2] = 1; });
  const cx = await page.evaluate(() => __game.cam.x);
  await page.waitForFunction((x) => __game.cam.manual && __game.cam.x > x + 20, cx);
  await page.evaluate(() => { __pad.axes[2] = 0; });
  // Start goes to the menu, Start again starts a match
  await page.evaluate(() => __press(9));
  await page.waitForSelector('#menu:not([hidden])');
  await page.evaluate(() => __press(9, false));
  await page.waitForTimeout(80);
  await page.evaluate(() => __press(9));
  await page.waitForFunction(() => document.getElementById('menu').hidden && window.__game && __game.tickCount === 0);
  await page.evaluate(() => __press(9, false));
  assert.deepEqual(errors, []);
  await page.close();
});

await test('AI vs AI in the browser matches the headless Node simulation', async () => {
  const seed = 20260904;
  const { page, errors } = await open(`/?seed=${seed}`);
  await page.selectOption('#opt-teams', '2');
  await page.selectOption('#opt-per', '3');
  for (const sel of await page.$$('.team-row select')) await sel.selectOption('normal');
  const rows = await page.$$eval('.team-row', (rs) => rs.map((r) => ({ name: r.querySelector('input').value, color: r.querySelector('.swatch').style.backgroundColor })));
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  const cfg = await page.evaluate(() => ({ teams: __game.config.teams, snailsPerTeam: __game.config.snailsPerTeam, seed: __game.seed }));
  assert.equal(cfg.seed, seed);
  assert.equal(cfg.teams.length, rows.length);
  const node = new Game(null, cfg);
  const TOTAL = 60 * 150, CHUNK = 300;
  let b;
  for (let done = 0; done < TOTAL; done += CHUNK) {
    b = await ticks(page, CHUNK);
    for (let i = 0; i < CHUNK; i++) node.tick();
    assert.equal(b.hash, node.stateHash(), `browser and Node diverged at tick ${b.tick}`);
    if (done === CHUNK * 4) await page.screenshot({ path: path.join(outDir, 'ai-match.png') });
    if (b.phase === 'over') break;
  }
  assert.ok(b.turn >= 5, `expected several turns, got ${b.turn}`);
  const hp = await page.evaluate(() => __game.snails.map((s) => s.hp));
  assert.ok(hp.some((h) => h < 100), 'somebody got hit');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('phone portrait: touch controls and HUD do not overlap', async () => {
  const { page, errors } = await open('/?seed=7', { width: 390, height: 844 }, { deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  await ticks(page, 30);
  await page.screenshot({ path: path.join(outDir, 'mobile.png') });
  const box = async (sel) => page.locator(sel).boundingBox();
  const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const left = await box('.touch.left'), right = await box('.touch.right');
  const weapons = await box('#weapons'), teams = await box('#hud-teams'), turn = await box('.hud-turn'), wind = await box('.hud-wind');
  assert.ok(!overlaps(left, right), 'touch button groups overlap');
  assert.ok(!overlaps(weapons, teams), 'weapon bar overlaps team list');
  assert.ok(!overlaps(turn, wind), 'turn chip overlaps wind');
  assert.ok(left.x + left.width <= 390 && right.x + right.width <= 390, 'buttons off screen');
  // the fire button must react to touch
  await page.locator('.tbtn.fire').dispatchEvent('pointerdown');
  await ticks(page, 10);
  assert.equal(await page.evaluate(() => __game.charging), true, 'touch fire did not start charging');
  await page.locator('.tbtn.fire').dispatchEvent('pointerup');
  await ticks(page, 5);
  assert.equal(await page.evaluate(() => __game.phase), 'retreat');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('language switch translates the menu and default team names', async () => {
  const { page, errors } = await open('/');
  // headless Chromium is en-US, so the page starts in English
  assert.equal(await page.locator('#btn-start').textContent(), 'Start match');
  assert.equal(await page.inputValue('.team-row:nth-child(1) input'), 'Slime Gang');
  assert.deepEqual(await page.$$eval('.team-row:nth-child(2) select option', (os) => os.map((o) => o.textContent)), ['Human', 'Computer – easy', 'Computer – normal', 'Computer – hard']);
  assert.equal(await page.title(), 'Snailmageddon');
  assert.equal(await page.locator('h1').textContent(), 'Snailmageddon');
  await page.selectOption('#opt-lang', 'sv');
  assert.equal(await page.title(), 'Snäckmageddon');
  assert.equal(await page.locator('#btn-start').textContent(), 'Starta match');
  assert.equal(await page.inputValue('.team-row:nth-child(1) input'), 'Slemligan');
  assert.equal(await page.locator('#opt-style option').first().textContent(), 'Tecknad (Worms-stil)');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'sv');
  // a custom name survives a switch, a default name follows it
  await page.fill('.team-row:nth-child(2) input', 'Mitt lag');
  await page.selectOption('#opt-lang', 'en');
  assert.equal(await page.inputValue('.team-row:nth-child(1) input'), 'Slime Gang');
  assert.equal(await page.inputValue('.team-row:nth-child(2) input'), 'Mitt lag');
  // the choice is remembered
  await page.selectOption('#opt-lang', 'sv');
  await page.reload();
  await page.waitForSelector('#btn-start');
  assert.equal(await page.locator('#btn-start').textContent(), 'Starta match');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('settings: turn time, sudden death, volume and the mute button are remembered', async () => {
  const { page, errors } = await open('/?seed=4242');
  assert.equal(await page.inputValue('#opt-turntime'), '45');
  assert.equal(await page.inputValue('#opt-sudden'), '16');
  assert.equal(await page.inputValue('#opt-volume'), '80');
  await page.selectOption('#opt-turntime', '20');
  await page.selectOption('#opt-sudden', '0');
  await page.fill('#opt-volume', '40');
  await page.dispatchEvent('#opt-volume', 'input');
  await page.selectOption('.team-row:nth-child(1) select', 'normal');
  await page.selectOption('.team-row:nth-child(2) select', 'normal');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => { window.__manualTick = true; });
  const rules = await page.evaluate(() => ({ ...__game.rules, timer: __game.timer, rec: [__game.recording.turnTime, __game.recording.suddenDeath] }));
  assert.deepEqual(rules, { turnTime: 20, suddenDeath: 0, timer: 20, rec: [20, 0] });
  await page.waitForFunction(() => document.getElementById('hud-timer').textContent === '20');
  // the HUD mute button flips the sound and the menu keeps the state
  assert.equal(await page.locator('#btn-mute').textContent(), '🔊');
  await page.click('#btn-mute');
  assert.equal(await page.locator('#btn-mute').textContent(), '🔇');
  assert.equal(await page.getAttribute('#btn-mute', 'aria-label'), 'Sound on');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.settings')));
  assert.equal(saved.muted, true);
  assert.equal(saved.volume, 0.4);
  assert.equal(saved.turnTime, 20);
  assert.equal(saved.suddenDeath, 0);
  // a kill shot switches on slow motion: the loop then advances fewer ticks per real second
  await page.evaluate(() => {
    const g = __game;
    const victim = g.snails.find((s) => s.alive && s.team !== g.active.team);
    victim.hp = 5;
    g.explosion(victim.x, victim.y - 10, 40, 50, null);
  });
  const slow = await page.evaluate(() => __game.slowmo);
  assert.ok(slow > 0, 'slow motion did not start');
  await page.evaluate(() => { window.__manualTick = false; });
  const t0 = await page.evaluate(() => __game.tickCount);
  await page.waitForTimeout(500);
  const t1 = await page.evaluate(() => __game.tickCount);
  assert.ok(t1 - t0 < 20, `expected slowed ticks, got ${t1 - t0} in 500 ms`);
  // everything survives a reload
  await page.reload();
  await page.waitForSelector('#btn-start');
  assert.equal(await page.inputValue('#opt-turntime'), '20');
  assert.equal(await page.inputValue('#opt-sudden'), '0');
  assert.equal(await page.inputValue('#opt-volume'), '40');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('first-match guide advances as the player walks, aims and fires', async () => {
  const { page, errors } = await open('/?seed=4242');
  await page.selectOption('.team-row:nth-child(2) select', 'normal');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  // the guide is evaluated by the HUD updater (throttled to ~80 ms), so give it a moment after each action
  const settle = async () => { await ticks(page, 5); await page.waitForTimeout(200); };
  await settle();
  const step = () => page.evaluate(() => ({ hidden: document.getElementById('tutorial').hidden, text: document.getElementById('tut-step').textContent }));
  assert.deepEqual(await step(), { hidden: false, text: 'Step 1 of 4' });
  await page.keyboard.down('ArrowRight'); await ticks(page, 60); await page.keyboard.up('ArrowRight'); await settle();
  assert.equal((await step()).text, 'Step 2 of 4');
  await page.keyboard.down('ArrowUp'); await ticks(page, 20); await page.keyboard.up('ArrowUp'); await settle();
  assert.equal((await step()).text, 'Step 3 of 4');
  await page.keyboard.down('Space'); await ticks(page, 20); await page.keyboard.up('Space'); await settle();
  assert.equal((await step()).text, 'Step 4 of 4');
  await page.click('#tut-skip');
  assert.equal((await step()).hidden, true);
  // done: a new match does not show the guide again
  await page.click('#btn-menu');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  await settle();
  assert.equal((await step()).hidden, true);
  assert.deepEqual(errors, []);
  await page.close();
});

await test('Snigelpost: two players trade turns through the server', async () => {
  // both browsers get their own anonymous user (separate contexts, separate storage)
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const setup = async (ctx, url) => {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    await fake.install(page);
    // stand-in for the browser's push service: no network, deterministic keys
    await page.addInitScript(() => {
      const sub = { endpoint: 'https://push.example.test/' + Math.random().toString(36).slice(2), toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPUBKEY', auth: 'AUTH' } }; } };
      let current = null;
      PushManager.prototype.getSubscription = async () => current;
      PushManager.prototype.subscribe = async () => { current = sub; return sub; };
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + url);
    await page.evaluate(() => { window.__manualTick = true; });
    return page;
  };
  const shoot = async (page) => {
    await page.keyboard.down('ArrowUp'); await ticks(page, 10); await page.keyboard.up('ArrowUp');
    await page.keyboard.down('Space'); await ticks(page, 25); await page.keyboard.up('Space');
    for (let i = 0; i < 400; i++) { await ticks(page, 10); if (await page.evaluate(() => __game.paused || __game.phase === 'over')) break; }
    await page.waitForTimeout(150);
  };
  // A creates a match and sees the invite link before playing turn 1
  const a = await setup(ctxA, '/');
  await a.waitForSelector('#online:not([hidden])');
  await a.fill('#opt-name', 'Anna');
  await a.click('#btn-online-create');
  await a.waitForSelector('#waiting:not([hidden])');
  const link = await a.inputValue('#wait-link');
  assert.match(link, /\?match=/, 'no invite link');
  assert.equal(await a.locator('#btn-wait-play').isHidden(), false, 'host should be offered to play turn 1');
  await a.click('#btn-wait-play');
  await shoot(a);
  await a.waitForFunction(() => document.getElementById('wait-status').textContent.length > 0 && !document.getElementById('waiting').hidden);
  const afterA = await a.evaluate(() => ({ status: document.getElementById('wait-status').textContent, paused: __game.paused, hash: __game.stateHash() }));
  assert.ok(afterA.paused, 'host game not paused after its turn');
  const matchId = new URL(link).searchParams.get('match');
  const m1 = fake.matches.get(matchId);
  assert.equal(m1.turn_count, 1, 'turn 1 not stored');
  assert.equal(m1.last_hash, afterA.hash);
  // B opens the link: joins, watches A's turn, plays turn 2
  const b = await setup(ctxB, '/?match=' + matchId);
  await b.waitForFunction(() => window.__game);
  await b.waitForSelector('#replaybar:not([hidden])');
  await b.click('#btn-skip-replay');
  const bState = await b.evaluate(() => ({ hash: __game.stateHash(), tick: __game.tickCount, team: __game.active.team, paused: __game.paused, waiting: document.getElementById('waiting').hidden }));
  assert.equal(bState.hash, m1.last_hash, 'guest did not reproduce the host turn');
  assert.equal(bState.team, 1);
  assert.equal(bState.paused, false);
  assert.equal(bState.waiting, true, 'guest should be playing, not waiting');
  assert.equal(fake.matches.get(matchId).status, 'playing');
  await shoot(b);
  await b.waitForFunction(() => !document.getElementById('waiting').hidden && /skickat|sent/i.test(document.getElementById('wait-status').textContent));
  const m2 = fake.matches.get(matchId);
  assert.equal(m2.turn_count, 2);
  assert.equal(m2.turn_team, 0);
  // B turns on notifications from the waiting overlay
  await b.waitForSelector('#btn-push:not([hidden])');
  await b.click('#btn-push');
  await b.waitForFunction(() => document.getElementById('btn-push').hidden);
  assert.equal(fake.pushes.length, 1, 'subscription not saved');
  assert.match(fake.pushes[0].endpoint, /push\.example\.test/);
  assert.match(await b.locator('#push-hint').textContent(), /on for this device|på för den här/);
  // both turns asked the server to notify the other player, and the join did too
  const kinds = fake.notifies.map((n) => n.event).sort();
  assert.deepEqual(kinds, ['joined', 'turn', 'turn']);
  // A refreshes, gets B's turn shown, then plays on
  await a.click('#btn-wait-refresh');
  await a.waitForSelector('#replaybar:not([hidden])');
  await a.click('#btn-skip-replay');
  const aState = await a.evaluate(() => ({ hash: __game.stateHash(), team: __game.active.team, paused: __game.paused, waiting: document.getElementById('waiting').hidden }));
  assert.equal(aState.hash, m2.last_hash, 'host did not reproduce the guest turn');
  assert.equal(aState.team, 0);
  assert.equal(aState.paused, false);
  assert.equal(aState.waiting, true);
  // the match was created as best of 3 (the default), so the score shows in the waiting overlay
  assert.equal(fake.series.size, 1);
  assert.equal([...fake.series.values()][0].best_of, 3);
  assert.deepEqual(fake.matches.get(matchId).config, { snailsPerTeam: 3, turnTime: 45, suddenDeath: 16 }, 'rules missing from the match config');
  // B gives up (two presses): match 1 to A, the series continues with match 2 where B starts
  await b.click('#btn-wait-resign'); await b.click('#btn-wait-resign');
  await b.waitForFunction(() => /gav upp|gave up/i.test(document.getElementById('wait-status').textContent));
  assert.equal(fake.matches.get(matchId).status, 'finished');
  assert.equal(fake.matches.get(matchId).winner, 0, 'host should win when guest resigns');
  await until(() => fake.notifies.some((n) => n.match_id === matchId && n.event === 'resigned'), 'no resign notification');
  const rated = [...fake.ratings.values()].map((r) => r.rating).sort((x, y) => y - x);
  assert.deepEqual(rated, [1016, 984], 'the resign should move both ratings');
  assert.equal([...fake.matches.values()].filter((m) => m.rated).length, 1);
  const ser = [...fake.series.values()][0];
  assert.equal(ser.wins_host, 1); assert.equal(ser.status, 'playing'); assert.equal(ser.match_no, 2);
  const m2id = ser.current_match;
  assert.equal(fake.matches.get(m2id).host, ser.guest, 'match 2 should be started by the other player');
  // B sees "next match" in the waiting overlay and it is B's turn there
  await b.waitForFunction(() => !document.getElementById('btn-wait-next').hidden);
  assert.match(await b.locator('#wait-series').textContent(), /0–1|0-1/);
  await b.click('#btn-wait-next');
  await b.waitForFunction(() => window.__game && __game.seed === 4322 && document.getElementById('waiting').hidden && __game.active.team === 0);
  assert.equal(await b.evaluate(() => __game.tickCount), 0, 'match 2 should start fresh');
  await shoot(b);
  await b.waitForFunction(() => /skickat|sent/i.test(document.getElementById('wait-status').textContent));
  // A: match 1 shows as won, series 1–0, and a "next match" button leads to match 2 where A now plays second
  await a.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))); // same as the 8 s poll
  await a.waitForSelector('#gameover:not([hidden])');
  assert.match(await a.locator('#go-title').textContent(), /1–0|1-0/);
  assert.equal(await a.locator('#btn-go-next').isHidden(), false, 'next-match button missing');
  assert.equal(await a.locator('#btn-go-rematch').isHidden(), true, 'rematch should wait until the series is over');
  await a.click('#btn-go-next');
  await a.waitForSelector('#replaybar:not([hidden])');
  await a.click('#btn-skip-replay');
  assert.equal(await a.evaluate(() => __game.active.team), 1, 'A should be team 1 in match 2');
  // timeout claim after A's turn: pretend B has been silent for 15 days
  await shoot(a);
  await a.waitForFunction(() => /skickat|sent/i.test(document.getElementById('wait-status').textContent));
  fake.matches.get(m2id).updated_at = new Date(Date.now() - 15 * 86400000).toISOString();
  await a.click('#btn-wait-refresh');
  await a.waitForTimeout(300);
  assert.equal(await a.locator('#btn-wait-claim').isHidden(), false, 'claim button should show after 14 silent days');
  await a.click('#btn-wait-claim');
  await a.waitForFunction(() => /tog hem|claimed/i.test(document.getElementById('wait-status').textContent));
  assert.equal(ser.status, 'finished', 'series should be decided 2–0');
  assert.equal(ser.winner_user, ser.host);
  // now a rematch (new series) is offered, as is extending to best of 5 (2–0 is not yet 3 wins)
  await a.waitForFunction(() => !document.getElementById('btn-wait-rematch').hidden);
  assert.equal(await a.locator('#btn-wait-extend5').isHidden(), false, 'extend-to-5 should be offered at 2–0');
  assert.equal(await a.locator('#btn-wait-extend3').isHidden(), true);
  await a.click('#btn-wait-rematch');
  await a.waitForFunction(() => window.__game && __game.seed === 4321);
  const rematch = [...fake.matches.values()].find((m) => m.seed === 4321);
  assert.ok(rematch && rematch.status === 'playing' && rematch.guest, 'rematch not created as a playing match');
  assert.equal(fake.series.get(rematch.series_id).best_of, 3, 'rematch keeps the series length');
  assert.ok(fake.notifies.some((n) => n.match_id === rematch.id && n.event === 'rematch'), 'no rematch notification');
  // uncaught errors are reported to the usage counter (analytics is disabled on localhost, so check the hook is wired)
  assert.equal(await a.evaluate(() => typeof window.onerror !== 'undefined'), true);
  // the rematch starts straight into A's turn (A is host again); the HUD menu button leads back
  await a.waitForFunction(() => document.getElementById('waiting').hidden && __game.active.team === 0);
  await a.click('#btn-menu');
  await a.waitForSelector('.mrow');
  await a.waitForFunction(() => document.querySelectorAll('#season-rank li').length === 2);
  assert.match(await a.locator('#season-rank li.me').textContent(), /1032|1031|1030/);
  assert.match(await a.locator('#season-rank-me').textContent(), /rank 1 of 2|plats 1 av 2/);
  assert.match(await a.locator('#profile-stats').textContent(), /Rank: (Garden snail|Trädgårdssnäcka) \(10\d\d\)/);
  assert.match(await a.locator('.mrow .mname').first().textContent(), /Gäst|B|…|Snail|Snäcka/);
  assert.deepEqual(errors, []);
  await ctxA.close(); await ctxB.close();
});

await test('account: link an e-mail, then sign in with a login link on another device', async () => {
  const ctxA = await browser.newContext(), ctxB = await browser.newContext();
  const a = await ctxA.newPage(); a.setDefaultTimeout(20000); await fake.install(a);
  await a.goto(base + '/'); await a.waitForSelector('#online:not([hidden])');
  await a.waitForFunction(() => !document.getElementById('account-row').hidden);
  assert.match(await a.locator('#account-status').textContent(), /lives in this browser|bara i den här/);
  // a match exists on A's anonymous account
  await a.fill('#opt-name', 'Anna'); await a.click('#btn-online-create');
  await a.waitForSelector('#waiting:not([hidden])');
  const uidA = [...fake.matches.values()][fake.matches.size - 1].host;
  await a.click('#btn-wait-menu');
  // bad address is refused locally, good address sends a confirmation mail
  await a.fill('#opt-email', 'not-an-address'); await a.click('#btn-link-email');
  assert.match(await a.locator('#account-msg').textContent(), /valid e-mail|giltig/);
  await a.fill('#opt-email', 'anna@example.test'); await a.click('#btn-link-email');
  await a.waitForFunction(() => /confirm|bekräfta/i.test(document.getElementById('account-msg').textContent));
  await a.waitForFunction(() => /Confirmation sent|Bekräftelse skickad/.test(document.getElementById('account-status').textContent));
  assert.equal(fake.mails.length, 1); assert.equal(fake.mails[0].kind, 'email_change'); assert.equal(fake.mails[0].uid, uidA);
  assert.match(fake.mails[0].redirect, /^http:\/\/localhost:\d+\/$/);
  // clicking the link brings the browser back with the session in the fragment: same user, now linked
  await a.goto('about:blank'); await a.goto(base + '/' + fake.clickMail(fake.mails[0])); // a real link is a fresh page load
  await a.waitForFunction(() => /linked to anna@example.test|kopplat till anna@example.test/.test(document.getElementById('account-status').textContent));
  assert.equal(await a.evaluate(() => location.hash), '', 'tokens should be removed from the URL');
  assert.match(await a.locator('#account-msg').textContent(), /now linked|nu kopplat/);
  assert.equal(await a.locator('#account-row').isHidden(), true);
  assert.equal(await a.locator('#btn-logout').isHidden(), false);
  await a.waitForSelector('.mrow');
  assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidA);
  // device B: anonymous at first, asks for a login link with the same address
  const b = await ctxB.newPage(); b.setDefaultTimeout(20000); await fake.install(b);
  await b.goto(base + '/'); await b.waitForFunction(() => !document.getElementById('account-row').hidden);
  assert.equal(await b.locator('.mrow').count(), 0);
  await b.fill('#opt-email', 'nobody@example.test'); await b.click('#btn-login-email');
  await b.waitForFunction(() => /no account|inget konto/i.test(document.getElementById('account-msg').textContent));
  await b.fill('#opt-email', 'Anna@example.test'); await b.click('#btn-login-email');
  await b.waitForFunction(() => /Login link sent|Inloggningslänk skickad/.test(document.getElementById('account-msg').textContent));
  assert.equal(fake.mails.length, 2); assert.equal(fake.mails[1].kind, 'magiclink'); assert.equal(fake.mails[1].uid, uidA);
  await b.goto('about:blank'); await b.goto(base + '/' + fake.clickMail(fake.mails[1]));
  await b.waitForFunction(() => /linked to anna@example.test|kopplat till anna@example.test/.test(document.getElementById('account-status').textContent));
  await b.waitForSelector('.mrow');
  assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidA, 'B should now be the same user as A');
  // sign out gives a fresh anonymous account on this device
  await b.click('#btn-logout');
  await b.waitForFunction(() => !document.getElementById('account-row').hidden);
  assert.notEqual(await b.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidA);
  await ctxA.close(); await ctxB.close();
});

await test('Google: link an anonymous account, sign in with it elsewhere, a taken identity offers login; rate limit and scanner-proof links', async () => {
  const ctxA = await browser.newContext(), ctxB = await browser.newContext(), ctxC = await browser.newContext();
  const a = await ctxA.newPage(); a.setDefaultTimeout(20000); await fake.install(a);
  await a.goto(base + '/'); await a.waitForFunction(() => !document.getElementById('account-row').hidden);
  await a.fill('#opt-name', 'Anna'); await a.click('#btn-online-create');
  await a.waitForSelector('#waiting:not([hidden])');
  const uidA = [...fake.matches.values()][fake.matches.size - 1].host;
  await a.click('#btn-wait-menu');
  // A links the anonymous account: same user id afterwards, the match is still there
  await a.click('#btn-google');
  await a.waitForFunction(() => /via Google/.test(document.getElementById('account-status').textContent));
  assert.equal(await a.evaluate(() => location.hash), '');
  assert.match(await a.locator('#account-msg').textContent(), /now linked|nu kopplat/);
  assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidA);
  assert.equal(fake.google.owner, uidA);
  await a.waitForSelector('.mrow');
  // B: a fresh device signs in with the same Google account and becomes A
  const b = await ctxB.newPage(); b.setDefaultTimeout(20000); await fake.install(b);
  await b.goto(base + '/'); await b.waitForFunction(() => !document.getElementById('account-row').hidden);
  await b.click('#btn-google'); // two hops: the link attempt is refused, then it signs in as the owner
  await b.waitForFunction(() => /signed in|inloggad/i.test(document.getElementById('account-msg')?.textContent || ''));
  await b.waitForSelector('.mrow');
  assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidA);
  // C: anonymous with a match of its own; the Google identity already belongs to A
  const c = await ctxC.newPage(); c.setDefaultTimeout(20000); await fake.install(c);
  await c.goto(base + '/'); await c.waitForFunction(() => !document.getElementById('account-row').hidden);
  await c.fill('#opt-name', 'Carl'); await c.click('#btn-online-create');
  await c.waitForSelector('#waiting:not([hidden])'); await c.click('#btn-wait-menu');
  const uidC = await c.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id);
  assert.notEqual(uidC, uidA);
  await c.click('#btn-google');
  await c.waitForFunction(() => /another player account|annat spelarkonto/.test(document.getElementById('account-msg')?.textContent || ''));
  assert.equal(await c.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidC, 'still Carl until he chooses to switch');
  await c.click('#btn-google-login');
  await c.waitForFunction(() => /via Google/.test(document.getElementById('account-status').textContent));
  assert.equal(await c.evaluate(() => JSON.parse(localStorage.getItem('snackmageddon.session')).user_id), uidA);
  // e-mail rate limit is explained, not shown as a raw error
  await c.click('#btn-logout'); await c.waitForFunction(() => !document.getElementById('account-row').hidden);
  fake.google.rateLimited = true;
  await c.fill('#opt-email', 'carl@example.test'); await c.click('#btn-link-email');
  await c.waitForFunction(() => /Too many e-mails|För många mejl/.test(document.getElementById('account-msg').textContent));
  fake.google.rateLimited = false;
  // scanner-proof link: ?token_hash needs a press, the first visit spends nothing
  await c.click('#btn-link-email');
  await c.waitForFunction(() => /Confirmation sent|Bekräftelse skickad/.test(document.getElementById('account-status').textContent));
  const mail = fake.mails[fake.mails.length - 1];
  assert.equal(mail.kind, 'email_change');
  await c.goto('about:blank'); await c.goto(`${base}/?token_hash=${mail.tokenHash}&type=email_change`);
  await c.waitForSelector('#btn-confirm-link:not([hidden])');
  assert.equal(await c.evaluate(() => location.search), '', 'the token is removed from the URL');
  assert.equal(mail.spent, undefined, 'loading the page must not spend the token');
  await c.click('#btn-confirm-link');
  await c.waitForFunction(() => /linked to carl@example.test|kopplat till carl@example.test/.test(document.getElementById('account-status').textContent));
  assert.equal(mail.spent, true);
  assert.equal(await c.locator('#btn-confirm-link').isHidden(), true);
  await ctxA.close(); await ctxB.close(); await ctxC.close();
});

await test('profile: pick a look, locked items stay locked, the look shows up in matches', async () => {
  const { page, errors } = await open('/?seed=4242');
  await page.waitForFunction(() => document.querySelectorAll('#pick-shell button').length === 7 && document.querySelectorAll('#pick-hat button').length === 7);
  assert.equal(await page.locator('#pick-shell button.sel').getAttribute('data-id'), 'spiral');
  assert.equal(await page.locator('#pick-hat button.locked').count(), 4, 'crown, viking, top hat and laurel are locked at first');
  assert.equal(await page.locator('#pick-hat button[data-id=crown]').isDisabled(), true);
  assert.match(await page.locator('#pick-hat button[data-id=crown]').textContent(), /10 wins|10 vinster/);
  assert.match(await page.locator('#pick-shell button[data-id=gold]').textContent(), /Link an e-mail first|Koppla e-post först/);
  await page.click('#pick-shell button[data-id=dots]');
  await page.click('#pick-hat button[data-id=party]');
  assert.equal(await page.locator('#pick-hat button.sel').getAttribute('data-id'), 'party');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('snackmageddon.settings')).look.hat === 'party');
  // saved on the server (debounced) and used for the human team in a local match
  await until(() => [...fake.profiles.values()].some((p) => p.look.shell === 'dots' && p.look.hat === 'party'), 'look not saved on the server');
  await page.selectOption('.team-row:nth-child(2) select', 'hard');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  const looks = await page.evaluate(() => __game.teams.map((t) => t.look));
  assert.deepEqual(looks[0], { shell: 'dots', hat: 'party' });
  assert.equal(looks[1], null, 'the computer team has no look');
  // a Snigelpost match carries the look for the opponent to draw
  await page.click('#btn-menu');
  await page.click('#btn-online-create');
  await page.waitForSelector('#waiting:not([hidden])');
  const m = [...fake.matches.values()].pop();
  assert.deepEqual(m.looks, { 0: { shell: 'dots', hat: 'party' } });
  assert.deepEqual(await page.evaluate(() => __game.teams[0].look), { shell: 'dots', hat: 'party' });
  // the look survives a reload
  await page.click('#btn-wait-menu');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pick-hat button.sel')?.dataset.id === 'party');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('season awards: badges in the profile, the item unlocks, last season shows the winners', async () => {
  const { page, errors } = await open('/');
  await page.waitForFunction(() => document.querySelectorAll('#pick-hat button').length === 7 && document.querySelectorAll('#pick-shell button').length === 7);
  const laurel = page.locator('#pick-hat button[data-id=laurel]');
  assert.equal(await laurel.isDisabled(), true);
  assert.match(await laurel.textContent(), /Top 3 in rating|Topp 3 i rating/);
  assert.equal(await page.locator('#profile-awards').isHidden(), true);
  assert.match(await page.locator('#season-last').textContent(), /No rewards|inga belöningar/);
  // the season closer hands this player a laurel wreath (2nd in rating) and someone else the confetti shell
  const uid = [...fake.accounts.keys()].pop();
  fake.profiles.set('other', { name: 'Eva', look: {} });
  fake.awards.push({ season: '2026-Q2', uid, kind: 'rank', place: 2, item: 'laurel', value: 1090 }, { season: '2026-Q2', uid: 'other', kind: 'daily', place: 1, item: 'confetti', value: 1240 });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('profile-awards').hidden);
  assert.match(await page.locator('#profile-awards').textContent(), /2026-Q2: #2 in rating \(1090\)|2026-Q2: 2:a i rating \(1090\)/);
  assert.equal(await laurel.isDisabled(), false);
  assert.equal(await page.locator('#pick-shell button[data-id=confetti]').isDisabled(), true, 'the other award stays locked');
  await laurel.click();
  await page.waitForFunction(() => document.querySelector('#pick-hat button.sel')?.dataset.id === 'laurel');
  await until(() => [...fake.profiles.values()].some((p) => p.look.hat === 'laurel'), 'laurel not saved');
  await page.waitForFunction(() => /2026-Q2/.test(document.getElementById('season-last').textContent));
  assert.match(await page.locator('#season-last').textContent(), /Eva · (shot of the day|Dagens skott) 1240/);
  assert.match(await page.locator('#season-rewards').textContent(), /laurel wreath|lagerkransen/);
  // a game draws the awarded hat on the player's snails
  await page.selectOption('.team-row:nth-child(2) select', 'easy');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game);
  assert.equal(await page.evaluate(() => __game.teams[0].look.hat), 'laurel');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('buying premium cosmetics: needs a linked e-mail, starts Checkout, unlocks on return', async () => {
  const { page, errors } = await open('/');
  await page.waitForFunction(() => document.querySelectorAll('#pick-shell button').length === 7);
  // anonymous: premium is locked with a hint to link an e-mail first
  const gold = page.locator('#pick-shell button[data-id=gold]');
  assert.equal(await gold.isDisabled(), true);
  assert.match(await gold.textContent(), /Link an e-mail first|Koppla e-post först/);
  // link an e-mail (server side) and reload: the buy button appears
  const uid = [...fake.accounts.keys()].pop();
  fake.accounts.get(uid).email = 'buyer@example.test';
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pick-shell button[data-id=gold]')?.classList.contains('buy'));
  assert.equal(await gold.isDisabled(), false);
  assert.match(await gold.textContent(), /Buy|Köp/);
  assert.equal(await page.locator('#pick-hat button[data-id=tophat]').isDisabled(), false);
  // buying goes through the buy function, which sends the browser to Checkout (the fake sends it straight back)
  await page.click('#pick-shell button[data-id=gold]');
  await page.waitForFunction(() => document.querySelector('#pick-shell button[data-id=gold]')?.classList.contains('locked') && location.search === '', null, { timeout: 5000 }).catch(() => {});
  assert.deepEqual(fake.checkouts, [{ uid, item: 'gold' }]);
  // back on the site with ?bought=gold before the webhook has landed: waits, then the grant arrives
  await page.goto('about:blank');
  await page.goto(base + '/?bought=gold');
  await page.waitForFunction(() => /waiting for confirmation|väntar på bekräftelse/.test(document.getElementById('profile-msg').textContent));
  fake.grant(uid, 'gold');
  await page.waitForFunction(() => /Thanks for your purchase|Tack för köpet/.test(document.getElementById('profile-msg').textContent), null, { timeout: 8000 });
  assert.equal(await page.locator('#pick-shell button.sel').getAttribute('data-id'), 'gold', 'the bought shell should be selected');
  assert.equal(await page.evaluate(() => location.search), '', 'the query should be cleaned');
  await until(() => [...fake.profiles.values()].pop()?.look.shell === 'gold', 'bought look not saved on the server');
  // cancelled checkout just says so
  await page.goto('about:blank');
  await page.goto(base + '/?cancelled=tophat');
  await page.waitForFunction(() => /cancelled|avbröts/.test(document.getElementById('profile-msg').textContent));
  assert.deepEqual(errors, []);
  await page.close();
});

await test('shot of the day: play, get a score, see it on the leaderboard', async () => {
  const { page, errors } = await open('/?day=2026-09-05');
  await page.waitForFunction(() => document.getElementById('daily-day').textContent === '2026-09-05');
  await page.waitForFunction(() => /Nobody has taken|Ingen har skjutit/.test(document.getElementById('daily-status').textContent));
  assert.match(await page.locator('#daily-blurb').textContent(), /grenade|granat/i);
  await page.fill('#opt-name', 'Anna');
  await page.click('#btn-daily');
  await page.waitForFunction(() => window.__game && __game.daily);
  await page.evaluate(() => { window.__manualTick = true; });
  assert.equal(await page.evaluate(() => __game.weaponId), 'granat');
  assert.equal(await page.locator('#weapons button:not([disabled])').count(), 1, 'only the weapon of the day is selectable');
  // make sure the shot counts: weaken a target and blow it up, then fire
  await page.evaluate(() => { const t = __game.teams[1].snails[0]; t.hp = 20; __game.explosion(t.x, t.y - 10, 36, 48, null); });
  await page.keyboard.down('Space'); await ticks(page, 20); await page.keyboard.up('Space');
  await page.evaluate(() => { for (let i = 0; i < 60 * 60 && __game.phase !== 'over'; i++) __game.tick(); });
  await page.waitForSelector('#gameover:not([hidden])');
  const score = await page.evaluate(() => __game.daily.score);
  assert.ok(score >= 150, `score ${score}`);
  assert.match(await page.locator('#go-title').textContent(), new RegExp(`${score} (points|poäng)`));
  await page.waitForFunction(() => /Rank 1 of 1|Plats 1 av 1/.test(document.getElementById('go-daily').textContent));
  assert.match(await page.locator('#go-daily').textContent(), /New best|Nytt dagsbästa/);
  assert.equal(await page.locator('#btn-again').textContent(), 'Try again');
  const row = [...fake.dailyRows.values()][0];
  assert.equal(row.name, 'Anna'); assert.equal(row.score, score); assert.equal(row.recording.mode, 'daily');
  // back in the menu the board shows the entry
  await page.click('#btn-tomenu');
  await page.waitForFunction(() => document.querySelectorAll('#daily-board li').length === 1);
  assert.match(await page.locator('#daily-board li.me').textContent(), /Anna/);
  assert.match(await page.locator('#daily-me').textContent(), /rank 1 of 1|plats 1 av 1/);
  // a worse retry keeps the best
  await page.click('#btn-daily');
  await page.waitForFunction(() => window.__game && __game.daily && __game.phase === 'aim');
  await page.evaluate(() => { for (let i = 0; i < 60 * 60 && __game.phase !== 'over'; i++) __game.tick(); });
  await page.waitForFunction(() => /Your best: \d+|Ditt bästa: \d+/.test(document.getElementById('go-daily').textContent));
  assert.equal([...fake.dailyRows.values()][0].score, score);
  assert.equal([...fake.dailyRows.values()][0].attempts, 2);
  assert.deepEqual(errors, []);
  await page.close();
});

await test('Poki build: no links out, no invitations or accounts, local play and the shot of the day work', async () => {
  const { page, errors } = await open('/?platform=poki&seed=4242');
  await page.waitForFunction(() => document.body.classList.contains('portal'));
  await page.evaluate(() => window.__platformReady); // with network the real SDK boots here, without it the game carries on
  assert.equal(await page.locator('a[href]:not([hidden])').count(), 0, 'no visible links');
  for (const id of ['btn-install', 'online-title', 'btn-online-create', 'online-list', 'account']) assert.equal(await page.locator('#' + id).isHidden(), true, id + ' should be hidden');
  assert.equal(await page.locator('#opt-name').isVisible(), true, 'the name is still needed for the leaderboards');
  assert.equal(await page.locator('#daily').isVisible(), true);
  assert.equal(await page.locator('#season').isVisible(), true);
  await page.waitForFunction(() => document.querySelectorAll('#pick-shell button').length === 7);
  assert.equal(await page.locator('#pick-shell button[data-id=gold]').textContent().then((t) => /Buy|Köp/.test(t)), false, 'no purchases on Poki');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null, 'no service worker on a portal');
  await page.selectOption('.team-row:nth-child(2) select', 'easy');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__game && __game.turnCount === 1);
  // without network the SDK download fails and the game must carry on; with it, nothing may be called before the SDK has booted
  // (the SDK's own COOP-header warning appears only because the test server is plain http on a non-localhost origin in CI)
  assert.deepEqual(errors.filter((e) => !/Failed to load resource|Cross-Origin-Opener-Policy/.test(e)), []);
  await page.close();
});

await test('Google Play (TWA): everything as on the web except purchases, the daily shortcut starts the shot', async () => {
  const { page, errors } = await open('/?twa=1');
  await page.waitForFunction(() => document.querySelectorAll('#pick-shell button').length === 7);
  const uid = [...fake.accounts.keys()].pop();
  fake.accounts.get(uid).email = 'play@example.test';
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#pick-shell button').length === 7 && sessionStorage.getItem('snackmageddon.twa') === '1');
  assert.equal(await page.locator('#pick-shell button[data-id=gold]').isDisabled(), true, 'no Stripe purchases inside the Play app');
  assert.equal(await page.locator('#online-title').isVisible(), true, 'Snigelpost stays');
  assert.equal(await page.locator('#account').isVisible(), true, 'e-mail linking stays');
  await page.goto(base + '/?daily=1');
  await page.waitForFunction(() => window.__game && __game.daily);
  assert.equal(await page.evaluate(() => location.search), '');
  assert.deepEqual(errors, []);
  await page.close();
});

await test('service worker registers and manifest is valid', async () => {
  const { page, errors } = await open('/');
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  assert.ok(sw.active, 'service worker not active');
  const manifest = await page.evaluate(() => fetch('manifest.webmanifest').then((r) => r.json()));
  assert.equal(manifest.display, 'fullscreen');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'Play wants a maskable icon');
  assert.equal(manifest.id, '/');
  assert.ok(manifest.screenshots.length >= 4 && manifest.screenshots.some((s) => s.form_factor === 'narrow'));
  assert.deepEqual(manifest.categories, ['games', 'entertainment']);
  for (const s of manifest.screenshots) assert.equal((await page.evaluate((u) => fetch(u).then((r) => r.status), s.src)), 200, s.src + ' missing');
  assert.equal(await page.evaluate(() => fetch('.well-known/assetlinks.json').then((r) => r.json()).then((j) => j[0].target.package_name)), 'se.snails.app');
  assert.equal(await page.evaluate(() => fetch('privacy.html').then((r) => r.status)), 200);
  assert.deepEqual(errors, []);
  await page.close();
});

await browser.close();
server.close();
if (failed) { console.log(`\n${failed} browser test(s) failed`); process.exit(1); }
console.log('\nall browser tests passed');
