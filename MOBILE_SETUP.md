# Garmin Coach på telefonen

Den lokala desktop-anslutningen fortsätter använda ACTION_API_KEY.
Mobilanslutningen använder OAuth med Cloudflares workers-oauth-provider 1.2.4.
Samma Worker, GarminAccount och Garmin-session används. OAuth-token lagras i
en separat OAUTH_KV-namespace. KV ingår i Workers Free med användningsgränser.
Ingen betald hosting eller ytterligare identitetstjänst krävs.

## Aktivera på Cloudflare

1. I garmin-coach → Settings → Variables and Secrets: lägg till en **Secret**
   med namnet OAUTH_APPROVAL_KEY. Skapa ett unikt, slumpmässigt lösenord på
   minst 32 och högst 256 tecken i din lösenordshanterare. Spara det där också.
   Använd inte ACTION_API_KEY, ADMIN_API_KEY eller Garmin-lösenordet.
   Klistra inte in det i chatten, GitHub eller byggloggar.
2. Sammanfoga ändringen till main. Det befintliga Cloudflare-bygget skapar
   OAUTH_KV automatiskt via Wrangler och driftsätter Workern. Om bygget saknar
   rätt att skapa KV: skapa en namespace i Cloudflare och ange dess ID i
   kv_namespaces i wrangler.jsonc; inga hemligheter ska placeras i den filen.
3. Kontrollera att bygget lyckas och att OAUTH_KV finns under Bindings.

Utan den separata godkännandekoden och KV är OAuth avstängt. Den gamla
desktop-anslutningen fortsätter fungera. Befintliga bindings och migreringar
ska behållas.

## Anslut genom ChatGPTs molnanslutning

Använd ChatGPT på webben, inte den lokala inställningsvyn för MCP som har
fältet "Bearer token env var". Välj Add custom MCP server i Plugins och ange:

- Server URL: https://garmin-coach.marcus-stahlnacke.workers.dev/mcp
- Authentication: OAuth
- Client registration: CIMD om alternativet finns; annars Dynamic Client
  Registration (DCR). Servern stöder båda.
- Scope: garmin:read offline_access om formuläret efterfrågar det.

Discovery finns på /.well-known/oauth-authorization-server och
/.well-known/oauth-protected-resource/mcp (även rotvarianten stöds av biblioteket).
Authorize: /authorize. Token: /oauth/token. DCR: /oauth/register.

Vid anslutningen öppnas Workerns HTTPS-sida /authorize. Kontrollera att
domänen är garmin-coach.marcus-stahlnacke.workers.dev, att du själv startade
anslutningen och att mottagardomänen stämmer med ChatGPT-flödet. Ange
OAUTH_APPROVAL_KEY bara där och godkänn läsåtkomst. ACTION_API_KEY stannar
på servern och behöver inte finnas på telefonen eller i molnpluginen.

En portabel desktop-plugin blir inte automatiskt en molnanslutning genom
att ändra en etikett. Molnanslutningen måste registreras och testas efter
driftsättningen. Återanvänd pluginens coachinstruktioner; publicering i en
offentlig katalog krävs inte. Ändra inte den fungerande desktop-pluginen
förrän molnanslutningen har verifierats.

Testa listActivities med limit=1 på webben och sedan samma plugin i
telefonens ChatGPT-app på samma konto. Kontrollera att fem läsverktyg finns.
Mobilstödet är inte verifierat förrän det testet fungerar.

## Säkerhet och begränsningar

OAuth-biblioteket sköter PKCE, klient-/redirectvalidering, browserbundna
godkännanden, resursbundna token och tokenförnyelse. Endast garmin:read och
offline_access godkänns; administrationsrutter omfattas inte. Ingen ny
Garmin-inloggning behövs. Godkännandeförsök begränsas globalt till 10 per
10 minuter, godkännandesidor till 100 per 10 minuter. KV:s gratisgränser
kan stoppa nya anslutningar vid hög belastning. KV har eventual consistency;
detta är en privat, personlig integration och ingen fleranvändartjänst.

Access-token gäller i en timme och refresh-token i 30 dagar. Ta bort
molnanslutningen när den inte längre ska användas. För nödavstängning av
alla OAuth-anrop, ta bort OAUTH_APPROVAL_KEY i Cloudflare. Att bara byta
kod hindrar nya godkännanden med den gamla koden men återkallar inte
redan utfärdade token. Desktop-nyckeln påverkas inte av att OAuth stängs av.

Validering: npm run typecheck, npm run build, npm run test:oauth.
OAuth-testet använder det riktiga OAuth-biblioteket med tillfällig lagring
och fiktiva hemligheter i Node. Det ersätter inte test på driftsatt Worker.

