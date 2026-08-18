import fs from 'node:fs';
import { mailboxPath, type TerminalIdentity } from '../../terminal/transport-protocol.js';

/** WebContainer 守护进程使用的最小同步文件接口。 */
export interface TerminalMailboxFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  rmSync?(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

export const nodeFs: TerminalMailboxFs = fs;

export function rootPath(instanceId: string, sessionId: string): string {
  return mailboxPath({ instanceId, sessionId }, 'open.json').slice(1, -'/open.json'.length);
}

export function decodePathPart(value: string): string | null {
  try { const decoded = decodeURIComponent(value); return decoded && decoded !== '.' && decoded !== '..' ? decoded : null; } catch { return null; }
}

export function dirname(file: string): string { const i = file.lastIndexOf('/'); return i > 0 ? file.slice(0, i) : '.'; }
export function byteLength(value: string): number { return typeof Buffer === 'undefined' ? value.length : Buffer.byteLength(value); }
export function takePrefixByBytes(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (byteLength(value) <= limit) return value;
  let output = '';
  let used = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > limit) break;
    output += character;
    used += size;
  }
  return output;
}

export function splitByBytes(value: string, limit: number): string[] {
  if (byteLength(value) <= limit) return [value];
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of value) {
    const n = byteLength(char);
    if (chunk && bytes + n > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char;
    bytes += n;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function clampDimension(value: number, fallback: number): number { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
export function unlinkQuiet(fsys: TerminalMailboxFs, path: string): void { try { fsys.unlinkSync(path); } catch { /* already consumed */ } }
export function readJson(fsys: TerminalMailboxFs, path: string): unknown {
  try { return JSON.parse(fsys.readFileSync(path, 'utf8')); } catch { return null; }
}
export function sameIdentity(a: TerminalIdentity, b: TerminalIdentity): boolean {
  return a.protocolVersion === b.protocolVersion && a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.bootNonce === b.bootNonce;
}
