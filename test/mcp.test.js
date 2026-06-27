import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpClient, isToolAllowed, parseSseMessages, toLlmTools } from '../src/mcp.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('parses JSON-RPC messages from SSE', () => {
  const messages = parseSseMessages([
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    ''
  ].join('\n'));

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    jsonrpc: '2.0',
    id: 1,
    result: { ok: true }
  });
});

test('uses a read-only MCP allowlist by default', () => {
  assert.equal(isToolAllowed({ name: 'search_issues' }, [], []), true);
  assert.equal(isToolAllowed({ name: 'get_issue_comments' }, [], []), true);
  assert.equal(isToolAllowed({ name: 'search_articles' }, [], []), true);
  assert.equal(isToolAllowed({ name: 'update_issue' }, [], []), false);
  assert.equal(isToolAllowed({ name: 'create_article' }, [], []), false);

  const { tools, nameMap } = toLlmTools([
    { name: 'search_issues', inputSchema: { type: 'object' } },
    { name: 'update_issue', inputSchema: { type: 'object' } }
  ], [], []);

  assert.deepEqual(tools.map((tool) => tool.function.name), ['search_issues']);
  assert.equal(nameMap.get('search_issues'), 'search_issues');
});

test('coalesces concurrent MCP initialize calls', async () => {
  const client = new McpHttpClient({ endpoint: 'http://mcp.example', apiKey: '' });
  let initializeCalls = 0;
  let initializedNotifications = 0;

  client.postMessage = async (message) => {
    if (message.method === 'initialize') {
      initializeCalls += 1;
      await wait(5);
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18' }
      };
    }

    if (message.method === 'notifications/initialized') {
      initializedNotifications += 1;
      return null;
    }

    throw new Error(`unexpected method ${message.method}`);
  };

  await Promise.all([
    client.initialize(),
    client.initialize(),
    client.initialize()
  ]);

  assert.equal(initializeCalls, 1);
  assert.equal(initializedNotifications, 1);
  assert.equal(client.initialized, true);
});
