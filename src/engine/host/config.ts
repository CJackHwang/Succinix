// host config 域（O3 拆分）：引擎配置 / 实例会话 cwd / env 合并 / 在途实例上下文。
import fs from 'node:fs';
import path from 'node:path';
import { instanceStateRootFor, instanceStateFile, vfsToReal, spawnCwdFor, DEFAULT_INSTANCE_ID } from '../host-route.js';

// 陈旧结果文件（浏览器已放弃的请求）存活上限。可被 /etc/succinix.engine.json 的
// { resultTtlMs } 覆盖（TASK21：引擎选项经容器内小配置文件传给 host，浏览器侧 boot 时写入）。
let RESULT_TTL_MS = 120000;

// 当前结果文件 TTL（rpc 域清理用；getEngineConfig 按实例配置覆盖）。
export function resultTtlMs(): number {
  return RESULT_TTL_MS;
}

// 引擎配置文件：浏览器侧 boot 时写入（仅当显式传了 resultTtlMs），host 启动读取。
// TASK24 双根修复：浏览器 wc.fs 的 `/` == host 进程 cwd，写 `wc.fs /etc/succinix.engine.json`
// 即 host 视角的 `process.cwd()/etc/succinix.engine.json`；若仍读 node 虚拟系统根 `/etc/...`
// （bin/dev/etc 那个根）会读不到 → resultTtlMs 覆盖从未生效。统一用 process.cwd() 拼接。
// 失败静默回落默认值 —— 配置文件是可选优化，不影响协议。
function loadEngineConfig(stateRoot: string): { resultTtlMs?: number } {
  try {
    const cfgPath = `${stateRoot}/etc/succinix.engine.json`;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { resultTtlMs?: unknown };
    if (typeof cfg.resultTtlMs === 'number' && Number.isFinite(cfg.resultTtlMs) && cfg.resultTtlMs > 0) {
      return { resultTtlMs: cfg.resultTtlMs };
    }
  } catch {
    /* 文件缺失 / 非法：回落默认 */
  }
  return {};
}

// 引擎配置按实例读取（M2）：浏览器侧 boot 时把配置写到该实例的
// <stateRoot>/etc/succinix.engine.json；host 按请求携带的 instanceId 解析自身配置路径
// （全局单份 /etc 配置在多实例下会串扰，禁止）。配置缓存按实例存 —— host 常驻，
// 每个实例的配置在其首请求时读一次。resultTtlMs 是全局结果文件清理参数，最后一次
// 加载生效（清理动作是 host 全局的，不按实例区分）。
const engineCfgByInstance = new Map<string, { resultTtlMs?: number }>();

function getEngineConfig(instanceId: string): { resultTtlMs?: number } {
  let cfg = engineCfgByInstance.get(instanceId);
  if (cfg === undefined) {
    cfg = loadEngineConfig(instanceStateRootFor(instanceId, process.cwd()));
    if (cfg.resultTtlMs !== undefined) RESULT_TTL_MS = cfg.resultTtlMs;
    engineCfgByInstance.set(instanceId, cfg);
  }
  return cfg;
}

// 启动即读默认实例配置（host 常驻，之后不再变化；默认实例 = 现状单例语义）。
getEngineConfig(DEFAULT_INSTANCE_ID);

// ─── 会话 cwd（TASK23，融合基石）───
// node/npm/npx/python 子进程统一用会话 cwd（初始 = process.cwd()），不再固定 host cwd。
// Lifo 的 cd 成功后 host 同步会话 cwd（仅当新 cwd 在 /workspace 挂载下 —— 那是映射到 host
// 真实文件系统的路径，Lifo VFS 私有路径如 /tmp 没有 host 等价物，不同步）。
// 会话 cwd 持久化到 /etc/succinix.cwd（随快照），刷新后 host 启动恢复。
// TASK24 双根修复：浏览器 wc.fs 的 `/` == host 进程 cwd，随快照的 /etc/succinix.cwd 落在
// `process.cwd()/etc/` 下；若 CWD_FILE 仍用 node 虚拟系统根 `/etc/succinix.cwd`（只读系统根），
// 写不进去/读不到 → 刷新后 cwd 永久丢失。统一用 process.cwd() 拼接。
// WORKSPACE_MOUNT / vfsToReal / spawnCwdFor / resolveBrowserPath /
// pythonRuntimeArgs / lifoSpawndCwd / lifoCwdToSessionCwd / capOutput /
// MAX_OUTPUT_BYTES 均在 host-route.ts（P1-4）。

// 会话 cwd 按实例分键（M2）：同页共享 host 时各实例独立 cwd（缺省 default 键 = 现状单值
// 全等）。启动读各自持久化 cwd；文件缺失 / 目录已不存在（被删）时回落 process.cwd()。
// 校验用 vfsToReal 映射到 host 真实路径再 statSync —— 持久化的值可能是 Lifo VFS 路径
// （/workspace/...），node 虚拟系统根下不存在该路径，直接 existsSync 会误判为失效。
function loadSessionCwd(instanceId: string): string {
  try {
    const saved = fs.readFileSync(instanceStateFile(instanceId, process.cwd(), 'etc/succinix.cwd'), 'utf8').trim();
    if (saved) {
      const real = vfsToReal(saved, process.cwd());
      if (fs.existsSync(real) && fs.statSync(real).isDirectory()) {
        return saved; // 返回持久化的会话 cwd（显示语义不变，spawn 时再映射）
      }
    }
  } catch {
    /* 文件缺失 / 不可读：回落默认 */
  }
  return process.cwd();
}

const sessionCwdByInstance = new Map<string, string>();

export function getSessionCwd(instanceId: string): string {
  let cwd = sessionCwdByInstance.get(instanceId);
  if (cwd === undefined) {
    cwd = loadSessionCwd(instanceId);
    sessionCwdByInstance.set(instanceId, cwd);
  }
  return cwd;
}

// 持久化会话 cwd。写失败不阻断命令 —— cwd 同步是增强，不因持久化失败把命令报错。
function persistSessionCwd(instanceId: string, cwd: string): void {
  try {
    // 全新容器可能没有 /etc（浏览器侧只在首次写配置时 mkdir），host 侧写前确保父目录存在。
    const file = instanceStateFile(instanceId, process.cwd(), 'etc/succinix.cwd');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cwd);
  } catch {
    /* 写失败静默（快照仍会收录当前会话内已同步的 cwd） */
  }
}

export function setSessionCwd(instanceId: string, cwd: string): void {
  sessionCwdByInstance.set(instanceId, cwd);
  persistSessionCwd(instanceId, cwd);
}

// D3：实例级重置时清该实例的会话 cwd 缓存（host 侧内存态）。
export function clearSessionCwd(instanceId: string): void {
  sessionCwdByInstance.delete(instanceId);
}

// TASK24（自检崩溃根因修复）：子进程 spawn 前必须把 VFS 路径映射回 host 真实路径
// （/workspace → process.cwd()，/workspace/foo → process.cwd()/foo）；直接 spawn
// { cwd: '/workspace' } 会因 chdir 失败在 WebContainer 里挂起（spawn 不报 ENOENT）。
export function spawnCwd(instanceId: string): string {
  return spawnCwdFor(getSessionCwd(instanceId), process.cwd());
}

// ─── /etc/succinix.env 合并（TASK10）───
// env 命令把环境变量持久化到 /etc/succinix.env（浏览器侧 wc.fs 写入，随快照保留）。
// host 是常驻进程，启动后无法更新自身 process.env —— 改为 spawn 子进程时
// 解析该文件并合并进 env 选项，使 node/npm/npx 子进程能读到配置的变量。
// TASK24 双根修复：浏览器 wc.fs 写 `/etc/succinix.env` == host 视角 `process.cwd()/etc/succinix.env`；
// 若仍读 node 虚拟系统根 `/etc/succinix.env` 会读不到 → env 合并从未生效。统一 process.cwd() 拼接。
function loadEnvFile(instanceId: string): Record<string, string> {
  try {
    const text = fs.readFileSync(instanceStateFile(instanceId, process.cwd(), 'etc/succinix.env'), 'utf8');
    const env: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      env[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
    return env;
  } catch {
    return {}; // 文件不存在 / 不可读：空合并，不影响 spawn
  }
}

// 子进程环境 = host 自身环境 + 该实例 env 文件覆盖（文件是配置的权威来源；M2 按实例分键）。
export function mergedEnv(instanceId: string): NodeJS.ProcessEnv {
  return { ...process.env, ...loadEnvFile(instanceId) };
}

// 当前在途请求的实例（M2）：单 host 串行处理 /cmd.json，handleCommand 期间恒为请求所属
// 实例；Lifo 混合链转发 / spawn / cd 同步据此解析 cwd 与环境。处理完毕下一请求覆盖。
let currentInstance = DEFAULT_INSTANCE_ID;

// 实例上下文读写（config 域单例；run/spawn/ps-kill 按需读取）。
export function setCurrentInstanceId(id: string): void {
  currentInstance = id;
}

export function currentInstanceId(): string {
  return currentInstance;
}
