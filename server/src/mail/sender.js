// 邮件发送与品牌化模板（可可色 #6b4a35 / 米色 #fbf3ea，内联 CSS，表格布局兼容邮件客户端）
// 兼容保留：sendMail({to,subject,text,html}) / sendCodeEmail(to, code, purpose)
// 新增：renderEmail / codeEmailTemplate / shareNoticeTemplate / expiryNoticeTemplate / sendShareNotice / sendExpiryNotice
import nodemailer from 'nodemailer';
import { getSmtpConfig, getAdminSetting } from '../services/settings.js';
import env from '../env.js';
import logger from '../core/logger.js';

const BRAND = {
  cocoa: '#6b4a35',
  cocoaDeep: '#4a3324',
  cocoaLight: '#8c6247',
  cream: '#fbf3ea',
  sand: '#f3e3d1',
  ink: '#3b2a1e',
  muted: '#8a7461',
  line: '#e8d7c3',
  white: '#ffffff',
};
const FOOTER = 'Cocoa · Sand Salt';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

const SERVICE_LABELS = {
  chat: '对话',
  embedding: '嵌入',
  deepseek: 'DeepSeek',
  stt: '语音识别',
  tts: '语音合成',
  vision: '图片理解',
  search: '网页搜索',
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serviceNames(services) {
  const list = Array.isArray(services) ? services : services ? [services] : [];
  return list.map((s) => SERVICE_LABELS[String(s)] || String(s)).filter(Boolean);
}

function formatTime(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) return `${text.slice(0, 16)}（UTC+8）`;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  // 统一按 UTC+8 展示
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}（UTC+8）`;
}

// v1.5.0：管理端可在 admin_settings.mailTemplates 覆盖标题/正文（占位变量 {{name}} {{shareId}} {{expiresAt}} {{time}} {{reason}}）
export const MAIL_TEMPLATE_KINDS = ['code', 'share', 'expiry', 'quota', 'ban'];

export function fillPlaceholders(text, vars = {}) {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]),
  );
}

/** 读取某类邮件的覆盖模板（未配置返回 null） */
export function mailTemplateOverride(kind) {
  let cfg = {};
  try {
    cfg = getAdminSetting('mailTemplates', {}) || {};
  } catch {
    return null;
  }
  const item = cfg[String(kind || '')];
  if (!item || typeof item !== 'object') return null;
  const subject = typeof item.subject === 'string' ? item.subject.trim().slice(0, 200) : '';
  const body = typeof item.body === 'string' ? item.body.slice(0, 4000) : '';
  if (!subject && !body) return null;
  return { subject, body };
}

/** 用覆盖模板替换标题与正文；未配置则原样返回 */
export function applyMailOverride(kind, tpl, vars = {}) {
  const override = mailTemplateOverride(kind);
  if (!override) return tpl;
  const subject = override.subject ? fillPlaceholders(override.subject, vars) : tpl.subject;
  if (!override.body) return { ...tpl, subject, overridden: true };
  const lines = fillPlaceholders(override.body, vars)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rendered = renderEmail({
    title: subject,
    preheader: lines[0] || subject,
    paragraphs: lines,
    notice: '',
    footerNote: '',
  });
  return { ...tpl, subject, html: rendered.html, text: rendered.text, overridden: true };
}

function nowUtc8() {
  const t = new Date(Date.now() + 8 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 19)}`;
}

/**
 * 统一品牌模板。全部使用内联 CSS（Gmail/QQ 邮箱会剥离 <style>）。
 * @returns {{html:string, text:string}}
 */
export function renderEmail({
  title = '',
  preheader = '',
  paragraphs = [],
  code = '',
  meta = [],
  action = null,
  notice = '',
  footerNote = '',
} = {}) {
  const lines = Array.isArray(paragraphs) ? paragraphs.filter(Boolean) : paragraphs ? [paragraphs] : [];
  const metaRows = (Array.isArray(meta) ? meta : []).filter((row) => Array.isArray(row) && row[0] && row[1] !== undefined && row[1] !== '');
  const actionLabel = action?.label ? escapeHtml(action.label) : '';
  const actionUrl = action?.url ? String(action.url) : '';
  const year = new Date().getUTCFullYear();

  const paragraphHtml = lines
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.75;color:${BRAND.ink};">${escapeHtml(p)}</p>`,
    )
    .join('');

  const codeHtml = code
    ? `<div style="margin:20px 0 22px;text-align:center;">
         <div style="display:inline-block;background:${BRAND.cream};border:1px dashed ${BRAND.cocoa};border-radius:14px;padding:16px 26px;font-family:${MONO};font-size:28px;letter-spacing:9px;font-weight:700;color:${BRAND.cocoa};">${escapeHtml(code)}</div>
         <div style="margin-top:10px;font-size:12px;color:${BRAND.muted};">请勿把验证码告诉任何人</div>
       </div>`
    : '';

  const actionHtml = actionLabel && actionUrl
    ? `<div style="margin:22px 0 6px;">
         <a href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener"
            style="display:inline-block;background:${BRAND.cocoa};color:${BRAND.white};text-decoration:none;font-size:14px;font-weight:600;padding:12px 26px;border-radius:999px;">
           ${actionLabel}
         </a>
       </div>`
    : '';

  const metaHtml = metaRows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="margin:16px 0 6px;background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:12px;padding:4px 0;">
         ${metaRows
           .map(
             ([k, v], idx) => `<tr>
               <td style="padding:10px 16px;font-size:13px;color:${BRAND.muted};white-space:nowrap;${idx ? `border-top:1px solid ${BRAND.line};` : ''}">${escapeHtml(k)}</td>
               <td style="padding:10px 16px;font-size:13px;color:${BRAND.cocoaDeep};font-weight:600;${idx ? `border-top:1px solid ${BRAND.line};` : ''}">${escapeHtml(v)}</td>
             </tr>`,
           )
           .join('')}
       </table>`
    : '';

  const noticeHtml = notice
    ? `<div style="margin:18px 0 4px;padding:12px 14px;background:${BRAND.sand};border-left:4px solid ${BRAND.cocoa};border-radius:8px;font-size:13px;line-height:1.7;color:${BRAND.cocoaDeep};">
         ${escapeHtml(notice)}
       </div>`
    : '';

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title || FOOTER)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};font-family:${FONT};color:${BRAND.ink};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:30px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:560px;width:100%;background:${BRAND.white};border:1px solid ${BRAND.line};border-radius:18px;overflow:hidden;">
          <tr>
            <td style="background:${BRAND.cocoa};background-image:linear-gradient(135deg,${BRAND.cocoa},${BRAND.cocoaLight});padding:24px 30px;">
              <div style="font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:4px;color:${BRAND.sand};text-transform:uppercase;">COCOA</div>
              <div style="margin-top:8px;font-family:${FONT};font-size:22px;line-height:1.35;font-weight:700;color:${BRAND.white};">${escapeHtml(title)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 30px 6px;">
              ${paragraphHtml}
              ${codeHtml}
              ${actionHtml}
              ${metaHtml}
              ${noticeHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 30px 26px;">
              <div style="border-top:1px solid ${BRAND.line};margin:0 0 14px;"></div>
              <div style="font-family:${FONT};font-size:14px;font-weight:700;color:${BRAND.cocoa};">${FOOTER}</div>
              <div style="margin-top:6px;font-family:${FONT};font-size:12px;line-height:1.7;color:${BRAND.muted};">
                ${footerNote ? `${escapeHtml(footerNote)}<br>` : ''}此邮件由 Cocoa 自动发送，请勿直接回复。
              </div>
            </td>
          </tr>
        </table>
        <div style="margin-top:14px;font-family:${FONT};font-size:11px;color:#a89380;">© ${year} ${FOOTER} · 与角色的每一句对话，都留在这里</div>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textParts = [
    `【${title || FOOTER}】`,
    '',
    ...lines,
    code ? `验证码：${code}` : '',
    actionLabel && actionUrl ? `${actionLabel}：${actionUrl}` : '',
    ...metaRows.map(([k, v]) => `${k}：${v}`),
    notice ? `提示：${notice}` : '',
    '',
    FOOTER,
    footerNote || '',
    '此邮件由 Cocoa 自动发送，请勿直接回复。',
  ].filter((line) => line !== undefined && line !== null && line !== '');

  return { html, text: textParts.join('\n') };
}

/** 验证码邮件（注册 / 登录 / 重置密码） */
export function codeEmailTemplate({ code = '', purpose = 'register', email = '', minutes = 10 } = {}) {
  const label = purpose === 'login' ? '登录验证码' : purpose === 'reset' ? '重置密码验证码' : '注册验证码';
  const verb = purpose === 'login' ? '登录' : purpose === 'reset' ? '重置密码' : '注册';
  const meta = [
    ['用途', label],
    ['有效期', `${minutes} 分钟`],
  ];
  if (email) meta.push(['接收邮箱', email]);
  const base = {
    subject: `【Cocoa】${label}`,
    ...renderEmail({
      title: label,
      preheader: `你的 Cocoa 验证码是 ${code}，${minutes} 分钟内有效。`,
      paragraphs: [
        `你好${email ? `（${email}）` : ''}：`,
        `你正在${verb} Cocoa。请在客户端填入下方验证码完成验证，验证码 ${minutes} 分钟内有效。`,
      ],
      code,
      meta,
      notice: '若非本人操作，请忽略本邮件，你的账号不会有任何改动。',
      footerNote: 'Cocoa 不会通过邮件索取密码、API Key 或验证码。',
    }),
  };
  return applyMailOverride('code', base, {
    name: email || '',
    code,
    shareId: '',
    expiresAt: `${minutes} 分钟`,
    time: nowUtc8(),
    reason: '',
  });
}

/** 分享 / 索要通知（direction: share 对方分享给我；request 对方索要我；result 处理结果） */
export function shareNoticeTemplate(payload = {}) {
  const {
    direction = 'share',
    ownerName = '',
    targetName = '',
    services = [],
    permanent = false,
    durationText = '',
    expiresAt = '',
    note = '',
    accepted,
    actionUrl = '',
  } = payload;

  const names = serviceNames(services);
  const serviceText = names.length ? names.join('、') : '对话与嵌入';
  const validity = permanent ? '永久有效' : expiresAt ? `有效期至 ${formatTime(expiresAt)}` : durationText || '按申请时长';

  let title = '收到模型分享';
  let subject = '【Cocoa】收到模型分享';
  let paragraphs;
  let notice = '';

  if (direction === 'request') {
    title = '模型分享请求';
    subject = '【Cocoa】模型分享请求';
    paragraphs = [
      `${ownerName || '对方'}（代号 ${targetName || '未知'}）希望使用你的模型服务。`,
      `服务：${serviceText}；${validity}。`,
      note ? `附言：${note}` : '请前往「设置 - 模型分享」接受或拒绝该请求。',
    ];
    notice = '若 72 小时内未处理，请求会在「模型分享」的历史记录中保留，可随时处理。';
  } else if (direction === 'result') {
    const ok = accepted !== false;
    title = ok ? '模型分享已生效' : '模型分享未通过';
    subject = `【Cocoa】${title}`;
    paragraphs = [
      ok
        ? `${targetName || '对方'}（代号 ${ownerName || '未知'}）已接受你的模型分享，现在起可以使用你的 ${serviceText} 服务。`
        : `${targetName || '对方'}（代号 ${ownerName || '未知'}）没有接受本次模型分享请求。`,
      ok ? `有效期：${validity}。` : '你可以稍后再次发起请求。',
    ];
  } else {
    paragraphs = [
      `${ownerName || '对方'}（代号 ${targetName || '未知'}）向你分享了模型服务。`,
      `服务：${serviceText}；${validity}。`,
      note ? `附言：${note}` : '现在你可以在未配置对应服务时直接使用这份分享。',
    ];
    notice = '分享仅授予模型调用权限，对方无法查看你的对话内容。';
  }

  const base = {
    subject,
    ...renderEmail({
      title,
      preheader: `${ownerName || '对方'} · ${serviceText} · ${validity}`,
      paragraphs,
      meta: [
        ['服务', serviceText],
        ['有效期', validity],
        ...(note ? [['附言', note]] : []),
      ],
      action: actionUrl ? { label: '前往 Cocoa 查看', url: actionUrl } : null,
      notice,
      footerNote: '你可以在「设置 - 模型分享」中随时撤销或查看记录。',
    }),
  };
  return applyMailOverride('share', base, {
    name: direction === 'request' ? targetName || ownerName : ownerName || targetName,
    shareId: targetName || ownerName || '',
    expiresAt: validity,
    time: nowUtc8(),
    reason: note || '',
  });
}

/** 分享到期通知 */
export function expiryNoticeTemplate(payload = {}) {
  const {
    ownerName = '', targetName = '', services = [], expiresAt = '',
    direction = 'share', actionUrl = '', upcoming = false, name = '', shareId = '',
    resourceTitle = '',
  } = payload;
  const names = serviceNames(services);
  const serviceText = names.length ? names.join('、') : resourceTitle || '模型授权';
  const endedAt = formatTime(expiresAt) || '刚刚';
  const incoming = direction === 'share';
  const title = upcoming ? '模型授权即将到期' : '模型分享已到期';
  const subject = upcoming ? '【Cocoa】模型授权即将到期' : '【Cocoa】模型分享已到期';
  const base = {
    subject,
    ...renderEmail({
      title,
      preheader: upcoming ? `${serviceText} 将于 ${endedAt} 到期` : `${serviceText} 的分享已于 ${endedAt} 到期`,
      paragraphs: upcoming
        ? [
            `${serviceText} 的使用授权将于 ${endedAt} 到期。`,
            '到期后相关服务会自动回退到你自己的配置；如需继续使用，请前往共享广场重新申请。',
          ]
        : [
            incoming
              ? `${ownerName || '对方'}（代号 ${targetName || '未知'}）分享给你的模型服务已于 ${endedAt} 到期。`
              : `你分享给 ${targetName || '对方'}（代号 ${ownerName || '未知'}）的模型服务已于 ${endedAt} 到期。`,
            '到期后相关服务会自动回退到你自己的配置；未配置时对应功能将暂停，直到重新配置或收到新的分享。',
          ],
      meta: [
        ['服务', serviceText],
        [upcoming ? '到期时间' : '到期时间', endedAt],
        ['方向', incoming ? '收到的分享' : '送出的分享'],
        ...(shareId ? [['Share ID', shareId]] : []),
      ],
      action: actionUrl ? { label: '管理模型分享', url: actionUrl } : null,
      notice: upcoming ? '如果已用不到，可以忽略本邮件。' : '如果这是误操作，可以让对方重新分享一次。',
      footerNote: '此通知在分享到期前后自动发送。',
    }),
  };
  return applyMailOverride('expiry', base, {
    name: name || ownerName || targetName || '',
    shareId: shareId || targetName || ownerName || '',
    expiresAt: endedAt,
    time: nowUtc8(),
    reason: upcoming ? '即将到期' : '已到期',
  });
}

/** 广场额度提醒（软限额 / 硬限额） */
export function quotaNoticeTemplate(payload = {}) {
  const {
    name = '',
    shareId = '',
    level = 'soft',
    resourceTitle = '',
    usedTokens = 0,
    tokenSoft = 0,
    tokenHard = 0,
    expiresAt = '',
    actionUrl = '',
  } = payload;
  const hard = level === 'hard';
  const title = hard ? '模型使用已达硬限额' : '模型使用接近限额';
  const subject = hard ? '【Cocoa】模型使用已达硬限额' : '【Cocoa】模型使用接近限额';
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const base = {
    subject,
    ...renderEmail({
      title,
      preheader: hard
        ? `你在「${resourceTitle || '共享广场'}」的模型授权已用尽，相关调用已暂停`
        : `你在「${resourceTitle || '共享广场'}」的模型授权已接近软限额`,
      paragraphs: [
        `你好${name ? `（${name}）` : ''}：你在共享广场使用的「${resourceTitle || '模型授权'}」${
          hard ? '已达到硬限额，相关模型调用已暂停' : '已达到软限额，建议留意剩余额度'
        }。`,
        hard
          ? '如需继续使用，请联系发布者调整限额，或前往共享广场选择其他资源。'
          : '达到硬限额后会立即暂停调用，届时对话框上方会显示额度提示。',
      ],
      meta: [
        ['已用 token', fmt(usedTokens)],
        ...(tokenSoft ? [['软限额', fmt(tokenSoft)]] : []),
        ...(tokenHard ? [['硬限额', fmt(tokenHard)]] : []),
        ...(expiresAt ? [['授权到期', formatTime(expiresAt)]] : []),
      ],
      action: actionUrl ? { label: '前往共享广场', url: actionUrl } : null,
      notice: hard ? '本条通知在额度用尽时自动发送。' : '本条通知在达到软限额时发送一次。',
      footerNote: '额度统计按模型调用的输入/输出 token 累计。',
    }),
  };
  return applyMailOverride('quota', base, {
    name,
    shareId,
    expiresAt: formatTime(expiresAt),
    time: nowUtc8(),
    reason: hard ? '已达硬限额' : '已达软限额',
  });
}

/** 分享权限被禁用通知（管理员操作） */
export function banNoticeTemplate(payload = {}) {
  const { name = '', shareId = '', scope = 'all', reason = '', until = '', actionUrl = '' } = payload;
  const scopeText = { all: '全部分享权限', server: '本服广场分享权限', global: '全球广场分享权限' }[scope] || '分享权限';
  const base = {
    subject: '【Cocoa】分享权限已被禁用',
    ...renderEmail({
      title: '分享权限已被禁用',
      preheader: `管理员已禁用你的${scopeText}`,
      paragraphs: [
        `你好${name ? `（${name}）` : ''}：管理员已禁用你的${scopeText}。`,
        '禁用期间你无法发布新的广场资源，已发布的资源仍可被使用；如有疑问请联系管理员。',
      ],
      meta: [
        ['范围', scopeText],
        ['原因', reason || '未填写'],
        ['解除时间', until ? formatTime(until) : '永久'],
        ...(shareId ? [['Share ID', shareId]] : []),
      ],
      action: actionUrl ? { label: '前往共享广场', url: actionUrl } : null,
      notice: '本条通知由管理员操作触发。',
      footerNote: '若你认为处理有误，请联系服务器管理员。',
    }),
  };
  return applyMailOverride('ban', base, {
    name,
    shareId,
    expiresAt: until ? formatTime(until) : '永久',
    time: nowUtc8(),
    reason: reason || '未填写',
  });
}

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
  const tpl = codeEmailTemplate({ code, purpose, email: to });
  try {
    return await sendMail({ to, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } catch (err) {
    logger.error('发送验证码失败', err.message);
    return { ok: false, reason: err.message };
  }
}

/** 分享 / 索要通知（direction: share | request | result） */
export async function sendShareNotice(to, payload = {}) {
  const tpl = shareNoticeTemplate(payload);
  try {
    return await sendMail({ to, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } catch (err) {
    logger.error('发送分享通知失败', err.message);
    return { ok: false, reason: err.message };
  }
}

/** 分享到期通知 */
export async function sendExpiryNotice(to, payload = {}) {
  const tpl = expiryNoticeTemplate(payload);
  try {
    return await sendMail({ to, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } catch (err) {
    logger.error('发送到期通知失败', err.message);
    return { ok: false, reason: err.message };
  }
}

/** 广场额度提醒（应用内 + 邮件） */
export async function sendQuotaNotice(to, payload = {}) {
  const tpl = quotaNoticeTemplate(payload);
  try {
    return await sendMail({ to, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } catch (err) {
    logger.error('发送额度通知失败', err.message);
    return { ok: false, reason: err.message };
  }
}

/** 分享权限禁用通知（应用内 + 邮件） */
export async function sendBanNotice(to, payload = {}) {
  const tpl = banNoticeTemplate(payload);
  try {
    return await sendMail({ to, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } catch (err) {
    logger.error('发送禁用通知失败', err.message);
    return { ok: false, reason: err.message };
  }
}

export const mailConfigured = () => Boolean(getSmtpConfig().host && getSmtpConfig().user);
export { env, BRAND, FOOTER };
