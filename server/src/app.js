import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import env from './env.js';
import logger from './core/logger.js';
import { AppError } from './core/errors.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import configRouter from './routes/config.js';
import charactersRouter from './routes/characters.js';
import chatRouter from './routes/chat.js';
import memoryRouter from './routes/memory.js';
import booksRouter from './routes/books.js';
import statsRouter from './routes/stats.js';
import adminRouter from './routes/admin.js';
import mediaRouter from './routes/media.js';
import onebotRouter from './routes/onebot.js';
import versionRouter from './routes/version.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        logger.debug('http', req.method, req.path, res.statusCode, `${Date.now() - started}ms`);
      }
    });
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      name: 'cocoa',
      version: '1.1.0',
      time: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  });

  app.use('/api/auth', authRouter());
  app.use('/api/users', usersRouter());
  app.use('/api/config', configRouter());
  // 角色路由先挂载：只处理 /、/expand、/templates、/:id、/:id/settings、/:id/state
  app.use('/api/characters', charactersRouter());
  // 聊天路由与角色路由共用 /api/characters 前缀（聊天仅处理 /:id/messages 等，其余 next()）
  const chat = chatRouter();
  app.use('/api/characters', chat);
  app.use('/api/chat', chat);
  app.use('/api/memory', memoryRouter());
  app.use('/api/books', booksRouter());
  app.use('/api/stats', statsRouter());
  app.use('/api/admin', adminRouter());
  app.use('/api/media', mediaRouter());
  app.use('/api/version', versionRouter());
  app.use('/onebot', onebotRouter());
  app.use('/api/onebot', onebotRouter());

  // 可选前端（若存在 web 构建产物）
  const webDist = path.join(env.root, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|static|onebot|ws).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((req, res, next) => next(new AppError(404, 'not_found', `接口不存在：${req.method} ${req.path}`)));

  // 统一错误处理
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error('unhandled', req.method, req.path, err.stack || err.message);
    else logger.debug('handled', req.method, req.path, err.message);
    res.status(status).json({
      error: {
        code: err.code || 'internal_error',
        message: err.message || '服务器内部错误',
        ...(err.extra ? { detail: err.extra } : {}),
      },
    });
  });

  return app;
}

export default createApp;
