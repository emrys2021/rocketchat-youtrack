import http from 'node:http';
import { URL } from 'node:url';
import { config, validateConfig } from './config.js';
import { HttpError, readJsonBody, sendJson, sendText } from './http.js';
import { isToolAllowed } from './mcp.js';
import { buildRuntime } from './runtime.js';
import { errorToMeta, log } from './logger.js';
import { extractRocketEvent, shouldReplyViaBot, verifyRocketRequest } from './webhook.js';

validateConfig();

const { mcpClient, youtrackRestClient, rocketClient, agent } = buildRuntime();

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

  const event = extractRocketEvent(body, config.rocket.botUsername);
  if (event.isBot || !event.text) {
    return sendJson(res, 200, { ok: true, ignored: true });
  }

  log('info', 'rocket_question_received', {
    roomId: event.roomId,
    roomName: event.roomName,
    userName: event.userName,
    messageId: event.messageId
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
        text: '收到，我正在 YouTrack 中检索相似 issue。'
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
    youtrackRestWorkItems: youtrackRestClient.canFetchWorkItems()
  });
});

process.on('SIGTERM', () => {
  log('info', 'sigterm_received');
  server.close(() => process.exit(0));
});
