// Timestamped stdout logging.
// SECURITY: never pass passwords, password hashes, session IDs, tokens,
// or full settings values to these functions.
function write(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  process.stdout.write(line);
}

export const logger = {
  info: (msg) => write('INFO', String(msg)),
  warn: (msg) => write('WARN', String(msg)),
  error: (msg) => write('ERROR', String(msg)),
};
