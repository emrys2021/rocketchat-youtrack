import { config, validateConfig } from './config.js';
import { buildRuntime } from './runtime.js';
import { RocketRealtimeClient } from './rocket-realtime.js';
import { createLoopGuard } from './loop-guard.js';
import { log, errorToMeta } from './logger.js';

/**
 * bot-login 模式入口。
 *
 * 后端直接登录 Rocket.Chat bot 账户，通过 Realtime (DDP/WebSocket) 订阅通知，
 * 收到私信(DM) 或频道内 @youtrack-bot 提及时调用 agent.answer()，再用 bot 账户
 * 的 REST token 回复到原 room/thread。
 *
 * 与 server.js 的 outgoing webhook 模式互补：可以二选一启动，也可以并行运行。
 */
validateConfig('bot');

if (!config.rocket.userId) {
  // realtime 登录会返回 userId，但回复用的 REST 调用（chat.sendMessage）需要
  // ROCKET_USER_ID。这里仅提醒：建议为 bot 账户配置 Personal Access Token，
  // 同时拿到 userId 和 token。
  log('warn', 'bot_runner_missing_user_id', {
    note: 'ROCKET_USER_ID 未配置，REST 回复可能失败。建议为 bot 账户配置 Personal Access Token 的 userId/token。'
  });
}

const { agent, rocketClient } = buildRuntime();
const loopGuard = createLoopGuard({
  windowMs: config.rocket.loopWindowMs,
  maxEvents: config.rocket.loopMaxEvents
});

const realtime = new RocketRealtimeClient({
  url: config.rocket.url,
  userId: config.rocket.userId,
  authToken: config.rocket.authToken,
  username: config.rocket.botUsername,
  password: config.rocket.botPassword
});

// 登录后拿到的 bot 用户 id 用于过滤 DDP 自己发出的消息。
let realtimeBotUserId = config.rocket.userId || '';
// REST token 可能属于另一个账号；启动后通过 /api/v1/me 校验并加入自消息过滤。
let restBotUserId = config.rocket.userId || '';
let restBotUsername = config.rocket.botUsername || '';
const seenMessageIds = new Map();
const maxSeenMessages = 500;

realtime.on('ready', ({ userId, authToken }) => {
  if (userId) realtimeBotUserId = userId;

  // 没有单独配置 PAT（ROCKET_USER_ID / ROCKET_AUTH_TOKEN）时，
  // 用 realtime 登录返回的 userId/token 兜底，让 bot 仍能通过 REST 发回复。
  if (!rocketClient.canPost()) {
    rocketClient.setCredentials({ userId, authToken });
    if (rocketClient.canPost()) {
      restBotUserId = userId || restBotUserId;
      log('info', 'bot_runner_using_login_token', { userId });
    }
  }

  const configuredUserIdMismatch = config.rocket.userId && userId && config.rocket.userId !== userId;
  if (configuredUserIdMismatch) {
    log('warn', 'bot_login_identity_mismatch', {
      configuredUserId: config.rocket.userId,
      loginUserId: userId,
      recommendation: 'ROCKET_USER_ID should belong to the same bot account as ROCKET_BOT_USERNAME/ROCKET_BOT_PASSWORD.'
    });
  }

  log('info', 'bot_runner_ready', {
    userId: realtimeBotUserId,
    botUsername: config.rocket.botUsername,
    canPost: rocketClient.canPost(),
    rocketLoopWindowMs: config.rocket.loopWindowMs,
    rocketLoopMaxEvents: config.rocket.loopMaxEvents,
    rocketIgnoreAutoReplies: config.rocket.ignoreAutoReplies
  });

  void validateRestBotIdentity(userId);
});

realtime.on('message', (event) => {
  void handleIncoming(event);
});

async function handleIncoming(event) {
  const ignoreReason = getIncomingIgnoreReason(event);
  if (ignoreReason) {
    log('info', 'bot_message_ignored', {
      reason: ignoreReason,
      roomId: event.roomId,
      messageId: event.messageId,
      userName: event.userName,
      senderId: event.senderId,
      isDirect: event.isDirect
    });
    return;
  }

  // 对通知做去重，避免 Rocket.Chat 通知重发或重连期间重复回复。
  if (hasSeenMessage(event)) return;
  rememberMessage(event);

  // 判断是否需要响应：私信无条件响应；频道消息要求 @ 提及 bot。
  const mention = config.rocket.botUsername ? `@${config.rocket.botUsername}` : '';
  const isMentioned = mention && event.text.includes(mention);
  if (!event.isDirect && !isMentioned) return;

  // 清理掉 @ 提及前缀，得到纯净问题。
  const question = stripMention(event.text, mention).trim();
  if (!question) return;

  const loopState = loopGuard.record(event);
  if (loopState.blocked) {
    log('error', 'bot_loop_guard_tripped', {
      roomId: event.roomId,
      messageId: event.messageId,
      userName: event.userName,
      senderId: event.senderId,
      isDirect: event.isDirect,
      count: loopState.count,
      windowMs: loopState.windowMs,
      maxEvents: loopState.maxEvents,
      recommendation: 'Check Rocket.Chat Auto-Reply settings and bot identity configuration.'
    });
    return;
  }

  log('info', 'bot_question_received', {
    roomId: event.roomId,
    messageId: event.messageId,
    userName: event.userName,
    isDirect: event.isDirect
  });

  const replyContext = {
    roomId: event.roomId,
    threadId: event.messageId,
    // 私信里没必要开线程，频道里按配置回复到线程。
    replyInThread: event.isDirect ? false : config.rocket.replyInThread
  };

  try {
    if (config.rocket.postProgress) {
      await safePost(replyContext, '收到，正在处理，请稍候…');
    }

    const answer = await agent.answer(question, {
      userName: event.userName,
      roomId: event.roomId
    });
    await rocketClient.postMessage({ ...replyContext, text: answer });
  } catch (error) {
    log('error', 'bot_answer_failed', {
      roomId: event.roomId,
      messageId: event.messageId,
      ...errorToMeta(error)
    });
    await safePost(replyContext, `处理失败：${error.message || String(error)}`);
  }
}

async function safePost(replyContext, text) {
  try {
    await rocketClient.postMessage({ ...replyContext, text });
  } catch (error) {
    log('error', 'bot_post_failed', errorToMeta(error));
  }
}

async function validateRestBotIdentity(loginUserId = '') {
  if (!rocketClient.canPost()) return;

  try {
    const me = await rocketClient.getMe();
    const actualUser = me.user && typeof me.user === 'object' ? me.user : me;
    const actualUserId = actualUser._id || actualUser.id || '';
    const actualUsername = actualUser.username || '';

    restBotUserId = actualUserId || restBotUserId;
    restBotUsername = actualUsername || restBotUsername;

    const loginUserIdMismatch = loginUserId && actualUserId && loginUserId !== actualUserId;
    const configuredUsernameMismatch = config.rocket.botUsername && actualUsername && config.rocket.botUsername !== actualUsername;

    log(loginUserIdMismatch || configuredUsernameMismatch ? 'warn' : 'info', 'bot_rest_identity_checked', {
      loginUserId,
      restUserId: actualUserId,
      configuredUsername: config.rocket.botUsername,
      restUsername: actualUsername,
      loginUserIdMismatch,
      configuredUsernameMismatch,
      recommendation: loginUserIdMismatch || configuredUsernameMismatch
        ? 'Use the same Rocket.Chat bot account for DDP login and REST replies, and update ROCKET_BOT_USERNAME/ROCKET_USER_ID.'
        : undefined
    });
  } catch (error) {
    log('warn', 'bot_rest_identity_check_failed', {
      ...errorToMeta(error),
      recommendation: 'Check ROCKET_URL, ROCKET_USER_ID, and ROCKET_AUTH_TOKEN. Self-message filtering will fall back to configured values.'
    });
  }
}

function getIncomingIgnoreReason(event) {
  if (!event.text) return 'empty_text';
  if (event.senderId && realtimeBotUserId && event.senderId === realtimeBotUserId) return 'bot_message';
  if (event.senderId && restBotUserId && event.senderId === restBotUserId) return 'bot_message';
  if (config.rocket.botUsername && event.userName === config.rocket.botUsername) return 'bot_message';
  if (restBotUsername && event.userName === restBotUsername) return 'bot_message';
  if (event.isSystem) return 'system_message';
  if (config.rocket.ignoreAutoReplies && event.isAutoReply) return 'auto_reply';
  return '';
}

function stripMention(text, mention) {
  if (!mention) return text;
  return text.split(mention).join(' ');
}

function getMessageKey(event) {
  if (event.messageId) return event.messageId;
  return [event.roomId, event.userName, event.rawText || event.text].join(':');
}

function hasSeenMessage(event) {
  return seenMessageIds.has(getMessageKey(event));
}

function rememberMessage(event) {
  seenMessageIds.set(getMessageKey(event), Date.now());
  if (seenMessageIds.size <= maxSeenMessages) return;

  const keysToDelete = seenMessageIds.size - maxSeenMessages;
  let deleted = 0;
  for (const key of seenMessageIds.keys()) {
    seenMessageIds.delete(key);
    deleted += 1;
    if (deleted >= keysToDelete) break;
  }
}

realtime.start();

log('info', 'bot_runner_started', {
  nodeEnv: config.nodeEnv,
  rocketUrl: config.rocket.url,
  botUsername: config.rocket.botUsername,
  canPost: rocketClient.canPost(),
  rocketLoopWindowMs: config.rocket.loopWindowMs,
  rocketLoopMaxEvents: config.rocket.loopMaxEvents,
  rocketIgnoreAutoReplies: config.rocket.ignoreAutoReplies
});

process.on('SIGTERM', () => {
  log('info', 'sigterm_received');
  realtime.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'sigint_received');
  realtime.stop();
  process.exit(0);
});
