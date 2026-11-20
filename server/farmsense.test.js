import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import irrigationHandler from '../api/irrigation/remote.js';
import { fetchSensorLatest, normalizeSensorPayload } from './apiUtils.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; return this; }, end(body) { this.body = JSON.parse(body); } };
}

test('zero-valued readings remain valid; stale telemetry remains unavailable', () => {
  assert.equal(normalizeSensorPayload({ moisture: 0, air_temperature: 0 }).available, true);
  const stale = normalizeSensorPayload({ available: false, moisture: 30, device_online: false, message: 'Arduino telemetry is stale' });
  assert.equal(stale.available, false);
  assert.equal(stale.device_online, false);
  assert.match(stale.message, /stale/);
});

test('sensor proxy authenticates with server key and does not fabricate failures', async () => {
  process.env.FARMSENSE_API_KEY = 'private-backend-key';
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer private-backend-key');
    return Response.json({ available: true, moisture: 25, humidity: 70 });
  };
  assert.equal((await fetchSensorLatest()).humidity, 70);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await fetchSensorLatest()).available, false);
});

test('public irrigation route refuses missing keys before calling backend', async () => {
  process.env.IRRIGATION_CONTROL_KEY = 'operator-key-123456789';
  globalThis.fetch = () => { throw new Error('Unauthorized request reached backend'); };
  const res = response();
  await irrigationHandler({ method: 'POST', headers: {}, body: { mode: 'remote_on', duration_seconds: 60 } }, res);
  assert.equal(res.statusCode, 401);
});

test('missing server operator-key configuration disables commands', async () => {
  delete process.env.IRRIGATION_CONTROL_KEY;
  const res = response();
  await irrigationHandler({ method: 'POST', headers: {}, body: { mode: 'off' } }, res);
  assert.equal(res.statusCode, 503);
});

test('commands validate duration and reject the old truthy-string boolean payload', async () => {
  process.env.IRRIGATION_CONTROL_KEY = 'operator-key-123456789';
  for (const body of [{ enabled: 'false' }, { mode: 'remote_on', duration_seconds: 301 }]) {
    const res = response();
    await irrigationHandler({ method: 'POST', headers: { authorization: 'Bearer operator-key-123456789' }, body }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('remote start is acknowledged as pending, not as actual pump activation', async () => {
  process.env.IRRIGATION_CONTROL_KEY = 'operator-key-123456789';
  process.env.FARMSENSE_API_KEY = 'different-private-backend-key';
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer different-private-backend-key');
    assert.deepEqual(JSON.parse(options.body), { mode: 'remote_on', duration_seconds: 60 });
    return Response.json({ mode: 'remote_on', pending: true, applied: false,
      device_online: true, actual_irrigation_active: false }, { status: 202 });
  };
  const res = response();
  await irrigationHandler({ method: 'POST', headers: { authorization: 'Bearer operator-key-123456789' },
    body: { mode: 'remote_on', duration_seconds: 60 } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.pending, true);
  assert.equal(res.body.actual_irrigation_active, false);
});

test('offline start rejection propagates and failed commands never report success', async () => {
  process.env.IRRIGATION_CONTROL_KEY = 'operator-key-123456789';
  for (const status of [409, 500]) {
    globalThis.fetch = async () => Response.json({ detail: 'Arduino is offline' }, { status });
    const res = response();
    await irrigationHandler({ method: 'POST', headers: { authorization: 'Bearer operator-key-123456789' },
      body: { mode: 'remote_on', duration_seconds: 60 } }, res);
    assert.equal(res.statusCode, status === 409 ? 409 : 502);
    assert.equal(res.body.available, false);
  }
});
