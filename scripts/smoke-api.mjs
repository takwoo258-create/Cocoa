#!/usr/bin/env node
/**
 * Cocoa 后端接口冒烟（对已部署实例执行，只读为主，会创建 1 个测试用户）
 *
 * 用法：
 *   node scripts/smoke-api.mjs [--base http://127.0.0.1:8787] [--kill-user]
 *   # 远程服务器上运行时没有 SMTP 时验证码不会回显，可用管理员账号跳过注册：
 *   COCOA_ADMIN_EMAIL=admin@cocoa.local COCOA_ADMIN_PASSWORD=xxx node scripts/smoke-api.mjs --base http://127.0.0.1:8787
 *
 * 退出码：0 全部关键步骤通过；1 有失败
 */
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = (argOf('--base', process.env.COCOA_BASE || 'http://127.0.0.1:8787')).replace(/\/$/, '');
const ADMIN_EMAIL = process.env.COCOA_ADMIN_EMAIL || '';
const ADMIN_PASS = process.env.COCOA_ADMIN_PASSWORD || '';

const results = [];
const stamp = Date.now();
const EMAIL = `smoke+${stamp}@example.com`;
const PASSWORD = `Smoke-${stamp}-pwd`;

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${step}${detail ? ` — ${detail}` : ''}`);
}

async function req(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = raw ? text : text.slice(0, 200);
  }
  return { status: res.status, data, raw: text };
}

const brief = (r) => `HTTP ${r.status} ${typeof r.data === 'string' ? r.data.slice(0, 120) : JSON.stringify(r.data).slice(0, 200)}`;

async function main() {
  // 1) 健康检查
  const health = await req('/api/health');
  record('GET /api/health', health.status === 200 && health.data?.ok === true, brief(health));

  // 2) 认证：拿管理员令牌（优先），否则走注册流程
  let token = null;
  if (ADMIN_EMAIL && ADMIN_PASS) {
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: ADMIN_EMAIL, mode: 'password', password: ADMIN_PASS },
    });
    token = login.data?.token || null;
    record('POST /api/auth/login (admin)', login.status === 200 && !!token, brief(login));
  }

  if (!token) {
    const code = await req('/api/auth/send-code', { method: 'POST', body: { email: EMAIL, purpose: 'register' } });
    record('POST /api/auth/send-code', code.status === 200, brief(code));
    const devCode = code.data?.devCode;
    if (!devCode) {
      record('注册流程（SMTP 已配置，无法自动取码）', true, '跳过：生产环境不回显 devCode，改传 COCOA_ADMIN_EMAIL/PASSWORD');
    } else {
      const reg = await req('/api/auth/register', {
        method: 'POST',
        body: { username: `smoke${stamp}`, email: EMAIL, password: PASSWORD, confirmPassword: PASSWORD, qq: '', code: devCode },
      });
      token = reg.data?.token || null;
      record('POST /api/auth/register', reg.status === 201 || reg.status === 200, brief(reg));
    }
  }

  // 3) 用户资料
  if (token) {
    const me = await req('/api/users/me', { token });
    record('GET /api/users/me', me.status === 200 && !!me.data?.user, brief(me));
  } else {
    record('GET /api/users/me', false, '无令牌，跳过');
  }

  // 4) 服务配置
  if (token) {
    const cfg = await req('/api/config', { token });
    record('GET /api/config', cfg.status === 200, brief(cfg));
    const prefs = await req('/api/config/preferences', { token });
    record('GET /api/config/preferences', prefs.status === 200, brief(prefs));
  }

  // 5) 角色
  if (token) {
    const chars = await req('/api/characters', { token });
    const okChars = chars.status === 200 && Array.isArray(chars.data);
    record('GET /api/characters', okChars, brief(chars));
    const created = await req('/api/characters', {
      method: 'POST',
      token,
      body: {
        name: '冒烟角色', age: '20', race: '人类', gender: '女', personality: '温柔',
        worldview: '现代都市', hobbies: '看书', relation: '朋友', appearance: '黑发', occupation: '学生',
      },
    });
    record('POST /api/characters', created.status === 201 || created.status === 200, brief(created));
  }

  // 6) 统计
  if (token) {
    const usage = await req('/api/stats/usage?range=7d', { token });
    record('GET /api/stats/usage', usage.status === 200 && !!usage.data?.totals, brief(usage));
  }

  // 7) WebSocket（可选，失败不致命）
  if (token) {
    try {
      const evt = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${token}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('ws timeout 8s')); }, 8000);
        ws.onmessage = (e) => { clearTimeout(t); ws.close(); resolve(String(e.data).slice(0, 120)); };
        ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
      });
      record('WS /ws', true, evt);
    } catch (err) {
      record('WS /ws', false, err.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── 汇总：${results.length - failed.length}/${results.length} 通过 ──`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('冒烟脚本异常：', err.message);
  process.exit(1);
});
