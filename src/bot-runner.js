import { config, validateConfig } from './config.js';
import { buildRuntime } from './runtime.js';
import { RocketRealtimeClient } from './rocket-realtime.js';
import { createLoopGuard } from './loop-guard.js';
import { createMessageDeduper } from './message-dedupe.js';
import { createMessageAdmission } from './message-admission.js';
import { createRocketStreamManager } from './rocket-stream-manager.js';
import { createBotIdentityManager } from './bot-identity.js';
import { createBotMessageHandler } from './bot-message-handler.js';
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
  log('warn', 'bot_runner_missing_user_id', {
    note: 'ROCKET_REST_USER_ID 未配置，REST 回复会等 DDP 登录成功后用登录 token 兜底。生产环境建议配置 bot 账户的 ROCKET_REST_USER_ID + ROCKET_REST_PAT。'
  });
}

const { agent, rocketClient } = buildRuntime();
const loopGuard = createLoopGuard({
  windowMs: config.rocket.loopWindowMs,
  maxEvents: config.rocket.loopMaxEvents
});

// DDP resume token 优先级：显式配置的 ROCKET_DDP_RESUME_TOKEN > REST PAT。
// PAT 可直接用于 DDP login({ resume })，因此纯 PAT
// （ROCKET_REST_USER_ID + ROCKET_REST_PAT）即可完成登录，无需 bot 密码。
const ddpResumeToken = config.rocket.ddpResumeToken || config.rocket.restPat;

const realtime = new RocketRealtimeClient({
  url: config.rocket.url,
  userId: config.rocket.userId,
  resumeToken: ddpResumeToken,
  username: config.rocket.botUsername,
  password: config.rocket.botPassword
});

const messageDeduper = createMessageDeduper({
  ttlMs: config.rocket.messageDedupeTtlMs,
  maxEntries: config.rocket.messageDedupeMaxEntries
});
const messageAdmission = createMessageAdmission({
  deduper: messageDeduper,
  loopGuard,
  ignoreAutoReplies: config.rocket.ignoreAutoReplies
});
const identityManager = createBotIdentityManager({
  rocketClient,
  rocketConfig: config.rocket,
  log
});

let identityGeneration = 0;
let messageHandler;
const streamManager = createRocketStreamManager({
  realtime,
  mode: config.rocket.messageStreamMode,
  notificationFallbackMs: config.rocket.notificationFallbackMs,
  messageDeduper,
  evaluateProbe: (event) => messageAdmission.evaluateRealtimeProbe(event, {
    identity: identityManager.getIdentity(),
    mentionName: identityManager.getMentionName(),
    resolveRoomType,
    onRoomTypeLookupFailed
  }),
  handleFallbackMessage: (event) => messageHandler.handleIncoming(event),
  log
});

messageHandler = createBotMessageHandler({
  agent,
  rocketClient,
  messageAdmission,
  identityManager,
  rocketConfig: config.rocket,
  getActiveMessageStreamMode: () => streamManager.getActiveMode(),
  resolveRoomType,
  onRoomTypeLookupFailed,
  log
});

realtime.on('ready', ({ userId, authToken }) => {
  identityManager.handleRealtimeReadyCredentials({ userId, authToken });

  log('info', 'bot_runner_ready', {
    userId: identityManager.getRealtimeBotUserId(),
    botUsername: config.rocket.botUsername,
    canPost: rocketClient.canPost(),
    rocketLoopWindowMs: config.rocket.loopWindowMs,
    rocketLoopMaxEvents: config.rocket.loopMaxEvents,
    rocketIgnoreAutoReplies: config.rocket.ignoreAutoReplies,
    rocketRestTokenSource: config.rocket.restTokenSource || 'ddp_login_fallback_after_ready'
  });

  const generation = ++identityGeneration;
  streamManager.reset();
  void confirmIdentityThenSubscribe(userId, generation);
});

realtime.on('message', (event) => {
  if (!identityManager.isConfirmed()) return;
  void messageHandler.handleIncoming(event);
});

realtime.on('roomChanged', (event) => {
  if (!identityManager.isConfirmed()) return;
  void streamManager.handleRoomChanged(event);
});

/**
 * 身份确认门禁：(重)连后先通过 /api/v1/me 确认 bot 自身身份，成功才订阅消息流。
 * 失败则带退避重试，期间不订阅、不处理消息。用户看到的效果是：配置错时 bot 宁可不回复，
 * 也不会把自己的回复当成用户问题反复处理。
 */
async function confirmIdentityThenSubscribe(loginUserId, generation, attempt = 1) {
  const ok = await identityManager.validateRestIdentity(loginUserId);
  if (generation !== identityGeneration) return;
  if (!ok) {
    const delayMs = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
    log('warn', 'bot_identity_unconfirmed_retry', {
      attempt,
      delayMs,
      note: 'bot 身份未确认，暂不订阅消息流，稍后重试。'
    });
    setTimeout(() => {
      if (generation === identityGeneration && !identityManager.isConfirmed()) {
        void confirmIdentityThenSubscribe(loginUserId, generation, attempt + 1);
      }
    }, delayMs);
    return;
  }

  identityManager.markConfirmed();
  streamManager.subscribe(identityManager.getRealtimeBotUserId());
  const identityState = identityManager.getState();
  log('info', 'bot_runner_subscribed_after_identity', {
    restUserId: identityState.restBotUserId,
    restUsername: identityState.restBotUsername,
    messageStreamMode: config.rocket.messageStreamMode,
    activeMessageStreamMode: streamManager.getActiveMode()
  });
}

async function resolveRoomType(event) {
  return rocketClient.getRoomType(event.roomId);
}

function onRoomTypeLookupFailed(error, event) {
  log('warn', 'bot_room_type_lookup_failed', { roomId: event.roomId, ...errorToMeta(error) });
}

realtime.start();

log('info', 'bot_runner_started', {
  nodeEnv: config.nodeEnv,
  rocketUrl: config.rocket.url,
  botUsername: config.rocket.botUsername,
  canPost: rocketClient.canPost(),
  rocketLoopWindowMs: config.rocket.loopWindowMs,
  rocketLoopMaxEvents: config.rocket.loopMaxEvents,
  rocketIgnoreAutoReplies: config.rocket.ignoreAutoReplies,
  rocketMessageStreamMode: config.rocket.messageStreamMode,
  rocketNotificationFallbackMs: config.rocket.notificationFallbackMs,
  rocketMessageDedupeTtlMs: config.rocket.messageDedupeTtlMs,
  rocketMessageDedupeMaxEntries: config.rocket.messageDedupeMaxEntries
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
