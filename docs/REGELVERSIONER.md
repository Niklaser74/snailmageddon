# Regelversioner för simuleringen

Snigelpost-matcher spelas över dagar och veckor, och båda spelarnas enheter
måste räkna fram exakt samma tillstånd från samma inspelning. Varje ändring
av simuleringen som ger en annan hash (`stateHash()`) är därför en ny
**regelversion**. Det här dokumentet är strategin.

## Principer

1. **Varje match bär sin regelversion.** Inspelningar (`recording.rulesVersion`)
   och matchraden på servern (`snails_matches.rules_version`) säger vilken
   version matchen startades med. Den ändras aldrig under matchen.
2. **Spelet kör flera versioner samtidigt.** `SUPPORTED_RULES` i `js/game.js`
   listar dem (idag 3 och 4). `new Game(...)` tar versionen från inspelningen
   eller matchen och ställer in sig efter den: vapenlista, och vid behov
   gränser i logiken, som vindregeln: `if (this.rulesVersion >= 4)` läser
   `rules.wind`, annars spelas normal vind. Nya matcher startas
   alltid med `RULES_VERSION`.
3. **Fönstret är aktuell + föregående.** När en ny version införs blir den
   äldsta i fönstret pensionerad. Servern får ett solnedgångsdatum för den
   (`snails_rules.sunset_at`, normalt 30 dagar fram), så pågående matcher
   hinner spelas klart. Efter datumet stänger det nattliga städjobbet
   återstående matcher på den versionen som oavgjorda och tar bort öppna
   inbjudningar.
4. **Facit-inspelningar bevisar bakåtkompatibiliteten.** `test/fixtures/rules-v<N>.json`
   är inspelningar gjorda av koden som införde version N, med hashen vid varje
   dragbyte. Determinism-testet spelar upp dem med dagens kod. Divergerar
   någon har simuleringen ändrats för en gammal version, vilket är ett fel.
5. **Servern speglar listan.** Tabellen `snails_rules` avgör vilka versioner
   `snails_create_match` och `snails_rematch` accepterar. Klienten och
   servern måste uppdateras ihop (samma commit ändrar båda).

## Vad räknas som regeländring?

Allt som simuleringen läser: vapenparametrar, fysik, terrängen, lådor,
turordning, skada, AI-*resultat* som går in i simuleringen räknas dock inte,
eftersom AI:ns val spelas in som input (AI:n kan förbättras fritt). Rendering,
ljud, kamera och HUD är aldrig regeländringar. Kör
`node test/determinism.test.mjs`: om facit-testet är grönt är det ingen
regeländring.

## Så inför du regelversion N

1. Höj `RULES_VERSION` till N och sätt `SUPPORTED_RULES = [N-1, N]` i
   `js/game.js`. Lägg en rad i kommentaren ovanför om vad N ändrar.
2. Grinda ändringen: nya vapen får `since: N`; annan logik får
   `if (this.rulesVersion >= N)`. Den gamla vägen måste bli kvar tills
   versionen pensioneras.
3. Skapa facit: `node test/make-fixture.mjs . > test/fixtures/rules-vN.json`.
   Rör aldrig en befintlig facitfil.
4. Kör testerna. `rules v(N-1)` måste vara grön, annars har du ändrat den
   gamla vägen.
5. Migration: `insert into snails_rules (version, supported, note) values (N, true, '…')`
   och `update snails_rules set supported = false, sunset_at = current_date + 30 where version = N-2`.
6. Höj `VERSION` i `sw.js` så klienterna hämtar den nya koden. Klienter som
   fortfarande kör gammal kod får texten "Matchen använder nyare regler" och
   uppmanas ladda om.
7. När solnedgången passerat: ta bort grindarna för den pensionerade versionen
   i koden och dess facitfil, och krymp `SUPPORTED_RULES`.

## Historik

| Version | Infört | Innehåll |
|---|---|---|
| 1 | 2026-09-04 | första Snigelpost-reglerna (pensionerad samma dag, inga matcher) |
| 2 | 2026-09-04 | lådor, slemklot, saltregn, ammunition; dragtid och plötslig död som matchregler |
| 3 | 2026-09-04 | skalstöt, snigelhopp |
