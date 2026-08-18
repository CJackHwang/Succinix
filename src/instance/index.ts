// 实例聚合 API（M5）：createSuccinixInstance 一个工厂产出终端 / executor / 快照 / 服务。
// 工厂做**引擎级 boot**（host 注入 + spawn + 就绪 → session（instanceId 注入 rpc/命令 ctx）
// → 按实例快照键恢复 → snapshot/services 绑定 per-instance 视图）。应用级 bootsteps
// （workspace init / motd / env 统计 / autostart）**不在工厂内** —— 由宿主经 TerminalBoot
// 参数化或自行决定（独立应用 demo 见 src/boot.ts）。
//
// 同页多实例（DM-11，组织性隔离，非安全边界）：共享单 host。RPC 通道按 wc 共享
// （client.ts 的 channelFor），每个实例一个带自身 instanceId 的 client（M3 host 路由）；
// 看门狗是 per-host（页面级一个），工厂不内置看门狗；端口事件经 M4 的实例期望端口
// 注册表归属（instancePorts）。双 tab 各容器天然隔离，与单实例行为全等。
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { BootUI } from '../terminal/ui.js';
import {
  TerminalClient,
  createTerminalExecutor,
  pagePorts,
  waitForHostReady,
  type EngineBootHooks,
  type TerminalExecutor,
} from '../engine/index.js';
import type { TerminalBootOptions } from '../terminal/index.js';
import { createPersist, getPersist, type PersistContext, type PersistOptions, type SnapshotMeta } from '../persist/index.js';
import {
  listExecutionServiceStates,
  startExecutionService,
  stopExecutionService,
} from '../services/world-client.js';
import type { ServiceContext } from '../services/types.js';
import { clearDbActivePorts } from '../services/registry.js';
import { DEFAULT_INSTANCE_ID, instanceStateRoot } from './paths.js';
import { instancePorts } from './ports.js';

// 工厂缺省 boot 步骤文案（引擎级；应用级步骤由宿主负责，见 SDK.md）。
export const DEFAULT_INSTANCE_BOOT_STEPS = [
  'Restored instance workspace from persistent storage',
  'Starting host runtime',
  'TerminalExecutor ready',
] as const;

export interface SuccinixInstanceOptions {
  /** WebContainer 实例（宿主已 boot 的容器） */
  wc: WebContainer;
  /** 实例 id（M3 host 路由 / M2 状态根 / M1 快照键）。空串按默认实例处理 */
  instanceId: string;
  /** 状态根前缀覆盖（缺省 = DM-12 内置 /workspace/.succinix-<id>；默认实例恒为 /etc）。
   *  仅影响浏览器侧状态文件布局；host 侧进程归属/状态解析以内置前缀为准，宿主使用
   *  自定义前缀时应保持 instanceId 命名与内置前缀对齐（如 instanceId 'users/alice'）。 */
  statePrefix?: string;
  /** 用户 home（U1，浏览器 wc.fs 视角，如 /workspace/users/alice；宿主可覆盖根）。
   *  目录及执行世界 cwd 由宿主经 ensureUserHome / runApplicationBootSteps(userHome) 初始化。 */
  home?: string;
  /** 快照存储覆盖（缺省 = 每实例键 instance:<id>，同库不同 key；默认实例 = current） */
  persistence?: { dbName?: string; storeKey?: string; includeGit?: boolean };
  /** 引擎 boot 钩子透传（资产 URL / 端口回调 / 命令采集 / resultTtlMs ...） */
  executor?: EngineBootHooks;
  /** 同页共享 RPC 通道（per-page）：传入宿主已 boot 的 TerminalClient 时复用其通道与 host，
   *  工厂不再拉起新 host（单 host 不变量）；缺省自建（单实例 / 双 tab 各自独立，行为全等）。
   *  注意：请求的 instanceId 取自 client 自身（构造时传入），共享一个 client 的多个实例
   *  会共享同一 instanceId —— 每实例一个 client（通道自动共享）才是按实例路由的姿势。 */
  rpc?: TerminalClient;
  /** 共享 host 进程句柄（rpc 共享路径下由宿主注入；executor.respawn 用它先 kill 旧 host） */
  hostProc?: WebContainerProcess;
  /** boot 进度 UI（缺省静默；宿主可传 E2 TerminalBoot 的 UI） */
  bootUI?: BootUI;
  /** boot 步骤文案（缺省 = DEFAULT_INSTANCE_BOOT_STEPS；应用级 bootsteps 归宿主） */
  bootSteps?: TerminalBootOptions['steps'];
  /** restart 后重跑应用级 bootsteps 的钩子（D3）：工厂只负责引擎级重置，
   *  workspace/env/services/motd/autostart 由宿主恢复。 */
  onRestart?: (ctx: SuccinixRestartContext) => Promise<unknown>;
}

/** restart 钩子上下文（D3）：引擎级产物 + 重建后的新会话。 */
export interface SuccinixRestartContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
}

export interface SuccinixInstance {
  instanceId: string;
  /** 本实例的 RPC 客户端（请求带 instanceId，host 按实例路由；同页多实例经共享通道串行） */
  client: TerminalClient;
  /** 命令式通道（包装本实例的 client；rpc 共享路径下与宿主共用 host） */
  executor: TerminalExecutor;
  /** 本实例快照持久化上下文（snapshot 命令 / 宿主直用） */
  persist: PersistContext;
  /** 本实例端口视图源：port → 预览 URL（server-ready 事件按期望端口归属） */
  ports: Map<number, string>;
  snapshot: { save(force?: boolean): Promise<unknown>; restore(): Promise<void> };
  services: {
    list(): Promise<unknown[]>;
    start(name: string): Promise<unknown>;
    stop(name: string): Promise<unknown>;
  };
  /** 实例级重置（M4）：清快照 + 清状态根（不刷新宿主页面，不动共享 host）。
   *  默认实例 = 整页刷新语义（rebootMode 'page'，现状）。 */
  restart(): Promise<void>;
  /** 释放资源：会话 + executor。自建 host 时同时 kill host；rpc 共享路径不动共享 host。幂等 */
  dispose(): Promise<void>;
}

// 引擎级 boot 步骤渲染（与 TerminalBoot 同款 marker 格式；缺省静默）。
function makeBootReporter(
  ui: BootUI | undefined,
  steps: readonly string[]
): { ok(msg?: string): void; note(msg: string): void } {
  let step = 0;
  return {
    ok: (msg) => {
      step++;
      const text = msg ?? steps[step - 1] ?? `step ${step}`;
      ui?.log(`[  OK  ] ${step}/${steps.length} ${text}`, 'ok');
    },
    note: (msg) => ui?.log(`[ .... ] ${msg}`, 'note'),
  };
}

// D4：非默认实例的快照 scope —— 遍历根收到 /workspace（状态根 / 用户 home / 工作区都在
// 其下，不再收录 /etc、/var/log 等共享系统目录），并按实例归属排除其他实例的
// `.succinix-*` 状态根与其他用户的 home（同页多实例快照内容隔离，非安全边界）。
function instancePersistScope(instanceId: string, opts: SuccinixInstanceOptions): PersistOptions | undefined {
  if (instanceId === DEFAULT_INSTANCE_ID) return undefined;
  return {
    scopeRoot: '/workspace',
    instanceScope: {
      stateRoot: instanceStateRoot(instanceId, opts.statePrefix),
      home: opts.home,
    },
  };
}

export async function createSuccinixInstance(opts: SuccinixInstanceOptions): Promise<SuccinixInstance> {
  const instanceId = opts.instanceId && opts.instanceId.trim() ? opts.instanceId : DEFAULT_INSTANCE_ID;
  const boot = makeBootReporter(opts.bootUI, opts.bootSteps ?? DEFAULT_INSTANCE_BOOT_STEPS);

  // 快照按实例键（M1）：宿主可自定义 dbName/storeKey；缺省 = 每实例键 instance:<id>。
  // D4：缺省实例 = 整棵 FS 快照（现状全等）；非默认实例 = /workspace scope +
  // 按实例归属排除其他实例的状态根 / 用户 home / tinbase（同页多实例内容隔离）。
  const scope = instancePersistScope(instanceId, opts);
  const persist = opts.persistence ? createPersist({ ...scope, ...opts.persistence }) : getPersist(instanceId, scope);
  // v0.7 binds the persistence context to the execution-world WebContainer.
  // This switches the instance to binary export/generation storage while
  // preserving the FileSystemAPI-only compatibility adapter for SDK callers.
  persist.bindContainer?.(opts.wc);
  // Node 子进程使用宿主内置实例 cwd；statePrefix 只影响浏览器侧布局，首条 Node
  // 命令到达宿主前必须确保 /workspace/.succinix-<id> 已存在。
  if (instanceId !== DEFAULT_INSTANCE_ID) {
    await opts.wc.fs.mkdir(instanceStateRoot(instanceId, opts.statePrefix), { recursive: true });
  }

  // 端口视图（M4）：server-ready 按实例期望端口归属；工厂维护本实例 port → url 表
  // （services ctx / 宿主预览用），宿主回调透传（如打印 [preview] 行）。
  const ports = new Map<number, string>();
  // D2：事件按实例期望归属 —— 同页所有实例共享 wc 的 server-ready 事件（页面级分发），
  // 无法归属的端口只进页面级 registry（pagePorts.readyPorts()），不进任何实例视图。
  // 缺省实例 = 页面级全部（现状行为全等：旧默认路径的 ports 视图直接就是页面 registry）。
  const isExpected = (port: number): boolean => instanceId === DEFAULT_INSTANCE_ID || instancePorts.expects(instanceId, port);
  const executorHooks: EngineBootHooks = {
    ...opts.executor,
    instanceId,
    onServerReady: (port, url) => {
      if (!isExpected(port)) return;
      ports.set(port, url);
      opts.executor?.onServerReady?.(port, url);
    },
    onServerClosed: (port) => {
      if (!isExpected(port)) return;
      ports.delete(port);
      opts.executor?.onServerClosed?.(port);
    },
  };
  let unsubscribePorts: (() => void) | null = null;

  // 引擎级 boot：注入 host + spawn + 就绪。
  // rpc 传入 = 同页共享通道（宿主已 boot 的 host，工厂不拉第二个 host —— 单 host 不变量）；
  // 缺省自建（单实例 / 双 tab 各自独立容器，行为全等现状）。
  let client: TerminalClient;
  let executor: TerminalExecutor;
  if (opts.rpc) {
    client = opts.rpc;
    executor = createTerminalExecutor({ wc: opts.wc, client, hostProc: opts.hostProc, sharedHost: true });
    // D2：同页共享 RPC 路径 —— 页面 host 已 bind wc 事件（单 host 不变量），工厂不重复
    // 拉起 host，这里直接订阅本实例的端口钩子（按期望归属过滤，与自建路径同款语义）。
    unsubscribePorts = pagePorts.subscribe(instanceId, {
      onServerReady: (port, url) => {
        if (!isExpected(port)) return;
        ports.set(port, url);
        opts.executor?.onServerReady?.(port, url);
      },
      onServerClosed: (port) => {
        if (!isExpected(port)) return;
        ports.delete(port);
        opts.executor?.onServerClosed?.(port);
      },
    });
    await waitForHostReady(client, 30);
  } else {
    client = new TerminalClient(opts.wc, { onCommand: opts.executor?.onCommand, instanceId });
    executor = createTerminalExecutor({ wc: opts.wc, client });
    await executor.boot(opts.wc, executorHooks);
    // bootEngineHost 内部已按 instanceId 订阅（hooks 带端口回调时）；dispose 时退订。
    unsubscribePorts = () => pagePorts.unsubscribe(instanceId);
  }

  // 按实例快照键恢复（M1 load；缺省 default 键 = 现状全等）。
  let restored: SnapshotMeta | null = null;
  try {
    restored = await persist.load(opts.wc.fs);
  } catch (e) {
    boot.note(`Persistent restore failed (${String(e).slice(0, 80)}); continuing with current filesystem`);
  }
  boot.ok(
    restored
      ? `Restored instance workspace from persistent storage (${restored.fileCount} files, ${Math.round(restored.totalBytes / 1024)} KB)`
      : 'Initialized fresh workspace'
  );

  const svcCtx: ServiceContext = { wc: opts.wc, client, ports, instanceId, statePrefix: opts.statePrefix };
  let disposed = false;

  const instance: SuccinixInstance = {
    instanceId,
    client,
    executor,
    persist,
    ports,
    snapshot: {
      save: (force) => persist.save(opts.wc.fs, force),
      restore: async () => {
        await persist.load(opts.wc.fs);
      },
    },
    services: {
      list: () => listExecutionServiceStates(svcCtx),
      start: (name) => startExecutionService(svcCtx, name),
      stop: (name) => stopExecutionService(svcCtx, name),
    },
    restart: async () => {
      if (instanceId === DEFAULT_INSTANCE_ID) {
        // 默认实例 = 整页语义（rebootMode 'page'，现状）：工厂不擅自重置默认实例状态。
        if (typeof location !== 'undefined') location.reload();
        return;
      }
      // 实例级重置（M4 / D3）：停进程 → 清端口期望/活动端口记录 → 清 host 缓存 →
      // 清快照 + 清状态根 → 重跑应用级 bootsteps（宿主注入）。不动共享 host
      // 进程本体（单 host 不变量），只清该实例的归属进程与缓存。
      // 1. host 侧收口：kill 本实例归属进程 + 清 sessionCwd/currentRun 缓存。
      try {
        await client.resetInstance();
      } catch {
        /* host 不可达：浏览器侧继续清理，进程残留由下一次 boot 快照/宿主兜底 */
      }
      // 2. 清端口期望 / 数据库端口投影 / 实例端口视图（旧 URL 不再可用）。
      instancePorts.releaseAll(instanceId);
      clearDbActivePorts(instanceId);
      ports.clear();
      // 3. 清快照 + 状态根（M4 现状）。
      await persist.clear();
      const root = instanceStateRoot(instanceId, opts.statePrefix);
      try {
        await opts.wc.fs.rm(root, { recursive: true });
      } catch {
        /* 状态根不存在 / 删除失败：忽略，下一轮 boot 按全新系统走 */
      }
      // 4. 重跑应用级 bootsteps（宿主注入；共享 host/Sandbox 不重启）。
      await opts.onRestart?.({ wc: opts.wc, client, ports });
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unsubscribePorts?.();
      unsubscribePorts = null;
      persist.dispose?.();
      // rpc 共享路径：executor 持有 hostProc（respawn 用）但标记 sharedHost，
      // dispose 只清引用不动共享 host；
      // 自建路径：executor.dispose kill 自建 host（单实例页面的 host 由实例拥有）。
      await executor.dispose();
    },
  };
  return instance;
}
