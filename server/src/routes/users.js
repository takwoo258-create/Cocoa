import { Router } from 'express';
import { get, run } from '../db/index.js';
import { hashPassword, verifyPassword, sha256 } from '../core/crypto.js';
import { nowIso } from '../core/util.js';
import { badRequest, conflict, unauthorized, asyncHandler } from '../core/errors.js';
import { requireAuth } from '../auth/middleware.js';
import { publicUser } from './auth.js';
import { getUserApi } from '../services/settings.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.get('/me', (req, res) => {
    const cfg = getUserApi(req.userId);
    res.json({
      user: publicUser(req.user),
      ready: { chat: Boolean(cfg.chat.apiKey), embedding: Boolean(cfg.embedding.apiKey) },
    });
  });

  r.put(
    '/me',
    asyncHandler(async (req, res) => {
      const user = get('SELECT * FROM users WHERE id = ?', req.userId);
      const patch = {};
      const { username, email, qq, password, newPassword, oldPassword } = req.body || {};

      if (username !== undefined && username !== user.username) {
        const name = String(username).trim();
        if (!/^[\w\u4e00-\u9fa5.-]{2,32}$/.test(name)) throw badRequest('用户名格式不正确', 'username_invalid');
        if (get('SELECT id FROM users WHERE username = ? AND id <> ?', name, user.id)) throw conflict('用户名已被占用', 'username_taken');
        patch.username = name;
      }
      if (email !== undefined && String(email).toLowerCase() !== user.email) {
        const mail = String(email).toLowerCase().trim();
        if (!EMAIL_RE.test(mail)) throw badRequest('邮箱格式不正确', 'email_invalid');
        if (get('SELECT id FROM users WHERE email = ? AND id <> ?', mail, user.id)) throw conflict('邮箱已被占用', 'email_taken');
        patch.email = mail;
      }
      if (qq !== undefined && String(qq) !== (user.qq || '')) {
        const q = String(qq).trim();
        if (!/^\d{5,12}$/.test(q)) throw badRequest('QQ 号格式不正确', 'qq_invalid');
        if (get('SELECT id FROM users WHERE qq = ? AND id <> ?', q, user.id)) throw conflict('QQ 号已绑定其他账号', 'qq_taken');
        patch.qq = q;
      }
      const nextPassword = newPassword ?? password;
      if (nextPassword) {
        if (String(nextPassword).length < 8) throw badRequest('密码长度至少 8 位', 'password_weak');
        if (!verifyPassword(String(oldPassword || ''), user.password_hash, user.password_salt)) {
          throw unauthorized('原密码不正确', 'password_invalid');
        }
        const { hash, salt } = hashPassword(String(nextPassword));
        patch.password_hash = hash;
        patch.password_salt = salt;
        run('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash <> ?', user.id, sha256(req.token));
      }

      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
        run(`UPDATE users SET ${sets} WHERE id = ?`, ...Object.values(patch), user.id);
      }
      const updated = get('SELECT * FROM users WHERE id = ?', user.id);
      res.json({ user: publicUser(updated), updatedAt: nowIso() });
    }),
  );

  return r;
}
