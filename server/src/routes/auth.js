import { Router } from 'express';
import { get, run } from '../db/index.js';
import { hashPassword, verifyPassword, signToken, sha256, randomCode, randomToken, hmac } from '../core/crypto.js';
import { nowIso, uuid } from '../core/util.js';
import { badRequest, conflict, unauthorized, asyncHandler } from '../core/errors.js';
import { sendCodeEmail } from '../mail/sender.js';
import { rateLimit, clientKey } from '../core/ratelimit.js';
import { requireAuth } from '../auth/middleware.js';
import env from '../env.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    qq: row.qq,
    role: row.role,
    emailVerified: Boolean(row.email_verified),
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastActiveAt: row.last_active_at,
  };
}

function issueToken(user, req) {
  const token = signToken({ uid: user.id, role: user.role }, env.tokenTtlSec);
  const expires = new Date(Date.now() + env.tokenTtlSec * 1000).toISOString();
  run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at, user_agent) VALUES(?,?,?,?,?)',
    sha256(token),
    user.id,
    nowIso(),
    expires,
    String(req.headers['user-agent'] || '').slice(0, 200),
  );
  run('UPDATE users SET last_login_at = ?, last_active_at = ? WHERE id = ?', nowIso(), nowIso(), user.id);
  return { token, expiresAt: expires };
}

function consumeCode(email, purpose, code) {
  const row = get(
    'SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY created_at DESC LIMIT 1',
    email,
    purpose,
  );
  if (!row) throw badRequest('请先获取验证码', 'code_missing');
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest('验证码已过期，请重新获取', 'code_expired');
  if (row.attempts >= 5) throw badRequest('验证码错误次数过多，请重新获取', 'code_locked');
  const expect = hmac(`${purpose}:${email}:${code}`);
  if (expect !== row.code_hash) {
    run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    throw badRequest('验证码不正确', 'code_invalid');
  }
  run('UPDATE email_codes SET used = 1 WHERE id = ?', row.id);
}

export default function register() {
  const r = Router();

  r.post(
    '/send-code',
    asyncHandler(async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const purpose = req.body?.purpose === 'login' ? 'login' : 'register';
      if (!EMAIL_RE.test(email)) throw badRequest('邮箱格式不正确', 'email_invalid');
      const limit = rateLimit({ key: clientKey(req, `code:${email}`), limit: 1, windowMs: 60_000 });
      if (!limit.ok) throw badRequest('验证码发送过于频繁，请 60 秒后再试', 'code_too_frequent');
      const exists = get('SELECT id FROM users WHERE email = ?', email);
      if (purpose === 'register' && exists) throw conflict('该邮箱已注册，请直接登录', 'email_registered');
      if (purpose === 'login' && !exists) throw badRequest('该邮箱尚未注册', 'email_not_found');
      if (purpose === 'register' && !env.allowRegister) throw badRequest('当前已关闭注册', 'register_closed');

      const code = randomCode(6);
      run(
        'INSERT INTO email_codes(id, email, purpose, code_hash, expires_at, created_at) VALUES(?,?,?,?,?,?)',
        uuid(),
        email,
        purpose,
        hmac(`${purpose}:${email}:${code}`),
        new Date(Date.now() + 10 * 60_000).toISOString(),
        nowIso(),
      );
      const sent = await sendCodeEmail(email, code, purpose);
      res.json({
        ok: true,
        sent: sent.ok,
        cooldown: 60,
        // 仅开发环境且未配置 SMTP 时回显，便于本地联调
        ...(sent.ok ? {} : env.nodeEnv !== 'production' ? { devCode: code } : {}),
        ...(sent.ok ? {} : { warning: '邮件服务未配置，验证码未能通过邮件送达' }),
      });
    }),
  );

  r.post(
    '/register',
    asyncHandler(async (req, res) => {
      if (!env.allowRegister) throw badRequest('当前已关闭注册', 'register_closed');
      const username = String(req.body?.username || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const confirmPassword = String(req.body?.confirmPassword ?? req.body?.confirm ?? '');
      const qq = String(req.body?.qq || '').trim();
      const code = String(req.body?.code || '').trim();

      if (!/^[\w\u4e00-\u9fa5.-]{2,32}$/.test(username)) throw badRequest('用户名需 2-32 位，支持中英文、数字、下划线', 'username_invalid');
      if (!EMAIL_RE.test(email)) throw badRequest('邮箱格式不正确', 'email_invalid');
      if (password.length < 8 || password.length > 64) throw badRequest('密码长度需为 8-64 位', 'password_weak');
      if (password !== confirmPassword) throw badRequest('两次输入的密码不一致', 'password_mismatch');
      if (!/^\d{5,12}$/.test(qq)) throw badRequest('请填写正确的 QQ 号', 'qq_invalid');

      if (get('SELECT id FROM users WHERE email = ?', email)) throw conflict('该邮箱已注册', 'email_registered');
      if (get('SELECT id FROM users WHERE username = ?', username)) throw conflict('该用户名已被使用', 'username_taken');
      if (get('SELECT id FROM users WHERE qq = ?', qq)) throw conflict('该 QQ 号已绑定其他账号', 'qq_taken');

      consumeCode(email, 'register', code);

      const { hash, salt } = hashPassword(password);
      const id = `u_${randomToken(9)}`;
      run(
        `INSERT INTO users(id, username, email, password_hash, password_salt, role, qq, email_verified, created_at)
         VALUES(?,?,?,?,?,'user',?,1,?)`,
        id,
        username,
        email,
        hash,
        salt,
        qq,
        nowIso(),
      );
      const user = get('SELECT * FROM users WHERE id = ?', id);
      const { token } = issueToken(user, req);
      res.status(201).json({ token, user: publicUser(user), needsApiConfig: true });
    }),
  );

  r.post(
    '/login',
    asyncHandler(async (req, res) => {
      const identifier = String(req.body?.identifier || req.body?.email || req.body?.username || '').trim();
      const mode = req.body?.mode === 'code' ? 'code' : 'password';
      if (!identifier) throw badRequest('请输入用户名或邮箱', 'identifier_required');
      const isEmail = EMAIL_RE.test(identifier.toLowerCase());
      const user = isEmail
        ? get('SELECT * FROM users WHERE email = ?', identifier.toLowerCase())
        : get('SELECT * FROM users WHERE username = ?', identifier);
      if (!user) throw unauthorized('账号或凭证不正确', 'login_failed');
      if (user.status !== 'active') throw unauthorized('账号已被停用，请联系管理员', 'account_disabled');

      if (mode === 'password') {
        const password = String(req.body?.password || '');
        if (!password) throw badRequest('请输入密码', 'password_required');
        if (!verifyPassword(password, user.password_hash, user.password_salt)) {
          throw unauthorized('账号或密码不正确', 'login_failed');
        }
      } else {
        if (!isEmail) throw badRequest('验证码登录仅支持邮箱', 'email_required');
        const code = String(req.body?.code || '').trim();
        consumeCode(user.email, 'login', code);
      }
      const { token, expiresAt } = issueToken(user, req);
      res.json({ token, expiresAt, user: publicUser(user) });
    }),
  );

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  r.post('/logout', requireAuth, (req, res) => {
    run('DELETE FROM auth_tokens WHERE token_hash = ?', sha256(req.token));
    res.json({ ok: true });
  });

  r.post('/logout-all', requireAuth, (req, res) => {
    run('DELETE FROM auth_tokens WHERE user_id = ?', req.userId);
    res.json({ ok: true });
  });

  return r;
}
