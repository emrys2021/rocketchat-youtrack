import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRocketEvent, verifyRocketRequest } from '../src/webhook.js';

test('extracts common outgoing webhook payload', () => {
  const event = extractRocketEvent({
    token: 'secret',
    text: '@youtrack NullPointerException in SyncJob',
    trigger_word: '@youtrack',
    channel_id: 'GENERAL',
    channel_name: 'general',
    user_name: 'alice',
    message_id: 'msg1'
  }, 'youtrack-bot');

  assert.equal(event.text, 'NullPointerException in SyncJob');
  assert.equal(event.roomId, 'GENERAL');
  assert.equal(event.userName, 'alice');
  assert.equal(event.messageId, 'msg1');
  assert.equal(event.isBot, false);
});

test('detects bot loops', () => {
  const event = extractRocketEvent({
    text: 'hello',
    user_name: 'youtrack-bot'
  }, 'youtrack-bot');

  assert.equal(event.isBot, true);
});

test('verifies token from body or header', () => {
  assert.equal(verifyRocketRequest({ headers: {} }, { token: 'a' }, 'a'), true);
  assert.equal(verifyRocketRequest({ headers: { 'x-rocketchat-livechat-token': 'a' } }, {}, 'a'), true);
  assert.equal(verifyRocketRequest({ headers: {} }, { token: 'b' }, 'a'), false);
});
