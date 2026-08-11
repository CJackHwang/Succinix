// 包安装/移除/信息（O10 拆分自 pkg.ts）：按来源判定走 lifo 或 npm 通道，
// 回显真实命令 stdout 尾部 + 成功/失败摘要。
import { log } from '../log.js';
import {
  isValidPackageName,
  lifoTerm,
  q,
  parseLifoSearch,
  TIMEOUT,
  OUTPUT_TAIL_CHARS,
  type ActionResult,
  type PkgContext,
  type SearchEntry,
} from './metadata.js';
import { detectSource, listLifo, listNpm } from './registry.js';

// pkg install <name>：按来源判定走 lifo 或 npm；回显真实命令 stdout 尾部 + 成功/失败摘要。
export async function installPackage(ctx: PkgContext, rawName: string): Promise<ActionResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, message: 'pkg install: package name required' };
  if (!isValidPackageName(name)) {
    return { ok: false, message: `pkg install: invalid package name '${name}' (scoped @scope/name or [a-zA-Z0-9-_.]+, no whitespace, no leading dash)` };
  }
  const base = lifoTerm(name);

  const { source, fellBack } = await detectSource(ctx, name);
  const hint = fellBack ? ' (lifo unavailable — fell back to npm)' : '';
  if (source === 'lifo') {
    const r = await ctx.client.terminal(`lifo install ${q(base)}`, TIMEOUT.install.opts, TIMEOUT.install.wait);
    const out = String(r.stdout ?? '').trim();
    if (r.ok) {
      void log('INFO', `pkg install: ${base} via lifo`);
      return { ok: true, message: `'${base}' installed (source: lifo)`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
    }
    const why = r.stderr || out || r.error || 'lifo install exited non-zero';
    void log('WARN', `pkg install failed: ${base} via lifo (${String(why).slice(0, 120)})`);
    return { ok: false, message: `install failed: ${String(why).slice(0, 300)}`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }

  const r = await ctx.client.terminal(`npm install ${q(name)} --no-audit --no-fund`, TIMEOUT.install.opts, TIMEOUT.install.wait);
  const out = String(r.stdout ?? '').trim();
  if (r.ok) {
    void log('INFO', `pkg install: ${name} via npm`);
    return { ok: true, message: `'${name}' installed (source: npm)${hint}`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }
  const why = r.stderr || out || r.error || 'npm install exited non-zero';
  void log('WARN', `pkg install failed: ${name} via npm (${String(why).slice(0, 120)})`);
  return { ok: false, message: `install failed: ${String(why).slice(0, 300)}`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
}

// pkg remove <name>：按已装来源走对应通道（同名冲突优先 lifo，与 list 判定一致）。
export async function removePackage(ctx: PkgContext, rawName: string): Promise<ActionResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, message: 'pkg remove: package name required' };
  if (!isValidPackageName(name)) {
    return { ok: false, message: `pkg remove: invalid package name '${name}' (scoped @scope/name or [a-zA-Z0-9-_.]+, no whitespace, no leading dash)` };
  }
  const base = lifoTerm(name);

  if ((await listLifo(ctx.client)).some((p) => p.name === base)) {
    const r = await ctx.client.terminal(`lifo remove ${q(base)}`, TIMEOUT.remove.opts, TIMEOUT.remove.wait);
    const out = String(r.stdout ?? '').trim();
    if (r.ok) {
      void log('INFO', `pkg remove: ${base} via lifo`);
      return { ok: true, message: `'${base}' removed (source: lifo)`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
    }
    const why = r.stderr || out || r.error || 'lifo remove exited non-zero';
    void log('WARN', `pkg remove failed: ${base} via lifo (${String(why).slice(0, 120)})`);
    return { ok: false, message: `remove failed: ${String(why).slice(0, 300)}`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }

  if ((await listNpm(ctx.wc)).some((p) => p.name === name)) {
    const r = await ctx.client.terminal(`npm uninstall ${q(name)} --no-audit --no-fund`, TIMEOUT.remove.opts, TIMEOUT.remove.wait);
    const out = String(r.stdout ?? '').trim();
    if (r.ok) {
      void log('INFO', `pkg remove: ${name} via npm`);
      return { ok: true, message: `'${name}' removed (source: npm)`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
    }
    const why = r.stderr || out || r.error || 'npm uninstall exited non-zero';
    void log('WARN', `pkg remove failed: ${name} via npm (${String(why).slice(0, 120)})`);
    return { ok: false, message: `remove failed: ${String(why).slice(0, 300)}`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }

  void log('WARN', `pkg remove: ${name} not installed`);
  return { ok: false, message: `'${name}' is not installed (nothing to remove)` };
}

// pkg info <name>：来源判定（lifo 优先）→ 版本/描述。entry 供调用方渲染。
export async function packageInfo(ctx: PkgContext, rawName: string): Promise<{ ok: boolean; message: string; entry?: SearchEntry }> {
  const name = rawName.trim();
  if (!name) return { ok: false, message: 'pkg info: package name required' };
  if (!isValidPackageName(name)) {
    return { ok: false, message: `pkg info: invalid package name '${name}' (scoped @scope/name or [a-zA-Z0-9-_.]+, no whitespace, no leading dash)` };
  }
  const base = lifoTerm(name);

  // lifo 探测（来源判定规则）：命中即返回 lifo 侧信息；探测失败标记回落，供失败提示附加。
  let lifoProbeFailed = false;
  try {
    const r = await ctx.client.terminal(`lifo search ${q(base)}`, TIMEOUT.lifoSearch.opts, TIMEOUT.lifoSearch.wait);
    if (r.ok) {
      const hit = parseLifoSearch(String(r.stdout ?? '')).find((h) => h.name === base);
      if (hit) return { ok: true, message: '', entry: hit };
    }
  } catch {
    lifoProbeFailed = true; /* registry 探测失败 → 走 npm view */
  }

  // npm 通道：npm view <name> name version description --json（真 Node，registry 探测）。
  try {
    const r = await ctx.client.terminal(`npm view ${q(name)} name version description --json`, TIMEOUT.view.opts, TIMEOUT.view.wait);
    if (r.ok && String(r.stdout ?? '').trim()) {
      const o = JSON.parse(String(r.stdout)) as Record<string, unknown>;
      return {
        ok: true,
        message: '',
        entry: {
          name: String(o.name ?? name),
          version: String(o.version ?? '?'),
          description: String(o.description ?? ''),
          source: 'npm',
        },
      };
    }
    const why = r.stderr || String(r.stdout ?? '').trim().slice(0, 120) || r.error || 'npm view exited non-zero';
    const fallback = lifoProbeFailed ? ' (lifo unavailable — fell back to npm)' : '';
    return { ok: false, message: `'${name}' not found: ${why}${fallback}` };
  } catch (e) {
    const fallback = lifoProbeFailed ? ' (lifo unavailable — fell back to npm)' : '';
    return { ok: false, message: `'${name}' not found: ${String(e).slice(0, 200)}${fallback}` };
  }
}
