# Snäckmageddon

*Snäckmageddon is a Worms-style, turn-based artillery game with giant African
land snails, built as an installable PWA with no build step. The interface is
available in Swedish and English (auto-detected, switchable in the menu). Play
it at https://snails.se/snailmageddon/ or on itch.io: https://knackpot.itch.io/snailmageddon.*

Turbaserat artilleri-spel i Worms Armageddon-anda, fast med **afrikanska jättesnäckor**
(Achatina) i stället för maskar. Byggt som en installerbar PWA i ren HTML/Canvas/JavaScript
utan byggsteg eller beroenden.

## Köra

Spelet måste serveras över HTTP (ES-moduler + service worker fungerar inte via `file://`):

```bash
npx serve .          # eller: python3 -m http.server 8080
```

Öppna sedan `http://localhost:8080` (eller den port som skrivs ut). Publiceringen
sker automatiskt till GitHub Pages vid varje push till `main`. Spelet ligger på
**https://snails.se/snailmageddon/**: domänen sitter på hubben
([Niklaser74/Niklaser74.github.io](https://github.com/Niklaser74/Niklaser74.github.io)),
och GitHub Pages lägger varje repo på kontot under `snails.se/<repo>/`. Därför
har det här repot ingen `CNAME` och inga rotrelativa sökvägar —
`test/paths.test.mjs` stoppar dem, och samma regel är det som gör itch- och
Poki-zipparna möjliga. Manifestets `"id": "/"` är kvar från tiden på roten och
ska inte ändras: samma id gör att installerade appar uppdateras i stället för
att bli dubbletter. Allt på snails.se delar origin, så cache-namn (`sw.js`)
och `localStorage`-nycklar är prefixade med spelets namn.

## Snäckdesign

`design/snails.html` visar fem förslag på hur snäckorna kan se ut, ritade med samma kod
som spelet använder (`js/snails.js`). Vald stil kan bytas i spelmenyn. Standardstilen
sätts i `js/main.js` (`settings.style`).

| id | Stil |
|----|------|
| `cartoon` | Tecknad Worms-stil (standard) |
| `achatina` | Naturtrogen Achatina med koniskt skal |
| `kommando` | Kommandosnäcka med hjälm och bandana |
| `pixel` | Retro 24×16 pixelsprite |
| `flat` | Flat/minimalistisk |

## Spelet

- 2–4 lag, 1–4 snäckor per lag, människa eller dator per lag.
- 45 sekunder per drag, 4 sekunders reträtt efter skott.
- Vapen: Bazooka (vind), Granat (studsar, 3 s), Saltspruta (kort räckvidd), Dynamit,
  Slemklot (klibbar fast, även på snäckor, 2 s), Saltregn (markörsiktat luftanfall).
  Dynamit, slemklot och saltregn har begränsad ammunition per lag.
- Lådor faller ner mellan dragen: hälsa (+35) eller extra ammunition. Lådor i en
  explosion smäller själva.
- Förstörbar terräng, fallskada, vatten som dränker, plötslig död efter 16 drag.
- Språk: svenska eller engelska, väljs automatiskt efter webbläsaren och kan bytas i
  menyn. All UI-text ligger i `js/i18n.js`; spelmotorn skickar meddelandenycklar.
- Guide: en fyrstegsguide visas i första matchen (gå, sikta, skjut, reträtt) och kan
  visas igen från hjälpdialogen.
- Mätning: ett fåtal anonyma händelser (app-öppning, matchstart/slut, guide) räknas i
  Supabase. Inga namn, inga IP-adresser, av på localhost och vid Do Not Track.
  Se `supabase/README.md`.
- Tangentbord: ← → / A D gå, ↑ ↓ / W S sikta, mellanslag ladda+skjut, Enter hoppa,
  1–8 / Tab vapen, Esc meny. Touch: knappar på skärmen, dra för att panorera, nyp för zoom.
  Handkontroll: styrkors/spak, A skjut, B hoppa, LB/RB vapen, högerspak kamera, Start meny.

## Snigelpost (asynkront multiplayer)

Spela mot en kompis i egen takt: skapa en match i menyn, skicka länken, spela
ditt drag när du hinner. Varje drag lagras som inspelade indata i Supabase
(`snails_matches`, `snails_turns`) och spelas upp exakt på motståndarens enhet
tack vare den deterministiska simuleringen. Motståndarens senaste drag visas i
tredubbel hastighet innan du får spela. Väntläget uppdateras automatiskt var
åttonde sekund, och med knappen "Meddela mig när det är min tur" får du en
push-notis när motståndaren spelat, även när sidan är stängd (iPhone kräver att
spelet är installerat på hemskärmen). Kräver att **anonym inloggning** är påslagen
i Supabase-projektet (Authentication → Sign In / Providers → Anonymous).

## Deterministisk simulering

Simuleringen går i fasta steg om 1/60 s, all slump är seedad och all matte i
simuleringen är motoroberoende (`js/dmath.js`). Kollisionsmasken beräknas
analytiskt, aldrig från canvas-pixlar. Varje indata (tangent, touch eller AI)
går genom `game.tick()` och spelas in som `(tick, input)`-par i
`game.recording`. En inspelning kan spelas upp bit för bit med
`Game.fromRecording(canvas, recording)`, även utan webbläsare:

```bash
npm test               # determinismtester i Node, inga beroenden
npm install            # hämtar Playwright för webbläsartesterna
npm run test:browser   # spelar genom riktiga UI:t i Chromium, skärmdumpar i test-results/
```

Webbläsartestet driver simuleringen tick för tick (`window.__manualTick`) och
jämför webbläsarens `stateHash()` med en headless Node-körning på samma seed
(`?seed=1234` i URL:en ger en reproducerbar match). Båda testsviterna körs i
CI vid varje push.

`game.stateHash()` ger en 32-bitars hash av hela speltillståndet och används
för att upptäcka om två körningar glider isär. Det här är grunden för replays,
asynkront multiplayer och serversidig verifiering.

## Distribution

- `npm run build:itch` bygger `dist/snackmageddon-itch.zip` för itch.io. Arbetsflödet
  *Release build* gör samma sak vid en versionstagg och kan pusha med butler,
  se `docs/store/itch.md`.
- `js/platform.js` känner av var spelet körs (egen sajt, itch.io, Poki) och kopplar in
  Pokis SDK bara där. `?platform=poki` tvingar läget för test. Se `docs/store/poki.md`.
- Butikstexter, omslag och skärmdumpar ligger i `docs/store/`.

## Struktur

```
index.html            app-skal, meny, HUD
manifest.webmanifest  PWA-manifest
sw.js                 service worker (cache-first, offline)
css/style.css
js/main.js            meny, HUD, input, kamera, PWA-registrering
js/game.js            spellogik: turordning, fysik, vapen, AI, rendering (regelversioner: docs/REGELVERSIONER.md)
js/daily.js           Dagens skott: bana och vapen ur datumet, topplista
js/cosmetics.js       skalmönster och hattar, upplåsningsregler, ritning
js/season.js          säsong (kvartal), Elo-spegel och ranknivåer
js/themes.js          terrängteman: färger och dekorationer, rent visuellt
js/gamepad.js         handkontroll (Gamepad API), skriver in i game.input
android/              Bubblewrap-konfiguration för Google Play (docs/store/google-play.md)
privacy.html          integritetspolicy (krävs av Google Play)
js/terrain.js         förstörbar terräng (canvas + kollisionsmask)
js/snails.js          snäck-sprites (alla stilar)
js/audio.js           syntetiserade ljudeffekter
js/rng.js             seedad slump, shuffle, tillståndshash
js/dmath.js           motoroberoende sin/cos/atan2
js/i18n.js            ordlista svenska/engelska
js/supa.js            Supabase-klient (anonym auth, RPC) utan bibliotek
js/online.js          Snigelpost: matcher, drag, replay
js/analytics.js       mätning
js/platform.js        web / itch.io / Poki
js/analytics.js       anonym räknare (Supabase)
js/platform.js        plattformsadapter (web, itch.io, Poki)
scripts/build-itch.mjs paketering för itch.io
docs/store/           butikstexter och bilder
test/                 determinism- och webbläsartester (körs i CI)
design/snails.html    designförslag
icons/                app-ikoner
```
