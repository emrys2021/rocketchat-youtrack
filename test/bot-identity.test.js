import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotIdentityManager } from '../src/bot-identity.js';

function createLog() {
  const entries = [];
  const log = (level, message, meta) => entries.push({ level, message, meta });
  log.entries = entries;
  return log;
}

test('bot identity manager confirms REST identity and uses real username for mentions', async () => {
  const log = createLog();
  const rocketClient = {
    canPost: () => true,
    setCredentials: () => {},
    getMe: async () => ({ _id: 'bot-id', username: 'real-bot' })
  };
  const manager = createBotIdentityManager({
    rocketClient,
    rocketConfig: { userId: 'bot-id', botUsername: 'configured-bot' },
    log
  });

  assert.equal(await manager.validateRestIdentity('bot-id'), true);
  assert.equal(manager.getMentionName(), 'real-bot');
  assert.deepEqual(manager.getIdentity(), {
    realtimeBotUserId: 'bot-id',
    restBotUserId: 'bot-id',
    configuredBotUsername: 'configured-bot',
    restBotUsername: 'real-bot'
  });
  assert.equal(log.entries.at(-1).message, 'bot_rest_identity_checked');
  assert.equal(log.entries.at(-1).level, 'warn');
});

test('bot identity manager rejects mismatched DDP and REST accounts', async () => {
  const log = createLog();
  const rocketClient = {
    canPost: () => true,
    setCredentials: () => {},
    getMe: async () => ({ _id: 'rest-bot-id', username: 'rest-bot' })
  };
  const manager = createBotIdentityManager({
    rocketClient,
    rocketConfig: { userId: 'rest-bot-id', botUsername: 'bot' },
    log
  });

  assert.equal(await manager.validateRestIdentity('ddp-bot-id'), false);
  assert.equal(log.entries.at(-1).message, 'bot_identity_account_mismatch');
  assert.equal(log.entries.at(-1).level, 'error');
});

test('bot identity manager can fall back to DDP login token for REST replies', () => {
  const log = createLog();
  let userId = '';
  let authToken = '';
  const rocketClient = {
    canPost: () => Boolean(userId && authToken),
    setCredentials: (credentials) => {
      userId = credentials.userId || userId;
      authToken = credentials.authToken || authToken;
    }
  };
  const manager = createBotIdentityManager({
    rocketClient,
    rocketConfig: { userId: '', botUsername: 'bot' },
    log
  });

  manager.handleRealtimeReadyCredentials({ userId: 'bot-id', authToken: 'login-token' });

  assert.equal(rocketClient.canPost(), true);
  assert.equal(manager.getState().realtimeBotUserId, 'bot-id');
  assert.equal(manager.getState().restBotUserId, 'bot-id');
  assert.equal(log.entries.at(-1).message, 'bot_runner_using_login_token');
});