import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRocketMarkdown } from '../src/text.js';

test('converts Markdown tables to fenced text blocks for Rocket.Chat', () => {
  const input = [
    '今日工单：',
    '',
    '| Issue ID | 标题 | 负责人 |',
    '|---|---|---|',
    '| HELPDESK-4106 | 余荻源 电话调整 | qiuweihao |',
    '| HELPDESK-4105 | 处理 NET&FUQL2606068 | xierulin |'
  ].join('\n');

  const output = normalizeRocketMarkdown(input);

  assert.match(output, /```text/);
  assert.match(output, /Issue ID/);
  assert.doesNotMatch(output, /\|---\|---\|---\|/);
});

test('does not rewrite tables already inside fenced code blocks', () => {
  const input = ['```text', '| a | b |', '|---|---|', '```'].join('\n');
  assert.equal(normalizeRocketMarkdown(input), input);
});
