// 远程执行工具：node remote.mjs <本地脚本文件> [--put 本地文件:远端路径 ...]
// 读取 /data/dsh/home/.cocoa-deploy/ssh.env 里的连接信息；避免 shell 引号地狱。
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';

const envFile = process.env.COCOA_SSH_ENV || "/data/dsh/home/.cocoa-deploy/ssh.env";
const cfg = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^export\s+([A-Z_]+)=(.*)$/);
  if (m) cfg[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const args = process.argv.slice(2);
const scriptFile = args.find((a) => !a.startsWith('--') && !a.includes(':') && fs.existsSync(a));
const puts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--put' && args[i + 1]) {
    const [local, remote] = args[i + 1].split(':');
    puts.push({ local, remote });
  }
}

if (!scriptFile) {
  console.error('用法: node remote.mjs <本地脚本文件> [--put 本地:远端 ...]');
  process.exit(2);
}

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      for (const { local, remote } of puts) {
        await new Promise((res, rej) =>
          conn.sftp((e, sftp) => (e ? rej(e) : sftp.fastPut(local, remote, (er) => (er ? rej(er) : res())))),
        );
        console.log(`[put] ${path.basename(local)} → ${remote}`);
      }
      const script = fs.readFileSync(scriptFile, 'utf8');
      const remotePath = `/tmp/remote-${Date.now()}.sh`;
      await new Promise((res, rej) =>
        conn.sftp((e, sftp) => {
          if (e) return rej(e);
          sftp.writeFile(remotePath, script, (er) => (er ? rej(er) : res()));
        }),
      );
      const code = await new Promise((resolve, reject) => {
        conn.exec(`bash ${remotePath}; rc=$?; rm -f ${remotePath}; exit $rc`, (err, ch) => {
          if (err) return reject(err);
          ch.on('data', (d) => process.stdout.write(d));
          ch.stderr.on('data', (d) => process.stderr.write(d));
          ch.on('close', (c) => resolve(c));
        });
      });
      conn.end();
      process.exit(code);
    } catch (err) {
      console.error('[remote] error:', err.message);
      conn.end();
      process.exit(1);
    }
  })
  .on('error', (e) => {
    console.error('[remote] ssh error:', e.message);
    process.exit(1);
  })
  .connect({
    host: cfg.COCOA_SSH_HOST,
    port: Number(cfg.COCOA_SSH_PORT || 22),
    username: cfg.COCOA_SSH_USER,
    password: cfg.COCOA_SSH_PASS,
    readyTimeout: 45000,
  });
