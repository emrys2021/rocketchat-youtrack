const autoReplyPatterns = [
  /^hey,\s*i received your message and will get back to you as soon as possible\.?$/i,
  /^i received your message and will get back to you/i,
  /\bauto[-\s]?reply\b/i
];

export function isAutoReplyText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return autoReplyPatterns.some((pattern) => pattern.test(value));
}

export function isSystemMessageType(type) {
  return Boolean(type && type !== 'message');
}
