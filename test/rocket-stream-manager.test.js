import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageDeduper } from '../src/message-dedupe.js';
import { createRocketStreamManager } from '../src/rocket-stream-manager.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRealtimeStub() {
  const calls = [];
  return {
    calls,
    subscribeToMessages() {
      calls.push(['messages']);
      return true;
    },
    subscribeToNotifications(userId) {
      calls.push(['notification', userId]);
      return true;
    },
    subscribeToNotificationProbe(userId) {
      calls.push(['notification_probe', userId]);
      return true;
    }
  };
}

test('stream manager subscribes according to configured mode', () => {
  const autoRealtime = createRealtimeStub();
  const auto = createRocketStreamManager({
    realtime: autoRealtime,
    mode: 'auto',
    messageDeduper: createMessageDeduper(),
    log: () => {}
  });
  assert.equal(auto.subscribe('bot-id'), 'notification_probe');
  assert.deepEqual(autoRealtime.calls, [['notification_probe', 'bot-id']]);

  const notificationRealtime = createRealtimeStub();
  const notification = createRocketStreamManager({
    realtime: notificationRealtime,
    mode: 'notification',
    messageDeduper: createMessageDeduper(),
    log: () => {}
  });
  assert.equal(notification.subscribe('bot-id'), 'notification');
  assert.deepEqual(notificationRealtime.calls, [['notification', 'bot-id']]);

  const messagesRealtime = createRealtimeStub();
  const messages = createRocketStreamManager({
    realtime: messagesRealtime,
    mode: 'my_messages',
    messageDeduper: createMessageDeduper(),
    log: () => {}
  });
  assert.equal(messages.subscribe('bot-id'), 'my_messages');
  assert.deepEqual(messagesRealtime.calls, [['messages']]);
});

test('auto mode falls back to __my_messages__ when notification misses a responsive room change', async () => {
  const realtime = createRealtimeStub();
  const deduper = createMessageDeduper({ ttlMs: 60000, maxEntries: 100 });
  let fallbackEvent = null;
  const manager = createRocketStreamManager({
    realtime,
    mode: 'auto',
    notificationFallbackMs: 5,
    messageDeduper: deduper,
    evaluateProbe: async (event) => ({ accepted: true, messageKey: event.messageId }),
    handleFallbackMessage: (event) => {
      fallbackEvent = event;
    },
    log: () => {}
  });

  manager.subscribe('bot-id');
  await manager.handleRoomChanged({ roomId: 'dm-room', messageId: 'm1', userName: 'alice', text: 'hello' });
  await wait(30);

  assert.equal(manager.getActiveMode(), 'my_messages');
  assert.deepEqual(realtime.calls, [['notification_probe', 'bot-id'], ['messages']]);
  assert.equal(fallbackEvent.source, 'rooms_changed_fallback');
  assert.equal(fallbackEvent.messageId, 'm1');
});

test('auto mode does not fall back when the message was already processed', async () => {
  const realtime = createRealtimeStub();
  const deduper = createMessageDeduper({ ttlMs: 60000, maxEntries: 100 });
  deduper.checkAndRemember('m1');
  let fallbackCalled = false;
  const manager = createRocketStreamManager({
    realtime,
    mode: 'auto',
    notificationFallbackMs: 5,
    messageDeduper: deduper,
    evaluateProbe: async (event) => ({ accepted: true, messageKey: event.messageId }),
    handleFallbackMessage: () => {
      fallbackCalled = true;
    },
    log: () => {}
  });

  manager.subscribe('bot-id');
  await manager.handleRoomChanged({ roomId: 'dm-room', messageId: 'm1', userName: 'alice', text: 'hello' });
  await wait(30);

  assert.equal(manager.getActiveMode(), 'notification_probe');
  assert.deepEqual(realtime.calls, [['notification_probe', 'bot-id']]);
  assert.equal(fallbackCalled, false);
});

test('stream manager reset clears pending fallback timers', async () => {
  const realtime = createRealtimeStub();
  let fallbackCalled = false;
  const manager = createRocketStreamManager({
    realtime,
    mode: 'auto',
    notificationFallbackMs: 10,
    messageDeduper: createMessageDeduper({ ttlMs: 60000, maxEntries: 100 }),
    evaluateProbe: async (event) => ({ accepted: true, messageKey: event.messageId }),
    handleFallbackMessage: () => {
      fallbackCalled = true;
    },
    log: () => {}
  });

  manager.subscribe('bot-id');
  await manager.handleRoomChanged({ roomId: 'dm-room', messageId: 'm1', userName: 'alice', text: 'hello' });
  manager.reset();
  await wait(30);

  assert.equal(manager.getActiveMode(), '');
  assert.equal(fallbackCalled, false);
});
test('fallback message clears probe room classification fields', async () => {
  const realtime = createRealtimeStub();
  let fallbackEvent = null;
  const manager = createRocketStreamManager({
    realtime,
    mode: 'auto',
    notificationFallbackMs: 5,
    messageDeduper: createMessageDeduper({ ttlMs: 60000, maxEntries: 100 }),
    evaluateProbe: async (event) => {
      event.isDirect = false;
      event.roomType = '';
      return { accepted: true, messageKey: event.messageId, event };
    },
    handleFallbackMessage: (event) => {
      fallbackEvent = event;
    },
    log: () => {}
  });

  manager.subscribe('bot-id');
  await manager.handleRoomChanged({
    roomId: 'dm-room',
    messageId: 'm-clean',
    userName: 'alice',
    text: 'hello',
    isDirect: false,
    roomType: ''
  });
  await wait(30);

  assert.ok(fallbackEvent);
  assert.equal(Object.hasOwn(fallbackEvent, 'isDirect'), false);
  assert.equal(Object.hasOwn(fallbackEvent, 'roomType'), false);
  assert.equal(fallbackEvent.source, 'rooms_changed_fallback');
});
