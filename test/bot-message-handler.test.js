import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotMessageHandler } from '../src/bot-message-handler.js';

function createLog() {
  const entries = [];
  const log = (level, message, meta) => entries.push({ level, message, meta });
  log.entries = entries;
  return log;
}

test('bot message handler answers accepted channel messages in thread', async () => {
  const posts = [];
  const log = createLog();
  const handler = createBotMessageHandler({
    agent: {
      answer: async (question, context) => {
        assert.equal(question, '查一下类似 issue');
        assert.deepEqual(context, { userName: 'alice', roomId: 'channel-room' });
        return '这里是答案';
      }
    },
    rocketClient: {
      postMessage: async (message) => posts.push(message)
    },
    messageAdmission: {
      evaluateRealtimeMessage: async (event, options) => {
        assert.equal(options.identity.realtimeBotUserId, 'bot-id');
        assert.equal(options.mentionName, 'bot');
        return { accepted: true, question: '查一下类似 issue', event };
      }
    },
    identityManager: {
      getIdentity: () => ({ realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' }),
      getMentionName: () => 'bot'
    },
    rocketConfig: { postProgress: true, replyInThread: true },
    getActiveMessageStreamMode: () => 'notification_probe',
    resolveRoomType: async () => 'c',
    onRoomTypeLookupFailed: () => {},
    log
  });

  await handler.handleIncoming({
    roomId: 'channel-room',
    messageId: 'm1',
    userName: 'alice',
    isDirect: false
  });

  assert.equal(posts.length, 2);
  assert.equal(posts[0].text, '收到，正在处理，请稍候…');
  assert.equal(posts[0].threadId, 'm1');
  assert.equal(posts[0].replyInThread, true);
  assert.equal(posts[1].text, '这里是答案');
  assert.equal(posts[1].threadId, 'm1');
  assert.equal(log.entries[0].message, 'bot_question_received');
  assert.equal(Object.hasOwn(log.entries[0].meta, 'questionPreview'), false);
});

test('bot message handler does not thread direct message replies', async () => {
  const posts = [];
  const handler = createBotMessageHandler({
    agent: { answer: async () => 'direct answer' },
    rocketClient: { postMessage: async (message) => posts.push(message) },
    messageAdmission: { evaluateRealtimeMessage: async () => ({ accepted: true, question: 'hello' }) },
    identityManager: {
      getIdentity: () => ({ realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' }),
      getMentionName: () => 'bot'
    },
    rocketConfig: { postProgress: false, replyInThread: true },
    getActiveMessageStreamMode: () => 'my_messages',
    resolveRoomType: async () => 'd',
    onRoomTypeLookupFailed: () => {},
    log: () => {}
  });

  await handler.handleIncoming({ roomId: 'dm-room', messageId: 'm2', userName: 'alice', isDirect: true });

  assert.deepEqual(posts, [{ roomId: 'dm-room', threadId: 'm2', replyInThread: false, text: 'direct answer' }]);
});

test('bot message handler logs rejected messages without posting', async () => {
  const posts = [];
  const log = createLog();
  const handler = createBotMessageHandler({
    agent: { answer: async () => 'should not run' },
    rocketClient: { postMessage: async (message) => posts.push(message) },
    messageAdmission: { evaluateRealtimeMessage: async () => ({ accepted: false, category: 'ignore', reason: 'bot_message' }) },
    identityManager: {
      getIdentity: () => ({ realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' }),
      getMentionName: () => 'bot'
    },
    rocketConfig: { postProgress: true, replyInThread: true },
    getActiveMessageStreamMode: () => 'my_messages',
    resolveRoomType: async () => 'd',
    onRoomTypeLookupFailed: () => {},
    log
  });

  await handler.handleIncoming({ roomId: 'dm-room', messageId: 'm3', userName: 'bot', isDirect: true });

  assert.deepEqual(posts, []);
  assert.equal(log.entries[0].message, 'bot_message_ignored');
  assert.equal(log.entries[0].meta.reason, 'bot_message');
});
test('bot message handler uses normalized admission event for reply context', async () => {
  const posts = [];
  const log = createLog();
  const handler = createBotMessageHandler({
    agent: {
      answer: async (_question, context) => {
        assert.deepEqual(context, { userName: 'alice', roomId: 'dm-normalized' });
        return 'normalized answer';
      }
    },
    rocketClient: { postMessage: async (message) => posts.push(message) },
    messageAdmission: {
      evaluateRealtimeMessage: async () => ({
        accepted: true,
        question: 'hello',
        event: {
          roomId: 'dm-normalized',
          messageId: 'm-normalized',
          userName: 'alice',
          isDirect: true,
          source: 'room_messages'
        }
      })
    },
    identityManager: {
      getIdentity: () => ({ realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' }),
      getMentionName: () => 'bot'
    },
    rocketConfig: { postProgress: false, replyInThread: true },
    getActiveMessageStreamMode: () => 'my_messages',
    resolveRoomType: async () => 'd',
    onRoomTypeLookupFailed: () => {},
    log
  });

  await handler.handleIncoming({ roomId: 'raw-room', messageId: 'raw-message', userName: 'raw-user', isDirect: false });

  assert.deepEqual(posts, [{
    roomId: 'dm-normalized',
    threadId: 'm-normalized',
    replyInThread: false,
    text: 'normalized answer'
  }]);
  assert.equal(log.entries[0].meta.roomId, 'dm-normalized');
  assert.equal(log.entries[0].meta.isDirect, true);
});

test('bot message handler logs question preview only when enabled', async () => {
  const log = createLog();
  const handler = createBotMessageHandler({
    agent: { answer: async () => 'answer' },
    rocketClient: { postMessage: async () => {} },
    messageAdmission: {
      evaluateRealtimeMessage: async () => ({
        accepted: true,
        question: '请查 token: secret-value 的类似 issue',
        event: { roomId: 'dm-room', messageId: 'm-preview', userName: 'alice', isDirect: true }
      })
    },
    identityManager: {
      getIdentity: () => ({ realtimeBotUserId: 'bot-id', restBotUserId: 'bot-id', configuredBotUsername: 'bot', restBotUsername: 'bot' }),
      getMentionName: () => 'bot'
    },
    rocketConfig: { postProgress: false, replyInThread: true },
    loggingConfig: { logUserQuestion: true, logUserQuestionMaxChars: 20 },
    getActiveMessageStreamMode: () => 'my_messages',
    resolveRoomType: async () => 'd',
    onRoomTypeLookupFailed: () => {},
    log
  });

  await handler.handleIncoming({ roomId: 'dm-room', messageId: 'm-preview', userName: 'alice', isDirect: true });

  assert.equal(log.entries[0].message, 'bot_question_received');
  assert.match(log.entries[0].meta.questionPreview, /token: \[redacted\]/);
  assert.equal(log.entries[0].meta.questionPreview.includes('secret-value'), false);
});
