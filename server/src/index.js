import http from 'node:http';
import env from './env.js';
import logger from './core/logger.js';
import { createApp } from './app.js';
import { attachWebSocket } from './realtime/hub.js';
import { ensureBootstrapAdmin } from './services/bootstrap.js';
import { startScheduler } from './ai/scheduler.js';

const app = createApp();
const server = http.createServer(app);
attachWebSocket(server, '/ws');

ensureBootstrapAdmin();

server.listen(env.port, env.host, () => {
  logger.info(`Cocoa 后端已启动 http://${env.host}:${env.port} (${env.nodeEnv})`);
});

try {
  startScheduler();
} catch (err) {
  logger.error('调度器启动失败', err.message);
}

// OneBot（NapCat）反向 WS：模块未就绪时不影响主服务
try {
  const { attachOnebot } = await import('./onebot/server.js');
  attachOnebot(server);
  logger.info('OneBot 反向 WS 已挂载');
} catch (err) {
  logger.warn('OneBot 模块未就绪，跳过挂载：', err.message);
}

function shutdown(signal) {
  logger.info('收到退出信号', signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', err?.stack || err));
