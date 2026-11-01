import nodemailer from 'nodemailer';
import { getSmtpConfig } from '../services/settings.js';
import env from '../env.js';
import logger from '../core/logger.js';

let cached = null;
let cachedKey = '';

function transport() {
  const cfg = getSmtpConfig();
  const key = `${cfg.host}|${cfg.port}|${cfg.user}|${cfg.pass}`;
  if (cached && cachedKey === key) return { cfg, tx: cached };
  if (!cfg.host || !cfg.user) return { cfg, tx: null };
  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: Boolean(cfg.secure),
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  cachedKey = key;
  return { cfg, tx: cached };
}

export async function sendMail({ to, subject, text, html }) {
  const { cfg, tx } = transport();
  if (!tx) {
    logger.warn('SMTP 未配置，邮件未发送', to, subject);
    return { ok: false, reason: 'smtp_not_configured' };
  }
  const from = cfg.from || cfg.user;
  await tx.sendMail({ from, to, subject, text, html });
  return { ok: true };
}

export async function sendCodeEmail(to, code, purpose = 'register') {
  const title = purpose === 'login' ? 'Cocoa 登录验证码' : 'Cocoa 注册验证码';
  const text = `你的 Cocoa 验证码是 ${code}，10 分钟内有效。若非本人操作请忽略。`;
  const html = `<div style="font-family:system-ui;padding:24px"><h2>Cocoa</h2><p>${text}</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p></div>`;
  try {
    return await sendMail({ to, subject: title, text, html });
  } catch (err) {
    logger.error('发送验证码失败', err.message);
    return { ok: false, reason: err.message };
  }
}

export const mailConfigured = () => Boolean(getSmtpConfig().host && getSmtpConfig().user);
export { env };
