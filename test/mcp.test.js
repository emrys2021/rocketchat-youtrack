import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseMessages } from '../src/mcp.js';

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
