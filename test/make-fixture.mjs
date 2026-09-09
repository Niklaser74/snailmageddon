// Generates a golden fixture for the current rules version: two AI matches with
// the state hash at every turn change. Run from the repo root:
//   node test/make-fixture.mjs . > test/fixtures/rules-v<N>.json
// Do it once when a rules version is introduced, never again for that version:
// the fixture is the proof that later code still plays old matches identically.
const { Game, RULES_VERSION } = await import(new URL(process.argv[2] + '/js/game.js', 'file://' + process.cwd() + '/').href);
const out = [];
const mk = (seed, teams) => ({ seed, snailsPerTeam: 3, teams });
for (const [name, cfg] of [
  ['ai-vs-ai', mk(20260904, [{ name: 'A', color: '#f00', ai: true }, { name: 'B', color: '#00f', ai: true }])],
  ['fast-rules', { ...mk(777, [{ name: 'A', color: '#f00', ai: true }, { name: 'B', color: '#00f', ai: true }]), turnTime: 20, suddenDeath: 8 }],
  ...(RULES_VERSION >= 4 ? [['storm-rules', { ...mk(4242, [{ name: 'A', color: '#f00', ai: 'hard' }, { name: 'B', color: '#00f', ai: 'hard' }]), wind: 'storm' }]] : []),
]) {
  const g = new Game(null, cfg);
  const hashes = [];
  let lastTurn = -1;
  for (let i = 0; i < 60 * 240 && g.phase !== 'over'; i++) { g.tick(); if (g.turnCount !== lastTurn) { hashes.push([g.tickCount, g.stateHash()]); lastTurn = g.turnCount; } }
  hashes.push([g.tickCount, g.stateHash()]);
  out.push({ name, ticks: g.tickCount, turns: g.turnCount, phase: g.phase, recording: g.recording, hashes });
}
console.log(JSON.stringify({ rulesVersion: RULES_VERSION, generated: new Date().toISOString().slice(0, 10), matches: out }));
