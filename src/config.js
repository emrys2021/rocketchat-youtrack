import { loadDotEnv } from './env.js';

loadDotEnv();

function getString(name, fallback = '') {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  // 以 < 开头的值是 .env.example 里未替换的占位符，视为未配置。
  if (value.trimStart().startsWith('<')) return fallback;
  return value;
}

function getInteger(name, fallback) {
  const raw = getString(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function getFloat(name, fallback) {
  const raw = getString(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function getBoolean(name, fallback) {
  const raw = getString(name).toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getList(name) {
  return getString(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferYouTrackBaseUrl(mcpUrl) {
  if (!mcpUrl) return '';
  try {
    const url = new URL(mcpUrl);
    return url.origin;
  } catch {
    return '';
  }
}

export const config = {
  port: getInteger('PORT', 8080),
  nodeEnv: getString('NODE_ENV', 'development'),
  adminToken: getString('ADMIN_TOKEN'),

  llm: {
    apiUrl: getString('LLM_API_URL'),
    apiKey: getString('LLM_API_KEY'),
    model: getString('LLM_MODEL'),
    temperature: getFloat('LLM_TEMPERATURE', 0.2),
    timeoutMs: getInteger('LLM_TIMEOUT_MS', 60000),
    maxOutputTokens: getInteger('LLM_MAX_OUTPUT_TOKENS', 1600)
  },

  mcp: {
    url: getString('MCP_URL'),
    apiKey: getString('MCP_API_KEY'),
    authHeader: getString('MCP_AUTH_HEADER', 'Authorization'),
    authScheme: getString('MCP_AUTH_SCHEME', 'Bearer'),
    protocolVersion: getString('MCP_PROTOCOL_VERSION', '2025-06-18'),
    timeoutMs: getInteger('MCP_TIMEOUT_MS', 30000),
    toolsCacheSeconds: getInteger('MCP_TOOLS_CACHE_SECONDS', 300),
    maxToolRounds: getInteger('MCP_MAX_TOOL_ROUNDS', 4),
    resultMaxChars: getInteger('MCP_RESULT_MAX_CHARS', 12000),
    allowedTools: getList('MCP_ALLOWED_TOOLS'),
    blockedToolWords: getList('MCP_BLOCKED_TOOL_WORDS')
  },

  youtrack: {
    baseUrl: getString('YOUTRACK_BASE_URL', inferYouTrackBaseUrl(getString('MCP_URL'))),
    apiToken: getString('YOUTRACK_API_TOKEN', getString('MCP_API_KEY')),
    timeoutMs: getInteger('YOUTRACK_TIMEOUT_MS', 30000),
    workItemsLimit: getInteger('YOUTRACK_WORK_ITEMS_LIMIT', 20),
    enrichIssueLimit: getInteger('YOUTRACK_ENRICH_ISSUE_LIMIT', 3),
    commentsLimit: getInteger('YOUTRACK_COMMENTS_LIMIT', 20)
  },

  rocket: {
    webhookToken: getString('ROCKET_WEBHOOK_TOKEN'),
    url: getString('ROCKET_URL'),
    userId: getString('ROCKET_USER_ID'),
    authToken: getString('ROCKET_AUTH_TOKEN'),
    botUsername: getString('ROCKET_BOT_USERNAME', 'youtrack-bot'),
    botPassword: getString('ROCKET_BOT_PASSWORD'),
    replyInThread: getBoolean('ROCKET_REPLY_IN_THREAD', true),
    postProgress: getBoolean('ROCKET_POST_PROGRESS', true),
    messageMaxChars: getInteger('ROCKET_MESSAGE_MAX_CHARS', 3500),
    timeoutMs: getInteger('ROCKET_TIMEOUT_MS', 15000),
    ignoreAutoReplies: getBoolean('ROCKET_IGNORE_AUTO_REPLIES', true),
    loopWindowMs: getInteger('ROCKET_LOOP_WINDOW_MS', 60000),
    loopMaxEvents: getInteger('ROCKET_LOOP_MAX_EVENTS', 4),
    messageDedupeTtlMs: getInteger('ROCKET_MESSAGE_DEDUPE_TTL_MS', 10 * 60 * 1000),
    messageDedupeMaxEntries: getInteger('ROCKET_MESSAGE_DEDUPE_MAX_ENTRIES', 1000)
  }
};

/**
 * 校验环境变量。两种运行模式要求不同：
 *   - 'webhook'（默认，server.js）：依赖 outgoing webhook，要求 ROCKET_WEBHOOK_TOKEN。
 *   - 'bot'（bot-runner.js）：直接登录 realtime，要求 ROCKET_URL + 登录凭据，
 *     不需要 ROCKET_WEBHOOK_TOKEN。
 */
export function validateConfig(mode = 'webhook') {
  const missing = [];

  if (!config.llm.apiUrl) missing.push('LLM_API_URL');
  if (!config.llm.apiKey) missing.push('LLM_API_KEY');
  if (!config.llm.model) missing.push('LLM_MODEL');
  if (!config.mcp.url) missing.push('MCP_URL');
  if (!config.mcp.apiKey) missing.push('MCP_API_KEY');

  if (mode === 'bot') {
    if (!config.rocket.url) missing.push('ROCKET_URL');
    const hasPassword = Boolean(config.rocket.botUsername && config.rocket.botPassword);
    if (!hasPassword) {
      missing.push('ROCKET_BOT_USERNAME + ROCKET_BOT_PASSWORD');
    }
  } else {
    if (!config.rocket.webhookToken) missing.push('ROCKET_WEBHOOK_TOKEN');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function hasRocketBotCredentials() {
  return Boolean(config.rocket.url && config.rocket.userId && config.rocket.authToken);
}
