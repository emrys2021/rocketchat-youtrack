import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIssueIds } from '../src/agent.js';
import { formatWorkItems } from '../src/youtrack-rest.js';

test('extracts readable and database issue ids from tool text', () => {
  const ids = extractIssueIds('Found HZNM-123 and {"idReadable":"OPS-45","id":"2-35"}.');
  assert.deepEqual(ids, ['HZNM-123', 'OPS-45', '2-35']);
});

test('formats work item evidence for LLM context', () => {
  const text = formatWorkItems('OPS-45', [
    {
      date: 1766620800000,
      duration: { minutes: 90, presentation: '1h 30m' },
      type: { name: 'Troubleshooting' },
      author: { name: 'Alice' },
      text: 'Reset browser protocol handler and verified Outlook links open correctly.'
    }
  ]);

  assert.match(text, /Work items for OPS-45/);
  assert.match(text, /Troubleshooting/);
  assert.match(text, /Reset browser protocol handler/);
});
