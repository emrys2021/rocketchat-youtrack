import { config, validateConfig } from './config.js';
import { buildRuntime } from './runtime.js';
import { RocketRealtimeClient } from './rocket-realtime.js';
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

const realtime = new RocketRealtimeClient({
  url: config.rocket.url,
  userId: config.rocket.userId,
  authToken: config.rocket.authToken,
  username: config.rocket.botUsername,
  password: config.rocket.botPassword
});

// 登录后拿到的 bot 用户 id，用于过滤自己发出的消息，避免回复循环。
let botUserId = config.rocket.userId || '';

realtime.on('ready', ({ userId }) => {
  if (userId) botUserId = userId;
  log('info', 'bot_runner_ready', { userId: botUserId, botUsername: config.rocket.botUsername });
});

realtime.on('message', (event) => {
  void handleIncoming(event);
});

async function handleIncoming(event) {
  // 1. 过滤自己发出的消息，避免循环。
  if (event.senderId && botUserId && event.senderId === botUserId) return;
  if (config.rocket.botUsername && event.userName === config.rocket.botUsername) return;

  // 2. 判断是否需要响应：私信无条件响应；频道消息要求 @ 提及 bot。
  const mention = config.rocket.botUsername ? `@${config.rocket.botUsername}` : '';
  const isMentioned = mention && event.text.includes(mention);
  if (!event.isDirect && !isMentioned) return;

  // 3. 清理掉 @ 提及前缀，得到纯净问题。
  const question = stripMention(event.text, mention).trim();
  if (!question) return;

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
      await safePost(replyContext, '收到，我正在 YouTrack 中检索相似 issue。');
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

function stripMention(text, mention) {
  if (!mention) return text;
  return text.split(mention).join(' ');
}

realtime.start();

log('info', 'bot_runner_started', {
  nodeEnv: config.nodeEnv,
  rocketUrl: config.rocket.url,
  botUsername: config.rocket.botUsername,
  canPost: rocketClient.canPost()
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
