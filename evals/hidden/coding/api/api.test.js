import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUser, NotFoundError, ApiError } from '../src/api.js';

const fake = (status, body) => async (url) => ({
  status, ok: status >= 200 && status < 300, url,
  json: async () => body, text: async () => JSON.stringify(body),
});

test('200 returns the user', async () => assert.deepEqual(await fetchUser('7', fake(200, { id: 7 })), { id: 7 }));
test('201 is also success', async () => assert.deepEqual(await fetchUser('7', fake(201, { id: 7 })), { id: 7 }));
test('404 throws NotFoundError', async () => assert.rejects(fetchUser('9', fake(404, { error: 'nope' })), NotFoundError));
test('500 throws ApiError with the status', async () => {
  await assert.rejects(fetchUser('9', fake(500, { error: 'boom' })), (e) => e instanceof ApiError && e.status === 500);
});
test('403 throws ApiError, not NotFoundError', async () => {
  await assert.rejects(fetchUser('9', fake(403, {})), (e) => e instanceof ApiError && !(e instanceof NotFoundError) && e.status === 403);
});
test('the id is URL-encoded', async () => {
  let seen;
  await fetchUser('a/b', async (url) => { seen = url; return fake(200, {})(url); });
  assert.match(seen, /users\/a%2Fb$/);
});
