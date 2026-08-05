// 日志模块（TASK12）：journald 风格，落盘 /var/log/succinix.log（容器 FS，随快照持久）。
// 行格式：2026-08-05T04:00:00Z [level] message（level: INFO/WARN/ERROR/BOOT）。
// 采集点：boot 事件 / 命令执行 / 服务事件 / 快照事件 / 错误，全部经 log() 落盘。
// 约束：日志写入失败绝不影响主流程（内部全捕获静默降级）。
//
// 注意：WebContainer FileSystemAPI（1.6.4）没有 appendFile（类型与运行时均无），
// 因此追加实现为"读现有内容 + 写回"（POC 文件小，~200KB 上限内全量读改写可接受）。
import type { FileSystemAPI } from '@webcontainer/api';

export const LOG_FILE = '/var/log/succinix.log';
/** 简化 log rotate：超过 ~200KB 时截断保留尾部 */
const MAX_LOG_BYTES = 200 * 1024;

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'BOOT';

let logFs: FileSystemAPI | null = null;

// 串行写链：保证日志行按调用顺序落盘。调用方可 fire-and-forget（void log(...)）不阻塞命令流，
// 也可 await 等待本次写入完成；doLog 内部捕获全部异常，链永不 reject。
let writeChain: Promise<void> = Promise.resolve();

// 初始化日志模块（boot.ts 在 WebContainer 就绪后调用，注入容器 FS；可重复调用）。
// 同时确保 /var/log 目录存在（全新系统没有该目录；快照恢复后已有），失败静默下次重试。
export function initLogger(fs: FileSystemAPI): void {
  logFs = fs;
  void ensureLogDir(fs);
}

// 追加一条日志。写失败静默降级，绝不影响主流程。
export function log(level: LogLevel, msg: string): Promise<void> {
  const fs = logFs;
  if (!fs) return Promise.resolve();
  writeChain = writeChain
    .then(() => doLog(fs, level, msg))
    .catch(() => {
      /* 静默降级：日志写失败不影响主流程 */
    });
  return writeChain;
}

// 等待排队中的日志全部落盘（自检/测试在断言前调用，保证读到已写入的内容）。
export async function flushLogs(): Promise<void> {
  await writeChain;
}

// 单行格式：ISO 时间戳 + [级别] + 消息；消息内换行折叠为空格，保证一行一条日志。
function formatLine(level: LogLevel, msg: string): string {
  const clean = msg.replace(/\r?\n/g, ' ').trim();
  return `${new Date().toISOString()} [${level}] ${clean}`;
}

// 确保 /var/log 存在；成功后标记，避免每次写入都重复 mkdir。
let logDirReady = false;

async function ensureLogDir(fs: FileSystemAPI): Promise<void> {
  if (logDirReady) return;
  try {
    await fs.mkdir('/var/log', { recursive: true });
    logDirReady = true;
  } catch {
    /* 目录创建失败：下次写入再试 */
  }
}

async function doLog(fs: FileSystemAPI, level: LogLevel, msg: string): Promise<void> {
  await ensureLogDir(fs);
  const line = formatLine(level, msg);
  // 追加：读现有内容 + 写回（无 appendFile；POC 全量读改写，200KB 内可接受）。
  const existing = await fs.readFile(LOG_FILE, 'utf8').catch(() => '');
  let next = `${existing}${line}\n`;
  // 简化 log rotate：超过上限截断保留尾部（从行首截，避免把一行切成两半）。
  // 退化场景：尾部是一整条超长单行（tail 内无换行，或唯一的 \n 就在末尾）时，
  // 保留尾部原样——宁可按行略超限，也不把整条日志清空。
  if (next.length > MAX_LOG_BYTES) {
    const tail = next.slice(-MAX_LOG_BYTES);
    const idx = tail.indexOf('\n');
    next = idx === -1 || idx === tail.length - 1 ? tail : tail.slice(idx + 1);
  }
  await fs.writeFile(LOG_FILE, next);
}

// 读最近 n 行（n<=0 视为全部）。返回日志原文（带时间戳）；文件缺失返回空串。
export async function readLog(fs: FileSystemAPI, n: number): Promise<string> {
  await flushLogs(); // 先等排队写入落盘，保证读到最新内容
  const text = await fs.readFile(LOG_FILE, 'utf8').catch(() => '');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 去掉结尾空元素
  const count = n > 0 ? Math.min(n, lines.length) : lines.length;
  return lines.slice(lines.length - count).join('\n');
}

// 清空日志文件。与写链串行：先等排队中的日志写完再清空，避免残留写入"复活"空文件。
export async function clearLog(fs: FileSystemAPI): Promise<void> {
  await flushLogs();
  await ensureLogDir(fs);
  await fs.writeFile(LOG_FILE, '');
}

// 只看 BOOT 级：按行级正则过滤（行首是 ISO 时间戳 + "[BOOT]"），返回最近 n 条（n<=0 视为全部）。
// 不用裸 includes('[BOOT]')，避免消息正文含 "[BOOT]" 的 INFO 行被误当 BOOT 级。
export async function readBootLog(fs: FileSystemAPI, n: number): Promise<string> {
  await flushLogs();
  const text = await fs.readFile(LOG_FILE, 'utf8').catch(() => '');
  const bootLines = text.split('\n').filter((l) => /^\S+\s+\[BOOT\]/.test(l));
  const count = n > 0 ? Math.min(n, bootLines.length) : bootLines.length;
  return bootLines.slice(bootLines.length - count).join('\n');
}
