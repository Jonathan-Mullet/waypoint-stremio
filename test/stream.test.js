const { test } = require('node:test');
const assert = require('node:assert');
const { buildResumeStream } = require('../src/stream.js');

const TOKENS = { user_key: 's1', client_id: 'c', access_token: 't' };

test('movie in progress → one resume stream with timestamp', async () => {
  const r = await buildResumeStream(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [{ type: 'movie', imdb: 'tt0816692', progress: 45 }],
    _getRuntimeMinutes: async () => 169,
  });
  assert.strictEqual(r.streams.length, 1);
  assert.ok(r.streams[0].title.includes('Resume at ~'));
  assert.ok(r.streams[0].title.includes('45%'));
});

test('episode in progress → matched by season+episode', async () => {
  const r = await buildResumeStream(TOKENS, 'series', 'tt0903747:2:5', {
    _getPlayback: async () => [{ type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 60 }],
    _getRuntimeMinutes: async () => 47,
  });
  assert.strictEqual(r.streams.length, 1);
  assert.ok(r.streams[0].title.includes('60%'));
});

test('wrong episode → no stream', async () => {
  const r = await buildResumeStream(TOKENS, 'series', 'tt0903747:1:1', {
    _getPlayback: async () => [{ type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 60 }],
    _getRuntimeMinutes: async () => 47,
  });
  assert.strictEqual(r.streams.length, 0);
});

test('title not in progress → no stream', async () => {
  const r = await buildResumeStream(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [],
    _getRuntimeMinutes: async () => 169,
  });
  assert.strictEqual(r.streams.length, 0);
});

test('progress 0 → no stream (nothing to resume)', async () => {
  const r = await buildResumeStream(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [{ type: 'movie', imdb: 'tt0816692', progress: 0 }],
    _getRuntimeMinutes: async () => 169,
  });
  assert.strictEqual(r.streams.length, 0);
});

test('runtime unavailable → percent-only title, still one stream', async () => {
  const r = await buildResumeStream(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [{ type: 'movie', imdb: 'tt0816692', progress: 45 }],
    _getRuntimeMinutes: async () => null,
  });
  assert.strictEqual(r.streams.length, 1);
  assert.ok(r.streams[0].title.includes('45%'));
  assert.ok(!r.streams[0].title.includes('Resume at ~'));
});

test('Trakt failure → no stream (graceful)', async () => {
  const r = await buildResumeStream(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => { throw new Error('network'); },
    _getRuntimeMinutes: async () => 169,
  });
  assert.strictEqual(r.streams.length, 0);
});
