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
  assert.equal(event.roomType, 'd');
  assert.equal(event.isDirect, true);
  assert.equal(event.isSystem, false);
  assert.equal(event.isAutoReply, false);
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

test('marks direct message auto-replies', () => {
  const event = parseNotification({
    payload: {
      _id: 'msg3',
      rid: 'roomDM',
      type: 'd',
      sender: { _id: 'u3', username: 'alice' },
      message: { msg: 'Hey, I received your message and will get back to you as soon as possible.' }
    }
  });

  assert.ok(event);
  assert.equal(event.isDirect, true);
  assert.equal(event.isAutoReply, true);
});

test('marks Rocket.Chat system messages without treating direct rooms as system messages', () => {
  const event = parseNotification({
    payload: {
      _id: 'msg4',
      rid: 'roomCh',
      type: 'c',
      t: 'uj',
      sender: { _id: 'u4', username: 'alice' },
      message: { msg: 'alice joined' }
    }
  });

  assert.ok(event);
  assert.equal(event.isDirect, false);
  assert.equal(event.messageType, 'uj');
  assert.equal(event.isSystem, true);
});

test('returns null when room or text is missing', () => {
  assert.equal(parseNotification(null), null);
  assert.equal(parseNotification({ payload: { rid: 'r', message: {} } }), null);
  assert.equal(parseNotification({ payload: { message: { msg: 'hi' } } }), null);
});
