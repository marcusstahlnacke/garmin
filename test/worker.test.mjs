import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Response } from 'miniflare';

const ACTION = 'action-test-key-' + 'a'.repeat(32);
const ADMIN = 'admin-test-key-' + 'b'.repeat(32);
const SECRET = Buffer.alloc(32, 7).toString('base64');
const SESSION = { di_token: 'test-access-original', di_refresh_token: 'test-refresh-original', di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' };
const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function fixture(t, options = {}) {
  const path = await mkdtemp(join(tmpdir(), 'garmin-worker-test-'));
  const state = { calls: [], refreshes: 0, challenge: true, ...options };
  const outbound = async request => {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.text() : '';
    state.calls.push({ url: url.href, body, auth: request.headers.get('Authorization'), cookie: request.headers.get('Cookie') });
    if (state.networkError) return new Response('dummy-private-upstream-error', { status: 500 });
    if (url.hostname === 'sso.garmin.com') {
      if (url.pathname.includes('sign-in')) {
        if (state.redirect) return new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid/capture' } });
        if (state.blocked) return reply({}, 403);
        return new Response('<html>Sign in</html>', { headers: { 'Set-Cookie': 'SESSION=test-mfa-cookie; Path=/; Secure; HttpOnly' } });
      }
      assert.equal(request.headers.get('Cookie'), 'SESSION=test-mfa-cookie');
      if (url.pathname.endsWith('/login')) {
        assert.equal(JSON.parse(body).password, 'dummy-password');
        if (state.captcha) return reply({ responseStatus: { type: 'CAPTCHA_REQUIRED' } });
        return reply(state.challenge ? { responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: { mfaLastMethodUsed: 'email' } } : { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'test-service-ticket' });
      }
      if (url.pathname.endsWith('/mfa/verifyCode')) {
        assert.equal(JSON.parse(body).mfaVerificationCode, '123456');
        return reply(state.badCode ? { responseStatus: { type: 'INVALID_CODE' } } : { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'test-service-ticket' });
      }
    }
    if (url.hostname === 'diauth.garmin.com') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        state.refreshes++;
        if (state.refreshFailed) return reply({}, 401);
        return reply({ access_token: 'test-access-rotated', refresh_token: 'test-refresh-rotated', expires_in: 3600 });
      }
      assert.equal(params.get('service_ticket'), 'test-service-ticket');
      assert.equal(params.get('service_url'), 'https://mobile.integration.garmin.com/gcm/ios');
      return reply({ access_token: SESSION.di_token, refresh_token: SESSION.di_refresh_token, expires_in: 3600 });
    }
    assert.equal(url.hostname, 'connectapi.garmin.com', 'No arbitrary outbound destinations');
    if (state.unauthorized && request.headers.get('Authorization') !== 'Bearer test-access-rotated') return reply({}, 401);
    if (url.pathname.endsWith('/socialProfile')) return state.badProfile ? reply({}, 401) : reply({ displayName: 'test-user' });
    if (url.pathname.includes('activitylist-service')) {
      const start = Number(url.searchParams.get('start') || 0);
      const limit = Number(url.searchParams.get('limit') || 10);
      return reply([{ activityId: 123, averageHR: 143, startLatitude: 59 }, { activityId: 124 }, { activityId: 125 }].slice(start, start + limit));
    }
    if (url.pathname.endsWith('/details')) return reply({
      metricDescriptors: [{ key: 'directLatitude', metricsIndex: 0, unit: 'degree' }, { key: 'directHeartRate', metricsIndex: 1, unit: 'bpm' }],
      activityDetailMetrics: Array.from({ length: 230 }, () => ({ metrics: [59, 143] })),
    });
    if (url.pathname.endsWith('/exerciseSets')) return reply({ exerciseSets: [{ repetitionCount: 8, weight: 40000, weightUnit: 'gram' }] });
    if (url.pathname.endsWith('/weather') && state.weatherUnavailable) return reply({}, 404);
    if (url.pathname.endsWith('/splits') && state.hugeSplits) return reply({ samples: 'x'.repeat(90000) });
    if (/\/activity\/\d+$/.test(url.pathname)) return reply({ activityId: 123, activityTypeDTO: { typeKey: state.sport || 'running' }, summaryDTO: { startTimeLocal: '2026-10-20T08:00:00', averageHR: 143, startLatitude: 59 } });
    if (url.pathname.endsWith('/hrTimeInZones')) return reply([]);
    return reply({ value: 42, latitude: 59, recorded: true });
  };
  const runtimeOptions = convertV4MiniflareOptions({
    name: 'garmin-test', modules: true, scriptPath: resolve('dist/index.js'), compatibilityDate: '2026-11-02',
    bindings: { ACTION_API_KEY: ACTION, ADMIN_API_KEY: ADMIN, SESSION_ENCRYPTION_KEY: SECRET },
    durableObjects: { GARMIN: { className: 'GarminAccount', useSQLite: true } },
    resourcePersistencePath: path, outboundService: outbound, cf: false,
  });
  let mf = new Miniflare(runtimeOptions);
  t.after(async () => { await mf.dispose(); await rm(path, { recursive: true, force: true }); });
  await mf.ready;
  const call = async (route, body, key = ADMIN, extra = {}) => {
    const response = await mf.dispatchFetch('https://coach.example' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const connect = async () => {
    const response = await call('/admin/import', SESSION);
    assert.equal(response.status, 200, JSON.stringify(response.data));
  };
  const evict = () => mf.unsafeEvictDurableObject('garmin-test', 'GarminAccount', { name: 'personal-account-v1' });
  const restart = async () => { await mf.dispose(); mf = new Miniflare(runtimeOptions); await mf.ready; };
  return { get mf() { return mf; }, call, connect, evict, restart, state, path };
}

test('public schema exposes read-only actions, not administrative login', async t => {
  const { mf } = await fixture(t);
  const response = await mf.dispatchFetch('https://coach.example/openapi.json');
  const schema = await response.json();
  assert.equal(schema.servers[0].url, 'https://coach.example');
  assert.equal(Object.keys(schema.paths).length, 5);
  assert.equal(schema.paths['/activities'].get.operationId, 'listActivities');
  for (const [path, operations] of Object.entries(schema.paths)) {
    assert.ok(!path.includes('admin'));
    assert.deepEqual(Object.keys(operations), ['get']);
    assert.deepEqual(operations.get.security, [{ bearerAuth: [] }]);
  }
});

test('Action and administrator credentials cannot access each other\'s routes', async t => {
  const { call, state } = await fixture(t);
  assert.equal((await call('/admin/status', undefined, ACTION)).status, 401);
  assert.equal((await call('/activities', undefined, ADMIN)).status, 401);
  assert.equal((await call('/activities', undefined, 'wrong')).status, 401);
  assert.equal(state.calls.length, 0);
});

test('unconnected account returns explicit connection requirement', async t => {
  const { call } = await fixture(t);
  assert.deepEqual((await call('/activities', undefined, ACTION)).data, { error: 'garmin_not_connected' });
});

test('browser page has no inline script, no cache and no iframe access', async t => {
  const { mf } = await fixture(t);
  const response = await mf.dispatchFetch('https://coach.example/connect');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /src="\/connect.js"/);
});

test('cross-origin login is rejected without contacting Garmin', async t => {
  const { call, state } = await fixture(t);
  assert.equal((await call('/admin/login', { username: 'dummy', password: 'dummy-password' }, ADMIN, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(state.calls.length, 0);
});

test('MFA flow preserves cookies and pending state across object eviction', async t => {
  const { call, evict, state } = await fixture(t);
  const first = await call('/admin/login', { username: 'dummy@example.com', password: 'dummy-password' });
  assert.deepEqual(first.data, { status: 'mfa_required' });
  await evict();
  assert.equal((await call('/admin/status')).data.mfa_pending, true);
  const second = await call('/admin/mfa', { code: '123456' });
  assert.deepEqual(second.data, { status: 'connected' });
  assert.equal(state.calls.filter(c => c.url.includes('verifyCode')).length, 1);
  await evict();
  assert.equal((await call('/activities', undefined, ACTION)).status, 200);
});

test('non-MFA login verifies profile and saves a session', async t => {
  const { call } = await fixture(t, { challenge: false });
  assert.equal((await call('/admin/login', { username: 'dummy', password: 'dummy-password' })).data.status, 'connected');
  assert.equal((await call('/admin/status')).data.connected, true);
});

test('rotated refresh token survives eviction and concurrent requests refresh only once', async t => {
  const { call, connect, evict, state } = await fixture(t);
  await connect();
  state.unauthorized = true;
  const responses = await Promise.all(Array.from({ length: 3 }, () => call('/activities', undefined, ACTION)));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(state.refreshes, 1);
  await evict();
  const count = state.calls.length;
  assert.equal((await call('/activities', undefined, ACTION)).status, 200);
  assert.equal(state.refreshes, 1);
  assert.ok(state.calls.slice(count).some(c => c.auth === 'Bearer test-access-rotated'));
});

test('failed token refresh returns reconnect requirement without leaking tokens', async t => {
  const { call, connect, state } = await fixture(t);
  await connect();
  state.unauthorized = true; state.refreshFailed = true;
  const response = await call('/activities', undefined, ACTION);
  assert.equal(response.status, 409);
  assert.equal(response.data.error, 'garmin_reconnect_required');
  assert.ok(!JSON.stringify(response).includes(SESSION.di_refresh_token));
});

for (const [sport, expected] of [['trail_running', 'running'], ['indoor_cycling', 'indoor_cycling'], ['road_biking', 'cycling'], ['strength_training', 'strength']]) {
  test(`workout manifest preserves data and identifies ${sport}`, async t => {
    const { call, connect } = await fixture(t, { sport });
    await connect();
    const response = await call('/activities/123/analysis', undefined, ACTION);
    assert.equal(response.data.sport, expected);
    assert.equal(response.data.activity.summaryDTO.averageHR, 143);
    assert.equal(response.data.activity.summaryDTO.startLatitude, undefined);
    if (expected === 'strength') assert.ok(response.data.sections_to_request.includes('exercise_sets'));
  });
}

test('metrics paginate, retain units, redact GPS and never label samples as exhaustive', async t => {
  const { call, connect } = await fixture(t);
  await connect();
  const result = (await call('/activities/123/metrics?start=100&limit=100', undefined, ACTION)).data;
  assert.equal(result.data.metricDescriptors[1].unit, 'bpm');
  assert.deepEqual(result.data.activityDetailMetrics[0].metrics, [null, 143]);
  assert.equal(result.data.activityDetailMetrics.length, 100);
  assert.equal(result.next_start, 200);
  assert.equal(result.total_returned_by_garmin, 230);
  const last = (await call('/activities/123/metrics?start=200', undefined, ACTION)).data;
  assert.equal(last.next_start, null);
  assert.equal(last.returned_points, 30);
});

test('strength reps and weight units are preserved', async t => {
  const { call, connect } = await fixture(t);
  await connect();
  const { data } = await call('/activities/123/sections/exercise_sets', undefined, ACTION);
  assert.equal(data.data.exerciseSets[0].repetitionCount, 8);
  assert.equal(data.data.exerciseSets[0].weightUnit, 'gram');
});

test('empty and unavailable sections remain distinct', async t => {
  const { call, connect } = await fixture(t, { weatherUnavailable: true });
  await connect();
  assert.equal((await call('/activities/123/sections/weather', undefined, ACTION)).data.status, 'unavailable');
  assert.equal((await call('/activities/123/sections/heart_rate_zones', undefined, ACTION)).data.status, 'empty');
});

test('history uses workout dates, pagination and excludes the activity day', async t => {
  const { call, connect, state } = await fixture(t);
  await connect();
  const response = await call('/activities?before_date=2026-10-20&history_days=28&limit=2', undefined, ACTION);
  assert.equal(response.data.next_start, 2);
  const query = new URL(state.calls.at(-1).url).searchParams;
  assert.equal(query.get('startDate'), '2026-09-22');
  assert.equal(query.get('endDate'), '2026-10-19');
});

test('wellness request uses the explicit historical date and connected profile', async t => {
  const { call, connect, state } = await fixture(t);
  await connect();
  assert.equal((await call('/wellness/2026-10-20/sleep', undefined, ACTION)).status, 200);
  assert.match(state.calls.at(-1).url, /dailySleepData\/test-user\?date=2026-10-20/);
});

test('unsafe paths, invalid pagination and dates are rejected', async t => {
  const { call, connect } = await fixture(t);
  await connect();
  for (const path of ['/activities?limit=999', '/activities?before_date=2026-02-30', '/activities?before_date=2026-99-99', '/activities/0/analysis', '/activities/123/sections/arbitrary', '/activities/123/sections/constructor', '/wellness/2026-10-20/unknown']) {
    const result = await call(path, undefined, ACTION);
    assert.ok([400, 404].includes(result.status), path);
  }
});

test('Garmin blocking and foreign redirect stop the flow without credential forwarding', async t => {
  const { call, state } = await fixture(t, { redirect: true });
  const result = await call('/admin/login', { username: 'dummy', password: 'dummy-password' });
  assert.equal(result.data.error, 'garmin_redirect_refused');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].body, '');
});

test('login attempts are limited durably', async t => {
  const { call, evict, state } = await fixture(t, { blocked: true });
  for (let i = 0; i < 5; i++) assert.equal((await call('/admin/login', { username: 'dummy', password: 'dummy-password' })).data.error, 'garmin_blocked');
  await evict();
  const before = state.calls.length;
  assert.equal((await call('/admin/login', { username: 'dummy', password: 'dummy-password' })).data.error, 'login_rate_limited');
  assert.equal(state.calls.length, before);
});

test('disconnect deletes the saved session and pending MFA', async t => {
  const { call, connect, evict } = await fixture(t);
  await connect();
  assert.equal((await call('/admin/disconnect', {})).data.status, 'disconnected');
  await evict();
  assert.equal((await call('/admin/status')).data.connected, false);
  assert.equal((await call('/activities', undefined, ACTION)).status, 409);
});

test('session data is not stored as plaintext on disk', async t => {
  const { connect, path, evict } = await fixture(t);
  await connect();
  await evict();
  let files = 0;
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await inspect(join(dir, entry.name));
      else {
        const bytes = await readFile(join(dir, entry.name));
        assert.equal(bytes.includes(Buffer.from(SESSION.di_token)), false, 'Access token must be encrypted');
        assert.equal(bytes.includes(Buffer.from(SESSION.di_refresh_token)), false, 'Refresh token must be encrypted');
        files++;
      }
    }
  }
  await inspect(path);
  assert.ok(files > 0, 'The persistence check must inspect actual files');
});

test('session and token rotation survive a full runtime restart', async t => {
  const { call, connect, restart, state } = await fixture(t);
  await connect();
  state.unauthorized = true;
  assert.equal((await call('/activities', undefined, ACTION)).status, 200);
  assert.equal(state.refreshes, 1);
  await restart();
  assert.equal((await call('/activities', undefined, ACTION)).status, 200);
  assert.equal(state.refreshes, 1);
});

test('invalid MFA attempts are limited and do not replace the active session', async t => {
  const { call, connect, state } = await fixture(t, { badCode: true });
  await connect();
  assert.equal((await call('/admin/login', { username: 'dummy', password: 'dummy-password' })).data.status, 'mfa_required');
  for (let i = 0; i < 5; i++) assert.equal((await call('/admin/mfa', { code: '123456' })).status, 401);
  const count = state.calls.length;
  assert.equal((await call('/admin/mfa', { code: '123456' })).data.error, 'mfa_attempt_limit');
  assert.equal(state.calls.length, count);
  assert.equal((await call('/activities', undefined, ACTION)).status, 200);
});

test('missing MFA challenge never sends a code to Garmin', async t => {
  const { call, state } = await fixture(t);
  assert.equal((await call('/admin/mfa', { code: '123456' })).data.error, 'mfa_expired');
  assert.equal(state.calls.length, 0);
});

test('oversized section is explicitly omitted rather than silently truncated', async t => {
  const { call, connect } = await fixture(t, { hugeSplits: true });
  await connect();
  const { data } = await call('/activities/123/sections/splits', undefined, ACTION);
  assert.equal(data.status, 'omitted');
  assert.equal(data.reason, 'response_budget_exceeded');
});

test('CAPTCHA stops login without disabling protection or saving a session', async t => {
  const { call } = await fixture(t, { captcha: true });
  assert.equal((await call('/admin/login', { username: 'dummy', password: 'dummy-password' })).data.error, 'garmin_captcha_required');
  assert.equal((await call('/admin/status')).data.connected, false);
});

test('upstream errors are sanitized', async t => {
  const { call, connect, state } = await fixture(t);
  await connect();
  state.networkError = true;
  const result = await call('/activities', undefined, ACTION);
  assert.equal(result.status, 502);
  assert.equal(result.data.error, 'garmin_http_500');
  assert.ok(!JSON.stringify(result.data).includes('dummy-private-upstream-error'));
});

test('data routes reject write operations', async t => {
  const { call, connect, state } = await fixture(t);
  await connect();
  const before = state.calls.length;
  assert.equal((await call('/activities/123/analysis', {}, ACTION)).status, 405);
  assert.equal(state.calls.length, before);
});
