import test from 'node:test';
import assert from 'node:assert/strict';
import { RocketClient } from '../src/rocket.js';

/**
 * getRoomType 缓存行为测试。
 *
 * 用 monkey-patch 全局 fetch 来计数 rooms.info 请求次数，验证：
 *   - 成功结果永久缓存：同一房间第二次不再发请求
 *   - 失败结果走负缓存：TTL 内不再重发请求（抑制 REST 放大）
 *   - 缓存超过上限时按 FIFO 淘汰最早条目
 */

function makeClient(overrides = {}) {
  return new RocketClient({
    url: 'http://rocket.test',
    userId: 'bot',
    authToken: 'token',
    ...overrides
  });
}

function withFakeFetch(handler, run) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    return handler(url, options);
  };
  return Promise.resolve()
    .then(() => run(() => calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body)
  };
}

test('caches a successful room type and does not re-request', async () => {
  const client = makeClient();
  await withFakeFetch(
    () => jsonResponse({ room: { t: 'd' } }),
    async (getCalls) => {
      assert.equal(await client.getRoomType('roomA'), 'd');
      assert.equal(await client.getRoomType('roomA'), 'd');
      assert.equal(getCalls(), 1, '成功结果应永久缓存，只发一次请求');
    }
  );
});

test('negative-caches a failed lookup within the TTL window', async () => {
  const client = makeClient({ roomTypeNegativeTtlMs: 60000 });
  await withFakeFetch(
    () => jsonResponse({ error: 'forbidden' }, false, 403),
    async (getCalls) => {
      // 第一次失败抛错并写负缓存。
      await assert.rejects(() => client.getRoomType('roomB'));
      // TTL 内第二次直接命中负缓存，返回空串，不再发请求。
      assert.equal(await client.getRoomType('roomB'), '');
      assert.equal(getCalls(), 1, '失败应负缓存，TTL 内不重发请求');
    }
  );
});

test('re-requests after the negative cache TTL expires', async () => {
  const client = makeClient({ roomTypeNegativeTtlMs: 1 });
  await withFakeFetch(
    () => jsonResponse({ room: { t: 'c' } }),
    async (getCalls) => {
      // 先手动塞一条已过期的负缓存。
      client._setRoomTypeCache('roomC', '', 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(await client.getRoomType('roomC'), 'c', '负缓存过期后应重新查询');
      assert.equal(getCalls(), 1);
    }
  );
});

test('evicts the oldest entry when exceeding the cache limit', async () => {
  const client = makeClient({ roomTypeCacheMax: 2 });
  client._setRoomTypeCache('r1', 'c', 0);
  client._setRoomTypeCache('r2', 'c', 0);
  client._setRoomTypeCache('r3', 'c', 0); // 超过上限，应淘汰最早的 r1

  assert.equal(client._roomTypeCache.has('r1'), false, '最早条目应被淘汰');
  assert.equal(client._roomTypeCache.has('r2'), true);
  assert.equal(client._roomTypeCache.has('r3'), true);
  assert.equal(client._roomTypeCache.size, 2);
});
