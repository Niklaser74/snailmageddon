# itch.io – sidtext och inställningar

**Titel:** Snäckmageddon
**Kort beskrivning (tagline):** Worms-stil artilleri med afrikanska jättesnäckor. Långsamma. Skalade. Dödliga.
**Klassificering:** HTML5-spel, gratis (betala vad du vill, förslag 20 kr)
**Genre:** Strategy · Taggar: artillery, turn-based, local-multiplayer, snails, destructible-terrain, pwa, swedish
**Uppladdning:** `dist/snackmageddon-itch.zip` (byggs med `npm run build:itch`), markera "This file will be played in the browser"
**Visningsläge:** Embed, 1280×720, "Fullscreen button" på, "Mobile friendly" på, orientering landscape
**Omslag:** `docs/store/cover-630x500.png` · Skärmdumpar: `docs/store/screenshots/*.png`

## Beskrivning (svenska)

Snäckmageddon är ett turbaserat artilleri-spel i klassisk Worms-anda, fast med afrikanska jättesnäckor i stället för maskar. Långsamma i steget, snabba på avtryckaren.

- 2–4 lag, spela mot varandra på samma skärm eller mot datorn
- Åtta vapen: bazooka som driver med vinden, studsande granat, saltspruta, dynamit, slemklot som klibbar fast på motståndaren, saltregn från himlen, skalstöt som knuffar och snigelhopp som teleporterar
- Förstörbar terräng, lådor med hälsa och ammunition, plötslig död med stigande vatten
- Prickad förhandsbana medan du siktar
- Fungerar i mobilen med touchkontroller, kan installeras som app och spelas offline
- Svenska och engelska

Gratis och utan reklam. Vill du stötta utvecklingen får du gärna betala vad du vill.

## Description (English)

Snäckmageddon is a turn-based artillery game in the classic Worms spirit, with giant African land snails instead of worms. Slow on their feet, quick on the trigger.

- 2–4 teams, hot-seat on one screen or against the computer
- Eight weapons: a wind-swept bazooka, a bouncing grenade, a salt shaker, dynamite, a slime ball that sticks to your opponent, salt rain from the sky, a shell shove that knocks snails flying and a snail hop that teleports
- Destructible terrain, crates with health and ammo, sudden death with rising water
- A dotted trajectory preview while you aim
- Plays on phones with touch controls, installs as an app and works offline
- Swedish and English

Free and ad-free. If you want to support development, pay what you want.

## Publicera med butler från CI

1. Skapa spelet på itch.io (Dashboard → Create new project), välj HTML som typ.
2. Skapa en API-nyckel: itch.io → Settings → API keys.
3. Lägg in två hemligheter i GitHub-repot (Settings → Secrets → Actions):
   `BUTLER_API_KEY` = nyckeln, `ITCH_TARGET` = `dittanvändarnamn/snackmageddon`.
4. Varje push till `main` kör arbetsflödet *Release build*: testerna, zipen
   och butler-push till itch.io, så itch.io följer snails.se. Versionen på
   itch blir `package.json`-versionen plus commit-hash (t.ex. `0.4.0-a31618b`).
   Det går också att köra för hand (Actions → Release build → Run workflow)
   eller tagga (`git tag v0.4.0 && git push origin v0.4.0`).
   Utan hemligheterna byggs zipen ändå och kan hämtas under Actions → Artifacts.
