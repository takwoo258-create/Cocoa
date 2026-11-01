// OneBot / NapCat 反向 WebSocket 服务端（与 Express 同端口，noServer 模式监听 upgrade）
import { WebSocketServer } from 'ws';
import { getOnebotConfig } from '../services/settings.js';
import logger from '../core/logger.js';
import { handleIncomingEvent, recordMessage } from './handler.js';

const clients = new Set();
const pending = new Map(); // echo -> { resolve, timer }

const stats = {
  startedAt: null,
  lastEventAt: null,
  lastReplyAt: null,
  lastError: null,
  events: 0,
  replies: 0,
  errors: 0,
};

let wss = null;
let heartbeat = null;
let echoSeq = 0;

function normalizePath(p) {
  const raw = String(p || '/onebot/ws').trim();
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw.replace(/\/+$/, '') || '/onebot/ws';
}

function currentConfig() {
  const cfg = getOnebotConfig();
  return {
    token: String(cfg.token || ''),
    selfId: String(cfg.selfId || ''),
    wsPath: normalizePath(cfg.wsPath),
  };
}

function sendJson(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** 向所有反向 WS 客户端发送 action，等待 echo 回执 */
export function sendAction(action, params = {}, timeoutMs = 10_000) {
  const ws = [...clients].find((c) => c.readyState === 1);
  if (!ws) return Promise.resolve({ ok: false, reason: 'not_connected' });
  const echo = `cocoa_${Date.now()}_${++echoSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(echo);
      resolve({ ok: false, reason: 'timeout', echo });
    }, timeoutMs);
    pending.set(echo, {
      timer,
      resolve: (data) => {
        clearTimeout(timer);
        pending.delete(echo);
        const retcode = Number(data?.retcode ?? 0);
        resolve({ ok: retcode === 0, reason: retcode === 0 ? null : data?.wording || data?.msg || 'action_failed', echo, data });
      },
    });
    try {
      ws.send(JSON.stringify({ action, params, echo }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(echo);
      resolve({ ok: false, reason: err.message || 'send_failed' });
    }
  });
}

/** 发送私聊消息；无连接时返回 {ok:false, reason:'not_connected'} */
export function sendPrivate(qq, text) {
  if (!qq || !text) return Promise.resolve({ ok: false, reason: 'invalid_params' });
  const numeric = /^\d+$/.test(String(qq)) ? Number(qq) : String(qq);
  return sendAction('send_private_msg', { user_id: numeric, message: String(text) });
}

/** 发送 QQ 空间说说（NapCat send_qzone_msg 扩展动作） */
export async function sendQzonePost({ content = '', images = [], ugcRight = 1 } = {}) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, reason: 'content_required' };
  const params = { content: text, ugc_right: Number(ugcRight) || 1 };
  if (Array.isArray(images) && images.length) params.images = images.slice(0, 9).map(String);
  const result = await sendAction('send_qzone_msg', params, 20_000);
  if (!result.ok) return { ok: false, reason: result.reason, data: result.data };
  const data = result.data?.data || result.data || {};
  return { ok: true, tid: data.tid || null, time: data.time || 0, raw: result.data };
}

export function onebotStatus() {
  const cfg = currentConfig();
  return {
    connected: clients.size > 0,
    clients: clients.size,
    selfId: cfg.selfId,
    wsPath: cfg.wsPath,
    tokenRequired: Boolean(cfg.token),
    attached: Boolean(wss),
    startedAt: stats.startedAt,
    lastEventAt: stats.lastEventAt,
    lastReplyAt: stats.lastReplyAt,
    events: stats.events,
    replies: stats.replies,
    errors: stats.errors,
    lastError: stats.lastError,
  };
}

async function onEvent(ws, data) {
  stats.events += 1;
  stats.lastEventAt = new Date().toISOString();
  let result;
  try {
    result = await handleIncomingEvent(data);
  } catch (err) {
    stats.errors += 1;
    stats.lastError = err?.message || String(err);
    logger.error('OneBot 事件处理异常', err?.stack || err?.message);
    return;
  }
  if (!result?.reply) return;
  recordMessage({ userId: result.userId || null, qq: result.qq, direction: 'out', content: result.reply });
  const sent = await sendPrivate(result.qq, result.reply);
  if (sent.ok) {
    stats.replies += 1;
    stats.lastReplyAt = new Date().toISOString();
  } else if (sent.reason !== 'not_connected') {
    stats.errors += 1;
    stats.lastError = sent.reason;
    logger.warn('OneBot 回复发送失败', sent.reason);
  } else {
    // 仅单连接场景下才会走到这里：用当前连接兜底发送
    sendJson(ws, { action: 'send_private_msg', params: { user_id: result.qq, message: result.reply }, echo: `cocoa_local_${++echoSeq}` });
  }
}

/**
 * 挂载 OneBot 反向 WS 到现有 http.Server（与 Express / /ws 同端口）。
 * 由 index.js 在创建 server 后调用：attachOnebot(server)
 * 重复调用安全（返回既有实例）。
 */
export function attachOnebot(server) {
  if (wss) return wss;
  const cfg = currentConfig();
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return;
    }
    if (url.pathname !== currentConfig().wsPath) return;
    const conf = currentConfig();
    const token = url.searchParams.get('access_token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (conf.token && token !== conf.token) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      } catch {}
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.onebot = true;
      ws.isAlive = true;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    stats.startedAt = stats.startedAt || new Date().toISOString();
    logger.info('OneBot 反向 WS 已连接', req?.socket?.remoteAddress || '', '当前连接数', clients.size);

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (data?.echo !== undefined && pending.has(String(data.echo))) {
        pending.get(String(data.echo))?.resolve?.(data);
        return;
      }
      if (!data?.post_type && data?.message === undefined) return;
      void onEvent(ws, data);
    });
    ws.on('close', () => {
      clients.delete(ws);
      logger.info('OneBot 反向 WS 已断开', '剩余连接数', clients.size);
    });
    ws.on('error', (err) => {
      stats.errors += 1;
      stats.lastError = err?.message || 'ws_error';
      logger.warn('OneBot WS 错误', err?.message);
    });
  });

  heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, 30_000);
  heartbeat.unref?.();

  logger.debug('OneBot 反向 WS 已挂载', cfg.wsPath);
  return wss;
}

export function detachOnebot() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  for (const ws of clients) {
    try {
      ws.close();
    } catch {}
  }
  clients.clear();
  for (const [, item] of pending) clearTimeout(item.timer);
  pending.clear();
  try {
    wss?.close();
  } catch {}
  wss = null;
  stats.startedAt = null;
}

export default { attachOnebot, detachOnebot, sendAction, sendPrivate, onebotStatus };
