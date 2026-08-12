// workspace 命令域：/ws/<name> 工作区管理（O1 拆分）。
import type { FileSystemAPI } from '@webcontainer/api';
import { isValidWorkspaceName } from '../config.js';
import { forcePersist } from '@succinix/engine';
import { RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
// ─── 工作区（workspace，TASK7）：/ws/<name> 子目录 = 一个工作区，
// /ws/.current 记录当前工作区名（随快照持久，host 零改动）。
// 全部走 wc.fs 原生 API：mkdir / readFile / writeFile / rm(recursive)。

const WS_ROOT = '/ws';
const WS_CURRENT_FILE = '/ws/.current';
const DEFAULT_WORKSPACE = 'main';

// 读当前工作区名；.current 缺失或不可读返回 null。
export async function getCurrentWorkspace(fs: FileSystemAPI): Promise<string | null> {
  try {
    const raw = await fs.readFile(WS_CURRENT_FILE, 'utf8');
    const name = raw.trim();
    return name || null;
  } catch {
    return null;
  }
}

// 列出全部工作区目录名（以目录为准；.current 是文件，天然排除）。
export async function listWorkspaces(fs: FileSystemAPI): Promise<string[]> {
  try {
    const entries = await fs.readdir(WS_ROOT, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name))
      .sort();
  } catch {
    return []; // /ws 不存在（极端情况），按空列表处理
  }
}

// 组装列表输出：当前工作区置顶，其余按名字排序；表格对齐，
// (current) 列对齐到最长名字 + 5 空格，最小列宽 9。
export function buildWorkspaceList(current: string | null, names: string[]): string[] {
  const lines = ['Workspaces'];
  if (names.length === 0) {
    lines.push('  (none)');
    return lines;
  }
  const ordered = [...names].sort();
  if (current && ordered.includes(current)) {
    ordered.splice(ordered.indexOf(current), 1);
    ordered.unshift(current);
  }
  const width = Math.max(9, ...ordered.map((n) => n.length + 5));
  for (const name of ordered) {
    const marker = name === current ? '(current)' : '';
    lines.push(`  ${name.padEnd(width)}${marker}`);
  }
  return lines;
}

// 创建工作区：目录已存在则报错。
export async function workspaceCreate(fs: FileSystemAPI, name: string): Promise<{ ok: boolean; message: string }> {
  if (!isValidWorkspaceName(name)) {
    return { ok: false, message: `invalid workspace name: '${name}' (letters, digits, dot, dash, underscore only)` };
  }
  if ((await listWorkspaces(fs)).includes(name)) {
    return { ok: false, message: `Workspace '${name}' already exists` };
  }
  try {
    await fs.mkdir(WS_ROOT, { recursive: true }); // 兜底：确保 /ws 存在
    await fs.mkdir(`${WS_ROOT}/${name}`, { recursive: false });
  } catch (e) {
    return { ok: false, message: `failed to create workspace: ${String(e).slice(0, 120)}` };
  }
  return { ok: true, message: `Workspace '${name}' created. Switch with: workspace switch ${name}` };
}

// 切换工作区：更新 /ws/.current；不存在则报错。
export async function workspaceSwitch(fs: FileSystemAPI, name: string): Promise<{ ok: boolean; message: string }> {
  if (!(await listWorkspaces(fs)).includes(name)) {
    return { ok: false, message: `Workspace '${name}' does not exist` };
  }
  try {
    await fs.writeFile(WS_CURRENT_FILE, name);
  } catch (e) {
    return { ok: false, message: `failed to switch workspace: ${String(e).slice(0, 120)}` };
  }
  // H1 类盲区：等长工作区名切换（如 main→test 同为 4 字符）不改变文件数/总字节，
  // persist 的内容盲签名会跳过自动快照写，重启即回滚 —— 写盘成功后强制落盘一次。
  // 快照失败只记日志，不把已成功的切换报为失败（与 config/motd 的 forcePersist 降级一致）。
  await forcePersist(fs, 'workspace');
  return { ok: true, message: `Switched to workspace '${name}'. Your files live in /ws/${name}. cd /ws/${name} to start working.` };
}

// 删除工作区：需 --yes；禁止删当前工作区与 main。
export async function workspaceRemove(
  fs: FileSystemAPI,
  name: string,
  current: string | null,
  yes: boolean
): Promise<{ ok: boolean; message: string }> {
  if (name === DEFAULT_WORKSPACE) {
    return { ok: false, message: `cannot remove 'main' (default workspace)` };
  }
  if (name === current) {
    return { ok: false, message: `cannot remove the current workspace (switch first: workspace switch main)` };
  }
  if (!(await listWorkspaces(fs)).includes(name)) {
    return { ok: false, message: `Workspace '${name}' does not exist` };
  }
  if (!yes) {
    return { ok: false, message: `This will permanently remove workspace '${name}' and its files. Confirm with: workspace rm ${name} --yes` };
  }
  try {
    await fs.rm(`${WS_ROOT}/${name}`, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, message: `failed to remove workspace: ${String(e).slice(0, 120)}` };
  }
  return { ok: true, message: `Workspace '${name}' removed` };
}

// workspace 命令族：workspace | create <name> | switch <name> | rm <name> --yes
export async function workspaceCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    const current = await getCurrentWorkspace(ctx.wc.fs);
    const names = await listWorkspaces(ctx.wc.fs);
    for (const line of buildWorkspaceList(current, names)) term.writeln(line);
    return;
  }
  if (sub === 'create') {
    const name = args[1] ?? '';
    if (!name) {
      term.writeln('usage: workspace create <name>');
      return;
    }
    const r = await workspaceCreate(ctx.wc.fs, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }
  if (sub === 'switch') {
    const name = args[1] ?? '';
    if (!name) {
      term.writeln('usage: workspace switch <name>');
      return;
    }
    const r = await workspaceSwitch(ctx.wc.fs, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }
  if (sub === 'rm') {
    const name = args[1] ?? '';
    if (!name) {
      term.writeln('usage: workspace rm <name> --yes');
      return;
    }
    const current = await getCurrentWorkspace(ctx.wc.fs);
    const r = await workspaceRemove(ctx.wc.fs, name, current, args.includes('--yes'));
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }
  term.writeln('usage: workspace | workspace create <name> | workspace switch <name> | workspace rm <name> --yes');
}
