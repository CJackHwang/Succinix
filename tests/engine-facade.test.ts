// 引擎门面 createTerminalExecutor 单测（P3-12）：boot / exec / spawn / listProcesses / kill /
// ping / dispose。用假 wc（内存 FS + 假 host RPC）驱动，不碰真实 WebContainer。
// 重点：exec 超时返回 { ok:false, timedOut:true } 而非抛异常；dispose 幂等；未 boot 调用抛错。
import { describe, it, expect, vi } from 'vitest';
import { createTerminalExecutor, type TerminalExecutor } from '../src/engine/index.js';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';

interface CmdReq {
  protocol?: number;
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
}

// 假 wc：内存 FS + 假 host（写 /cmd.json 即按响应函数生成 /result-<id>.json）+ spawn/on 桩。
function makeFakeWc(respond?: (req: CmdReq) => unknown) {
  const files = new Map<string, string>();
  const spawnCalls: Array<{ prog: string; args: string[] }> = [];
  const on = vi.fn();
  const hostProc: WebContainerProcess = { kill: vi.fn() } as unknown as WebContainerProcess;

  const fs = {
    readFile: async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    writeFile: async (path: string, content: string) => {
      if (path === '/cmd.json') {
        const req = JSON.parse(content) as CmdReq;
        const payload = respond?.(req);
        // undefined = host 不响应（模拟挂起/超时）
        if (payload !== undefined) files.set(`/result-${req.id}.json`, JSON.stringify({ id: req.id, ...(payload as object) }));
        return;
      }
      files.set(path, content);
    },
    rm: async (path: string) => {
      files.delete(path);
    },
  };

  const wc = {
    fs,
    spawn: vi.fn(async (prog: string, args: string[]) => {
      spawnCalls.push({ prog, args });
      return hostProc;
    }),
    on,
  };

  return { wc: wc as unknown as WebContainer, hostProc, spawnCalls, files, on };
}

const PONG = () => ({ ok: true, kind: 'pong' });

async function makeBooted(respond?: (req: CmdReq) => unknown): Promise<{ ex: TerminalExecutor; wc: WebContainer; hostProc: WebContainerProcess }> {
  const fake = makeFakeWc(respond);
  const ex = createTerminalExecutor();
  await ex.boot(fake.wc, { hostSrc: '// host.js', lifoCoreSrc: '// lifo-core.js' });
  return { ex, ...fake };
}

describe('createTerminalExecutor boot', () => {
  it('boot 注入 host.js + spawn host + 等待就绪（ping pong）', async () => {
    const fake = makeFakeWc(PONG);
    const ex = createTerminalExecutor();
    await ex.boot(fake.wc, { hostSrc: '// host.js', lifoCoreSrc: '// lifo-core.js' });
    expect(fake.files.get('/host.js')).toBe('// host.js');
    expect(fake.spawnCalls).toEqual([{ prog: 'node', args: ['host.js'] }]);
    expect(fake.files.get('/lifo-core.js')).toBe('// lifo-core.js');
    expect(fake.on).toHaveBeenCalled(); // server-ready / port 监听器注册
  });

  it('未 boot 就调用 exec 抛错', async () => {
    const ex = createTerminalExecutor();
    await expect(ex.exec('echo hi')).rejects.toThrow(/not booted/);
    await expect(ex.listProcesses()).rejects.toThrow(/not booted/);
  });
});

describe('createTerminalExecutor exec', () => {
  it('普通命令走 run 路由，返回完整 ExecResult + timedOut:false', async () => {
    const { ex } = await makeBooted((req) => (req.cmd === 'run' ? { ok: true, stdout: 'hi', runtime: 'lifo', exitCode: 0 } : PONG()));
    const res = await ex.exec('echo hi');
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('hi');
    expect(res.timedOut).toBe(false);
  });

  it('超时不抛异常：返回 { ok:false, timedOut:true }（收敛原始错误）', async () => {
    // boot 需要 ping 响应；run 不响应 → exec 超时。
    const { ex } = await makeBooted((req) => (req.cmd === 'ping' ? PONG() : undefined));
    const res = await ex.exec('sleep 60', { timeoutMs: 150 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(typeof res.stderr).toBe('string');
  });
});

describe('createTerminalExecutor spawn / listProcesses / kill / ping', () => {
  it('spawn 返回 pid', async () => {
    const { ex } = await makeBooted((req) => (req.cmd === 'spawn' ? { ok: true, pid: 123, runtime: 'node' } : PONG()));
    const res = await ex.spawn('node server.js');
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(123);
  });

  it('listProcesses 返回进程表快照', async () => {
    const { ex } = await makeBooted((req) =>
      req.cmd === 'ps'
        ? { ok: true, processes: [{ pid: 1, cmd: 'node host.js', status: 'running' }] }
        : PONG()
    );
    const procs = await ex.listProcesses();
    expect(procs.length).toBe(1);
    expect(procs[0]?.pid).toBe(1);
  });

  it('kill 返回 killed 状态', async () => {
    const { ex } = await makeBooted((req) => (req.cmd === 'kill' ? { ok: true, killed: true } : PONG()));
    expect(await ex.kill(42)).toBe(true);
  });

  it('ping 探活：pong → true，非 pong 响应 → false', async () => {
    const ok = await makeBooted(PONG);
    expect(await ok.ex.ping()).toBe(true);

    // boot 的第一个 ping 给 pong；之后给非 pong（kind=cwd）→ ping() 返回 false（快速，不等超时）。
    let pingCount = 0;
    const bad = await makeBooted((req) => {
      if (req.cmd === 'ping') {
        pingCount++;
        return pingCount === 1 ? PONG() : { ok: true, kind: 'cwd' };
      }
      return undefined;
    });
    expect(await bad.ex.ping()).toBe(false);
  });
});

describe('createTerminalExecutor pingDirect / respawn（P1-3）', () => {
  it('pingDirect：pong → true（绕过队列的直接探活）', async () => {
    const { ex } = await makeBooted(PONG);
    await new Promise((r) => setTimeout(r, 300)); // 清 lastCmdWrite margin
    expect(await ex.pingDirect(200)).toBe(true);
  });

  it('pingDirect：通道忙（有挂起的 run）→ null', async () => {
    let pings = 0;
    const { ex } = await makeBooted((req) => {
      if (req.cmd === 'ping') return PONG();
      if (req.cmd === 'run' && pings === 0) {
        pings++;
        return undefined; // 第一个 run 挂起（占 active）
      }
      return { ok: true, stdout: 'x', runtime: 'lifo', exitCode: 0 };
    });
    const run1 = ex.exec('slow', { timeoutMs: 300 }); // 挂起 → 短超时收尾
    await new Promise((r) => setTimeout(r, 0));
    const run2 = ex.exec('queued', { timeoutMs: 300 }); // 排队 → pending > active
    await new Promise((r) => setTimeout(r, 0));
    expect(await ex.pingDirect(100)).toBeNull();
    await Promise.all([run1, run2]);
  });

  it('respawn：kill 旧 host 再 spawn 新 host，等待就绪后可继续 exec', async () => {
    const fake = makeFakeWc(PONG);
    const ex = createTerminalExecutor();
    await ex.boot(fake.wc, { hostSrc: '// host.js', lifoCoreSrc: '// lifo-core.js' });
    expect(fake.spawnCalls.length).toBe(1);
    await ex.respawn();
    expect(fake.hostProc.kill).toHaveBeenCalledTimes(1); // kill 旧 host
    expect(fake.spawnCalls.length).toBe(2); // spawn 新 host
    const res = await ex.exec('echo hi');
    expect(res.ok).toBe(true);
  });

  it('未 boot 就 respawn 抛错', async () => {
    const ex = createTerminalExecutor();
    await expect(ex.respawn()).rejects.toThrow(/not booted/);
  });
});

describe('createTerminalExecutor dispose', () => {
  it('dispose kill host 进程并清引用；幂等', async () => {
    const fake = makeFakeWc(PONG);
    const ex = createTerminalExecutor();
    await ex.boot(fake.wc, { hostSrc: '// host.js' });
    expect(fake.hostProc.kill).not.toHaveBeenCalled();
    await ex.dispose();
    expect(fake.hostProc.kill).toHaveBeenCalledTimes(1);
    await ex.dispose(); // 幂等：第二次不再重复 kill
    expect(fake.hostProc.kill).toHaveBeenCalledTimes(1);
  });

  it('dispose 后 exec 抛错（客户端已释放）', async () => {
    const { ex } = await makeBooted(PONG);
    await ex.dispose();
    await expect(ex.exec('echo hi')).rejects.toThrow(/not booted/);
  });
});
