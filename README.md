# Garmin Coach på Cloudflare Workers Free

Workers-versionen kör hela tjänsten på Cloudflare. Ingen egen dator behöver vara igång efter publicering. Den använder en Worker och ett **SQLite-baserat Durable Object**, som stöds av Free-planen. Inga Containers, R2-buckets eller betalprodukter krävs. Behåll Workers Free; när gratisgränser överskrids kan tjänsten sluta svara tills kvoten återställs.

Implementerat: privat Garmin-inloggning med MFA, DI-tokenförnyelse, AES-256-GCM-krypterad sessionslagring, frånkoppling och fem skrivskyddade GPT Actions. Inloggningsprotokollet är portat från `python-garminconnect@0.3.20`; se [licensnotisen](THIRD_PARTY_NOTICES.md). Inga produktionsberoenden behövs.

**Verifieringsstatus:** typkontroll, lokalt Workers-bygge och 30 integrationstester med simulerade Garmin-svar. Riktig Garmin-inloggning och CPU-förbrukning i en publicerad Free Worker är ännu inte verifierade. Tjänsten är inte publicerad på ditt konto.

## 1. Installera och testa

Kör detta i en terminal med Node.js 22.12+ (eller en kompatibel nyare version). Källkoden måste finnas på datorn du använder för publicering; nedan visas molnmiljöns sökväg.

```bash
cd /workspace/garmin/workers
npm ci --ignore-scripts
npm run typecheck
npm test
```

Byggkommandot i testerna använder `wrangler deploy --dry-run`: det publicerar inte kod eller skapar resurser. Tester kör riktig lokal `workerd` och SQLite-lagring. Garmin är simulerat, inklusive inloggning, MFA, cookies, tokenrotation och omstarter.

För att köra lokalt: kopiera `.dev.vars.example` till `.dev.vars`, fyll i tre privata nycklar enligt nedan och kör `npm run dev`. Lokal drift ska endast exponeras på loopback. Anslut inte ditt riktiga Garmin-konto i en delad utvecklingsmiljö eller en miljö som ska sparas som delad avbildning. Publicera först och använd den privata anslutningssidan där.

## 2. Publicera på ditt gratis Cloudflare-konto

Detta är en engångsinstallation. Din dator behövs därefter inte för driften. Logga in via webbläsaren som Wrangler öppnar:

```bash
npx wrangler login
npx wrangler whoami
npm run deploy
```

Kontrollera att rätt konto väljs om du har flera. Byt `name` i `wrangler.jsonc` före publicering om `garmin-coach` redan används av en annan tjänst i ditt konto; skriv inte över en befintlig app. Wrangler skapar Workern och det SQLite-baserade Durable Object som är deklarerat i konfigurationen. Uppgradera inte till en betalplan om något går fel; läs felmeddelandet och felsök Free-stödet först.

Wrangler skriver ut tjänstens riktiga HTTPS-adress, normalt `https://garmin-coach.DITT-NAMN.workers.dev`. En egen domän behöver inte köpas.

## 3. Lägg till tre separata hemligheter

Skapa tre slumpmässiga nycklar på minst 32 tecken. `SESSION_ENCRYPTION_KEY` ska vara **exakt 32 slumpmässiga bytes kodade som base64**. Ett sätt att generera dem i din egen terminal är:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; for (const name of ['ACTION_API_KEY', 'ADMIN_API_KEY', 'SESSION_ENCRYPTION_KEY']) console.log(name + '=' + randomBytes(32).toString('base64'))"
```

Spara nycklarna privat, exempelvis i en lösenordshanterare. Skriv inte värdena i Git eller ChatGPT. Lägg in varje värde när respektive kommando frågar efter det:

```bash
npx wrangler secret put ACTION_API_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put SESSION_ENCRYPTION_KEY
```

- `ACTION_API_KEY`: anges endast i den privata GPT Action-konfigurationen; kan läsa träningsdata.
- `ADMIN_API_KEY`: används endast på din privata anslutningssida. Får inte ges till GPT:n.
- `SESSION_ENCRYPTION_KEY`: krypterar sessionslagringen. Ingen Garmin-inloggning används för att skapa denna nyckel.

Gör nycklarna olika. Innan de är korrekt konfigurerade vägrar tjänsten skyddade anrop. Nycklar kan också hanteras säkert som Worker Secrets i Cloudflares dashboard. Behåll krypteringsnyckeln över uppdateringar. För byte av krypteringsnyckel: koppla från först, byt nyckeln och anslut igen.

## 4. Anslut Garmin på tjänstens egen sida

Öppna `/connect` på HTTPS-adressen som Wrangler gav dig.

1. Ange **ADMIN_API_KEY** i fältet Administrationsnyckel.
2. Ange Garmin-mejl och lösenord och tryck Logga in.
3. Om Garmin begär MFA visas ett kodfält. Ange koden där.
4. Sidan visar ansluten först efter att Garmin har godkänt ett profil-anrop. Lösenord och MFA-kod sparas inte. Sessions- och refresh-token sparas krypterat i Durable Object.

En påbörjad MFA-inloggning går ut efter tio minuter och tas bort via ett alarm. Fem login-/importförsök tillåts per timme och fem kodförsök per MFA-period. En redan ansluten session byts inte ut om en ny inloggning misslyckas. Administrationsnyckeln hålls endast i sidans fält; den läggs inte i URL eller browserlagring. Loggar för applikationen är avstängda i den medföljande konfigurationen.

Garmin kan kräva CAPTCHA eller blockera datacenteranslutningar. Då avbryts inloggningen. Ingen CAPTCHA-lösning, TLS-impersonering eller avaktivering av MFA används. Om inloggningen blockeras kan alternativet på sidan importera en befintlig **DI-sessionsfil** från Python-versionens privata inloggning. Filen verifieras mot Garmin före lagring. Äldre `oauth1_token.json`/`oauth2_token.json` stöds inte. En importerad session kan fortfarande blockeras av Garmin från Cloudflares nätverk.

Knappen Koppla från raderar tjänstens aktiva session och pågående MFA. Detta återkallar inte automatiskt andra sessioner hos Garmin.

## 5. Koppla din privata GPT

I ChatGPTs GPT-editor:

1. Skapa eller öppna din egen GPT och håll den privat.
2. Kopiera [GPT_INSTRUCTIONS.md](GPT_INSTRUCTIONS.md) till instruktionerna.
3. Lägg till en Action och importera `https://DIN-WORKER-ADRESS/openapi.json`.
4. Välj **API Key → Bearer** och ange `ACTION_API_KEY`, aldrig administrationsnyckeln eller Garmin-lösenordet.
5. Testa `listActivities` och därefter `getActivityAnalysis` för ett faktiskt pass. Be sedan: ”Analysera mitt senaste pass och ta hänsyn till all tillgänglig relevant data och de senaste fyra veckornas träning.”

Schemat hämtar sin serveradress från det faktiska anropet; `PUBLIC_BASE_URL` behöver inte konfigureras. Ingen administrativ endpoint exponeras i GPT-schemat. Alla dataendpoints är GET.

## Vilka data hämtas?

| Action | Underlag |
| --- | --- |
| `listActivities` | Senaste pass eller sidindelad historik före ett passdatum |
| `getActivityAnalysis` | Passöversikt, träningsform, vägledning och lista över delar att hämta |
| `getActivitySection` | Varvtider, intervaller, puls-/effektzoner, styrkeset och väder |
| `getActivityMetrics` | Sidindelade mätserier med ursprungliga enhetsbeskrivningar |
| `getWellness` | Sömn, HRV, dagssammanfattning, träningsberedskap/status och konditionsmått för angivet datum |

GPT:n ska begära relevanta delar utifrån träningstyp och redovisa saknade uppgifter. En sammanfattning ensam är inte ett fullständigt analysunderlag. Det finns ingen garanti att Garmin har alla fält eller att samtliga Garmin-endpoints omfattas.

API:t bevarar Garmin-fält och enheter. Koordinatfält filtreras bort; namn, anteckningar och andra personuppgifter kan finnas kvar. Alla sådana texter är opålitliga data, aldrig instruktioner. Historik följs via `next_start`. Mätserier kan samplas ned av Garmin, även efter sidindelning. Svar över 85 kB markeras `omitted`, inte tyst avklippta. Varje Garmin-anrop har en tidsgräns på tolv sekunder och ett tak på 1 MB inkommande data. Applikationen begränsar autentiserade dataanrop till 2 000 per dygn och åtta samtidiga/väntande anrop för den personliga instansen.

## Kontrollera innan du räknar lösningen som färdig

- En riktig aktivitet och dess relevanta delar ska kunna läsas via GPT:n.
- Vänta efter användning och verifiera att en ny Workers-instans kan använda den sparade sessionen.
- Verifiera senare en riktig Garmin-tokenförnyelse; den simuleras endast i lokala tester.
- Kontrollera CPU-tid och kvoter i Cloudflare. Yttre Workers Free har 10 ms CPU-tid per anrop; Durable Objects har egna gränser/kvoter. Lokala tester upprätthåller inte Cloudflares faktiska Free-budget. Uppdelade anrop minskar svarsstorlek, men ersätter inte mätning i drift.
- `/health` visar endast att Workern svarar. `/admin/status` visar att en session är sparad; inget av dessa är ett funktionstest mot Garmin.

Versionen är personlig och har ett enda Garmin-konto. Dela inte den konfigurerade GPT:n eller dess API-nyckel med vänner. Per-person-inloggning och användarisolering krävs före delning.


Automatisk driftsättning via Cloudflare Workers Builds.