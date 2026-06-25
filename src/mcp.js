import { HttpError } from './http.js';
import { log } from './logger.js';
import { redactSecrets, truncateText } from './text.js';

function buildAuthValue(authScheme, apiKey) {
  if (!apiKey) return '';
  if (!authScheme) return apiKey;
  return `${authScheme} ${apiKey}`;
}

function parseSseMessages(text) {
  const messages = [];
  const events = text.split(/\r?\n\r?\n/);

  for (const event of events) {
    const dataLines = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;

    const data = dataLines.join('\n');
    try {
      messages.push(JSON.parse(data));
    } catch {
      messages.push({ parseError: true, data });
    }
  }

  return messages;
}

function normalizeToolContent(result, maxChars) {
  const parts = [];

  if (result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  for (const item of result?.content || []) {
    if (item.type === 'text') {
      parts.push(item.text || '');
    } else if (item.type === 'resource_link') {
      parts.push(JSON.stringify(item));
    } else if (item.type === 'resource') {
      parts.push(JSON.stringify(item.resource || item));
    } else {
      parts.push(`[${item.type || 'unknown'} content omitted]`);
    }
  }

  const joined = redactSecrets(parts.filter(Boolean).join('\n\n'));
  return truncateText(joined, maxChars);
}

export class McpHttpClient {
  constructor(options) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.authHeader = options.authHeader || 'Authorization';
    this.authScheme = options.authScheme || 'Bearer';
    this.protocolVersion = options.protocolVersion || '2025-06-18';
    this.timeoutMs = options.timeoutMs || 30000;
    this.toolsCacheSeconds = options.toolsCacheSeconds || 300;
    this.resultMaxChars = options.resultMaxChars || 12000;
    this.sessionId = undefined;
    this.negotiatedProtocolVersion = this.protocolVersion;
    this.initialized = false;
    this.nextId = 1;
    this.toolsCache = null;
    this.toolsCacheExpiresAt = 0;
  }

  async initialize() {
    if (this.initialized) return;

    const result = await this.sendRpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: {
        name: 'youtrack-rocket-agent',
        version: '0.1.0'
      }
    }, { skipInitializedCheck: true });

    if (!result?.protocolVersion) {
      throw new Error('MCP initialize response did not include protocolVersion');
    }

    this.negotiatedProtocolVersion = result.protocolVersion;

    await this.sendNotification('notifications/initialized', {});
    this.initialized = true;

    log('info', 'mcp_initialized', {
      protocolVersion: this.negotiatedProtocolVersion,
      hasSession: Boolean(this.sessionId)
    });
  }

  async listTools(forceRefresh = false) {
    await this.initialize();

    const now = Date.now();
    if (!forceRefresh && this.toolsCache && now < this.toolsCacheExpiresAt) {
      return this.toolsCache;
    }

    const tools = [];
    let cursor = undefined;

    do {
      const params = cursor ? { cursor } : {};
      const result = await this.sendRpc('tools/list', params);
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
    } while (cursor);

    this.toolsCache = tools;
    this.toolsCacheExpiresAt = now + this.toolsCacheSeconds * 1000;
    return tools;
  }

  async callTool(name, args) {
    await this.initialize();

    const result = await this.sendRpc('tools/call', {
      name,
      arguments: args || {}
    });

    return {
      raw: result,
      text: normalizeToolContent(result, this.resultMaxChars),
      isError: Boolean(result?.isError)
    };
  }

  async sendNotification(method, params) {
    await this.postMessage({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  async sendRpc(method, params, options = {}) {
    if (!options.skipInitializedCheck && !this.initialized && method !== 'initialize') {
      await this.initialize();
    }

    const id = this.nextId++;
    const response = await this.postMessage({
      jsonrpc: '2.0',
      id,
      method,
      params
    });

    if (response?.error) {
      throw new Error(`MCP ${method} failed: ${response.error.message || JSON.stringify(response.error)}`);
    }

    return response?.result;
  }

  async postMessage(message, retryOnMissingSession = true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    };

    if (this.apiKey) {
      headers[this.authHeader] = buildAuthValue(this.authScheme, this.apiKey);
    }
    if (this.initialized || message.method !== 'initialize') {
      headers['MCP-Protocol-Version'] = this.negotiatedProtocolVersion;
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });

      const responseSessionId = response.headers.get('mcp-session-id');
      if (responseSessionId) {
        this.sessionId = responseSessionId;
      }

      if (response.status === 404 && this.sessionId && retryOnMissingSession) {
        this.sessionId = undefined;
        this.initialized = false;
        await this.initialize();
        return this.postMessage(message, false);
      }

      if (response.status === 202) return null;

      const text = await response.text();
      if (!response.ok) {
        throw new HttpError(response.status, `MCP HTTP ${response.status}`, truncateText(text, 2000));
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        const messages = parseSseMessages(text);
        const matched = messages.find((item) => item.id === message.id) || messages.find((item) => item.result || item.error);
        if (!matched) {
          throw new Error('MCP SSE response did not include a matching JSON-RPC response');
        }
        return matched;
      }

      if (!text.trim()) return null;
      return JSON.parse(text);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function isToolAllowed(tool, allowedTools, blockedWords) {
  if (allowedTools.length > 0) {
    return allowedTools.includes(tool.name);
  }

  const haystack = `${tool.name || ''} ${tool.title || ''} ${tool.description || ''}`.toLowerCase();
  return !blockedWords.some((word) => word && haystack.includes(word.toLowerCase()));
}

export function toLlmTools(mcpTools, allowedTools, blockedWords) {
  const nameMap = new Map();
  const usedNames = new Set();

  const tools = mcpTools
    .filter((tool) => isToolAllowed(tool, allowedTools, blockedWords))
    .map((tool) => {
      const safeName = makeSafeToolName(tool.name, usedNames);
      nameMap.set(safeName, tool.name);

      return {
        type: 'function',
        function: {
          name: safeName,
          description: `${tool.title || tool.name}: ${tool.description || 'No description'}`,
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {}
          }
        }
      };
    });

  return { tools, nameMap };
}

function makeSafeToolName(name, usedNames) {
  const base = String(name || 'tool')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 56) || 'tool';

  let candidate = base;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base.slice(0, 52)}_${counter}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

export { parseSseMessages };
