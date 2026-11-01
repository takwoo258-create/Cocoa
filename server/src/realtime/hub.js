import { WebSocketServer } from 'ws';
import { resolveUser } from '../auth/middleware.js';
import logger from '../core/logger.js';

const log = logger;
const sockets = new Map(); // userId -> Set<ws>
let wss = null;

export function attachWebSocket(server, path = '/ws') {
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) return;
    const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = resolveUser(token);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      ws.isAlive = true;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const set = sockets.get(ws.userId) || new Set();
    set.add(ws);
    sockets.set(ws.userId, set);
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('close', () => {
      set.delete(ws);
      if (!set.size) sockets.delete(ws.userId);
    });
    ws.on('error', () => {});
    send(ws, { type: 'ready', userId: ws.userId, at: new Date().toISOString() });
    log.debug('WS 连接', ws.userId, '在线连接数', set.size);
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, 30_000);
  interval.unref?.();
  return wss;
}

function send(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  } catch {}
}

export function broadcast(userId, event) {
  const set = sockets.get(String(userId));
  if (!set) return 0;
  let n = 0;
  for (const ws of set) {
    send(ws, event);
    n++;
  }
  return n;
}

export function broadcastToCharacter(userId, characterId, event) {
  return broadcast(userId, { ...event, characterId });
}

export function onlineUserIds() {
  return [...sockets.keys()];
}

export function connectionCount() {
  let n = 0;
  for (const set of sockets.values()) n += set.size;
  return n;
}
