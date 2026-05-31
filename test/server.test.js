// test/server.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { encryptConfig } = require('../src/config.js');
const { deriveUserKey } = require('../src/config.js');

const KEY = 'a'.repeat(64);
process.env.CIPHER_KEY = KEY;

const app = require('../src/server.js');

function validToken(overrides = {}) {
  const access_token = 'test_access_token';
  return encryptConfig({
    v: 1,
    client_id: 'test_client',
    client_secret: 'test_secret',
    access_token,
    refresh_token: 'test_refresh',
    expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000,
    user_key: deriveUserKey(access_token),
    ...overrides,
  });
}

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(typeof res.body.uptime_s === 'number');
});

test('GET / serves onboarding page HTML', async () => {
  const res = await request(app).get('/');
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/html'));
  assert.ok(res.text.includes('Waypoint'));
});

test('GET /:config/manifest.json with valid config returns manifest', async () => {
  const res = await request(app).get(`/${validToken()}/manifest.json`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.id, 'io.github.waypoint-stremio');
  assert.ok(Array.isArray(res.body.catalogs));
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
});

test('configured manifest is installable (NOT configurationRequired)', async () => {
  const res = await request(app).get(`/${validToken()}/manifest.json`);
  // A token-bearing manifest is already configured — Stremio must show "Install",
  // which means configurationRequired must be absent/false.
  assert.notStrictEqual(res.body.behaviorHints?.configurationRequired, true);
});

test('GET /:config/configure serves the onboarding page (Configure gear works)', async () => {
  const res = await request(app).get(`/${validToken()}/configure`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/html'));
  assert.ok(res.text.includes('Waypoint'));
});

test('GET /configure serves the onboarding page', async () => {
  const res = await request(app).get('/configure');
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes('Waypoint'));
});

test('GET /:config/manifest.json with invalid chars returns 400', async () => {
  const res = await request(app).get('/invalid!!config/manifest.json');
  assert.strictEqual(res.status, 400);
});

test('GET /:config/manifest.json with expired token returns 400', async () => {
  const token = validToken({ expires_at: Date.now() - 1000 });
  const res = await request(app).get(`/${token}/manifest.json`);
  assert.strictEqual(res.status, 400);
});

test('GET /:config/catalog with invalid type returns 400', async () => {
  const res = await request(app).get(`/${validToken()}/catalog/badtype/waypoint-cw-movies.json`);
  assert.strictEqual(res.status, 400);
});

test('GET /:config/catalog with invalid catalogId returns 400', async () => {
  const res = await request(app).get(`/${validToken()}/catalog/movie/unknown-catalog.json`);
  assert.strictEqual(res.status, 400);
});

test('GET /:config/meta with invalid imdb id returns 400', async () => {
  const res = await request(app).get(`/${validToken()}/meta/movie/notanid.json`);
  assert.strictEqual(res.status, 400);
});

test('OPTIONS /:config/* returns 204 with CORS headers', async () => {
  const res = await request(app).options(`/${validToken()}/manifest.json`);
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
});

test('POST /api/oauth/start with malformed JSON returns 400 JSON (not HTML)', async () => {
  const res = await request(app)
    .post('/api/oauth/start')
    .set('Content-Type', 'application/json')
    .send('{ this is not valid json');
  assert.strictEqual(res.status, 400);
  assert.ok(res.headers['content-type'].includes('application/json'),
    'error handler must return JSON, not Express default HTML');
  assert.ok(res.body.error);
});

test('POST /api/oauth/start with missing fields returns 400', async () => {
  const res = await request(app).post('/api/oauth/start').send({ client_id: 'x' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'missing fields');
});
