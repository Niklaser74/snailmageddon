# Google Play via Bubblewrap (Trusted Web Activity)

Appen på Play är ett tunt Android-skal (TWA) som visar snails.se i Chrome
utan adressfält. Ingen kod dupliceras: allt som deployas till snails.se syns
direkt i appen. Bubblewrap är Googles eget verktyg för det. Play-kontot,
signeringsnyckeln och själva uppladdningen är dina; allt annat är förberett.

## Förberett i repot

- `manifest.webmanifest`: id, beskrivning, kategorier, maskable-ikon,
  skärmdumpar för både brett och smalt format, genväg till Dagens skott.
- `android/twa-manifest.json`: Bubblewraps konfiguration (paket
  `se.snails.app`, start-URL `/snailmageddon/?twa=1`, notiser på, genväg). `bubblewrap
  build` i den mappen räcker.
- `.well-known/assetlinks.json` på snails.se med plats för fingeravtrycket.
  Digital Asset Links måste svara på domänroten, så filen ligger i hubbens repo
  (`Niklaser74.github.io`), inte här.
- `privacy.html` på snails.se, svenska och engelska. Play kräver en
  integritetspolicy-URL: https://snails.se/privacy.html
- I appen (`platform.id === 'android'`, känns igen på `android-app://`
  som referrer eller `?twa=1`) döljs Stripe-köpen, eftersom Plays
  betalningspolicy kräver Google Play Billing för digitala varor. Allt annat
  fungerar som på webben, inklusive Snigelpost, notiser och e-postkoppling.
- Test i CI: `test/browser.test.mjs` kör `?twa=1` och kontrollerar att köp
  är dolda, att resten är kvar och att genvägen `?daily=1` startar Dagens
  skott.

## Bygga

```bash
npm i -g @bubblewrap/cli          # första gången; frågar efter JDK och Android SDK och kan hämta dem
cd android
bubblewrap build                  # läser twa-manifest.json, skapar android.keystore första gången (välj lösenord, spara dem)
```

Resultat: `app-release-bundle.aab` (till Play) och `app-release-signed.apk`
(för test på en telefon: `bubblewrap install`). Nyckelfilen `android.keystore`
ligger utanför git (`android/.gitignore`); säkerhetskopiera den och
lösenorden, utan dem går appen inte att uppdatera om du inte använder Play
App Signing (rekommenderat, se nedan).

Ny version: höj `appVersionName` och `appVersionCode` i
`android/twa-manifest.json` (Play kräver högre versionskod varje gång) och
kör `bubblewrap build` igen. `bubblewrap update` hämtar ändringar från
webbmanifestet om det ändrats.

## Digital Asset Links (tar bort adressfältet)

Utan rätt fingeravtryck öppnas appen som en vanlig Chrome-flik med adressfält.

1. Play Console → appen → Setup → App integrity → App signing. Kopiera
   SHA-256 under "App signing key certificate" (Play signerar om appen med sin
   egen nyckel, det är den som gäller).
2. Skriv in det i `.well-known/assetlinks.json` i stället för platshållaren
   och pusha. Vill du också kunna testa med den lokalt signerade apk:n: lägg
   till uppladdningsnyckelns fingeravtryck som ett andra element
   (`bubblewrap fingerprint list` visar det, eller
   `keytool -list -v -keystore android.keystore`).
3. Kontrollera: https://snails.se/.well-known/assetlinks.json ska svara med
   JSON, och `bubblewrap validate --url https://snails.se/snailmageddon/` eller Googles
   Statement List Generator ska bli grön.

## Play Console, steg för steg

1. Skapa appen: namn Snailmageddon, spel, gratis. Standardspråk engelska,
   lägg till svenska.
2. Ladda upp `app-release-bundle.aab` under Testing → Internal testing först.
   Lägg dig själv som testare, installera från länken, kontrollera att
   adressfältet är borta (assetlinks ok) och att notiser fungerar.
3. Butikssida: kort och lång beskrivning nedan, ikon 512×512
   (`icons/icon-512.png`), funktionsgrafik 1024×500 (skala om
   `docs/store/banner-1280x720.png` eller beskär), telefonskärmdumpar
   (`docs/store/screenshots/05-mobil.png` plus liggande), gärna
   surfplatteskärmdumpar (de liggande 1280×720 duger).
4. Policy → App content: integritetspolicy https://snails.se/privacy.html;
   annonser: nej; åtkomst: inga inloggningskrav (anonymt konto skapas
   automatiskt, e-post är valfritt); innehållsklassificering: fyll i
   frågeformuläret, tecknat våld utan blod ger PEGI 7 / Everyone 10+;
   målgrupp: 13+ (enklast, slipper barnreglerna); nyheter: nej; COVID: nej;
   Data safety: se tabellen nedan.
5. Produktion → Countries → alla eller Sverige först → skicka in. Första
   granskningen tar några dagar.

### Data safety-formuläret

| Fråga | Svar |
|---|---|
| Samlar appen in data? | Ja |
| Krypteras data under överföring? | Ja (HTTPS) |
| Kan användaren begära radering? | Ja (rensa webbdata eller mejla hej@snails.se) |
| Personlig info: e-postadress | Valfritt, för kontofunktioner, delas inte |
| App-aktivitet: annat (matcher, poäng, inställningar) | Obligatoriskt för spelfunktioner, delas inte |
| App-info och prestanda: kraschloggar/diagnostik | Anonyma felhändelser, analys, delas inte |
| Enhets-id | Nej |
| Plats, kontakter, foton, ekonomi, hälsa | Nej |

### Butikstext

**Kort (80 tecken):**
Turn-based artillery with giant snails. Play solo, together, or by Snail Mail.

**Lång:**
Snailmageddon is a turn-based artillery game with giant African land snails.
Aim, charge, and fire eight weapons across destructible terrain: bazooka,
grenade, salt shaker, dynamite, slime ball, salt rain, shell shove and the
snail hop. Play against the computer on three difficulty levels, with up to
four teams on one device, or by Snail Mail: send a link to a friend and play
your turn whenever you have a minute, with a notification when it is your
turn. Best-of-three series, a daily challenge with a leaderboard, seasons
with rank, and looks you unlock by playing. Works offline, supports
gamepads, in English and Swedish.

**Kort (svenska):**
Turbaserat artilleri med jättesnäckor. Spela själv, ihop eller via Snigelpost.

**Lång (svenska):**
Snäckmageddon är ett turbaserat artillerispel med afrikanska jättesnäckor.
Sikta, ladda och skjut med åtta vapen i förstörbar terräng: bazooka, granat,
saltspruta, dynamit, slemklot, saltregn, skalstöt och snigelhopp. Spela mot
datorn på tre svårighetsgrader, upp till fyra lag på samma enhet, eller via
Snigelpost: skicka en länk till en kompis och spela ditt drag när du hinner,
med en notis när det är din tur. Serier om bäst av tre, Dagens skott med
topplista, säsonger med rank och utseenden du låser upp genom att spela.
Fungerar offline, stöder handkontroll, på svenska och engelska.

## Vanliga fel

- **Adressfält syns i appen**: fingeravtrycket i assetlinks.json matchar inte
  Plays signeringsnyckel, eller filen serveras inte (kolla att `.nojekyll`
  finns och att URL:en svarar med `application/json`).
- **"App not installed" vid sidoladdning**: gammal version med annan nyckel
  finns kvar, avinstallera först.
- **Uppdateringen syns inte i appen**: appen visar alltid snails.se live; det
  är service workern som cachar. Varje deploy höjer `VERSION` i `sw.js`, så
  en omstart av appen räcker.
- **Notiser**: TWA använder Chromes notiser; de fungerar när appen är
  installerad från Play och sajten har `enableNotifications: true` (satt).
