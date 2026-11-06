#!/usr/bin/env node
/**
 * Cocoa 部署编排器（本机执行，通过 SSH 操作目标服务器）
 *
 * 依赖：项目自带 ssh2（package.json dependencies），无需全局安装。
 *
 * 环境变量（不要把密码写进仓库或命令行历史）：
 *   COCOA_SSH_HOST   默认 <SERVER_IP>
 *   COCOA_SSH_PORT   默认 22
 *   COCOA_SSH_USER   默认 root
 *   COCOA_SSH_PASS   SSH 密码（二选一）
 *   COCOA_SSH_KEY    私钥路径（二选一）
 *   COCOA_APP_DIR    默认 /opt/cocoa
 *   COCOA_PORT       默认 8787
 *   COCOA_ADMIN_EMAIL 初始管理员邮箱（首次部署生效）
 *
 * 用法：
 *   export COCOA_SSH_PASS='...'
 *   node deploy/deploy.mjs preflight   # 只读巡检
 *   node deploy/deploy.mjs deploy      # 打包 → 上传 → 安装 → 冒烟
 *   node deploy/deploy.mjs rollback    # 回滚到 /opt/cocoa.prev
 *   node deploy/deploy.mjs status      # 服务状态与最近日志
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'ssh2';

const ROOT = path.resolve(import.meta.dirname, '..');
const CFG = {
  sshHost: process.env.COCOA_SSH_HOST || '<SERVER_IP>',
  sshPort: Number(process.env.COCOA_SSH_PORT || 22),
  sshUser: process.env.COCOA_SSH_USER || 'root',
  sshPass: process.env.COCOA_SSH_PASS || '',
  sshKey: process.env.COCOA_SSH_KEY || '',
  appDir: process.env.COCOA_APP_DIR || '/opt/cocoa',
  appPort: Number(process.env.COCOA_PORT || 8787),
  adminEmail: process.env.COCOA_ADMIN_EMAIL || 'admin@cocoa.local',
  service: 'cocoa',
};

const log = (...a) => console.log('[deploy]', ...a);
const warn = (...a) => console.warn('[deploy][warn]', ...a);
const die = (msg) => { console.error('[deploy][error]', msg); process.exit(1); };

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(new Error(`SSH 连接失败：${err.message}`)));
    const opts = {
      host: CFG.sshHost,
      port: CFG.sshPort,
      username: CFG.sshUser,
      readyTimeout: 20000,
      keepaliveInterval: 10000,
    };
    if (CFG.sshKey) opts.privateKey = fs.readFileSync(CFG.sshKey);
    else if (CFG.sshPass) opts.password = CFG.sshPass;
    else return reject(new Error('需要 COCOA_SSH_PASS 或 COCOA_SSH_KEY'));
    conn.connect(opts);
  });
}

function exec(conn, cmd, { stream = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, ch) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      const timer = setTimeout(() => reject(new Error(`命令超时：${cmd}`)), timeout);
      ch.on('data', (d) => { out += d; if (stream) process.stdout.write(d); });
      ch.stderr.on('data', (d) => { errOut += d; if (stream) process.stderr.write(d); });
      ch.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err: errOut });
      });
    });
  });
}

function sftpPut(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve(remote)));
    });
  });
}

async function withSSH(fn) {
  const conn = await connect();
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

/** 本机打包源码（排除依赖、数据、构建产物、密钥） */
function pack() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const out = path.join('/tmp', `cocoa-code-${stamp}.tar.gz`);
  const excludes = [
    'node_modules', 'data', '.git', '.dsh', '.env', '.masterkey',
    'app/build', 'app/.dart_tool', 'app/android/.gradle', 'app/android/local.properties',
    'deploy/backups', '*.apk', '*.aab', '*.jks', '*.keystore', '*.log',
  ].flatMap((p) => ['--exclude', p]);
  const r = spawnSync('tar', ['-czf', out, ...excludes, '-C', ROOT, '.'], { stdio: 'inherit' });
  if (r.status !== 0) die('本机打包失败');
  const size = fs.statSync(out).size;
  log(`代码包：${out} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  return out;
}

/** 只读巡检 */
async function preflight(conn, { quiet = false } = {}) {
  const checks = [
    ['系统', 'uname -a; cat /etc/os-release | head -2'],
    ['内存', 'free -m 2>/dev/null || cat /proc/meminfo | head -2'],
    ['磁盘', 'df -h / /opt 2>/dev/null'],
    ['端口监听', 'ss -lntp 2>/dev/null | head -40'],
    ['NapCat/QQ 服务', "systemctl list-units --type=service --all 2>/dev/null | grep -Ei 'napcat|qq|onebot' || echo '(未发现 napcat/qq 相关单元)'"],
    ['Node', 'node -v 2>/dev/null || echo "(未安装 node)"; npm -v 2>/dev/null'],
    ['目标目录', `ls -ld ${CFG.appDir} ${CFG.appDir}.prev 2>/dev/null || echo '(不存在)'`],
    ['Cocoa 服务', `systemctl is-active ${CFG.service} 2>/dev/null; systemctl is-enabled ${CFG.service} 2>/dev/null`],
    ['目标端口占用', `ss -lntp 2>/dev/null | grep -E '[:.]${CFG.appPort} ' || echo '(端口 ${CFG.appPort} 空闲)'`],
    ['防火墙', 'command -v ufw >/dev/null && ufw status 2>/dev/null | head -5; command -v firewall-cmd >/dev/null && firewall-cmd --list-ports 2>/dev/null'],
  ];
  const report = {};
  for (const [label, cmd] of checks) {
    const r = await exec(conn, cmd, { timeout: 60000 });
    report[label] = (r.out || '').trim();
    if (!quiet) {
      console.log(`\n── ${label} ──\n${report[label] || '(空)'}`);
      if (r.err.trim()) console.log(`[stderr] ${r.err.trim()}`);
    }
  }
  return report;
}

function assess(report) {
  const notes = [];
  const nodeLine = report['Node'] || '';
  const m = nodeLine.match(/v(\d+)\.(\d+)/);
  if (!m) notes.push('服务器没有 Node，将安装 Node 24 静态包');
  else if (Number(m[1]) >= 22) notes.push(`复用已有 Node v${m[1]}.${m[2]}`);
  else notes.push(`Node v${m[1]}.${m[2]} 低于 engines(>=22.5)，将升级到 24`);

  const napcat = report['NapCat/QQ 服务'] || '';
  if (/napcat(?!.*未发现)/i.test(napcat) && !/未发现/.test(napcat)) notes.push('检测到 NapCat 服务，部署过程不会停止/重启它');
  else notes.push('未检测到 NapCat systemd 单元（可能以容器/进程方式运行，同样不动）');

  const portBusy = !/空闲/.test(report['目标端口占用'] || '');
  if (portBusy) {
    notes.push(`端口 ${CFG.appPort} 已被占用（若占用者是 ${CFG.service} 自身则按升级处理，否则需 export COCOA_PORT=8788）`);
  } else {
    notes.push(`端口 ${CFG.appPort} 空闲`);
  }
  return notes;
}

async function deploy() {
  const tarball = pack();
  await withSSH(async (conn) => {
    const report = await preflight(conn, { quiet: true });
    const notes = assess(report);
    console.log('\n── 巡检摘要 ──');
    for (const n of notes) log(n);
    if (!/空闲/.test(report['目标端口占用'] || '')) {
      // 端口被自己的 cocoa 服务占着属正常升级：确认占用者就是 cocoa 的 MainPID
      const own = await exec(conn, `mainpid=$(systemctl show -p MainPID --value ${CFG.service} 2>/dev/null || echo 0); pids=$(ss -lntp 2>/dev/null | grep -E '[:.]${CFG.appPort} ' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | tr '\\n' ' '); if [ "$mainpid" != "0" ] && echo " $pids " | grep -q " $mainpid "; then echo own; else echo other; fi`, { timeout: 30000 });
      if ((own.out || '').trim() !== 'own') {
        die(`端口 ${CFG.appPort} 被非 Cocoa 进程占用，安装脚本会拒绝继续；请 export COCOA_PORT=8788 重试`);
      }
      log(`端口 ${CFG.appPort} 由 ${CFG.service} 自身占用，按升级处理`);
    }

    const stamp = Date.now();
    const remoteTar = `/tmp/cocoa-code-${stamp}.tar.gz`;
    const remoteSh = `/tmp/cocoa-install-${stamp}.sh`;
    log(`上传代码包 → ${remoteTar}`);
    await sftpPut(conn, tarball, remoteTar);
    log('上传安装脚本');
    await sftpPut(conn, path.join(ROOT, 'deploy', 'install.sh'), remoteSh);

    log('远程安装（输出实时回传）');
    const cmd = `chmod +x ${remoteSh} && COCOA_ADMIN_EMAIL='${CFG.adminEmail}' ${remoteSh} ${remoteTar} ${CFG.appDir} ${CFG.appPort}; rc=$?; rm -f ${remoteTar} ${remoteSh}; exit $rc`;
    const r = await exec(conn, cmd, { stream: true, timeout: 900000 });
    if (r.code !== 0) die(`安装脚本失败（rc=${r.code}）`);

    // 数据目录属主兜底（历史上出现过 root:root 导致 EACCES）
    await exec(conn, `chown -R cocoa:cocoa ${CFG.appDir}/data 2>/dev/null; chmod 750 ${CFG.appDir}/data 2>/dev/null; true`, { timeout: 30000 });

    const health = await exec(conn, `curl -fsS -m 5 http://127.0.0.1:${CFG.appPort}/api/health`, { timeout: 30000 });
    log('远程健康检查：', (health.out || '').trim() || '(无响应)');
    const pwdRes = await exec(conn, `test -f ${CFG.appDir}/.admin-initial-password && echo '已生成（600，勿外泄）' || echo '(沿用旧密码)'`);
    console.log('\n──────── 部署结果 ────────');
    console.log(`服务        : ${CFG.service} (${CFG.appDir})`);
    console.log(`访问地址    : http://${CFG.sshHost}:${CFG.appPort}`);
    console.log(`健康检查    : ${(health.out || '').trim().slice(0, 200)}`);
    console.log(`初始管理员   : ${CFG.adminEmail}（密码见服务器 ${CFG.appDir}/.admin-initial-password，绝不打印）`);
    console.log(`回滚命令    : node deploy/deploy.mjs rollback  （或服务器内 deploy/rollback.sh）`);
    console.log('──────────────────────────');
  });
  fs.rmSync(tarball, { force: true });
}

async function rollback() {
  await withSSH(async (conn) => {
    const remoteSh = `/tmp/cocoa-rollback-${Date.now()}.sh`;
    await sftpPut(conn, path.join(ROOT, 'deploy', 'rollback.sh'), remoteSh);
    const r = await exec(conn, `chmod +x ${remoteSh} && COCOA_PORT=${CFG.appPort} ${remoteSh} ${CFG.appDir}; rc=$?; rm -f ${remoteSh}; exit $rc`, {
      stream: true,
      timeout: 300000,
    });
    if (r.code !== 0) die(`回滚失败（rc=${r.code}）`);
  });
}

async function status() {
  await withSSH(async (conn) => {
    const r = await exec(conn, `systemctl status ${CFG.service} --no-pager -l | head -25; echo; journalctl -u ${CFG.service} -n 30 --no-pager`, { timeout: 60000 });
    console.log(r.out);
  });
}

const mode = process.argv[2] || 'preflight';
try {
  if (mode === 'preflight') await withSSH(async (conn) => { const rep = await preflight(conn); console.log('\n── 结论 ──'); for (const n of assess(rep)) log(n); });
  else if (mode === 'deploy') await deploy();
  else if (mode === 'rollback') await rollback();
  else if (mode === 'status') await status();
  else die(`未知模式：${mode}（可用：preflight|deploy|rollback|status）`);
} catch (err) {
  die(err.message || String(err));
}
