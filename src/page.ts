export const page = `<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Anslut Garmin</title>
<h1>Anslut ditt Garmin-konto</h1>
<p>Privat anslutning för din GPT. Garmin-uppgifterna skickas till denna tjänst och vidare till Garmin, aldrig till ChatGPT. Lösenordet sparas inte. En krypterad session sparas tills du kopplar från. Tjänsten använder en inofficiell anslutning.</p>
<p>Inloggningen är inte verifierad mot ditt konto förrän ett riktigt pass har hämtats. Behåll MFA aktiverat. Om Garmin blockerar anslutningen ska du inte upprepa inloggningen direkt.</p>
<label>Administrationsnyckel <input id="admin" type="password" autocomplete="off"></label>
<form id="login"><h2>Garmin-inloggning</h2><p><label>Mejl <input id="email" type="email" autocomplete="username" required></label></p>
<p><label>Lösenord <input id="password" type="password" autocomplete="current-password" required></label></p><button>Logga in</button></form>
<form id="mfa" hidden><h2>MFA-kod</h2><label>Kod <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" required></label><button>Verifiera</button></form>
<h2>Session</h2><button id="status">Kontrollera anslutning</button> <button id="disconnect">Koppla från och radera session</button>
<details><summary>Alternativ: importera en befintlig DI-session</summary><p>Om webbinloggningen blockeras kan du importera sessionsfilen från Python-versionen. Filen innehåller hemligheter. Ladda endast upp den här på din egen HTTPS-adress. Äldre OAuth1/OAuth2-filer stöds inte.</p><input type="file" id="session" accept="application/json"><button id="import">Importera</button></details>
<p id="result" role="status"></p><script src="/connect.js" defer></script></html>`;

export const script = `const $ = id => document.getElementById(id);
const messages = {
 connected: 'Ansluten till Garmin. Hämta nu ett riktigt pass via din GPT för att verifiera hela flödet.',
 mfa_required: 'Garmin begär en MFA-kod. Kontrollera din vanliga verifieringskanal.',
 garmin_invalid_credentials: 'Garmin accepterade inte uppgifterna.',
 garmin_blocked: 'Garmin blockerade anslutningen. Upprepa inte inloggningen direkt.',
 garmin_captcha_required: 'Garmin kräver CAPTCHA. Detta flöde kan inte slutföra den kontrollen.',
 garmin_rate_limited: 'Garmin begränsar anropen. Vänta innan du försöker igen.',
 unauthorized: 'Fel administrationsnyckel.',
 login_rate_limited: 'För många inloggningsförsök. Vänta en timme.',
 mfa_expired: 'MFA-sessionen har gått ut. Börja med en ny inloggning.',
 mfa_attempt_limit: 'För många kodförsök. Börja med en ny inloggning.',
 garmin_login_or_mfa_failed: 'Garmin kunde inte verifiera inloggningen eller koden.',
 disconnected: 'Sessionen och pågående inloggning har raderats från denna tjänst.',
 garmin_reconnect_required: 'Garmin-sessionen är ogiltig. Anslut på nytt.',
};
async function call(path, body, method = 'POST') {
 $('result').textContent = 'Arbetar…';
 for (const button of document.querySelectorAll('button')) button.disabled = true;
 try {
  const response = await fetch(path, { method, cache: 'no-store', headers: { 'Authorization': 'Bearer ' + $('admin').value, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }) });
  const data = await response.json();
  $('mfa').hidden = data.status !== 'mfa_required';
  if (path === '/admin/status' && response.ok) $('result').textContent = data.connected ? 'En session finns sparad. Garmin godkänner den först när ett dataanrop lyckas.' : 'Ingen session är ansluten.';
  else $('result').textContent = messages[data.status || data.error] || 'Anropet misslyckades (' + (data.error || response.status) + '). Kontrollera anslutningen utan att dela hemligheter.';
 } catch { $('result').textContent = 'Kunde inte kontakta tjänsten.'; }
 finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
$('login').addEventListener('submit', event => { event.preventDefault(); const data = { username: $('email').value, password: $('password').value }; $('password').value = ''; call('/admin/login', data); });
$('mfa').addEventListener('submit', event => { event.preventDefault(); const code = $('code').value; $('code').value = ''; call('/admin/mfa', { code }); });
$('status').addEventListener('click', () => call('/admin/status', null, 'GET'));
$('disconnect').addEventListener('click', () => { if (confirm('Radera den sparade Garmin-sessionen?')) call('/admin/disconnect'); });
$('import').addEventListener('click', async () => { const file = $('session').files[0]; if (!file || file.size > 12000) { $('result').textContent = 'Välj en sessionsfil mindre än 12 kB.'; return; } try { const session = JSON.parse(await file.text()); $('session').value = ''; await call('/admin/import', session); } catch { $('result').textContent = 'Filen är inte giltig JSON.'; } });`;

export function pageResponse(content: string, type: string): Response {
  return new Response(content, { headers: {
    "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  } });
}
