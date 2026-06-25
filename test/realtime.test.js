import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotification } from '../src/rocket-realtime.js';

test('parses a direct message notification', () => {
  const event = parseNotification({
    title: 'alice',
    text: 'NullPointerException in SyncJob',
    payload: {
      _id: 'msg1',
      rid: 'roomDM',
      type: 'd',
      sender: { _id: 'u1', username: 'alice' },
      message: { msg: 'NullPointerException in SyncJob' }
    }
  });

  assert.ok(event);
  assert.equal(event.roomId, 'roomDM');
  assert.equal(event.messageId, 'msg1');
  assert.equal(event.text, 'NullPointerException in SyncJob');
  assert.equal(event.senderId, 'u1');
  assert.equal(event.userName, 'alice');
  assert.equal(event.isDirect, true);
});

test('parses a channel mention notification as non-direct', () => {
  const event = parseNotification({
    payload: {
      _id: 'msg2',
      rid: 'roomCh',
      type: 'c',
      sender: { _id: 'u2', username: 'bob' },
      message: { msg: '@youtrack-bot 帮我查一下' }
    }
  });

  assert.ok(event);
  assert.equal(event.isDirect, false);
  assert.equal(event.text, '@youtrack-bot 帮我查一下');
});

test('returns null when room or text is missing', () => {
  assert.equal(parseNotification(null), null);
  assert.equal(parseNotification({ payload: { rid: 'r', message: {} } }), null);
  assert.equal(parseNotification({ payload: { message: { msg: 'hi' } } }), null);
});
