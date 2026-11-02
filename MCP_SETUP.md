# Privat Garmin Coach-plugin

`/mcp` ger stateless MCP Streamable HTTP med JSON-svar. Samma Worker,
Garmin Durable Object och ACTION_API_KEY används. Inga nya molnresurser,
migreringar eller betalda tjänster krävs. Befintliga gratisnivågränser gäller.

Verktygen är listActivities, getActivityAnalysis, getActivitySection,
getActivityMetrics och getWellness. Alla går via befintliga GET-rutter.
Administrationsfunktioner exponeras inte. Bearer-nyckeln kontrolleras både
i MCP-lagret och av befintlig Worker/Durable Object.

1. Granska och sammanfoga ändringen. Driftsätt projektet med befintligt
   Cloudflare-flöde eller `npm ci` och `npm run deploy` från en redan
   autentiserad lokal miljö. Behåll befintliga bindings, migreringar och secrets.
2. MCP-adress: `https://garmin-coach.marcus-stahlnacke.workers.dev/mcp`.
3. Pluginanslutningen ska använda API key, Bearer. Ange ACTION_API_KEY enbart
   i värdens säkra nyckelfält. Lägg den aldrig i chatten, GitHub, ZIP,
   mcp.json eller kommandoradsargument. Använd inte ADMIN_API_KEY.
4. Verifiera initialize och tools/list efter anslutning; fem läsverktyg ska synas.
   Testa därefter listActivities med limit=1 och ett valt pass.

Anrop utan Origin tillåts för MCP-klienter mellan servrar. Om klienten faktiskt
skickar Origin måste den matcha Worker-adressen eller en uttryckligen angiven
MCP_ALLOWED_ORIGINS-lista (kommaseparerade fullständiga origins). Ingen wildcard.

Verifiering: `npm run typecheck`, `npm test`. MCP-verktygens annotations är
readOnlyHint=true och destructiveHint=false; servern begränsar också routningen
till schemats fem läsoperationer. POST på /mcp är protokolltransport och ger
ingen rätt att skriva träningsdata.

