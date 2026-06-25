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

export function normalizeRocketMarkdown(text) {
  if (typeof text !== 'string' || !text.includes('|')) return text || '';

  const lines = text.split(/\r?\n/);
  const output = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      output.push(line);
      continue;
    }

    if (!inFence && isTableRow(line) && isTableSeparator(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      output.push(formatMarkdownTableAsTextBlock(tableLines));
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function isTableRow(line = '') {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.slice(1, -1).includes('|');
}

function isTableSeparator(line = '') {
  if (!isTableRow(line)) return false;
  return splitTableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function formatMarkdownTableAsTextBlock(tableLines) {
  const rows = tableLines
    .filter((line, index) => index !== 1)
    .map(splitTableCells);
  const widths = [];

  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, cell.length);
    });
  }

  const body = rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index] || 0)).join('  ').trimEnd())
    .join('\n');

  return ['```text', body, '```'].join('\n');
}
