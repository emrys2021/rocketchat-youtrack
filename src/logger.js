export function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  const output = JSON.stringify(entry);
  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

export function errorToMeta(error) {
  if (!error) return {};
  return {
    error: error.message || String(error),
    stack: error.stack
  };
}
