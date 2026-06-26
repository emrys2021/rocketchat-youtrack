import { config, validateConfig } from './config.js';
import { buildRuntime } from './runtime.js';
import { RocketRealtimeClient } from './rocket-realtime.js';
import { createLoopGuard } from './loop-guard.js';
import { createMessageDeduper } from './message-dedupe.js';
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
  // ROCKET_REST_USER_ID。这里仅提醒：建议为 bot 账户配置 Personal Access Token，
  // 同时拿到 REST User Id 和 PAT。
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
// PAT 可直接用于 DDP login({ resume })（PAT 和普通 login token 都存在
// services.resume.loginTokens 里，DDP resume 校验不区分类型），因此纯 PAT
// （ROCKET_REST_USER_ID + ROCKET_REST_PAT）即可完成登录，无需 bot 密码。
const ddpResumeToken = config.rocket.ddpResumeToken || config.rocket.restPat;

const realtime = new RocketRealtimeClient({
  url: config.rocket.url,
  userId: config.rocket.userId,
  resumeToken: ddpResumeToken,
  username: config.rocket.botUsername,
  password: config.rocket.botPassword
});

// 登录后拿到的 bot 用户 id 用于过滤 DDP 自己发出的消息。
let realtimeBotUserId = config.rocket.userId || '';
// REST PAT 或 REST login authToken 可能属于另一个账号；启动后通过 /api/v1/me 校验并加入自消息过滤。
let restBotUserId = config.rocket.userId || '';
let restBotUsername = config.rocket.botUsername || '';
// 频道 @ 提及触发名。初值用配置的 botUsername；身份确认后改用 /me 返回的真实用户名，
// 避免 PAT-only 模式下 ROCKET_BOT_USERNAME 默认值与真实账号不符导致频道 @ 不触发。
let effectiveMentionName = config.rocket.botUsername || '';

// 消息去重：复用 webhook 模式同款 deduper（带 TTL + 数量上限），
// 用 config 里的 messageDedupeTtlMs / messageDedupeMaxEntries，不再硬编码 500 无 TTL。
// TTL 保证“一条消息在 ttl 内一定被记住”，覆盖重连/重发的短时间窗口，与流量大小无关。
const messageDeduper = createMessageDeduper({
  ttlMs: config.rocket.messageDedupeTtlMs,
  maxEntries: config.rocket.messageDedupeMaxEntries
});

// 身份确认门禁：只有 /api/v1/me 确认了 bot 自身身份后，identityConfirmed 才为 true，
// handleIncoming 才会真正处理消息。否则收到的消息一律不处理（安全失败），
// 避免“认不出自己发的回复”导致 bot ↔ bot 私信死循环。
let identityConfirmed = false;
let activeMessageStreamMode = '';
const notificationFallbackTimers = new Map();

realtime.on('ready', ({ userId, authToken }) => {
  if (userId) realtimeBotUserId = userId;

  // 没有配置 REST 回复凭据（ROCKET_REST_USER_ID + ROCKET_REST_PAT/ROCKET_REST_LOGIN_AUTH_TOKEN）时，
  // 用本次 DDP 登录返回的 userId/token 兜底，让 bot 仍能通过 REST 发回复。
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
      recommendation: 'ROCKET_REST_USER_ID should belong to the same bot account used for DDP login.'
    });
  }

  log('info', 'bot_runner_ready', {
    userId: realtimeBotUserId,
    botUsername: config.rocket.botUsername,
    canPost: rocketClient.canPost(),
    rocketLoopWindowMs: config.rocket.loopWindowMs,
    rocketLoopMaxEvents: config.rocket.loopMaxEvents,
    rocketIgnoreAutoReplies: config.rocket.ignoreAutoReplies,
    rocketRestTokenSource: config.rocket.restTokenSource || 'ddp_login_fallback_after_ready'
  });

  // 每次（重）连后，先确认身份，确认成功才订阅消息流。
  identityConfirmed = false;
  activeMessageStreamMode = '';
  clearNotificationFallbackTimers();
  void confirmIdentityThenSubscribe(userId);
});

realtime.on('message', (event) => {
  // 身份未确认前，丢弃一切消息：此时无法可靠区分 bot 自己的回复，处理有死循环风险。
  if (!identityConfirmed) return;
  void handleIncoming(event);
});

realtime.on('roomChanged', (event) => {
  if (!identityConfirmed) return;
  void handleRoomChanged(event);
});

/**
 * 身份确认门禁：(重)连后先通过 /api/v1/me 确认 bot 自身身份，成功才订阅消息流。
 * 失败则带退避重试，期间不订阅、不处理消息——宁可不工作，也不带病运行引发死循环。
 */
async function confirmIdentityThenSubscribe(loginUserId, attempt = 1) {
  const ok = await validateRestBotIdentity(loginUserId);
  if (!ok) {
    const delayMs = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
    log('warn', 'bot_identity_unconfirmed_retry', {
      attempt,
      delayMs,
      note: 'bot 身份未确认，暂不订阅消息流，稍后重试。'
    });
    setTimeout(() => {
      // 若期间已重连（产生了新的 ready），放弃这条过期的重试链。
      if (!identityConfirmed) void confirmIdentityThenSubscribe(loginUserId, attempt + 1);
    }, delayMs);
    return;
  }

  identityConfirmed = true;
  subscribeToConfiguredStream();
  log('info', 'bot_runner_subscribed_after_identity', {
    restUserId: restBotUserId,
    restUsername: restBotUsername,
    messageStreamMode: config.rocket.messageStreamMode,
    activeMessageStreamMode
  });
}

function subscribeToConfiguredStream() {
  const mode = config.rocket.messageStreamMode;
  if (mode === 'my_messages') {
    if (realtime.subscribeToMessages()) activeMessageStreamMode = 'my_messages';
    return;
  }

  if (mode === 'notification') {
    if (realtime.subscribeToNotifications(realtimeBotUserId)) activeMessageStreamMode = 'notification';
    return;
  }

  // auto：先订阅 notification + rooms-changed。notification 是主通道，rooms-changed 只做漏消息探针。
  if (realtime.subscribeToNotificationProbe(realtimeBotUserId)) {
    activeMessageStreamMode = 'notification_probe';
  }
}

async function handleRoomChanged(event) {
  if (config.rocket.messageStreamMode !== 'auto') return;
  if (activeMessageStreamMode === 'my_messages') return;

  const ignoreReason = getIncomingIgnoreReason(event);
  if (ignoreReason) return;

  const mention = getMention();
  const isMentioned = Boolean(mention && event.text.includes(mention));
  await ensureRoomType(event, isMentioned);
  if (!event.isDirect && !isMentioned) return;

  const key = getMessageKey(event);
  if (!key || notificationFallbackTimers.has(key) || messageDeduper.has(key)) return;

  const timer = setTimeout(() => {
    notificationFallbackTimers.delete(key);
    if (messageDeduper.has(key)) return;

    activateRoomMessagesFallback('notification_missed_after_rooms_changed', event);
    void handleIncoming({ ...event, source: 'rooms_changed_fallback' });
  }, config.rocket.notificationFallbackMs);
  notificationFallbackTimers.set(key, timer);

  log('info', 'bot_notification_fallback_scheduled', {
    roomId: event.roomId,
    messageId: event.messageId,
    userName: event.userName,
    isDirect: event.isDirect,
    delayMs: config.rocket.notificationFallbackMs
  });
}

function activateRoomMessagesFallback(reason, event = {}) {
  if (activeMessageStreamMode === 'my_messages') return false;
  const subscribed = realtime.subscribeToMessages();
  if (!subscribed) return false;
  activeMessageStreamMode = 'my_messages';
  log('warn', 'bot_realtime_fallback_to_room_messages', {
    reason,
    roomId: event.roomId,
    messageId: event.messageId,
    userName: event.userName,
    note: 'notification 未在 fallback 窗口内送达，已切换到 __my_messages__ 可靠消息流。'
  });
  return true;
}
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

  // 对消息做去重，避免 Rocket.Chat 重连重发、或同一消息被多次推送时重复回复。
  if (messageDeduper.checkAndRemember(getMessageKey(event)).duplicate) return;

  // 判断是否需要响应：私信无条件响应；频道消息要求 @ 提及 bot。
  // 用 effectiveMentionName（身份确认后为 /me 真实用户名）构造 @ 名，确保频道 @ 能命中真实账号。
  const mention = getMention();
  const isMentioned = Boolean(mention && event.text.includes(mention));

  await ensureRoomType(event, isMentioned);

  // 频道里没 @ 提及 → 不响应.
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
    isDirect: event.isDirect,
    source: event.source,
    activeMessageStreamMode
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

/**
 * 通过 /api/v1/me 确认 bot 自身身份，把真实 userId/username 写入自消息过滤变量。
 * @returns {Promise<boolean>} 是否确认成功（拿到真实 userId 才算成功）。
 */
async function validateRestBotIdentity(loginUserId = '') {
  if (!rocketClient.canPost()) {
    log('warn', 'bot_rest_identity_no_credentials', {
      note: '无 REST 凭据（PAT 或登录 token），无法确认 bot 身份，也无法回复——不订阅消息流。'
    });
    return false;
  }

  try {
    const me = await rocketClient.getMe();
    const actualUser = me.user && typeof me.user === 'object' ? me.user : me;
    const actualUserId = actualUser._id || actualUser.id || '';
    const actualUsername = actualUser.username || '';

    // 必须拿到真实 userId 才算确认成功：userId 是自消息过滤最可靠的判据。
    if (!actualUserId) {
      log('warn', 'bot_rest_identity_incomplete', {
        restUsername: actualUsername,
        note: '/api/v1/me 未返回 userId，身份确认失败。'
      });
      return false;
    }

    // 关键安全校验：DDP 登录账号 与 REST(/me) 账号必须是同一个。
    // __my_messages__ 会把“REST 账号发的回复”推给“DDP 账号”监听端，若两者不是同一账号，
    // 自消息过滤(senderId === realtimeBotUserId)会失效 → bot 认不出自己的回复 → 死循环。
    // 因此账号不一致时 hard fail：返回 false → 不订阅、不处理消息，持续重试并报错，逼迫修配置。
    const loginUserIdMismatch = loginUserId && loginUserId !== actualUserId;
    if (loginUserIdMismatch) {
      log('error', 'bot_identity_account_mismatch', {
        loginUserId,
        restUserId: actualUserId,
        restUsername: actualUsername,
        note: 'DDP 登录账号与 REST(/api/v1/me) 账号不一致，__my_messages__ 模式下会导致自消息过滤失效、死循环。已拒绝订阅。',
        recommendation: 'Use the SAME Rocket.Chat bot account for DDP login (resume token/PAT) and REST replies. Align ROCKET_REST_USER_ID + ROCKET_REST_PAT with the account used for DDP login.'
      });
      return false;
    }

    restBotUserId = actualUserId;
    if (actualUsername) restBotUsername = actualUsername;
    // DDP 自消息过滤也用这个确认到的真实 userId 兜底（登录 resume 可能未返回 id）。
    if (!realtimeBotUserId) realtimeBotUserId = actualUserId;
    // 第3点：用 /me 返回的真实用户名作为频道 @ 提及触发名，避免 PAT-only 模式下
    // ROCKET_BOT_USERNAME 默认值与真实账号不符导致频道 @ 不触发。
    if (actualUsername) effectiveMentionName = actualUsername;

    const configuredUsernameMismatch = config.rocket.botUsername && actualUsername && config.rocket.botUsername !== actualUsername;

    log(configuredUsernameMismatch ? 'warn' : 'info', 'bot_rest_identity_checked', {
      loginUserId,
      restUserId: actualUserId,
      configuredUsername: config.rocket.botUsername,
      restUsername: actualUsername,
      effectiveMentionName,
      configuredUsernameMismatch,
      recommendation: configuredUsernameMismatch
        ? 'Channel @mention now uses the real account username from /api/v1/me. Update ROCKET_BOT_USERNAME to match if you rely on it elsewhere.'
        : undefined
    });
    return true;
  } catch (error) {
    log('warn', 'bot_rest_identity_check_failed', {
      ...errorToMeta(error),
      recommendation: 'Check ROCKET_URL, ROCKET_REST_USER_ID, and ROCKET_REST_PAT or ROCKET_REST_LOGIN_AUTH_TOKEN.'
    });
    return false;
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

function getMention() {
  return effectiveMentionName ? `@${effectiveMentionName}` : '';
}

async function ensureRoomType(event, isMentioned) {
  if (event.isDirect !== undefined) return;

  if (isMentioned) {
    // 含提及：房间类型只影响是否开线程。频道场景按非私信处理，避免为每条 @ 消息额外查 rooms.info。
    event.isDirect = false;
    return;
  }

  try {
    const roomType = await rocketClient.getRoomType(event.roomId);
    event.roomType = roomType;
    event.isDirect = roomType === 'd';
  } catch (error) {
    // 查询失败时按频道处理（更保守：频道需 @ 提及，避免误回所有消息）。
    log('warn', 'bot_room_type_lookup_failed', { roomId: event.roomId, ...errorToMeta(error) });
    event.isDirect = false;
  }
}

function clearNotificationFallbackTimers() {
  for (const timer of notificationFallbackTimers.values()) {
    clearTimeout(timer);
  }
  notificationFallbackTimers.clear();
}
function stripMention(text, mention) {
  if (!mention) return text;
  return text.split(mention).join(' ');
}

// 去重 key：优先用 Rocket.Chat 的消息 _id；极少数无 _id 的情况回退到房间+发送者+文本组合。
function getMessageKey(event) {
  if (event.messageId) return event.messageId;
  return [event.roomId, event.userName, event.rawText || event.text].join(':');
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
