// 服务管理模块（TASK11）：/etc/succinix.services（服务定义）与 /etc/succinix.autostart（自启清单）。
// 服务 = 给后台进程（spawn）起名字 + 生命周期管理 + 可选开机自启，是 spawn/ps/kill + 端口注册表的
// **声明式封装**。定义文件 name|command|port，`|` 分隔、`#` 注释，随快照持久。
// 自启是"声明式重启"（boot 时拉起），不是守护进程/崩溃自愈（AGENTS.md 边界，不做崩溃重启）。
// 状态判定：进程表有该服务命令的 running 进程 且（若有端口）端口注册表就绪 → running，否则 stopped。
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './engine/index.js';
import { getSetting } from './config.js';
import { log } from './log.js';
import { forcePersist } from './persist.js';
import { sleep, ensureParentDir } from './util.js';

export const SERVICES_FILE = '/etc/succinix.services';
export const AUTOSTART_FILE = '/etc/succinix.autostart';

// 内置预置：文件缺失时回落 / boot 初始化写入。${PORT} 占位符在启动时替换为 settings 的 preview-port。
export const DEFAULT_SERVICES_TEXT =
  '# Succinix service definitions (name|command|port)\n' +
  'tinbase|npx tinbase start --port ${PORT} --engine wasm|3001\n';

const DEFAULT_PORT = 3001;
const PORT_WAIT_MS = 30000;

// M1 模式：本次会话启动过的服务实际端口记录在案（startService 记录，stop 清除）。
// 解决 preview-port 改动后静态 def.port 失真：服务启动时监听的是当时的端口，
// 就绪等待 / 状态 / 列表 / URL 展示都用记录值；会话内未启动过的服务回落动态解析。
const activePorts = new Map<string, number>();

export interface ServiceDef {
  name: string;
  /** 原始命令模板（可含 ${PORT} 占位符，启动时替换为 preview-port） */
  command: string;
  /** 服务端口（状态展示 + 就绪等待用）；无端口为 null */
  port: number | null;
}

export interface ServiceState {
  def: ServiceDef;
  state: 'running' | 'stopped';
  pid?: number;
  /** 有效端口：会话内启动记录值优先，否则动态解析（命令含 ${PORT} 按 preview-port）；无端口 null */
  effectivePort: number | null;
  /** running 且有端口时的预览 URL */
  url?: string;
}

export interface ServiceContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
}

export interface ServiceActionResult {
  ok: boolean;
  message: string;
  pid?: number;
}

// TASK19：npx 服务缺包安装 —— node_modules 不随快照持久，刷新/重开容器后 npx <pkg> 的包必然缺失。
// 若服务命令以 npx 开头且 /workspace/node_modules/<pkg> 不存在，先真实 npm install（与 dbStart 的安装路径一致），
// 再 spawn —— 否则 autostart 里 npx 的即时下载会跟 30s 端口等待竞态，时好时坏。
// N1（TASK20）：探测必须用绝对路径 —— `test -d node_modules/<pkg>` 相对路径被 Lifo 按 VFS 根解析，
// 而 npm install 装进 process.cwd()（即 /workspace）下的 node_modules，恒判缺失 → 每次冗余 npm install + 虚假 WARN。
async function ensureNpxPackage(ctx: ServiceContext, command: string): Promise<void> {
  const m = /^npx\s+(\S+)/.exec(command.trim());
  if (!m) return;
  const pkg = m[1];
  const rel = `/workspace/node_modules/${pkg}`;
  try {
    const probe = await ctx.client.terminal(`test -d '${rel}'`, undefined, 15000);
    if (probe.ok) return; // 已安装
  } catch {
    /* 探测失败：按缺失处理，尝试安装 */
  }
  void log('WARN', `service install: ${pkg} missing, running npm install before spawn`);
  const inst = await ctx.client.terminal(`npm install ${pkg} --no-audit --no-fund`, { timeout: 120000 }, 150000);
  if (!inst.ok) {
    void log('WARN', `service install failed: ${pkg} (${String(inst.stderr || inst.error || 'npm install failed').slice(0, 160)})`);
  }
}

// 门控回归防护：自动快照的目录签名门控（persist collectDir）只看目录结构+总字节，
// 捕捉不到"内容变更但大小不变"的写入。定义/自启文件的写入靠此强制落盘一次
// （与 config/motd 的 forcePersist 一致：try/catch + console.warn 降级，不打断命令）。
// 实现收敛到 persist.forcePersist（P2-6），tag 标注模块名便于定位。

// ─── 文件 I/O ───
export async function ensureServicesFiles(fs: FileSystemAPI): Promise<void> {
  await ensureParentDir(fs, SERVICES_FILE);
  try {
    await fs.readFile(SERVICES_FILE, 'utf8');
  } catch {
    try {
      await fs.writeFile(SERVICES_FILE, DEFAULT_SERVICES_TEXT);
    } catch {
      /* 写入失败不影响 boot，读取仍回落内置预置 */
    }
  }
  try {
    await fs.readFile(AUTOSTART_FILE, 'utf8');
  } catch {
    try {
      await fs.writeFile(AUTOSTART_FILE, '');
    } catch {
      /* 同上 */
    }
  }
}

async function readServicesRaw(fs: FileSystemAPI): Promise<string> {
  try {
    return await fs.readFile(SERVICES_FILE, 'utf8');
  } catch {
    return DEFAULT_SERVICES_TEXT;
  }
}

// 解析服务定义：空行 / # 注释跳过；缺 name 或 command 的行跳过；port 非法或缺失 → null；重名最后定义生效。
export function parseServices(text: string): ServiceDef[] {
  const map = new Map<string, ServiceDef>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 2) continue;
    const name = parts[0];
    const command = parts[1];
    if (!name || !command) continue;
    const port = parsePort(parts[2] ?? '');
    map.set(name, { name, command, port });
  }
  return [...map.values()];
}

function parsePort(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export async function readServices(fs: FileSystemAPI): Promise<ServiceDef[]> {
  return parseServices(await readServicesRaw(fs));
}

export async function writeServicesText(fs: FileSystemAPI, text: string): Promise<void> {
  await ensureParentDir(fs, SERVICES_FILE);
  await fs.writeFile(SERVICES_FILE, text);
}

// 注册一条服务定义（追加到文件，供自检用临时服务）。
export async function addServiceDef(fs: FileSystemAPI, name: string, command: string, port: number | null): Promise<void> {
  const text = (await readServicesRaw(fs)).trimEnd();
  await writeServicesText(fs, `${text}${text ? '\n' : ''}${name}|${command}|${port ?? ''}\n`);
  await forcePersist(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
}

// 按名字过滤移除定义（保留注释与其他行）；返回是否真有移除。
export async function removeServiceDef(fs: FileSystemAPI, name: string): Promise<boolean> {
  const text = await readServicesRaw(fs);
  const kept = text
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      if (!t || t.startsWith('#')) return true;
      return t.split('|')[0]?.trim() !== name;
    })
    .join('\n');
  if (kept === text) return false;
  await writeServicesText(fs, kept);
  await forcePersist(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
  return true;
}

// ─── 自启清单（每行一个服务名，去重）───

export async function readAutostart(fs: FileSystemAPI): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(AUTOSTART_FILE, 'utf8');
  } catch {
    return []; // 文件不存在 → 空自启清单
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!seen.has(line)) {
      seen.add(line);
      names.push(line);
    }
  }
  return names;
}

async function writeAutostart(fs: FileSystemAPI, names: string[]): Promise<void> {
  await ensureParentDir(fs, AUTOSTART_FILE);
  await fs.writeFile(AUTOSTART_FILE, names.map((n) => `${n}\n`).join(''));
}

// 启用自启：写入清单并去重；返回是否新增。
export async function enableAutostart(fs: FileSystemAPI, name: string): Promise<boolean> {
  const names = await readAutostart(fs);
  if (names.includes(name)) {
    void log('INFO', `service enable: ${name} already enabled`);
    return false;
  }
  names.push(name);
  await writeAutostart(fs, names);
  await forcePersist(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
  void log('INFO', `service enable: ${name}`);
  return true;
}

// 取消自启：从清单移除；返回是否原本存在。
export async function disableAutostart(fs: FileSystemAPI, name: string): Promise<boolean> {
  const names = await readAutostart(fs);
  if (!names.includes(name)) {
    void log('INFO', `service disable: ${name} not enabled`);
    return false;
  }
  await writeAutostart(fs, names.filter((n) => n !== name));
  await forcePersist(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
  void log('INFO', `service disable: ${name}`);
  return true;
}

// ─── 端口与命令渲染 ───

// 有效端口 = settings 的 preview-port（整数 1-65535），否则回落默认 3001。
export async function resolvePreviewPort(fs: FileSystemAPI): Promise<number> {
  const raw = await getSetting(fs, 'preview-port');
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

// 渲染命令模板：${PORT} 占位符替换为当前 preview-port（启动时读最新设置）。
export async function renderCommand(fs: FileSystemAPI, def: ServiceDef): Promise<string> {
  const port = await resolvePreviewPort(fs);
  return def.command.replace(/\$\{PORT\}/g, String(port));
}

// ─── 状态与生命周期 ───

// 命令签名：去掉引号、折叠空白 —— host 分词建 cmd 时剥离包裹引号，两边归一后才能可靠 includes 匹配。
function commandSignature(s: string): string {
  return s.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

// 匹配用命令渲染：会话内启动记录值优先（M1 残余修复，TASK18）。
// 运行中改 preview-port 后，正在运行的服务实际命令行仍是启动时的端口（如 --port 3001）；
// 若用当前 preview-port 渲染 needle（--port 3002），findServiceProcess 会匹配不到进程，
// status 误判 stopped。有记录时用记录值渲染 needle；无记录回落动态渲染。
async function renderCommandForMatch(ctx: ServiceContext, def: ServiceDef): Promise<string> {
  const recorded = activePorts.get(def.name);
  if (recorded !== undefined && def.command.includes('${PORT}')) {
    return def.command.replace(/\$\{PORT\}/g, String(recorded));
  }
  return renderCommand(ctx.wc.fs, def);
}

// 进程表里匹配该服务（渲染后命令）且 running 的进程。
async function findServiceProcess(ctx: ServiceContext, def: ServiceDef): Promise<{ pid: number; cmd: string } | undefined> {
  const needle = commandSignature(await renderCommandForMatch(ctx, def));
  let procs: Array<Record<string, unknown>> = [];
  try {
    const ps = await ctx.client.terminal('ps');
    procs = Array.isArray(ps.processes) ? ps.processes : [];
  } catch {
    return undefined; // 进程表不可达：按无匹配处理
  }
  const found = procs.find(
    (p) => p.status === 'running' && commandSignature(String(p.cmd ?? '')).includes(needle)
  );
  return found ? { pid: Number(found.pid), cmd: String(found.cmd) } : undefined;
}

// 有效端口解析：会话内启动记录值优先（M1：preview-port 改动后服务仍监听启动时端口）；
// 未启动过（或启动时显式 preferRecorded=false）的服务回落动态解析——命令含 ${PORT}
// 占位符时按当前 preview-port，否则 def.port。startService 走 preferRecorded=false：
// 新实例监听的是"当前" preview-port，忽略可能残留的旧记录（服务崩溃后 record 未清场景）。
async function resolveEffectivePort(ctx: ServiceContext, def: ServiceDef, preferRecorded = true): Promise<number | null> {
  if (preferRecorded) {
    const recorded = activePorts.get(def.name);
    if (recorded !== undefined) return recorded;
  }
  return def.command.includes('${PORT}') ? await resolvePreviewPort(ctx.wc.fs) : def.port;
}

// 状态判定：running 需进程表 running 且（有端口时）端口注册表就绪。
// 端口取"有效端口"（resolveEffectivePort）——preview-port 改动后服务实际监听新端口，
// 若用静态 def.port 判定会失真（新端口就绪却报 stopped / 旧端口展示与 URL 矛盾）。
export async function getServiceState(ctx: ServiceContext, def: ServiceDef): Promise<ServiceState> {
  const effectivePort = await resolveEffectivePort(ctx, def);
  const proc = await findServiceProcess(ctx, def);
  if (proc) {
    const portOk = effectivePort === null || ctx.ports.has(effectivePort);
    if (portOk) {
      return {
        def,
        state: 'running',
        pid: proc.pid,
        effectivePort,
        url: effectivePort !== null ? ctx.ports.get(effectivePort) : undefined,
      };
    }
  }
  return { def, state: 'stopped', effectivePort };
}

export async function listServiceStates(ctx: ServiceContext): Promise<ServiceState[]> {
  const defs = await readServices(ctx.wc.fs);
  return Promise.all(defs.map((def) => getServiceState(ctx, def)));
}

// 启动服务：同名只允许一个实例（进程表已有 running 进程 → 幂等报告已运行）；
// 有端口则等待端口就绪，进程提前退出 / 超时即失败。
export async function startService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  const defs = await readServices(ctx.wc.fs);
  const def = defs.find((d) => d.name === name);
  if (!def) {
    void log('WARN', `service start failed: ${name} (unknown service)`);
    return { ok: false, message: `unknown service: ${name}` };
  }

  const existing = await findServiceProcess(ctx, def);
  if (existing) {
    void log('INFO', `service start: ${name} already running (pid=${existing.pid})`);
    return { ok: true, message: `service '${name}' is already running (pid=${existing.pid})`, pid: existing.pid };
  }

  const command = await renderCommand(ctx.wc.fs, def);
  // TASK19：npx 服务缺包先安装（autostart/start 共用），避免 npx 即时下载与端口等待竞态。
  await ensureNpxPackage(ctx, command);
  // 新实例按当前 preview-port 解析（忽略旧记录），spawn 成功后记录实际端口。
  const effectivePort = await resolveEffectivePort(ctx, def, false);
  let pid: number;
  try {
    const r = await ctx.client.spawn(command, undefined, 8000);
    if (!r.ok || !r.pid) {
      const why = r.error || r.stderr || 'spawn returned failure';
      void log('WARN', `service start failed: ${name} (${why})`);
      return { ok: false, message: `failed to start '${name}': ${why}` };
    }
    pid = Number(r.pid);
  } catch (e) {
    void log('WARN', `service start failed: ${name} (${String(e)})`);
    return { ok: false, message: `failed to start '${name}': ${String(e)}` };
  }

  if (effectivePort === null) {
    void log('INFO', `service start: ${name} pid=${pid}`);
    return { ok: true, message: `service '${name}' started (pid=${pid})`, pid };
  }

  // 记录实际端口（M1）：preview-port 改动后服务监听的是启动时端口，就绪等待与后续
  // status/列表/URL 都用记录值，避免静态 def.port 误报。
  activePorts.set(name, effectivePort);

  // 等端口就绪：进程还在且端口未就绪 → 继续等；进程提前退出 → 立即失败。
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    if (ctx.ports.has(effectivePort)) {
      void log('INFO', `service start: ${name} pid=${pid} port=${effectivePort}`);
      return { ok: true, message: `service '${name}' started (pid=${pid}, port ${effectivePort})`, pid };
    }
    const alive = await findServiceProcess(ctx, def);
    if (!alive) {
      void log('WARN', `service start failed: ${name} exited before port ${effectivePort} became ready`);
      return { ok: false, message: `service '${name}' exited before port ${effectivePort} became ready`, pid };
    }
    await sleep(500);
  }
  void log('WARN', `service start: ${name} pid=${pid} port ${effectivePort} not ready within ${PORT_WAIT_MS / 1000}s`);
  return {
    ok: false,
    message: `service '${name}' process started (pid=${pid}) but port ${effectivePort} not ready within ${PORT_WAIT_MS / 1000}s`,
    pid,
  };
}

// 停止服务：查进程表 → kill；端口注册表条目由 host 的 port close 事件自动移除（现有逻辑）。
// kill 是异步的：返回前有界等待进程退出，消除 stop 后立即 status 仍看到 running 的竞态。
const EXIT_WAIT_MS = 5000;

export async function stopService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  const defs = await readServices(ctx.wc.fs);
  const def = defs.find((d) => d.name === name);
  if (!def) {
    void log('WARN', `service stop failed: ${name} (unknown service)`);
    return { ok: false, message: `unknown service: ${name}` };
  }

  const proc = await findServiceProcess(ctx, def);
  if (!proc) {
    void log('WARN', `service stop: ${name} not running`);
    return { ok: false, message: `service '${name}' is not running` };
  }

  try {
    const k = await ctx.client.terminal(`kill ${proc.pid}`);
    if (!k.ok || !k.killed) {
      const why = k.message ?? 'unknown reason';
      void log('WARN', `service stop failed: ${name} (${why})`);
      return { ok: false, message: `failed to stop '${name}': ${why}` };
    }
    // 有界等待：SIGTERM 已发，轮询进程表直到该 pid 不再是 running（或超时兜底）。
    const deadline = Date.now() + EXIT_WAIT_MS;
    while (Date.now() < deadline) {
      const ps = await ctx.client.terminal('ps');
      const procs = Array.isArray(ps.processes) ? ps.processes : [];
      const alive = procs.find((p) => Number(p.pid) === proc.pid && p.status === 'running');
      if (!alive) break;
      await sleep(100);
    }
    void log('INFO', `service stop: ${name} pid=${proc.pid}`);
    activePorts.delete(name); // M1：stop 后清除记录端口，状态回落动态解析
    return { ok: true, message: `service '${name}' stopped (pid=${proc.pid})`, pid: proc.pid };
  } catch (e) {
    void log('WARN', `service stop failed: ${name} (${String(e)})`);
    return { ok: false, message: `failed to stop '${name}': ${String(e)}` };
  }
}
