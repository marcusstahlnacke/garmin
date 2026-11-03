// Exercises the real OAuth library with in-memory bindings; no network or real secrets.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { test } from 'node:test';

const origin = 'https://garmin-coach.marcus-stahlnacke.workers.dev';
const resource = origin + '/mcp';
const bundled = await build({ entryPoints: ['src/oauth.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'worker-base', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'base', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class WorkerEntrypoint {}', loader: 'js' }));
  } }],
});
const { createOAuth } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
class MemoryKV {
  data = new Map();
  async get(k, type) { const v = this.data.get(k); if (!v) return null; return (type === 'json' || type?.type === 'json') ? JSON.parse(v) : v; }
  async put(k, v) { this.data.set(k, v); }
  async delete(k) { this.data.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.data.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
}

test('OAuth consent, PKCE, tokens and refresh protect the five-read-tool handler', async () => {
  let reads = 0;
  const env = { OAUTH_KV: new MemoryKV(), OAUTH_APPROVAL_KEY: 'test-approval-' + 'a'.repeat(32), ACTION_API_KEY: 'test-action-' + 'b'.repeat(32),
    GARMIN: { idFromName: () => 'personal', get: () => ({ oauthRateLimit: async () => true }) } };
  const pending = [];
  const ctx = () => ({ waitUntil: p => pending.push(p), passThroughOnException() {} });
  const provider = createOAuth(async req => { reads++; assert.equal(req.headers.get('Authorization'), `Bearer ${env.ACTION_API_KEY}`); return Response.json({ tools: 5 }); });
  const send = async (path, options = {}) => { const r = await provider.fetch(new Request(origin + path, options), env, ctx()); await Promise.all(pending.splice(0)); return r; };
  const missing = await send('/mcp');
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('WWW-Authenticate'), /resource_metadata/);
  assert.equal((await send('/.well-known/oauth-authorization-server')).status, 200);
  const registration = await send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: '<script>evil</script>', redirect_uris: ['https://chatgpt.com/connector_platform/oauth/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  const client = await registration.json();
  assert.ok(client.client_id, JSON.stringify(client));
  const verifier = 'v'.repeat(64);
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://chatgpt.com/connector_platform/oauth/callback', response_type: 'code', scope: 'garmin:read offline_access', resource, state: 'test-state', code_challenge: challenge, code_challenge_method: 'S256' });
  const badRedirect = new URLSearchParams(query); badRedirect.set('redirect_uri', 'https://evil.invalid/capture');
  assert.equal((await send('/authorize?' + badRedirect)).status, 400);
  const noPkce = new URLSearchParams(query); noPkce.delete('code_challenge'); noPkce.delete('code_challenge_method');
  assert.equal((await send('/authorize?' + noPkce)).status, 400);
  const writeScope = new URLSearchParams(query); writeScope.set('scope', 'garmin:write');
  assert.equal((await send('/authorize?' + writeScope)).status, 400);
  const page = await send('/authorize?' + query);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(!html.includes('<script>evil</script>'));
  assert.ok(html.includes('&#60;script&#62;'));
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const post = (key, cookieValue = cookie, source = origin) => send('/authorize', { method: 'POST', headers: { Origin: source, Cookie: cookieValue, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve', approval_key: key }) });
  assert.equal((await post('wrong')).status, 403);
  assert.equal((await post(env.OAUTH_APPROVAL_KEY, cookie, 'https://evil.invalid')).status, 403);
  assert.equal((await post(env.OAUTH_APPROVAL_KEY, '')).status, 400);
  assert.equal(reads, 0);
  const approved = await post(env.OAUTH_APPROVAL_KEY);
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get('Location'));
  assert.equal(callback.searchParams.get('state'), 'test-state');
  const code = callback.searchParams.get('code');
  assert.ok(code);
  assert.equal((await post(env.OAUTH_APPROVAL_KEY)).status, 400);
  const token = async body => { const r = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }); return { status: r.status, body: await r.json() }; };
  const grant = await token({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: callback.origin + callback.pathname, code_verifier: verifier, resource });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.ok(grant.body.refresh_token);
  assert.equal((await send('/mcp', { headers: { Authorization: `Bearer ${grant.body.access_token}` } })).status, 200);
  assert.equal(reads, 1);
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: grant.body.refresh_token, client_id: client.client_id, resource });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: client.client_id, resource: 'https://evil.invalid/mcp' })).status, 400);
  assert.equal((await token({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: callback.origin + callback.pathname, code_verifier: verifier, resource })).status, 400);
  assert.equal((await send('/mcp', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
});

