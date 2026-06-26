import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialSearchReminder, extractIssueIds } from '../src/agent.js';
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
test('builds generic retrieval reminder without naming exact tools', () => {
  const reminder = buildInitialSearchReminder([
    { function: { name: 'search_issues' } },
    { function: { name: 'search_articles' } }
  ]);

  assert.match(reminder, /YouTrack 只读工具/);
  assert.match(reminder, /根据用户问题选择合适/);
  assert.doesNotMatch(reminder, /search_issues/);
  assert.doesNotMatch(reminder, /search_articles/);
});

test('builds retrieval reminder only once and stops after any retrieval tool call', () => {
  const tools = [
    { function: { name: 'search_issues' } },
    { function: { name: 'search_articles' } }
  ];
  const reminded = new Set();

  assert.match(buildInitialSearchReminder(tools, new Set(), reminded), /YouTrack 只读工具/);
  assert.equal(buildInitialSearchReminder(tools, new Set(), reminded), '');
  assert.equal(buildInitialSearchReminder(tools, new Set(['search_issues']), new Set()), '');
});

test('does not build initial retrieval reminder without read-only retrieval tools', () => {
  assert.equal(buildInitialSearchReminder([{ function: { name: 'find_projects' } }]), '');
});
