# Mätning

Spelet räknar ett fåtal händelser i en Supabase-tabell (`public.snails_events`, i det delade projektet knackpot-portal).
Klienten är `js/analytics.js`, nycklarna ligger i `js/config.js`.

## Vad som skickas

| Händelse | Egenskaper |
|---|---|
| `app_open` | `installed` (körs som installerad app), `touch`, `w`, `h` |
| `match_start` | `teams`, `per`, `humans`, `style` |
| `match_end` | `turns`, `durationSec`, `winner` (`human`/`ai`/`draw`), `weapons` (skott per vapen) |
| `match_abandon` | `turns`, `durationSec` |
| `tutorial_done`, `tutorial_skip` | `step` |

Dessutom ett slumpat anonymt klient-id (localStorage), ett sessions-id per
sidladdning, appversion och språk. Inga namn, inga IP-adresser i tabellen,
inga cookies. Mätningen är av på localhost, med `?noanalytics` i adressen och
när webbläsaren skickar Do Not Track eller Global Privacy Control.

## Läsa av

I Supabase Studio, SQL Editor:

```sql
select * from snails_daily_metrics limit 30;   -- per dag: öppningar, unika, startade/avslutade matcher
select * from snails_retention limit 30;       -- kohorter: andel som kom tillbaka dag 1 och dag 7
select * from snails_weapon_usage;             -- skott per vapen
```

Vyerna går bara att läsa med dashboardens rättigheter. Anonyma klienter kan
bara lägga till rader, aldrig läsa, ändra eller ta bort (RLS).

## Sätta upp

1. Kör `supabase/migrations/20260904120000_events.sql` i projektet (SQL Editor
   eller `supabase db push`).
2. Fyll i `SUPABASE_URL` och `SUPABASE_KEY` (publishable key) i `js/config.js`.

# Snigelpost

Tabellerna `snails_matches` och `snails_turns` samt RPC-funktionerna
`snails_create_match`, `snails_join_match`, `snails_get_match`,
`snails_my_matches`, `snails_submit_turn` och `snails_delete_match` ligger i
`migrations/20260904150000_snigelpost.sql`. Klienten når bara funktionerna,
aldrig tabellerna. Funktionerna kontrollerar att anroparen är med i matchen,
att det är dennes tur, att dragnumret och startticken stämmer, och att en
match bara kan anslutas en gång.

Spelarna är anonyma Supabase Auth-användare. **Slå på anonym inloggning**:
Authentication → Sign In / Providers → Anonymous → "Allow anonymous sign-ins".
Utan det får menyn texten "Snigelpost är inte tillgängligt just nu".

Eftersom projektet delas med nissebus har dess trigger `handle_new_user` (som
skapar en rad i `profiles` för varje ny användare) ändrats så att den hoppar
över anonyma användare, som saknar e-post. Annars faller anonym inloggning med
"Database error saving new user". Ändringen ligger som migrationen
`handle_new_user_skip_anonymous` i projektet.

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
enheter; `snails_my_matches` visar bara seriens
aktuella match; `snails_extend_series` förlänger en avgjord serie till bäst av
3 eller 5 om det ännu inte är avgjort på den längden (t.ex. 2–0 i bäst av 3 kan
bli bäst av 5). `snails_rematch` startar en ny serie med samma längd, eller
returnerar den pågående seriens aktuella match. `snails_get_match` returnerar
`series` med ställning sett från anroparen.

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
vinster, vikingahjälm 350 p. Guld och cylinder är premium och kan inte låsas
upp än. Utseendet stämplas på matchen (`snails_matches.looks`) när den
skapas, ansluts, fortsätts i en serie eller revansch, så motståndarens enhet
kan rita det utan extra anrop. Byter man utseende uppdateras pågående
matcher.

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

**Slå på betalning** (ingenting av detta finns än, knapparna säger
"Betalning är inte påslagen än" tills det är gjort):

1. Skapa ett Stripe-konto. Lägg upp två produkter med engångspris
   (t.ex. 29 kr): Guldskal och Cylinderhatt. Anteckna deras `price_…`-id.
2. Supabase → Edge Functions → Secrets: `STRIPE_SECRET_KEY` (sk_live… eller
   sk_test…), `STRIPE_PRICE_GOLD`, `STRIPE_PRICE_TOPHAT`.
3. Stripe → Developers → Webhooks → Add endpoint:
   `https://zhkgsbbrxcrbwriztoxx.supabase.co/functions/v1/stripe-webhook`,
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
  följer med. Kräver **Allow manual linking** (Authentication → Sign In / Providers, överst).
- Om Google-kontot redan hör till ett annat spelarkonto svarar Supabase med
  `error_code=identity_already_exists` i URL-fragmentet. Har enheten inga
  matcher loggar spelet in som det kontot direkt (`/auth/v1/authorize`);
  annars visas en varning och en knapp för att byta konto.
- Återkomsten är samma som för e-postlänkar: sessionen i URL-fragmentet, som
  `handleRedirect()` sparar. Google-konton har e-post, så köp fungerar.

**Inställningar som krävs:**

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client
   ID (Web application). Authorized redirect URI:
   `https://zhkgsbbrxcrbwriztoxx.supabase.co/auth/v1/callback`. Fyll i
   OAuth consent screen (appnamn, e-post, hemsida https://snails.se,
   integritetspolicy https://snails.se/privacy.html) och publicera den, annars
   får bara testanvändare logga in.
2. Supabase → Authentication → Sign In / Providers → Google: på, Client ID och Client
   Secret från steg 1.
3. Supabase → Authentication → Sign In / Providers → sektionen User Signups överst → **Allow manual linking**: på.
4. Redirect URLs (Authentication → URL Configuration): `https://snails.se/**`
   och `https://niklaser74.github.io/snails/**`, som för e-postlänkarna.

Google-inloggningen delas med nissebus (samma projekt); nissebus behöver inte
använda den.

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

1. Resend (resend.com, gratis upp till 3 000 mejl/mån): Domains → Add
   `snails.se`. Lägg in posterna Resend visar i Cloudflare DNS (en TXT för
   DKIM, MX + TXT för `send.snails.se`, valfritt DMARC). Vänta på "Verified".
2. Resend → API Keys → skapa en nyckel med Sending access.
3. Supabase → Authentication → SMTP Settings → Enable Custom SMTP:
   Sender email `noreply@snails.se`, Sender name `Snäckmageddon`,
   Host `smtp.resend.com`, Port `465`, Username `resend`, Password = nyckeln.
4. Supabase → Authentication → Rate Limits → "Rate limit for sending emails":
   höj från 2 till t.ex. 30 per timme.

Inställningen gäller hela projektet, alltså även nissebus, vars mejl då också
går via snails.se-adressen. Vill du ha olika avsändare per app krävs separata
projekt.

### Länkar som tål Gmails skanner

Gmail (och en del företagsfilter) öppnar länkar i inkommande mejl innan
mottagaren ser dem. Supabases standardlänk (`{{ .ConfirmationURL }}`) är en
engångslänk, så skannern förbrukar den och spelaren får "Email link is invalid
or has expired" (syns i `auth_logs` som `/verify` från en Google-IP).

Klienten klarar därför också länkar med `?token_hash=…&type=…`: sidan visar
knappen "Bekräfta", och först vid tryck anropas `POST /auth/v1/verify`
(`verifyToken` i `js/supa.js`). Skannrar trycker inte på knappar.

Byt länken i mallarna (Authentication → Email Templates), villkorat så att
nissebus behåller standardlänken:

Magic Link:
```
{{ if eq .RedirectTo "https://snails.se/" }}
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink">Logga in i Snäckmageddon</a>
{{ else }}
<a href="{{ .ConfirmationURL }}">Logga in</a>
{{ end }}
```

Change Email Address:
```
{{ if eq .RedirectTo "https://snails.se/" }}
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email_change">Bekräfta e-postadressen för Snäckmageddon</a>
{{ else }}
<a href="{{ .ConfirmationURL }}">Bekräfta e-postadressen</a>
{{ end }}
```

`.RedirectTo` är exakt det klienten skickar (`location.origin + location.pathname`,
alltså `https://snails.se/`). GitHub Pages-adressen kan läggas till med ett
`or`. Mallbytet kan göras när som helst; båda länkvarianterna fungerar.

Regelversioner (`migrations/20260904230000_rules_versions.sql`): tabellen
`snails_rules` säger vilka versioner som får skapa matcher och när en
pensionerad version stängs (`sunset_at`). `snails_cleanup` avslutar då
kvarvarande matcher som oavgjorda. Strategin finns i `docs/REGELVERSIONER.md`.

Kända begränsningar:
- Servern kör inte simuleringen själv; den litar på klientens hash. Motståndarens
  klient jämför sin egen hash med den sparade och varnar vid avvikelse.
- Ett konto utan e-post lever i webbläsarens localStorage. Rensas den försvinner
  kontot och dess matcher.
- nissebus trigger skapar ingen `profiles`-rad när ett anonymt konto får e-post
  (den körs bara vid insert). En sådan användare saknar alltså profil i nissebus.

# Push-notiser

Web Push utan tredjepartstjänst. Klienten (`js/push.js`) prenumererar via
service workern och sparar prenumerationen med `snails_save_push`. Efter varje
inskickat drag anropar klienten edge-funktionen `notify-turn`
(`supabase/functions/notify-turn/`), som kontrollerar att anroparen är med i
matchen och skickar en notis till motståndarens enheter. I en serie läggs
ställningen till i texten och länken pekar på seriens aktuella match. Kryptot (RFC 8291
och VAPID) ligger i `webpush.js` och testas i `test/webpush.test.mjs`.

- Publik VAPID-nyckel: `VAPID_PUBLIC_KEY` i `js/config.js`.
- Privat VAPID-nyckel: Supabase Vault, hemligheten `snails_vapid_private`,
  läsbar bara för `service_role` via `snails_vapid_private()`.
- Döda prenumerationer (404/410 från push-tjänsten) tas bort automatiskt.
- iPhone/iPad kräver att spelet är installerat på hemskärmen; spelet visar en
  hjälptext i stället för knappen där.

Ny nyckel vid behov: generera ett P-256-par, lägg den privata som JWK i Vault
med samma namn och den publika i `js/config.js`. Alla befintliga
prenumerationer måste då göras om.
