import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageDeduper } from '../src/message-dedupe.js';

test('remembers a message id and reports duplicates during ttl', () => {
  const deduper = createMessageDeduper({ ttlMs: 1000, maxEntries: 10 });

  assert.deepEqual(deduper.checkAndRemember('msg1', 1000), {
    duplicate: false,
    remembered: true,
    key: 'msg1',
    expiresAt: 2000,
    enabled: true
  });
  assert.equal(deduper.checkAndRemember('msg1', 1500).duplicate, true);
});

test('allows the same message id after ttl expires', () => {
  const deduper = createMessageDeduper({ ttlMs: 1000, maxEntries: 10 });

  assert.equal(deduper.checkAndRemember('msg1', 1000).duplicate, false);
  assert.equal(deduper.checkAndRemember('msg1', 2500).duplicate, false);
});

test('ignores missing message ids without blocking', () => {
  const deduper = createMessageDeduper({ ttlMs: 1000, maxEntries: 10 });

  assert.equal(deduper.checkAndRemember('', 1000).duplicate, false);
  assert.equal(deduper.checkAndRemember('', 1000).remembered, false);
});

test('caps remembered entries', () => {
  const deduper = createMessageDeduper({ ttlMs: 1000, maxEntries: 2 });

  deduper.checkAndRemember('msg1', 1000);
  deduper.checkAndRemember('msg2', 1000);
  deduper.checkAndRemember('msg3', 1000);

  assert.equal(deduper.size(1000), 2);
  assert.equal(deduper.checkAndRemember('msg1', 1000).duplicate, false);
});
