import { OAuthProvider, AuthorizationError, type OAuthHelpers, type OAuthResourceContext, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { boundedText, equalSecret, json } from './common';
import type { Env } from './index';

const ORIGIN = 'https://garmin-coach.marcus-stahlnacke.workers.dev';
const RESOURCE = `${ORIGIN}/mcp`;
const SCOPES = ['garmin:read', 'offline_access'];
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

async function consent(request: Request, env: OAuthEnv): Promise<Response> {
  const stub = env.GARMIN.get(env.GARMIN.idFromName('personal-account-v1'));
  if (!await stub.oauthRateLimit(request.method === 'POST' ? 'approval' : 'page')) return json({ error: 'try_later' }, 429);
  const api = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const auth = await api.parseAuthRequest(request);
      if (auth.scope.some(s => !SCOPES.includes(s)) || !auth.scope.includes('garmin:read')) return json({ error: 'invalid_scope' }, 400);
      const details = await api.describeConsent(auth);
      const transaction = await api.beginConsent(auth);
      const headers = transaction.headers;
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      // Form POSTs need their real Origin for the strict check below.
      // Suppress cross-origin referrers without turning same-origin POSTs into Origin: null.
      headers.set('Referrer-Policy', 'same-origin');
      headers.set('X-Frame-Options', 'DENY');
      // Browsers also apply form-action to the OAuth callback redirect.
      headers.set('Content-Security-Policy', "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'");
      return new Response(`<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anslut Garmin Coach</title>
        <h1>Anslut Garmin Coach</h1><p><strong>${escape(details.clientName)}</strong> vill läsa dina tränings- och återhämtningsdata.</p>
        <p>${details.clientDomain ? `Klientens domän: ${escape(details.clientDomain)}.` : 'Klientnamnet är självregistrerat och inte verifierat.'}</p>
        <p>Anslutningen skickas tillbaka till <strong>${escape(details.redirectHost)}</strong>.</p>
        ${details.redirectIsLoopback ? '<p>Detta godkänner en lokal app på din dator.</p>' : ''}
        <p>Behörigheter: ${auth.scope.map(escape).join(', ')}. Ingen rätt att ändra Garmin-data.</p>
        <p>Fortsätt bara om du själv precis startade anslutningen. Ange din separata godkännandekod som sparats som OAUTH_APPROVAL_KEY i Cloudflare. Använd aldrig ditt Garmin-lösenord här.</p>
        <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(transaction.handle)}">
        <label>Godkännandekod <input type="password" name="approval_key" autocomplete="off" maxlength="256"></label>
        <p><button name="decision" value="approve">Godkänn läsåtkomst</button> <button name="decision" value="deny">Avbryt</button></p></form></html>`, { headers });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    if (request.headers.get('Origin') !== ORIGIN) return json({ error: 'origin_refused' }, 403);
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return json({ error: 'form_required' }, 415);
    const form = new URLSearchParams(await boundedText(request, 4096));
    const handle = form.get('handle') || '';
    if (form.get('decision') !== 'approve') {
      const denied = await api.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (!await equalSecret(form.get('approval_key') || '', env.OAUTH_APPROVAL_KEY || '')) return json({ error: 'approval_refused_restart_connection' }, 403);
    const approved = await api.approveConsent(request, handle);
    if (!approved.request.scope.includes('garmin:read') || approved.request.scope.some(s => !SCOPES.includes(s))) return json({ error: 'invalid_scope' }, 400);
    const grant = await api.completeAuthorization({
      request: approved.request, userId: 'personal-account-v1', metadata: {},
      scope: approved.request.scope, props: { userId: 'personal-account-v1' },
    });
    approved.headers.set('Location', grant.redirectTo);
    approved.headers.set('Cache-Control', 'no-store');
    approved.headers.set('Referrer-Policy', 'no-referrer');
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    // Never redirect from an unvalidated query or expose request/credential details.
    return json({ error: err instanceof AuthorizationError ? 'invalid_or_expired_authorization' : 'authorization_unavailable' }, 400);
  }
}

export function createOAuth(readMcp: (request: Request, env: Env) => Promise<Response>) {
  return new OAuthProvider<OAuthEnv>({
    apiRoute: '/mcp', authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES, requiredScopes: ['garmin:read'],
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ORIGIN] },
    apiHandler: { async fetch(request, env, ctx) {
      const authCtx = ctx as OAuthResourceContext<{ userId: string }>;
      if (!authCtx.auth.scope.includes('garmin:read')) return insufficientScope(authCtx.auth, ['garmin:read']);
      if (authCtx.props?.userId !== 'personal-account-v1') return json({ error: 'forbidden' }, 403);
      // Only the already-validated /mcp request receives the internal data credential.
      // It never leaves the Worker and is never returned to the client.
      const internal = new Request(request);
      internal.headers.set('Authorization', `Bearer ${env.ACTION_API_KEY}`);
      return readMcp(internal, env);
    } },
    defaultHandler: { async fetch(request, env) {
      return new URL(request.url).pathname === '/authorize' ? consent(request, env) : json({ error: 'not_found' }, 404);
    } },
  });
}

