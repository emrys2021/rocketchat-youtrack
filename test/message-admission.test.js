import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopGuard } from '../src/loop-guard.js';
import { createMessageDeduper } from '../src/message-dedupe.js';
import { createMessageAdmission, getMessageKey, stripMention } from '../src/message-admission.js';

function createAdmission(options = {}) {
  return createMessageAdmission({
    deduper: createMessageDeduper({ ttlMs: 60000, maxEntries: 100 }),
    loopGuard: createLoopGuard({ windowMs: 60000, maxEvents: 10 }),
    ignoreAutoReplies: true,
    ...options
  });
}

test('webhook admission ignores messages that should not enter the agent', () => {
  const admission = createAdmission();

  assert.equal(admission.evaluateWebhookMessage({ text: '' }).reason, 'empty_text');
  assert.equal(admission.evaluateWebhookMessage({ text: 'hello', isBot: true }).reason, 'bot_message');
  assert.equal(admission.evaluateWebhookMessage({ text: 'joined', isSystem: true }).reason, 'system_message');
  assert.equal(admission.evaluateWebhookMessage({
    text: 'Hey, I received your message and will get back to you as soon as possible.',
    isAutoReply: true
  }).reason, 'auto_reply');
});

test('webhook admission dedupes and trips loop guard', () => {
  const admission = createMessageAdmission({
    deduper: createMessageDeduper({ ttlMs: 60000, maxEntries: 100 }),
    loopGuard: createLoopGuard({ windowMs: 60000, maxEvents: 1 }),
    ignoreAutoReplies: true
  });

  assert.equal(admission.evaluateWebhookMessage({ text: 'one', roomId: 'r1', messageId: 'm1' }).accepted, true);
  assert.equal(admission.evaluateWebhookMessage({ text: 'one again', roomId: 'r1', messageId: 'm1' }).reason, 'duplicate_message');
  assert.equal(admission.evaluateWebhookMessage({ text: 'two', roomId: 'r1', messageId: 'm2' }).reason, 'loop_guard');
});

test('realtime admission allows direct messages and strips channel mentions', async () => {
  const admission = createAdmission();
  let roomLookups = 0;

  const direct = await admission.evaluateRealtimeMessage({
    text: 'outlook 打不开超链接',
    roomId: 'dm-room',
    messageId: 'm1',
    senderId: 'u1',
    userName: 'alice'
  }, {
    identity: { realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' },
    mentionName: 'bot',
    resolveRoomType: async () => {
      roomLookups += 1;
      return 'd';
    }
  });

  assert.equal(direct.accepted, true);
  assert.equal(direct.question, 'outlook 打不开超链接');
  assert.equal(direct.event.isDirect, true);
  assert.equal(roomLookups, 1);

  const mentioned = await admission.evaluateRealtimeMessage({
    text: '@bot 帮我查类似 issue',
    roomId: 'channel-room',
    messageId: 'm2',
    senderId: 'u1',
    userName: 'alice',
    isDirect: false
  }, {
    identity: { realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' },
    mentionName: 'bot'
  });

  assert.equal(mentioned.accepted, true);
  assert.equal(mentioned.question, '帮我查类似 issue');
});

test('realtime admission rejects self messages and non-mentioned channel messages', async () => {
  const admission = createAdmission();
  const identity = {
    realtimeBotUserId: 'bot-id',
    restBotUserId: 'bot-id',
    configuredBotUsername: 'bot',
    restBotUsername: 'bot'
  };

  assert.equal((await admission.evaluateRealtimeMessage({
    text: 'bot reply',
    roomId: 'dm-room',
    messageId: 'm1',
    senderId: 'bot-id',
    userName: 'bot',
    isDirect: true
  }, { identity, mentionName: 'bot' })).reason, 'bot_message');

  assert.equal((await admission.evaluateRealtimeMessage({
    text: '普通频道消息',
    roomId: 'channel-room',
    messageId: 'm2',
    senderId: 'u1',
    userName: 'alice',
    isDirect: false
  }, { identity, mentionName: 'bot' })).reason, 'not_addressed');
});

test('realtime probe classifies room type without remembering dedupe keys', async () => {
  const deduper = createMessageDeduper({ ttlMs: 60000, maxEntries: 100 });
  const admission = createMessageAdmission({
    deduper,
    loopGuard: createLoopGuard({ windowMs: 60000, maxEvents: 10 }),
    ignoreAutoReplies: true
  });

  const result = await admission.evaluateRealtimeProbe({
    text: '私聊 fallback',
    roomId: 'dm-room',
    messageId: 'm1',
    senderId: 'u1',
    userName: 'alice'
  }, {
    identity: { realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' },
    mentionName: 'bot',
    resolveRoomType: async () => 'd'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.messageKey, 'm1');
  assert.equal(deduper.has('m1'), false);
});

test('message key and mention helpers normalize fallback inputs', () => {
  assert.equal(getMessageKey({ roomId: 'r1', userName: 'alice', text: 'hello' }), 'r1:alice:hello');
  assert.equal(stripMention('@bot hello @bot', '@bot').trim(), 'hello');
});
test('realtime probe treats room type lookup failure as a fallback candidate', async () => {
  const admission = createAdmission();
  let lookupFailureReported = false;

  const result = await admission.evaluateRealtimeProbe({
    text: '没有 @ 的私聊候选',
    roomId: 'unknown-room',
    messageId: 'm-probe-fail',
    senderId: 'u1',
    userName: 'alice'
  }, {
    identity: { realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' },
    mentionName: 'bot',
    resolveRoomType: async () => {
      throw new Error('rooms.info failed');
    },
    onRoomTypeLookupFailed: () => {
      lookupFailureReported = true;
    }
  });

  assert.equal(result.accepted, true);
  assert.equal(result.messageKey, 'm-probe-fail');
  assert.equal(lookupFailureReported, true);
});

test('realtime admission does not remember messages rejected after room type lookup failure', async () => {
  const deduper = createMessageDeduper({ ttlMs: 60000, maxEntries: 100 });
  const admission = createMessageAdmission({
    deduper,
    loopGuard: createLoopGuard({ windowMs: 60000, maxEvents: 10 }),
    ignoreAutoReplies: true
  });
  const identity = { realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' };

  const rejected = await admission.evaluateRealtimeMessage({
    text: '没有 @ 的私聊消息',
    roomId: 'dm-room',
    messageId: 'm-retry',
    senderId: 'u1',
    userName: 'alice'
  }, {
    identity,
    mentionName: 'bot',
    resolveRoomType: async () => {
      throw new Error('rooms.info failed');
    }
  });

  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'not_addressed');
  assert.equal(deduper.has('m-retry'), false);

  const accepted = await admission.evaluateRealtimeMessage({
    text: '没有 @ 的私聊消息',
    roomId: 'dm-room',
    messageId: 'm-retry',
    senderId: 'u1',
    userName: 'alice'
  }, {
    identity,
    mentionName: 'bot',
    resolveRoomType: async () => 'd'
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.question, '没有 @ 的私聊消息');
  assert.equal(deduper.has('m-retry'), true);
});
