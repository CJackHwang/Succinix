// 服务管理模块（TASK11）：/etc/webunix.services（服务定义）与 /etc/webunix.autostart（自启清单）。
// 服务 = 给后台进程（spawn）起名字 + 生命周期管理 + 可选开机自启，是 spawn/ps/kill + 端口注册表的
// **声明式封装**。定义文件 name|command|port，`|` 分隔、`#` 注释，随快照持久。
// 自启是"声明式重启"（boot 时拉起），不是守护进程/崩溃自愈（AGENTS.md 边界，不做崩溃重启）。
// 状态判定：进程表有该服务命令的 running 进程 且（若有端口）端口注册表就绪 → running，否则 stopped。
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { getSetting } from './config.js';

export const SERVICES_FILE = '/etc/webunix.services';
export const AUTOSTART_FILE = '/etc/webunix.autostart';

// 内置预置：文件缺失时回落 / boot 初始化写入。${PORT} 占位符在启动时替换为 settings 的 preview-port。
export const DEFAULT_SERVICES_TEXT =
  '# WebUnix service definitions (name|command|port)\n' +
  'tinbase|npx tinbase start --port ${PORT} --engine wasm|3001\n';

const DEFAULT_PORT = 3001;
const PORT_WAIT_MS = 30000;

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── 文件 I/O ───

async function ensureParentDir(fs: FileSystemAPI, file: string): Promise<void> {
  const idx = file.lastIndexOf('/');
  if (idx <= 0) return;
  try {
    await fs.mkdir(file.slice(0, idx), { recursive: true });
  } catch {
    /* 目录已存在等，写入继续 */
  }
}

// 确保定义/自启文件存在：缺失时写内置预置 / 空清单（boot 调用，用户可随后编辑）。
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
  if (names.includes(name)) return false;
  names.push(name);
  await writeAutostart(fs, names);
  return true;
}

// 取消自启：从清单移除；返回是否原本存在。
export async function disableAutostart(fs: FileSystemAPI, name: string): Promise<boolean> {
  const names = await readAutostart(fs);
  if (!names.includes(name)) return false;
  await writeAutostart(fs, names.filter((n) => n !== name));
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

// 进程表里匹配该服务（渲染后命令）且 running 的进程。
async function findServiceProcess(ctx: ServiceContext, def: ServiceDef): Promise<{ pid: number; cmd: string } | undefined> {
  const command = await renderCommand(ctx.wc.fs, def);
  const needle = commandSignature(command);
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

// 状态判定：running 需进程表 running 且（有端口时）端口注册表就绪。
// 端口取"有效端口"：命令含 ${PORT} 占位符时按当前 preview-port 解析（preview-port 改动后
// 服务实际监听新端口，若用静态 def.port 判定会失真——新端口就绪却报 stopped）。
export async function getServiceState(ctx: ServiceContext, def: ServiceDef): Promise<ServiceState> {
  const proc = await findServiceProcess(ctx, def);
  if (proc) {
    const effectivePort = def.command.includes('${PORT}') ? await resolvePreviewPort(ctx.wc.fs) : def.port;
    const portOk = effectivePort === null || ctx.ports.has(effectivePort);
    if (portOk) {
      return {
        def,
        state: 'running',
        pid: proc.pid,
        url: effectivePort !== null ? ctx.ports.get(effectivePort) : undefined,
      };
    }
  }
  return { def, state: 'stopped' };
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
  if (!def) return { ok: false, message: `unknown service: ${name}` };

  const existing = await findServiceProcess(ctx, def);
  if (existing) {
    return { ok: true, message: `service '${name}' is already running (pid=${existing.pid})`, pid: existing.pid };
  }

  const command = await renderCommand(ctx.wc.fs, def);
  let pid: number;
  try {
    const r = await ctx.client.spawn(command, undefined, 8000);
    if (!r.ok || !r.pid) {
      return { ok: false, message: `failed to start '${name}': ${r.error || r.stderr || 'spawn returned failure'}` };
    }
    pid = Number(r.pid);
  } catch (e) {
    return { ok: false, message: `failed to start '${name}': ${String(e)}` };
  }

  if (def.port === null) {
    return { ok: true, message: `service '${name}' started (pid=${pid})`, pid };
  }

  // 等端口就绪：进程还在且端口未就绪 → 继续等；进程提前退出 → 立即失败。
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    if (ctx.ports.has(def.port)) {
      return { ok: true, message: `service '${name}' started (pid=${pid}, port ${def.port})`, pid };
    }
    const alive = await findServiceProcess(ctx, def);
    if (!alive) {
      return { ok: false, message: `service '${name}' exited before port ${def.port} became ready`, pid };
    }
    await sleep(500);
  }
  return {
    ok: false,
    message: `service '${name}' process started (pid=${pid}) but port ${def.port} not ready within ${PORT_WAIT_MS / 1000}s`,
    pid,
  };
}

// 停止服务：查进程表 → kill；端口注册表条目由 host 的 port close 事件自动移除（现有逻辑）。
// kill 是异步的：返回前有界等待进程退出，消除 stop 后立即 status 仍看到 running 的竞态。
const EXIT_WAIT_MS = 5000;

export async function stopService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  const defs = await readServices(ctx.wc.fs);
  const def = defs.find((d) => d.name === name);
  if (!def) return { ok: false, message: `unknown service: ${name}` };

  const proc = await findServiceProcess(ctx, def);
  if (!proc) return { ok: false, message: `service '${name}' is not running` };

  try {
    const k = await ctx.client.terminal(`kill ${proc.pid}`);
    if (!k.ok || !k.killed) {
      return { ok: false, message: `failed to stop '${name}': ${k.message ?? 'unknown reason'}` };
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
    return { ok: true, message: `service '${name}' stopped (pid=${proc.pid})`, pid: proc.pid };
  } catch (e) {
    return { ok: false, message: `failed to stop '${name}': ${String(e)}` };
  }
}
