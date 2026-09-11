# Supabase

Snäckmageddon kör mot Supabase-projektet **`snails`** (`lygpfumngyebxoqqncet`,
region eu-north-1 Stockholm, org Knackpot AB). Projektet är avsett för hela
snigelserien: varje spel får eget tabellprefix (`snails_` är Snäckmageddons,
`snailchess_` Snäckschacks — se snailchess-repots `supabase/README.md`), och
konton, push-prenumerationer, rating och Vault delas. Snäckschack delar även
sessionsnyckeln `snackmageddon.session` i `localStorage` (samma origin), så en
inloggning gäller båda. Migrationer från andra spel appliceras med MCP, inte
`supabase db push` härifrån.

Klienten är `js/supa.js` (auth + RPC utan bibliotek), `js/analytics.js`
(mätning) och `js/push.js` (Web Push). URL och publishable key ligger i
`js/config.js` — de är publika per design; row level security och
security-definer-funktionerna bestämmer vad nyckeln får göra.

Till 2026-09-10 låg spelet i det delade projektet `nissebus`
(`zhkgsbbrxcrbwriztoxx`). Flytten beskrivs sist i filen.

## Sätta upp från noll

1. **Migrationer.** `supabase/migrations/*.sql` i filordning (första filen
   slår på `pg_cron`, som `snigelpost_robust` och `season_awards` behöver för
   sina cron-jobb). Antingen `supabase db push` mot projektet eller via
   Supabase-MCP:n `apply_migration`. Projektets migrationshistorik
   (`supabase_migrations.schema_migrations`) speglar filnamnen.
2. **Vault.** Hemligheten `snails_vapid_private` = den privata VAPID-nyckeln som
   JWK; den publika ligger i `js/config.js`. Flyttskriptet nedan kopierar den
   mellan projekt. Ny nyckel: generera ett P-256-par, `select
   vault.create_secret('<jwk>', 'snails_vapid_private')`, byt den publika i
   `js/config.js` — alla prenumerationer måste då göras om.
3. **Authentication → Sign In / Providers:** Anonymous sign-ins **på**
   (annars säger menyn "Snigelpost är inte tillgängligt just nu"); Google
   **på** med Client ID/Secret från Google Cloud Console; **Allow manual
   linking på** (överst under User Signups) så ett anonymt konto kan få en
   Google-identitet och behålla sina matcher.
4. **Authentication → URL Configuration:** Site URL `https://snails.se/`
   (blir `https://snails.se/snailmageddon/` när spelet flyttar in under
   hubben); Redirect URLs `https://snails.se/**` och
   `http://localhost:8080/**` för utveckling.
5. **Authentication → Email Templates:** se *Länkar som tål Gmails skanner*.
6. **Authentication → SMTP Settings:** se *Egen SMTP via Resend*.
7. **Authentication → Rate Limits:** "Rate limit for sending emails" 30/h.
8. **Edge-funktioner:** `supabase functions deploy notify-turn buy
   --project-ref lygpfumngyebxoqqncet` och `supabase functions deploy
   stripe-webhook --no-verify-jwt --project-ref lygpfumngyebxoqqncet` (eller
   MCP:n `deploy_edge_function`; `stripe-webhook` är den enda utan JWT-krav —
   Stripes signatur är dess inloggning).
9. **Google Cloud Console** → OAuth-klienten: Authorized redirect URI
   `https://lygpfumngyebxoqqncet.supabase.co/auth/v1/callback`.
10. Kontrollera: `select jobname, schedule from cron.job` visar
    `snails_cleanup` (`17 4 * * *`) och `snails_close_season`
    (`10 0 1 1,4,7,10 *`).

# Mätning

Spelet räknar ett fåtal händelser i `public.snails_events`. Klienten är
`js/analytics.js`.

| Händelse | Egenskaper |
|---|---|
| `app_open` | `installed` (körs som installerad app), `touch`, `w`, `h` |
| `match_start` | `teams`, `per`, `humans`, `style` |
| `match_end` | `turns`, `durationSec`, `winner` (`human`/`ai`/`draw`), `weapons` (skott per vapen) |
| `match_abandon` | `turns`, `durationSec` |
| `tutorial_done`, `tutorial_skip` | `step` |
| `push_on`, `error`, `account`, `daily`, `buy` | se respektive avsnitt |

Dessutom ett slumpat anonymt klient-id (localStorage), ett sessions-id per
sidladdning, appversion och språk. Inga namn, inga IP-adresser i tabellen,
inga cookies. Mätningen är av på localhost, med `?noanalytics` i adressen och
när webbläsaren skickar Do Not Track eller Global Privacy Control.

Läsa av i SQL Editor:

```sql
select * from snails_daily_metrics limit 30;   -- per dag: öppningar, unika, startade/avslutade matcher
select * from snails_retention limit 30;       -- kohorter: andel som kom tillbaka dag 1 och dag 7
select * from snails_weapon_usage;             -- skott per vapen
```

Vyerna går bara att läsa med dashboardens rättigheter. Anonyma klienter kan
bara lägga till rader, aldrig läsa, ändra eller ta bort (RLS).

# Snigelpost

Tabellerna `snails_matches` och `snails_turns` samt RPC-funktionerna
`snails_create_match`, `snails_join_match`, `snails_get_match`,
`snails_my_matches`, `snails_submit_turn` och `snails_delete_match` ligger i
`migrations/20260904150000_snigelpost.sql`. Klienten når bara funktionerna,
aldrig tabellerna. Funktionerna kontrollerar att anroparen är med i matchen,
att det är dennes tur, att dragnumret och startticken stämmer, och att en
match bara kan anslutas en gång.

Spelarna är anonyma Supabase Auth-användare (se *Sätta upp från noll*, steg 3).

Fler funktioner (`migrations/20260904190000_snigelpost_robust.sql`):
- `snails_resign`: ge upp, motståndaren vinner. En öppen inbjudan raderas.
- `snails_claim_timeout`: den som väntar tar hem vinsten när motståndaren varit
  tyst i 14 dagar.
- `snails_rematch`: ny match mot samma motståndare, anroparen börjar. Finns
  redan en pågående match mellan de två returneras den.
- `snails_cleanup`: körs av pg_cron varje natt 04:17 UTC. Raderar inbjudningar
  ingen antagit på 30 dagar och färdiga matcher äldre än 90 dagar.
- Händelsen `error` i `snails_events` är klientfel (max fem per sidladdning).

Serier (`migrations/20260904210000_series.sql`): varje match tillhör en serie i
`snails_series` (bäst av 1, 3 eller 5; standard 3). Serien räknar vinster per
spelare, och när en match är slut skapar `snails_series_after_finish` nästa
match med omvänd startordning tills någon har tillräckligt många vinster.
`snails_create_match` tar `p_best_of` och en `p_config` med `snailsPerTeam`,
`turnTime` (20/30/45/60/90) och `suddenDeath` (0 = aldrig, annars draget då
vattnet börjar stiga); okända värden faller tillbaka på 45 och 16 på alla
enheter; `snails_my_matches` visar bara seriens aktuella match;
`snails_extend_series` förlänger en avgjord serie till bäst av 3 eller 5 om det
ännu inte är avgjort på den längden (t.ex. 2–0 i bäst av 3 kan bli bäst av 5).
`snails_rematch` startar en ny serie med samma längd, eller returnerar den
pågående seriens aktuella match. `snails_get_match` returnerar `series` med
ställning sett från anroparen.

Regelversioner (`migrations/20260904230000_rules_versions.sql`, v4 i
`20260909000000_rules_v4.sql`, version 2 stängs 2026-10-09): tabellen
`snails_rules` säger vilka versioner som får skapa matcher och när en
pensionerad version stängs (`sunset_at`). `snails_cleanup` avslutar då
kvarvarande matcher som oavgjorda. Strategin finns i `docs/REGELVERSIONER.md`.

# Dagens skott

Tabellen `snails_daily` (`migrations/20260905000000_daily.sql`) har en rad per
spelare och UTC-dag: bästa poäng, antal försök, vapen, regelversion och
inspelningen av det bästa skottet. `snails_daily_submit` tar emot ett försök
(bara dagens eller gårdagens datum, poäng 0–450, stödd regelversion) och
behåller det bästa; `snails_daily_board` ger topp tio och anroparens egen
placering. Rader äldre än 60 dagar städas.

Banan, vapnet och målen kommer ur datumet (`js/daily.js`), så alla spelar
samma skott. Servern litar på klientens poäng men sparar inspelningen, så en
edge-funktion kan senare spela upp den och kontrollera poängen.

# Profil och kosmetik

`snails_profiles` (`migrations/20260905010000_profiles.sql`) har namn och
utseende (`look`: skalmönster och hatt) per spelare. `snails_profile` ger
profilen, statistik (vinster, förluster, bästa Dagens skott) och listan över
upplåsta saker; `snails_profile_set` sparar namn och utseende men byter ut
allt som inte är upplåst mot standard. Reglerna ligger i `snails_unlocked`
och speglas i `js/cosmetics.js`: stjärnor 250 p, eld 5 vinster, krona 10
vinster, vikingahjälm 350 p. Guld och cylinder är premium. Utseendet stämplas
på matchen (`snails_matches.looks`) när den skapas, ansluts, fortsätts i en
serie eller revansch, så motståndarens enhet kan rita det utan extra anrop.
Byter man utseende uppdateras pågående matcher.

# Rank och säsonger

`snails_ratings` (`migrations/20260905020000_seasons.sql`) har en rad per
spelare och säsong (kalenderkvartal, `snails_season_key`). När en match
mellan två spelare avslutas kör `snails_series_after_finish` först
`snails_rate_match`: Elo med K = 32 från 1000, en gång per match (`rated`).
Uppgiven match och vinst efter tystnad räknas som förlust respektive vinst.
`snails_season` ger topp tio i rating, topp tio i säsongspoäng för Dagens
skott (summan av dagsbästa) och anroparens egna rader. Nivåerna (Slemhög
till Jättesnäcka) sätts av klienten i `js/season.js`. Gamla säsongers rader
sparas som historik.

# Säsongsbelöningar

`snails_close_season` (`migrations/20260905040000_season_awards.sql`) körs av
pg_cron tio minuter in på varje nytt kvartal och delar ut förra säsongens
belöningar till `snails_season_awards`: topp tre i rating (minst tre rankade
matcher) får lagerkransen, topp tre i säsongspoäng för Dagens skott får
konfettiskalet. Idempotent per säsong. Belöningarna är permanenta, låser upp
sakerna via `snails_unlocked`, syns som märken i profilen (`awards`) och som
förra säsongens vinnare i `snails_season` (`last`). Kan köras för hand:
`select public.snails_close_season('2026-Q3')` efter kvartalets slut.

# Betalning för premiumkosmetik (Stripe)

Guldskal och cylinder köps via Stripe Checkout. Flödet
(`migrations/20260905030000_purchases.sql`, `functions/buy`,
`functions/stripe-webhook`):

1. Klienten anropar edge-funktionen `buy` med `{ item }`. Den kräver att
   kontot har e-post (så köpet överlever rensad webbdata), skapar en Checkout
   Session med `client_reference_id` = användar-id och `metadata.item`, och
   returnerar sessionens URL. Klienten skickar webbläsaren dit.
2. Stripe skickar `checkout.session.completed` till `stripe-webhook`
   (ingen JWT, signaturen i `Stripe-Signature` är inloggningen; kollas i
   `verify.js`, testad i `test/stripe.test.mjs`). Funktionen anropar
   `snails_grant_purchase` med service role; raden i `snails_purchases` är
   idempotent på sessions-id.
3. `snails_unlocked` räknar in köpta saker. Tillbaka på sajten
   (`?bought=gold`) laddar klienten om profilen tills köpet syns och väljer
   det köpta.

**Slå på betalning** (inget av detta är gjort; knapparna säger "Betalning är
inte påslagen än" tills det är gjort):

1. Skapa ett Stripe-konto. Lägg upp två produkter med engångspris
   (t.ex. 29 kr): Guldskal och Cylinderhatt. Anteckna deras `price_…`-id.
2. Supabase → Edge Functions → Secrets: `STRIPE_SECRET_KEY` (sk_live… eller
   sk_test…), `STRIPE_PRICE_GOLD`, `STRIPE_PRICE_TOPHAT`.
3. Stripe → Developers → Webhooks → Add endpoint:
   `https://lygpfumngyebxoqqncet.supabase.co/functions/v1/stripe-webhook`,
   händelsen `checkout.session.completed`. Lägg dess signing secret som
   `STRIPE_WEBHOOK_SECRET` bland Supabase-hemligheterna.
4. Testa i Stripes testläge med kortet 4242 4242 4242 4242 innan live.
5. Köp går bara i webbversionen (`platform.id === 'web'`); itch- och
   Poki-byggen visar "kommer snart", eftersom portalerna har egna regler för
   betalning.

Köpvillkor och ångerrätt: ett digitalt köp levereras direkt. Skriv en rad om
det på Checkout-sidan (Stripe → Settings → Branding/Terms) innan live.

# Konton: Google och e-post

Ett anonymt konto blir permanent på två sätt. Menyn visar båda (Snigelpost →
kontorutan); Poki-läget döljer hela rutan.

## Google (huvudvägen)

"Fortsätt med Google" (`js/supa.js` `googleUrl`):

- Anonymt konto på enheten: `GET /auth/v1/user/identities/authorize?provider=google&skip_http_redirect=true`
  med kontots token ger en URL som webbläsaren skickas till. Efter Googles
  samtycke får **samma** användar-id en Google-identitet; matcher och profil
  följer med. Kräver **Allow manual linking**.
- Om Google-kontot redan hör till ett annat spelarkonto svarar Supabase med
  `error_code=identity_already_exists` i URL-fragmentet. Har enheten inga
  matcher loggar spelet in som det kontot direkt (`/auth/v1/authorize`);
  annars visas en varning och en knapp för att byta konto.
- Återkomsten är samma som för e-postlänkar: sessionen i URL-fragmentet, som
  `handleRedirect()` sparar. Google-konton har e-post, så köp fungerar.

OAuth-klienten i Google Cloud Console är snigelspelets (consent screen med
https://snails.se och https://snails.se/privacy.html). Dess redirect-URI måste
vara projektets callback, se *Sätta upp från noll* steg 9.

## E-post (reserv)

Klienten anropar `PUT /auth/v1/user` med adressen; Supabase skickar mallen
"Change Email Address" med en bekräftelselänk. När länken klickas är kontot
permanent (samma användar-id, matcherna följer med) och länken skickar
webbläsaren tillbaka till spelet med sessionen i URL-fragmentet, som
`handleRedirect()` sparar.

På en annan enhet skriver spelaren samma adress och väljer "Skicka
inloggningslänk": `POST /auth/v1/otp` med `create_user: false`, så en
felstavad adress kan aldrig skapa ett nytt konto. Länken loggar in som samma
användare. Den anonyma sessionen på den enheten ersätts; matcher som spelats
anonymt där följer inte med (gränssnittet säger det).

### Egen SMTP via Resend

Supabases inbyggda avsändare (`noreply@mail.app.supabase.io`) får skicka
**2 mejl i timmen** per projekt och är bara avsedd för utveckling. Loggarna
(`auth_logs`, `over_email_send_rate_limit`) visar när gränsen slår till;
spelet visar då "För många mejl just nu" och pekar på Google.

1. Resend (resend.com): domänen `snails.se` är redan verifierad (DKIM, MX +
   TXT för `send.snails.se` i Cloudflare DNS).
2. Resend → API Keys → en nyckel med Sending access.
3. Supabase → Authentication → SMTP Settings → Enable Custom SMTP:
   Sender email `noreply@snails.se`, Sender name `Snäckmageddon`,
   Host `smtp.resend.com`, Port `465`, Username `resend`, Password = nyckeln.
4. Supabase → Authentication → Rate Limits → "Rate limit for sending emails":
   höj från 2 till t.ex. 30 per timme.

### Länkar som tål Gmails skanner

Gmail (och en del företagsfilter) öppnar länkar i inkommande mejl innan
mottagaren ser dem. Supabases standardlänk (`{{ .ConfirmationURL }}`) är en
engångslänk, så skannern förbrukar den och spelaren får "Email link is invalid
or has expired" (syns i `auth_logs` som `/verify` från en Google-IP).

Klienten klarar därför också länkar med `?token_hash=…&type=…`: sidan visar
knappen "Bekräfta", och först vid tryck anropas `POST /auth/v1/verify`
(`verifyToken` i `js/supa.js`). Skannrar trycker inte på knappar.

Mallarna (Authentication → Email Templates) använder `.RedirectTo`, som är
exakt det klienten skickar (`location.origin + location.pathname`), så samma
mall fungerar både på roten och under `/snailmageddon/`:

Magic Link:
```
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink">Logga in i Snäckmageddon</a>
```

Change Email Address:
```
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email_change">Bekräfta e-postadressen för Snäckmageddon</a>
```

Kända begränsningar:
- Servern kör inte simuleringen själv; den litar på klientens hash. Motståndarens
  klient jämför sin egen hash med den sparade och varnar vid avvikelse.
- Ett konto utan e-post lever i webbläsarens localStorage. Rensas den försvinner
  kontot och dess matcher.

# Push-notiser

Web Push utan tredjepartstjänst. Klienten (`js/push.js`) prenumererar via
service workern och sparar prenumerationen med `snails_save_push`. Efter varje
inskickat drag anropar klienten edge-funktionen `notify-turn`
(`supabase/functions/notify-turn/`), som kontrollerar att anroparen är med i
matchen och skickar en notis till motståndarens enheter. I en serie läggs
ställningen till i texten och länken pekar på seriens aktuella match. Kryptot
(RFC 8291 och VAPID) ligger i `webpush.js` och testas i `test/webpush.test.mjs`.

- Publik VAPID-nyckel: `VAPID_PUBLIC_KEY` i `js/config.js`.
- Privat VAPID-nyckel: Supabase Vault, hemligheten `snails_vapid_private`,
  läsbar bara för `service_role` via `snails_vapid_private()`.
- Döda prenumerationer (404/410 från push-tjänsten) tas bort automatiskt.
- iPhone/iPad kräver att spelet är installerat på hemskärmen; spelet visar en
  hjälptext i stället för knappen där.

# Flytten från det delade projektet (2026-09-10)

Spelet startade i projektet `nissebus`, delat med Nissebus, med allt prefixat
`snails_`. Det tvingade fram kompromisser (patchad `handle_new_user`-trigger,
SMTP och Google-provider som gällde båda apparna, e-postmallar villkorade på
`.RedirectTo`). Därför fick serien ett eget projekt.

Så gjordes det, i den ordningen:

1. Nytt projekt `snails`; migrationerna applicerades via MCP:n och
   historiken sattes till repots filversioner. Funktioner, index, policyer och
   vyer diffades mot det gamla projektet med `md5(pg_get_functiondef(...))` —
   identiska.
2. Edge-funktionerna deployades till det nya projektet.
3. `js/config.js` fick den nya URL:en och nyckeln; `js/supa.js` fick en
   retry vid 401 (en access-token signerad av det gamla projektet avvisas av
   det nya tills den gått ut — med kopierad refresh-token blir bytet osynligt);
   `sw.js` bytte cache-prefix till `snailmageddon-` (allt på snails.se delar
   origin, så cache-namn måste vara namnrymda per spel).
4. Skrivstopp i det gamla projektet: `scripts/old-project-freeze.sql`
   (ångras med `old-project-unfreeze.sql`).
5. Data: `npm run migrate:supabase` (`scripts/migrate-supabase.mjs`) med
   `OLD_DB_URL` och `NEW_DB_URL` i miljön (Connect → Session pooler, användare
   postgres). Selektivt: konton som bär speldata eller är kopplade till
   e-post/Google följer med **inklusive sessioner och refresh-tokens**, så de
   enheterna förblir inloggade; tomma anonyma konton lämnas (klienten skapar
   tyst ett nytt); analytics-events kopieras; `snails_vapid_private` flyttas
   Vault → Vault utan att passera stdout. `--dry-run` visar antal,
   `--verify` jämför efteråt.
6. Deploy av spelet. Rollback: återställ `js/config.js`, kör
   `old-project-unfreeze.sql`.
7. Efter en vecka: i `nissebus` droppas `snails_*`-tabeller, -funktioner och
   -vyer, `cron.unschedule` på de två jobben, Vault-hemligheten tas bort och
   anonyma inloggningar stängs av. SMTP och Google-provider lämnas där (Nissebus
   mejlar via `noreply@snails.se` tills den får egen domän).
