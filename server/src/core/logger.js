import fs from 'node:fs';
import path from 'node:path';
import env from '../env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[process.env.COCOA_LOG_LEVEL || 'info'] ?? 20;
const logFile = path.join(env.logDir, 'cocoa.log');
const stream = fs.createWriteStream(logFile, { flags: 'a' });

function write(level, scope, args) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`;
  if (LEVELS[level] >= current) console.log(line);
  stream.write(line + '\n');
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope = 'app') {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

export const logger = createLogger('core');
export default logger;
