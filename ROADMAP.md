# Snäckmageddon – utvecklingsplan

Uppdaterad 2026-09-08. Spelet är publikt på https://snails.se, på
https://knackpot.itch.io/snailmageddon och som förberedda byggen för Poki och
Google Play.

## Tesen: dra spelet mot asynkront multiplayer

Worms är ett soffspel. Vår snäcka är långsam, och det gör vi till en styrka:
**Snigelpost** – man spelar sitt drag när man hinner, motståndaren får en notis
och svarar när den hinner. Som Wordfeud, fast med bazooka. Det är det som gör
spelet till något man återkommer till varje dag, vilket är förutsättningen för
intäkter.

Fas 1–3 är byggda: kärnloopen, Snigelpost med serier och notiser, och
progressionen med Dagens skott, profil, rank, säsonger och belöningar. Nästa
period handlar om tre saker: att få ut spelet (konton och inskick som bara du
kan göra), att göra servern misstänksam (verifiera drag och skott), och att
göra det lätt att sprida (delbara replays).

## Läget per fas

### Fas 1 – Känsla och kärnloop (klar utom ljudtillgångar)
| Klart | Kvar |
|---|---|
| Åtta vapen: bazooka, granat, saltspruta, dynamit, slemklot, saltregn, skalstöt, snigelhopp; ammunition och lådor | Inspelade ljud och musik (syntetiserat ljud finns) |
| Kamerapunch, slow motion vid dödsskott, skal som spricker, skalbitar, slemspår | |
| Terrängteman: trädgårdsland, strand, regnskog | |
| AI-nivåer lätt/normal/svår, guide i första matchen, förhandsbana vid sikte | |
| Regler i menyn (dragtid, plötslig död), mastervolym, ljud av/på i HUD:en | |
| Tangentbord, touch, handkontroll | |
| Tester i CI: determinism med facit-inspelningar (Node) och webbläsartester (Playwright) | |

### Fas 2 – Snigelpost (klar utom verifiering och åskådare)
| Klart | Kvar |
|---|---|
| Deterministisk simulering, replay, hash, regelversioner med solnedgång (`docs/REGELVERSIONER.md`) | Serversidig verifiering av drag: edge-funktion spelar upp inspelningen |
| Anonyma konton, Google-inloggning i drift (kopplar det anonyma kontot), e-post via Resend som reserv, skannertåliga länkar | Åskådarläge och delbar replay av färdig match |
| Matcher, drag, inbjudan via länk med Open Graph-taggar | |
| Serier bäst av 1/3/5, revansch, ge upp, vinst efter 14 dagars tystnad, städjobb | |
| Push-notiser (egen Web Push, VAPID i Vault), ställning i notisen | |
| Felrapportering som händelse i mätningen | |

### Fas 3 – Progression och identitet (byggd, betalning avstängd)
| Klart | Kvar |
|---|---|
| Dagens skott: samma bana och vapen för alla, ett skott, topplista, bästa försöket räknas | Serversidig verifiering av skott (inspelningen sparas redan) |
| Profil: namn, statistik, skalmönster och hattar; låses upp med vinster och Dagens skott; syns för motståndaren | Google Play Billing om Play-appen får spelare (Stripe får inte användas där) |
| Rank: Elo per kvartalssäsong, fem nivåer; säsongspoäng för Dagens skott; topplistor | |
| Säsongsbelöningar: lagerkrans och konfettiskal till topp tre, märken i profilen, pg_cron vid kvartalsskiftet | |
| Betalning: Stripe Checkout via edge-funktioner, webhook, idempotenta köp; avstängd tills nycklar finns | |

### Fas 4 – Distribution
| Klart | Kvar |
|---|---|
| snails.se via Cloudflare DNS och GitHub Pages, svenska och engelska, mätning i Supabase, Knackpot-märke i menyn och på sidorna | App Store via Capacitor (projekt, ikoner, splash och guide kan förberedas; bygget kräver Mac och Apple-konto) |
| itch.io publikt, butler-push från release-flödet | |
| Poki: SDK-adapter, Poki-läge utan länkar ut, konton eller köp, zip-bygge, checklista (`docs/store/poki.md`) | |
| Google Play: manifest, assetlinks, integritetspolicy, Play-läge utan Stripe, Bubblewrap-konfiguration och guide (`docs/store/google-play.md`) | |

## Väntar på dig

Sådant som kräver konton, nycklar eller en riktig webbläsare, i den ordning
det ger mest:

1. **Google-inloggning**: klar och verifierad i drift 2026-09-08.
2. **E-post via Resend**: klar och verifierad 2026-09-08. Egen SMTP, 30
   mejl/timme, mallarna använder `token_hash`-länken med Bekräfta-knapp.
3. **assetlinks.json och privacy.html**: kontrollerade i webbläsaren
   2026-09-08, båda svarar på snails.se.
4. **Poki**: utvecklarkonto och inskick enligt `docs/store/poki.md`.
5. **Google Play**: `bubblewrap build` i `android/`, uppladdning, fingeravtryck
   i `assetlinks.json`, butikssida enligt `docs/store/google-play.md`.
6. **Stripe**: konto, två produkter, fyra hemligheter, webhook enligt
   `supabase/README.md`. Köpknapparna aktiveras av sig själva när nycklarna
   finns.
7. **nissebus**: beslut om `pranks`-policyerna (släpper in anonyma spelare) och
   när Snigelpost ska få ett eget Supabase-projekt.

## Nästa period (byggarbete, i prioritetsordning)

1. **App Store via Capacitor**: sista distributionskanalen. Förbered
   Capacitor-projektet, ikoner, splash och guiden; bygget gör du på en Mac.
2. **Serversidig verifiering**: en edge-funktion som spelar upp inspelningen
   headless (`js/game.js` kör redan utan canvas) och underkänner fel hash och
   fel poäng. Dagens skott först (topplistan är annars lätt att fuska i),
   sedan Snigelpost-drag.
3. **Delbar replay och åskådarläge**: `?replay=<match>` visar en färdig match
   för vem som helst. Återanvänder replay-koden och är det billigaste sättet
   att sprida spelet i chattar.
4. **Poki `rewardedBreak`**: "se en annons, få ett extra försök i Dagens
   skott", om Poki tar in spelet.
5. **Inspelade ljud och musik**: enda kvarvarande fas 1-punkten.
6. **Kvalitetsrunda efter första riktiga spelarna**: läs `snails_retention`
   och felhändelserna, prestanda på svaga telefoner (åtta vapenknappar,
   slemspår, tre teman), och det spelarna faktiskt fastnar på.
7. **Eget Supabase-projekt** för Snigelpost när spelarantalet motiverar
   10 USD/mån.

## Lärdomar, och vad som gjordes åt dem

- **Snigelpost delar databas med nissebus.** Anonyma spelare får rollen
  `authenticated` i hela projektet, triggern för nya användare fick ändras och
  två policyer i nissebus (`pranks`) släpper in alla inloggade. Fortfarande
  öppet, se "Väntar på dig".
- **Regelversion mitt i en match.** Löst: spelet kör aktuell och föregående
  version, facit-inspelningar per version i testerna, solnedgång på servern
  (`docs/REGELVERSIONER.md`).
- **Inbjudningslänkar delas i chattar.** Löst med Open Graph-taggar.
- **Vi såg inga fel i produktion.** Löst: klientfel skickas som händelsen
  `error`.
- **Ingen ljud-av-knapp.** Löst, i HUD:en.
- **CI har nätverk, sandlådan inte.** Poki-SDK:n laddades bara på CI, och där
  visade det sig att spelet anropade SDK:n innan den bootat. Allt som beror på
  nätet måste testas på CI, inte bara lokalt.
- **Security definer kör som ägaren.** En rollkontroll på `current_user` är
  verkningslös; kontrollera JWT-rollen (`auth.role()`), som i köpfunktionen.
- **Service workern får inte fånga API-anrop.** Den hanterar nu bara den egna
  sajten; annars går testerna inte att styra och cachen kan ge gamla svar.
- **Parallella anrop vid start skapade två konton.** Inloggningen delas nu
  mellan alla som frågar samtidigt.
- **Supabases inbyggda e-post räcker inte ens för test.** Två mejl i timmen,
  och Gmails länkskanner förbrukar engångslänkarna. Löst i koden: Google som
  huvudväg, klick-bekräftade `token_hash`-länkar; kvar för dig: Resend som
  SMTP och mallbytet.
- **Visuellt och simulering hålls isär.** Teman, kosmetik, spår, sprickor och
  slow motion rör aldrig hashen. Facit-testerna bevakar det.

## Tekniska beslut (bekräftade)

1. Deterministisk simulering med fast tidssteg och egen matte – i drift.
2. Indata som händelser, inspelning per drag – i drift.
3. Regelversion per match, aktuell + föregående stöds, solnedgång på servern – i drift.
4. Mätning från dag ett – i drift (`snails_daily_metrics`, `snails_retention`, `error`).
5. Allt visuellt är skilt från simuleringen och får aldrig påverka hashen – bevakas av facit-testerna.
6. En plattformsadapter (`js/platform.js`) avgör vad som visas: länkar ut, köp, konton, service worker.

## Intäkter

Gratis spel, inget köpbart ger fördel, inga lootboxar. Nuläge och ordning:

1. Portaler för spelare och små intäkter: itch.io klart, Poki förberett.
2. Kosmetik via Stripe på snails.se: byggt, aktiveras med nycklarna. Kräver
   e-postkopplat konto så köpet överlever rensad webbdata.
3. Google Play: inga köp i appen tills Play Billing är byggt, det är
   Plays regel för digitala varor.
4. Belönad reklam på Poki (`rewardedBreak`) och säsongspass sist, när det
   finns spelare att räkna på.

## Risker

- **Worms-varumärket.** Aldrig i namn eller marknadsföring. Genren är fri.
- **Anonyma konton som försvinner.** Gränssnittet säger det och erbjuder
  e-postkoppling.
- **Missbruk av anonym inloggning.** Supabase rekommenderar captcha. Vänta
  tills mätningen visar problem.
- **Fusk i topplistorna.** Servern litar på klientens poäng och hash tills
  verifieringen (nästa period, punkt 2) finns. Inspelningarna sparas redan,
  så fusk kan upptäckas i efterhand.
- **Butikernas köpregler.** Stripe-köp bara på webben; Play och App Store
  kräver egna betalsystem för digitala varor.
- **Barn spelar.** Rena köpflöden, inga mörka mönster, ingen fri chatt.
