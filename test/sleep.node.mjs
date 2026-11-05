import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/data.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { wellness } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const client = data => ({ session: { displayName: 'test-user' }, async get(path) {
  assert.match(path, /date=2026-11-05/);
  return data;
} });

test('large sleep response retains summary, scores and units under response budget', async () => {
  const summary = { calendarDate: '2026-11-05', sleepTimeSeconds: 28000, awakeSleepSeconds: 0,
    sleepStartTimestampGMT: 1793829600000, sleepEndTimestampGMT: 1793857600000,
    sleepScores: { overall: { value: 82, qualifierKey: 'GOOD' } },
    averageSpO2Value: null, userConfirmed: false, respirationUnit: 'breaths/min' };
  const raw = { dailySleepDTO: summary, sleepMovement: Array.from({length: 3000}, (_, i) => ({ timestamp: i, activityLevel: 1 })),
    nested: { stages: [{ stage: 'deep', seconds: 100 }], note: 'retained' }, latitude: 59 };
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 85000);
  const result = await wellness(client(raw), '2026-11-05', 'sleep');
  assert.equal(result.status, 'available');
  assert.deepEqual(result.data.dailySleepDTO, summary);
  assert.equal(result.data.latitude, undefined);
  assert.equal(result.data.nested.note, 'retained');
  assert.equal(result.data.sleepMovement, undefined);
  assert.deepEqual(result.omitted_collections, [{path: 'sleepMovement', count: 3000}, {path: 'nested.stages', count: 1}]);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 85000);
  assert.equal(raw.sleepMovement.length, 3000);
});

test('empty sleep and upstream failures retain their original status', async () => {
  assert.equal((await wellness(client({}), '2026-11-05', 'sleep')).status, 'empty');
  const failed = { session: { displayName: 'test-user' }, async get() { throw Error('private upstream details'); } };
  assert.deepEqual(await wellness(failed, '2026-11-05', 'sleep'), {status: 'unavailable', reason: 'garmin_request_failed'});
});

test('HRV data is unchanged', async () => {
  const data = { hrvSummary: { lastNightAvg: 52 }, hrvReadings: [{value: 50}] };
  const fake = { session: { displayName: 'test-user' }, async get() { return data; } };
  assert.deepEqual(await wellness(fake, '2026-11-05', 'hrv'), {status: 'available', data});
});
