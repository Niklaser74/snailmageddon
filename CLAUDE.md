# CLAUDE.md

Snäckmageddon — turbaserat artilleri med afrikanska jättesnäckor (Worms med
sniglar). Första spelet i Knackpots snigelserie på snails.se. Installerbar PWA
utan byggsteg: ren HTML, Canvas och ES-moduler. Spelas på
https://snails.se/snailmageddon/, på itch.io och som förberedda byggen för Poki
och Google Play. Hubben som äger domänen är repot `Niklaser74.github.io`.

## Kör

| Vad | Kommando |
| --- | --- |
| Installera | `npm install` |
| Utveckling | `npm start` (Python) eller vilken statisk server som helst över HTTP |
| Tester | `npm test` (sökvägar, determinism, web push, Stripe) |
| Browsertester | `npm run test:browser` och `PREFIX=/snailmageddon npm run test:browser` |
| Bygg (itch/Poki) | `npm run build:itch`, `node scripts/build-poki.mjs` |
| Deploy | push till `main` → GitHub Pages; edge-funktioner separat (se `supabase/README.md`) |

Kör testerna innan du säger att du är klar. Är de röda när du börjar — säg det
och fortsätt inte som om de var gröna.

## Struktur

```
index.html, js/main.js     UI och menyer
js/game.js                 simuleringen — deterministisk, hashas, får aldrig läsa tid eller Math.random
js/terrain.js, themes.js   bana och teman (bara bild, aldrig simulering)
js/snails.js, cosmetics.js sprites — kopieras till hubben, håll dem fria från nätverk
js/supa.js, online.js      Supabase utan bibliotek, Snigelpost
js/push.js, sw.js          Web Push, service worker (cache-prefix snailmageddon-)
supabase/                  migrationer, edge-funktioner, README om projektet snails
test/                      Node-tester + Playwright
docs/store/                butikstexter, release notes
```

## Konventioner

- **Bara relativa sökvägar** i allt som deployas (`js/x.js`, `./`,
  `register('sw.js')`). `test/paths.test.mjs` stoppar rotrelativa. Skälet:
  spelet ligger under `/snailmageddon/` på snails.se och i zippar på itch/Poki.
- **Allt på snails.se delar origin.** Cache-namn börjar med `snailmageddon-`,
  `localStorage`-nycklar med `snackmageddon.`; `sw.js` raderar bara egna cachar.
- Simuleringen (`js/game.js`) använder `dmath.js` och `rng.js` — aldrig
  `Math.sin`/`Math.random`/`Date` — annars går replay-hashen sönder på andra
  enheter. Regelbyten = ny regelversion (`docs/REGELVERSIONER.md`).
- UI-text går via `t()` i `js/i18n.js`, svenska och engelska samtidigt.
- Servern litar inte på klienten mer än den måste: nya RPC:er är
  `security definer` med kontroll på `auth.uid()`, klienten når aldrig tabeller.
- Följ befintliga mönster i koden framför generella best practices. Ser något
  udda ut finns det oftast ett skäl — fråga innan du rättar det.

## Rör inte

- `manifest.webmanifest` `"id": "/"` — appens identitet sedan den låg på
  roten; byte ger dubbletter hos alla som installerat.
- `js/config.js` — nycklarna är publika per design men pekar på projektet
  `snails` (`lygpfumngyebxoqqncet`); byt inte utan flyttplan.
- `supabase/migrations/*` — appliceras aldrig om; ändringar är nya filer.
- `test/fixtures/rules-v*.json` — gyllene inspelningar; ändras bara med ny
  regelversion.
- Priser, juridisk text (`privacy.html`), Stripe- och VAPID-nycklar.

## Hemligheter

Inga i repot. Supabase-hemligheter ligger i projektets Vault och Edge Function
Secrets; itch-nyckeln i GitHub Actions secrets. Skriv aldrig ut nyckelvärden.

## Innan du är klar

1. `npm test` grönt.
2. Release notes i `docs/store/` om spelare märker ändringen.
3. Ändrade sprites (`js/snails.js` m.fl.)? Säg till att hubben ska köra
   `npm run sync:game`.
