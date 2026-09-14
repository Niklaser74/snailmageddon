#!/usr/bin/env node
// Copies the series' shared account client from the hub repo into this game.
// The hub (Niklaser74.github.io, js/account.js) owns the file; games vendor it
// unchanged so builds stay offline and tests deterministic. js/supa.js in the
// game re-exports it, so game code keeps importing `online` from './supa.js'.
//   HUB_DIR=../dev-snails npm run sync:account
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hub = resolve(root, process.env.HUB_DIR || '../dev-snails');
const src = join(hub, 'js', 'account.js');
if (!existsSync(src)) { console.error(`No hub checkout at ${hub} (set HUB_DIR).`); process.exit(1); }
copyFileSync(src, join(root, 'js', 'account.js'));
const hash = execSync('git rev-parse --short HEAD', { cwd: hub }).toString().trim();
const shim = `// The series' shared account client lives in the hub repo (Niklaser74.github.io,
// js/account.js) and is vendored here by \`npm run sync:account\` — do not edit
// js/account.js in this repo. Synced from hub commit ${hash}.
export { online } from './account.js';
`;
writeFileSync(join(root, 'js', 'supa.js'), shim);
const cur = readFileSync(join(root, 'js', 'account.js'), 'utf8');
console.log(`synced js/account.js (${cur.length} bytes) from hub @ ${hash}; js/supa.js re-exports it`);
