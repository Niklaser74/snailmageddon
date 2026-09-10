// Snäckmageddon lives at snails.se/snailmageddon/ (the hub owns the root) and is
// also zipped for itch.io and Poki, so every path in the shipped files must be
// relative. A root-relative one would work on a dev server and break in every
// real deployment. Run with the other Node tests: npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'index.html', 'privacy.html', 'design/snails.html', 'manifest.webmanifest', 'sw.js', 'css/style.css',
  ...fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f),
];
const patterns = [
  /(href|src)=["']\/(?!\/)/,                                          // href="/x"
  /url\(["']?\/(?!\/)/,                                                // css url(/x)
  /["'`]\/(js|css|icons|design|docs|sw\.js|manifest\.webmanifest)\b/,  // '/js/x' in scripts
  /register\(["']\//,                                                  // serviceWorker.register('/sw.js')
  /"(start_url|scope|src|url)":\s*"\/(?!\/)/,                          // manifest entries
];
// the manifest id is deliberately "/" (the app's identity from when it lived at the root)
const allow = [/"id": "\/"/];

const bad = [];
for (const f of files) {
  fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
    if (allow.some((a) => a.test(line))) return;
    if (patterns.some((p) => p.test(line))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
assert.deepEqual(bad, [], 'root-relative paths found');
console.log(`ok   paths: ${files.length} files use relative paths only`);
