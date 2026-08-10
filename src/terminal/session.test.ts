// SuccinixTerminalSession 单测（vitest，fake RPC + 收集 output）：
// 覆盖转义序列全分支 / 排队结算 / 历史 / Tab 补全 / cwd 跟随 / boot 门禁 /
// 本地命令表 / RPC 回落 / 协议响应呈现 / 中断 / dispose / onCommand 采集。
import { describe, it, expect, vi } from 'vitest';
import {
  SuccinixTerminalSession,
  type TerminalRpc,
  type TerminalOutput,
  type LocalCommandHandler,
} from './session.js';
import type { ExecResult } from '../engine/client.js';

interface CollectedOutput extends TerminalOutput {
  text: string;
  cleared: number;
}

function makeOutput(): CollectedOutput {
  const out: CollectedOutput = {
    text: '',
    cleared: 0,
    write: (d: string) => {
      out.text += d;
    },
    clear: () => {
      out.cleared++;
    },
  };
  return out;
}

function res(partial: Partial<ExecResult>): ExecResult {
  return { ok: true, ...partial };
}

interface FakeRpcOptions {
  exec?: (cmd: string, opts?: Record<string, unknown>, timeoutMs?: number) => Promise<ExecResult>;
  interruptDirect?: (timeoutMs?: number) => Promise<ExecResult | null>;
  readdir?: (dir: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
}

function makeRpc(opts: FakeRpcOptions = {}): TerminalRpc {
  return {
    exec: opts.exec ?? (async (cmd) => res({ stdout: `${cmd} out\n` })),
    ping: async () => true,
    interruptDirect: opts.interruptDirect,
    readdir: opts.readdir,
  };
}

function collectEntries() {
  const entries: Array<{ command: string; exit: number | null; runtime: string }> = [];
  return { entries, onCommand: (e: { command: string; exit: number | null; runtime: string }) => void entries.push(e) };
}

describe('escape sequences', () => {
  it('回车执行本地命令并回提示符', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { localHandlers: { hi: async (ctx) => ctx.output.write('hello\r\n') } });
    await s.boot();
    s.handleData('hi\r');
    await vi.waitFor(() => expect(out.text).toContain('hello'));
    expect(out.text).toContain('$ ');
  });

  it('残缺/未知转义序列丢弃，不把 [ 或字母回显成乱码', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out);
    await s.boot();
    s.handleData('\x1b[3~abc'); // 未知转义 + 后续字母：整段丢弃
    expect(out.text).not.toContain('[');
    expect(out.text).not.toContain('abc');
  });

  it('退格删除字符', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out);
    await s.boot();
    s.handleData('ab\u007f');
    s.handleData('\r');
    // ab 退格 → a；空命令不触发 RPC
    expect(out.text).toContain('a');
  });

  it('Ctrl+L 清屏并重绘提示符 + 当前输入', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out);
    await s.boot();
    s.handleData('abc\u000c');
    expect(out.cleared).toBe(1);
    expect(out.text).toContain('$ abc');
  });
});

describe('history', () => {
  it('上/下箭头浏览历史，末尾哨兵回新行', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { localHandlers: { a: async () => {}, b: async () => {} } });
    await s.boot();
    s.handleData('a\r');
    await vi.waitFor(() => expect(out.text).toContain('$ '));
    s.handleData('b\r');
    await vi.waitFor(() => expect(out.text).toContain('$ '));
    s.handleData('\x1b[A'); // 上：b
    expect(out.text.endsWith('b')).toBe(true);
    s.handleData('\x1b[A'); // 上：a
    expect(out.text.endsWith('a')).toBe(true);
    s.handleData('\x1b[B'); // 下：回到新行
  });

  it('空命令不进历史', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { localHandlers: { a: async () => {} } });
    await s.boot();
    s.handleData('\r');
    s.handleData('a\r');
    await vi.waitFor(() => expect(out.text).toContain('$ '));
    s.handleData('\x1b[A'); // 只有 a 一条历史
    expect(out.text.endsWith('a')).toBe(true);
  });
});

describe('boot gate', () => {
  it('boot 前静默忽略输入（不 echo、不排队、不执行）', async () => {
    const out = makeOutput();
    const exec = vi.fn(async (cmd: string) => res({ stdout: `${cmd}\n` }));
    const s = new SuccinixTerminalSession(makeRpc({ exec }), out);
    s.handleData('hello\r');
    expect(exec).not.toHaveBeenCalled();
    expect(out.text).toBe('');
    await s.boot();
    expect(out.text).toContain('$ ');
  });

  it('bootGate=false 时无需 boot 即可输入', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { bootGate: false, localHandlers: { hi: async (ctx) => ctx.output.write('hi\r\n') } });
    s.handleData('hi\r');
    await vi.waitFor(() => expect(out.text).toContain('hi'));
  });
});

describe('queue', () => {
  it('busy 时回车排队，当前命令结算后出队执行，空则回提示符', async () => {
    const out = makeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'slow') await gate;
      return res({ stdout: `${cmd} done\n` });
    });
    const s = new SuccinixTerminalSession(makeRpc({ exec }), out);
    await s.boot();
    s.handleData('slow\r');
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('slow', undefined, 60000));
    s.handleData('fast\r');
    await vi.waitFor(() => expect(out.text).toContain('queued: will run after the current command finishes'));
    release();
    await vi.waitFor(() => expect(out.text).toContain('fast done'));
    expect(out.text).toContain('$ ');
  });

  it('busy 时空命令不排队', async () => {
    const out = makeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new SuccinixTerminalSession(makeRpc({ exec: async () => (await gate, res({})) }), out);
    await s.boot();
    s.handleData('x\r');
    s.handleData('\r');
    expect(out.text).not.toContain('queued');
    release();
  });
});

describe('tab completion', () => {
  it('无 readdir 时降级为仅命令名补全', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { localHandlers: { clear: async () => {}, clearall: async () => {} } });
    await s.boot();
    s.handleData('clea');
    s.handleData('\t');
    await vi.waitFor(() => expect(out.text.endsWith('r')).toBe(true)); // 共同前缀补全
  });

  it('命令名多候选列出 + 共同前缀', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { localHandlers: { clear: async () => {}, clearall: async () => {} } });
    await s.boot();
    s.handleData('cle');
    s.handleData('\t');
    // clear / clearall 共同前缀 clear（token=cle，common=clear 长于 token）→ 补全到 clear
    await vi.waitFor(() => expect(out.text.endsWith('clear')).toBe(true));
  });

  it('路径补全走 readdir RPC，含 / 的 token 用绝对路径候选', async () => {
    const out = makeOutput();
    const rpc = makeRpc({
      readdir: async (dir) => {
        if (dir === '/') return [{ name: 'etc', isDirectory: () => true }, { name: 'var', isDirectory: () => false }];
        return [];
      },
    });
    const s = new SuccinixTerminalSession(rpc, out, { localHandlers: { cat: async () => {} } });
    await s.boot();
    s.handleData('cat /e');
    s.handleData('\t');
    await vi.waitFor(() => expect(out.text.endsWith('etc/')).toBe(true));
  });

  it('无斜杠 token 按会话 cwd 补当前目录条目', async () => {
    const out = makeOutput();
    const rpc = makeRpc({
      readdir: async (dir) => {
        // 会话 cwd /workspace → 浏览器路径 /
        expect(dir).toBe('/');
        return [{ name: 'main', isDirectory: () => true }];
      },
    });
    const s = new SuccinixTerminalSession(rpc, out, { localHandlers: { cd: async () => {} } });
    await s.boot();
    s.handleData('cd ma');
    s.handleData('\t');
    await vi.waitFor(() => expect(out.text.endsWith('main/')).toBe(true));
  });
});

describe('cwd follow', () => {
  it('cd 成功（结果带 cwd）→ 会话 cwd 更新 + 提示符短路径', async () => {
    const out = makeOutput();
    const rpc = makeRpc({
      exec: async (cmd) => (cmd === 'cd /workspace/proj' ? res({ cwd: '/workspace/proj' }) : res({})),
    });
    const s = new SuccinixTerminalSession(rpc, out);
    await s.boot();
    s.handleData('cd /workspace/proj\r');
    await vi.waitFor(() => expect(s.getCwd()).toBe('/workspace/proj'));
    expect(s.getPrompt()).toBe('guest@succinix:~/proj$ ');
  });

  it('pwd 内置命令打印会话 cwd', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { cwd: '/workspace/proj' });
    await s.boot();
    s.handleData('pwd\r');
    await vi.waitFor(() => expect(out.text).toContain('/workspace/proj'));
  });
});

describe('local handlers', () => {
  it('注入处理器接收 args，未命中原样走 RPC', async () => {
    const out = makeOutput();
    const exec = vi.fn(async (cmd: string) => res({ stdout: `${cmd}!\n` }));
    const handler: LocalCommandHandler = async (_ctx, args) => `got:${args.join(',')}\r\n`;
    const s = new SuccinixTerminalSession(makeRpc({ exec }), out, { localHandlers: { greet: handler } });
    await s.boot();
    s.handleData('greet a b\r');
    await vi.waitFor(() => expect(out.text).toContain('got:a,b'));
    s.handleData('unknowncmd\r');
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('unknowncmd', undefined, 60000));
  });

  it('help 列出已注入命令', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out, { localHandlers: { alpha: async () => {}, beta: async () => {} } });
    await s.boot();
    s.handleData('help\r');
    await vi.waitFor(() => expect(out.text).toContain('alpha'));
    expect(out.text).toContain('beta');
  });

  it('clear 清屏；echo 原样回显', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out);
    await s.boot();
    s.handleData('echo hello world\r');
    await vi.waitFor(() => expect(out.text).toContain('hello world'));
    s.handleData('clear\r');
    await vi.waitFor(() => expect(out.cleared).toBe(1));
  });
});

describe('protocol response rendering', () => {
  it('ps 表格渲染', async () => {
    const out = makeOutput();
    const rpc = makeRpc({
      exec: async () => res({ processes: [{ pid: 12, status: 'running', cmd: 'node host.js' }] }),
    });
    const s = new SuccinixTerminalSession(rpc, out);
    await s.boot();
    s.handleData('ps\r');
    await vi.waitFor(() => expect(out.text).toContain('PID  STATUS  COMMAND'));
    expect(out.text).toContain('node host.js');
  });

  it('spawn 后台响应 / cwd 响应 / bye 渲染', async () => {
    const out = makeOutput();
    const rpc = makeRpc({
      exec: async (cmd) => {
        if (cmd === 'spawnx') return res({ pid: 42, runtime: 'node' });
        if (cmd === 'cwd') return res({ cwd: '/workspace' });
        if (cmd === 'exit') return res({ kind: 'bye' });
        return res({});
      },
    });
    const s = new SuccinixTerminalSession(rpc, out);
    await s.boot();
    s.handleData('spawnx\r');
    await vi.waitFor(() => expect(out.text).toContain('started in background (pid=42'));
    s.handleData('cwd\r');
    await vi.waitFor(() => expect(out.text).toContain('/workspace'));
    s.handleData('exit\r');
    await vi.waitFor(() => expect(out.text).toContain('bye'));
  });

  it('stdout/stderr/exit marker/静默 error 呈现', async () => {
    const out = makeOutput();
    const rpc = makeRpc({
      exec: async () => res({ ok: false, exitCode: 2, stdout: 'o\n', stderr: 'e\n', error: 'boom' }),
    });
    const s = new SuccinixTerminalSession(rpc, out, {
      colors: { red: (x) => `<r>${x}</r>`, gray: (x) => `<g>${x}</g>`, amber: (x) => x },
    });
    await s.boot();
    s.handleData('failcmd\r');
    await vi.waitFor(() => expect(out.text).toContain('<r>e\n</r>'));
    expect(out.text).toContain('<g>[exit 2]</g>');
    // 有 stdout/stderr 时静默 error 不重复显示
    expect(out.text).not.toContain('<r>boom</r>');
  });
});

describe('interrupt', () => {
  it('busy Ctrl+C → interruptDirect + 清队列', async () => {
    const out = makeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const interrupt = vi.fn(async () => res({ ok: true, pid: 7 }));
    const s = new SuccinixTerminalSession(
      makeRpc({
        exec: async () => (await gate, res({})),
        interruptDirect: interrupt,
      }),
      out
    );
    await s.boot();
    s.handleData('slow\r');
    s.handleData('queued1\r');
    await vi.waitFor(() => expect(out.text).toContain('queued'));
    s.handleData('\u0003');
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalled());
    expect(out.text).toContain('queued commands discarded (1)');
    expect(out.text).toContain('interrupting command (pid=7)');
    release();
    await vi.waitFor(() => expect(out.text).toContain('$ '));
  });

  it('空闲 Ctrl+C → ^C + 新提示符；无 interruptDirect 时降级仅清队列', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc(), out);
    await s.boot();
    s.handleData('\u0003');
    expect(out.text).toContain('^C');
    const out2 = makeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s2 = new SuccinixTerminalSession(makeRpc({ exec: async () => (await gate, res({})) }), out2);
    await s2.boot();
    s2.handleData('x\r');
    s2.handleData('\u0003');
    await vi.waitFor(() => expect(out2.text).toContain('no interrupt channel'));
    release();
  });
});

describe('dispose & logging', () => {
  it('dispose 丢队列、抑制输出', async () => {
    const out = makeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new SuccinixTerminalSession(makeRpc({ exec: async () => (await gate, res({})) }), out);
    await s.boot();
    s.handleData('x\r');
    s.handleData('y\r');
    await vi.waitFor(() => expect(out.text).toContain('queued'));
    s.dispose();
    release();
    await new Promise((r) => setTimeout(r, 20));
    const len = out.text.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(out.text.length).toBe(len); // settle 后不再输出
  });

  it('onCommand 采集本地与 RPC 条目', async () => {
    const out = makeOutput();
    const { entries, onCommand } = collectEntries();
    const rpc = makeRpc({ exec: async () => res({ exitCode: 3 }) });
    const s = new SuccinixTerminalSession(rpc, out, { localHandlers: { hi: async () => {} }, onCommand });
    await s.boot();
    s.handleData('hi\r');
    await vi.waitFor(() => expect(entries.some((e) => e.command === 'hi' && e.runtime === 'browser')).toBe(true));
    s.handleData('node x\r');
    await vi.waitFor(() => expect(entries.some((e) => e.command === 'node x' && e.exit === 3)).toBe(true));
  });

  it('rpcExec 前置挂钩抛错 → phase=pre；RPC 抛错 → phase=rpc', async () => {
    const out = makeOutput();
    const s = new SuccinixTerminalSession(makeRpc({ exec: async () => Promise.reject(new Error('rpc down')) }), out, {
      beforeRpc: async (cmd) => {
        if (cmd === 'py') throw new Error('assets missing');
      },
    });
    const pre = await s.rpcExec('py', 1000);
    expect(pre).toMatchObject({ error: 'Error: assets missing', phase: 'pre' });
    const r = await s.rpcExec('node x', 1000);
    expect(r).toMatchObject({ error: 'Error: rpc down', phase: 'rpc' });
  });
});
