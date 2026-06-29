import { redactSecrets, truncateText } from './text.js';

export function buildQuestionLogFields(question, loggingConfig = {}) {
  if (!loggingConfig.logUserQuestion) return {};

  const maxChars = Number.isFinite(loggingConfig.logUserQuestionMaxChars)
    ? loggingConfig.logUserQuestionMaxChars
    : 500;
  const safeLimit = Math.max(50, Math.floor(maxChars));
  const questionPreview = truncateText(redactSecrets(String(question || '')), safeLimit);

  return questionPreview ? { questionPreview } : {};
}
