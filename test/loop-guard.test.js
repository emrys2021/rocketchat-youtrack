import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopGuard } from '../src/loop-guard.js';

test('blocks repeated messages in the same room after the configured threshold', () => {
  const guard = createLoopGuard({ windowMs: 60000, maxEvents: 2 });

  assert.equal(guard.record({ roomId: 'dm-room' }).blocked, false);
  assert.equal(guard.record({ roomId: 'dm-room' }).blocked, false);
  assert.equal(guard.record({ roomId: 'dm-room' }).blocked, true);
});

test('tracks rooms independently', () => {
  const guard = createLoopGuard({ windowMs: 60000, maxEvents: 1 });

  assert.equal(guard.record({ roomId: 'dm-room-1' }).blocked, false);
  assert.equal(guard.record({ roomId: 'dm-room-2' }).blocked, false);
  assert.equal(guard.record({ roomId: 'dm-room-1' }).blocked, true);
});
