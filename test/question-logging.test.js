import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionLogFields } from '../src/question-logging.js';

test('does not log question previews by default', () => {
  assert.deepEqual(buildQuestionLogFields('outlook 打不开超链接'), {});
});

test('logs redacted and truncated question previews when enabled', () => {
  const fields = buildQuestionLogFields(
    '请查一下 token: secret-value 这个报错是否有人处理过，错误详情很多很多。用户贴了很长的堆栈信息，需要确认是否有类似 issue 和解决方案。',
    {
      logUserQuestion: true,
      logUserQuestionMaxChars: 30
    }
  );

  assert.match(fields.questionPreview, /token: \[redacted\]/);
  assert.match(fields.questionPreview, /\[truncated \d+ chars\]/);
  assert.equal(fields.questionPreview.includes('secret-value'), false);
});
