import http from 'node:http';
import { URL } from 'node:url';
import { config, validateConfig } from './config.js';
import { HttpError, readJsonBody, sendJson, sendText } from './http.js';
import { isToolAllowed } from './mcp.js';
import { buildRuntime } from './runtime.js';
import { createLoopGuard } from './loop-guard.js';
import { createMessageDeduper } from './message-dedupe.js';
import { createMessageAdmission } from './message-admission.js';
import { errorToMeta, log } from './logger.js';
import { buildQuestionLogFields } from './question-logging.js';
import { extractRocketEvent, shouldReplyViaBot, verifyRocketRequest } from './webhook.js';

validateConfig();

const { mcpClient, youtrackRestClient, rocketClient, agent } = buildRuntime();
const loopGuard = createLoopGuard({
  windowMs: config.rocket.loopWindowMs,
  maxEvents: config.rocket.loopMaxEvents
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
let rocketBotIdentity = {
  username: config.rocket.botUsername,
  userId: config.rocket.userId
};

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();

  try {
    await route(req, res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    log(status >= 500 ? 'error' : 'warn', 'request_failed', {
      method: req.method,
      url: req.url,
      status,
      ...errorToMeta(error)
    });
    sendJson(res, status, {
      ok: false,
      error: error.message || 'Internal server error'
    });
  } finally {
    log('info', 'request_complete', {
      method: req.method,
      url: req.url,
      ms: Date.now() - startedAt
    });
  }
});

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/rocket') {
    return handleRocketWebhook(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/ask') {
    requireAdmin(req);
    const body = await readJsonBody(req);
    if (!body.question) throw new HttpError(400, 'question is required');
    const answer = await agent.answer(String(body.question), { userName: 'manual-test' });
    return sendJson(res, 200, { ok: true, answer });
  }

  if (req.method === 'GET' && url.pathname === '/debug/tools') {
    requireAdmin(req);
    const tools = await mcpClient.listTools(true);
    return sendJson(res, 200, {
      ok: true,
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        allowed: isToolAllowed(tool, config.mcp.allowedTools, config.mcp.blockedToolWords),
        inputSchema: tool.inputSchema
      }))
    });
  }

  if (req.method === 'GET' && url.pathname === '/debug/work-items') {
    requireAdmin(req);
    const issueId = url.searchParams.get('issue');
    if (!issueId) throw new HttpError(400, 'issue query parameter is required');
    if (!youtrackRestClient.canFetchWorkItems()) throw new HttpError(503, 'YouTrack REST client is not configured');
    const workItems = await youtrackRestClient.getIssueWorkItems(issueId);
    return sendJson(res, 200, { ok: true, issueId, workItems });
  }

  sendText(res, 404, 'not found');
}

async function handleRocketWebhook(req, res) {
  const body = await readJsonBody(req);
  if (!verifyRocketRequest(req, body, config.rocket.webhookToken)) {
    throw new HttpError(401, 'Invalid Rocket.Chat webhook token');
  }

  const event = extractRocketEvent(body, rocketBotIdentity);
  const admission = messageAdmission.evaluateWebhookMessage(event);
  if (!admission.accepted) {
    return sendWebhookAdmissionRejection(res, event, admission);
  }

  log('info', 'rocket_question_received', {
    roomId: event.roomId,
    roomName: event.roomName,
    userName: event.userName,
    userId: event.userId,
    messageId: event.messageId,
    ...buildQuestionLogFields(event.text, config.logging)
  });

  if (shouldReplyViaBot()) {
    sendJson(res, 202, { ok: true, accepted: true });
    void answerAndPost(event);
    return;
  }

  const answer = await agent.answer(event.text, event);
  return sendJson(res, 200, {
    text: answer
  });
}

async function answerAndPost(event) {
  try {
    if (config.rocket.postProgress) {
      await rocketClient.postMessage({
        roomId: event.roomId,
        threadId: event.messageId,
        replyInThread: config.rocket.replyInThread,
        text: '收到，正在处理，请稍候…'
      });
    }

    const answer = await agent.answer(event.text, event);
    await rocketClient.postMessage({
      roomId: event.roomId,
      threadId: event.messageId,
      replyInThread: config.rocket.replyInThread,
      text: answer
    });
  } catch (error) {
    log('error', 'answer_and_post_failed', {
      roomId: event.roomId,
      messageId: event.messageId,
      ...errorToMeta(error)
    });

    try {
      await rocketClient.postMessage({
        roomId: event.roomId,
        threadId: event.messageId,
        replyInThread: config.rocket.replyInThread,
        text: `处理失败：${error.message || String(error)}`
      });
    } catch (postError) {
      log('error', 'rocket_error_reply_failed', errorToMeta(postError));
    }
  }
}

function sendWebhookAdmissionRejection(res, event, admission) {
  if (admission.category === 'ignore') {
    log('info', 'rocket_message_ignored', {
      reason: admission.reason,
      roomId: event.roomId,
      roomName: event.roomName,
      userName: event.userName,
      userId: event.userId,
      messageId: event.messageId
    });
    return sendJson(res, 200, { ok: true, ignored: true, reason: admission.reason });
  }

  if (admission.category === 'dedupe') {
    log('info', 'rocket_message_duplicate_ignored', {
      roomId: event.roomId,
      roomName: event.roomName,
      userName: event.userName,
      userId: event.userId,
      messageId: event.messageId,
      dedupeTtlMs: config.rocket.messageDedupeTtlMs
    });
    return sendJson(res, 200, { ok: true, ignored: true, reason: admission.reason });
  }

  if (admission.category === 'loop_guard') {
    const loopState = admission.loopState || {};
    log('error', 'rocket_loop_guard_tripped', {
      roomId: event.roomId,
      roomName: event.roomName,
      userName: event.userName,
      userId: event.userId,
      messageId: event.messageId,
      count: loopState.count,
      windowMs: loopState.windowMs,
      maxEvents: loopState.maxEvents,
      recommendation: 'Check Rocket.Chat outgoing webhook trigger scope, user auto-reply settings, and ROCKET_BOT_USERNAME/ROCKET_REST_USER_ID.'
    });
    return sendJson(res, 200, { ok: true, ignored: true, reason: admission.reason });
  }

  return sendJson(res, 200, { ok: true, ignored: true, reason: admission.reason });
}

async function validateRocketBotIdentity() {
  if (!rocketClient.canPost()) return;

  try {
    const me = await rocketClient.getMe();
    const actualUser = me.user && typeof me.user === 'object' ? me.user : me;
    const actualUserId = actualUser._id || actualUser.id || '';
    const actualUsername = actualUser.username || '';

    rocketBotIdentity = {
      username: actualUsername || config.rocket.botUsername,
      userId: actualUserId || config.rocket.userId
    };

    const usernameMismatch = config.rocket.botUsername && actualUsername && config.rocket.botUsername !== actualUsername;
    const userIdMismatch = config.rocket.userId && actualUserId && config.rocket.userId !== actualUserId;

    log(usernameMismatch || userIdMismatch ? 'warn' : 'info', 'rocket_bot_identity_checked', {
      configuredUsername: config.rocket.botUsername,
      actualUsername,
      configuredUserId: config.rocket.userId,
      actualUserId,
      usernameMismatch,
      userIdMismatch,
      recommendation: usernameMismatch || userIdMismatch
        ? 'Update ROCKET_BOT_USERNAME and ROCKET_REST_USER_ID to match the Rocket.Chat REST token user.'
        : undefined
    });
  } catch (error) {
    log('warn', 'rocket_bot_identity_check_failed', {
      ...errorToMeta(error),
      recommendation: 'Check ROCKET_URL, ROCKET_REST_USER_ID, and ROCKET_REST_PAT or ROCKET_REST_LOGIN_AUTH_TOKEN. Self-message filtering will fall back to configured values.'
    });
  }
}

function requireAdmin(req) {
  if (!config.adminToken) {
    throw new HttpError(403, 'ADMIN_TOKEN is not configured');
  }
  if (req.headers['x-admin-token'] !== config.adminToken) {
    throw new HttpError(401, 'Invalid admin token');
  }
}

server.listen(config.port, () => {
  log('info', 'server_started', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    rocketBotReplies: rocketClient.canPost(),
    youtrackRestWorkItems: youtrackRestClient.canFetchWorkItems(),
    rocketLoopWindowMs: config.rocket.loopWindowMs,
    rocketLoopMaxEvents: config.rocket.loopMaxEvents,
    rocketIgnoreAutoReplies: config.rocket.ignoreAutoReplies,
    rocketMessageDedupeTtlMs: config.rocket.messageDedupeTtlMs,
    rocketMessageDedupeMaxEntries: config.rocket.messageDedupeMaxEntries
  });
  void validateRocketBotIdentity();
});

process.on('SIGTERM', () => {
  log('info', 'sigterm_received');
  server.close(() => process.exit(0));
});
