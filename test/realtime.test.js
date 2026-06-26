import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotification, parseRoomMessage, parseRoomsChanged } from '../src/rocket-realtime.js';

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

test('parses a stream-room-messages message', () => {
  const event = parseRoomMessage({
    _id: 'msg5',
    rid: 'roomDM',
    msg: '私聊测试-0626-001',
    ts: { $date: 1750000000000 },
    u: { _id: 'u5', username: 'alice' }
  });

  assert.ok(event);
  assert.equal(event.roomId, 'roomDM');
  assert.equal(event.messageId, 'msg5');
  assert.equal(event.text, '私聊测试-0626-001');
  assert.equal(event.senderId, 'u5');
  assert.equal(event.userName, 'alice');
  assert.equal(event.ts, 1750000000000);
  // stream-room-messages 消息体不含房间类型，roomType 留空、isDirect 留 undefined，
  // 由上层用 rooms.info 补齐。
  assert.equal(event.roomType, '');
  assert.equal(event.isDirect, undefined);
  assert.equal(event.isSystem, false);
  assert.equal(event.isAutoReply, false);
});

test('marks stream-room-messages system messages and auto-replies', () => {
  const systemEvent = parseRoomMessage({
    _id: 'msg6',
    rid: 'roomCh',
    msg: 'alice joined',
    t: 'uj',
    u: { _id: 'u6', username: 'alice' }
  });
  assert.ok(systemEvent);
  assert.equal(systemEvent.messageType, 'uj');
  assert.equal(systemEvent.isSystem, true);

  const autoReply = parseRoomMessage({
    _id: 'msg7',
    rid: 'roomDM',
    msg: 'Hey, I received your message and will get back to you as soon as possible.',
    u: { _id: 'u7', username: 'alice' }
  });
  assert.ok(autoReply);
  assert.equal(autoReply.isAutoReply, true);
});

test('returns null when stream-room-messages room or text is missing', () => {
  assert.equal(parseRoomMessage(null), null);
  assert.equal(parseRoomMessage({ rid: 'roomDM', msg: '' }), null);
  assert.equal(parseRoomMessage({ msg: 'hi', u: { _id: 'u8' } }), null);
});

test('parses rooms-changed lastMessage as a fallback candidate', () => {
  const event = parseRoomsChanged([
    'updated',
    {
      _id: 'roomDM',
      t: 'd',
      lastMessage: {
        _id: 'msg8',
        rid: 'roomDM',
        msg: '私聊 fallback 测试',
        u: { _id: 'u8', username: 'alice' }
      }
    }
  ]);

  assert.ok(event);
  assert.equal(event.roomId, 'roomDM');
  assert.equal(event.messageId, 'msg8');
  assert.equal(event.text, '私聊 fallback 测试');
  assert.equal(event.roomType, 'd');
  assert.equal(event.isDirect, true);
  assert.equal(event.roomAction, 'updated');
});