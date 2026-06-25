export function truncateText(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1[redacted]')
    .replace(/(token["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1[redacted]');
}

export function splitMessage(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
