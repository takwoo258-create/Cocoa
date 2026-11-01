// 服务器状态采集：CPU（os.cpus 两次差分，1s 缓存）/ 内存 / 磁盘 / 网络（/proc/net/dev）/ 运行时长
// 只依赖 node 内置模块，4C4G 机器上单次采集开销可忽略（磁盘 statfs 与 /proc 读文件均为 O(1)）
import fs from 'node:fs';
import os from 'node:os';
import env from '../env.js';
import { sleep, nowIso } from '../core/util.js';

const SAMPLE_INTERVAL_MS = 1000;
const CACHE_MS = 1000;
const PROC_NET_DEV = '/proc/net/dev';
const PROC_MEMINFO = '/proc/meminfo';

const round = (n, digit = 2) => {
  const f = 10 ** digit;
  return Math.round(Number(n || 0) * f) / f;
};

// 采样环形缓冲：只保留最近两次，够算差分即可（不随运行时间增长）
let cpuSamples = [];
let netSamples = [];
let samplerTimer = null;
let cache = { at: 0, data: null };

function cpuTicks() {
  let total = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    const t = cpu?.times || {};
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    idle += t.idle || 0;
  }
  return { total, idle };
}

/** /proc/net/dev 累计字节；容器内不可用时返回 null */
function readNetDev() {
  let text;
  try {
    text = fs.readFileSync(PROC_NET_DEV, 'utf8');
  } catch {
    return null;
  }
  const interfaces = [];
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of text.split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name || name === 'lo') continue;
    const fields = line.slice(idx + 1).trim().split(/\s+/).map((x) => Number(x) || 0);
    const rx = fields[0] || 0;
    const tx = fields[8] || 0;
    rxBytes += rx;
    txBytes += tx;
    interfaces.push({ name, rxBytes: rx, txBytes: tx });
  }
  return { rxBytes, txBytes, interfaces };
}

function pushSample() {
  const at = Date.now();
  const ticks = cpuTicks();
  cpuSamples.push({ at, ...ticks });
  if (cpuSamples.length > 2) cpuSamples = cpuSamples.slice(-2);
}

function ensureSampler() {
  if (samplerTimer) return;
  pushSample();
  samplerTimer = setInterval(pushSample, SAMPLE_INTERVAL_MS);
  // 后台采样不能阻止进程退出（测试/CLI 场景友好）
  if (typeof samplerTimer.unref === 'function') samplerTimer.unref();
}

/**
 * CPU 使用率：优先用两次 os.cpus() 差分；
 * - 首次调用且只有一次采样时，等 120ms 再采一次（仅首次成本）；
 * - 差分窗口内 tick 无变化（极短窗口）时用 loadavg/核数估算并标记 estimated。
 */
async function cpuUsage() {
  ensureSampler();
  if (cpuSamples.length < 2) {
    // 首次调用：等 120ms 再采一次，拿到真实差分（仅第一次请求付这个成本）
    await sleep(120);
    pushSample();
  }
  // 采样过旧（事件循环被长时间阻塞）时补一次，避免拿几分钟前的数据算瞬时值
  const last = cpuSamples[cpuSamples.length - 1];
  if (!last || Date.now() - last.at > SAMPLE_INTERVAL_MS * 2) pushSample();

  const prev = cpuSamples[cpuSamples.length - 2];
  const curr = cpuSamples[cpuSamples.length - 1];
  const cores = os.cpus()?.length || 1;
  const load = os.loadavg().map((n) => round(n, 2));

  let percent = null;
  let estimated = false;
  if (prev && curr) {
    const deltaTotal = curr.total - prev.total;
    const deltaIdle = curr.idle - prev.idle;
    if (deltaTotal > 0) percent = round((1 - deltaIdle / deltaTotal) * 100, 1);
  }
  if (percent === null) {
    percent = round(Math.min(100, (load[0] / cores) * 100), 1);
    estimated = true;
  }
  percent = Math.min(100, Math.max(0, percent));

  return {
    percent,
    cores,
    load,
    model: os.cpus()?.[0]?.model || '',
    speedMhz: os.cpus()?.[0]?.speed || 0,
    estimated,
    sampledAt: new Date(curr?.at || Date.now()).toISOString(),
  };
}

function memoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  let available = free;
  try {
    const info = fs.readFileSync(PROC_MEMINFO, 'utf8');
    const pick = (key) => {
      const m = info.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const memTotal = pick('MemTotal');
    const memAvailable = pick('MemAvailable') ?? pick('MemFree');
    if (memTotal) available = memAvailable ?? free;
  } catch {
    /* 非 Linux 环境回退到 os 值 */
  }
  const used = Math.max(0, total - available);
  return {
    total,
    used,
    free,
    available,
    percent: total ? round((used / total) * 100, 1) : 0,
  };
}

function diskUsage() {
  const targets = [env.dataDir, env.root, '/'];
  for (const target of targets) {
    try {
      const st = fs.statfsSync(target);
      const bsize = st.bsize || 4096;
      const total = st.blocks * bsize;
      const free = st.bavail * bsize;
      const used = Math.max(0, total - free);
      return {
        path: target,
        total,
        used,
        free,
        percent: total ? round((used / total) * 100, 1) : 0,
      };
    } catch {
      /* 尝试下一个挂载点 */
    }
  }
  return { path: null, total: 0, used: 0, free: 0, percent: 0, available: false };
}

function networkUsage() {
  const at = Date.now();
  const net = readNetDev();
  if (net) {
    netSamples.push({ at, rxBytes: net.rxBytes, txBytes: net.txBytes });
    if (netSamples.length > 2) netSamples = netSamples.slice(-2);
  }
  const prev = netSamples[netSamples.length - 2];
  const curr = netSamples[netSamples.length - 1];
  let rxRate = 0;
  let txRate = 0;
  if (prev && curr && curr.at > prev.at) {
    const sec = (curr.at - prev.at) / 1000;
    rxRate = Math.max(0, Math.round((curr.rxBytes - prev.rxBytes) / sec));
    txRate = Math.max(0, Math.round((curr.txBytes - prev.txBytes) / sec));
  }
  if (!net) {
    return { rxBytes: 0, txBytes: 0, rxRate: 0, txRate: 0, interfaces: [], available: false };
  }
  return {
    rxBytes: net.rxBytes,
    txBytes: net.txBytes,
    rxRate,
    txRate,
    interfaces: net.interfaces,
    available: true,
    sampledAt: new Date(at).toISOString(),
  };
}

/** 单次采样（CPU 已内置 1s 缓存；force=true 时跳过缓存，测试用） */
export async function collectServerStatus({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = {
    cpu: await cpuUsage(),
    memory: memoryUsage(),
    disk: diskUsage(),
    network: networkUsage(),
    uptime: Math.round(os.uptime()),
    processUptime: Math.round(process.uptime()),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    pid: process.pid,
    time: nowIso(),
  };
  cache = { at: Date.now(), data };
  return data;
}

/** 测试用：重置采样/缓存状态（不会停止已启动的采样定时器） */
export function resetStatusCache() {
  cache = { at: 0, data: null };
  cpuSamples = [];
  netSamples = [];
}

export default { collectServerStatus, resetStatusCache };
