# Poki – inskick och checklista

Poki tar in spel via https://developers.poki.com/ (Submit your game). De spelar
igenom spelet själva och ger feedback innan det läggs ut. Räkna med några
veckors ledtid och en QA-runda. Kontot måste du skapa själv; allt nedan är
förberett i koden.

## Vad du skickar in

1. **Länk för granskning:** https://snails.se/snailmageddon/?platform=poki
   (spelet går i Poki-läge: SDK:n laddas, inga länkar ut, inga konton).
   Lägg till `&pokidebug=1` för SDK:ns testläge.
2. **Bygge för Pokis hosting:** `node scripts/build-poki.mjs` ger
   `dist/snackmageddon-poki.zip` (index.html i roten, relativa sökvägar, ingen
   service worker eller manifest, plattformen stämplad i index.html). Samma zip
   byggs av release-flödet och ligger som artefakt `snackmageddon-poki`.
3. **Texter och bilder:** engelska texten i `itch.md`, `banner-1280x720.png`,
   `cover-630x500.png` och skärmdumparna i `screenshots/`.

Formuläret brukar fråga efter:

| Fält | Förslag |
|---|---|
| Title | Snailmageddon |
| Category | Action / Strategy (turn-based) |
| Tags | artillery, turn-based, snails, physics, 2 player, worms-like |
| Controls | Arrow keys or WASD to move and aim, Space to charge and fire, 1–8 weapons; touch buttons on mobile; gamepad supported |
| Players | 1 (vs computer), local 2–4 on one device |
| Orientation | Both (landscape and portrait tested) |
| Languages | English, Swedish |
| Age | All ages, cartoon violence |
| External services | Supabase backend for anonymous accounts, daily challenge and season leaderboards; no login, no e-mail, no payments in the Poki build |

## Vad som redan är på plats i koden

- Poki SDK bakom `js/platform.js`: `init` → `gameLoadingFinished`,
  `gameplayStart` vid matchstart, `gameplayStop` vid matchslut och avbrott,
  `commercialBreak` innan en ny match (ljudet tystas under reklamen).
  Misslyckas SDK:n (adblock, offline) går spelet ändå.
- Poki-läget döljer allt som pekar ut ur spelet eller kräver konto på annat
  håll: designsidan, installera-knappen, Snigelpost-inbjudningar och matchlistan,
  e-postkoppling, köp av premiumkosmetik. Inbjudningslänkar (`?match=`)
  ignoreras. Kvar är lokala matcher, Dagens skott, säsong, profil med
  utseende och de gratis- och spelupplåsta sakerna.
- Ingen service worker, inga cookies (anonymt konto i localStorage).
- Spelet startar direkt från menyn, fungerar i iframe, mobil landscape och
  portrait, med touchknappar och handkontroll.
- Engelska väljs automatiskt utanför Sverige.
- Testat i CI: `test/browser.test.mjs` kör spelet med `?platform=poki` och
  kontrollerar att inget länkar ut och att en match går att spela.

## Pokis vanligaste krav, avstämt mot spelet

| Krav | Läge |
|---|---|
| Laddar på under 5 s | Ja, ~160 kB utan externa beroenden |
| Fungerar utan SDK/ads (adblock) | Ja, SDK-fel sväljs |
| Inga länkar ut, ingen inloggning, inga köp | Ja i Poki-läget |
| `gameplayStart/Stop` på rätt ställen | Ja |
| `commercialBreak` bara vid naturliga pauser | Ja, mellan matcher |
| Ljud av under reklam | Ja |
| Mobilvänligt | Ja, touchkontroller och layout testade i CI |
| Engelska | Ja |
| Sparar framsteg | Ja, inställningar och profil i localStorage plus anonymt konto |

## Om Poki vill ha mer

- `rewardedBreak` finns i adaptern men används inte. Bra kandidat: "se en
  annons, få ett extra försök i Dagens skott" eller en extra vapenlåda.
- Poki brukar be om en egen laddningsskärm som visar procent; spelet laddar så
  snabbt att menyn räcker, men det kan läggas till om de ber om det.
- Poki-byggen får inte uppdatera sig själva från snails.se; ny version =
  nytt zip-inskick. Regelversionen i Snigelpost berör inte Poki-byggen
  eftersom Snigelpost är avstängt där.
