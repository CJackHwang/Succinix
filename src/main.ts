import { WebContainer } from '@webcontainer/api';

const statusEl = document.getElementById('status')!;
const outputEl = document.getElementById('output')!;
const log = (s: string) => {
  outputEl.textContent += s + '\n';
  outputEl.scrollTop = outputEl.scrollHeight;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── TerminalExecutor 客户端：浏览器侧单一入口，内部仍走文件 RPC ───
// 通道与 host 保持一致：/cmd.json → /result.json。
class TerminalClient {
  private id = 0;

  constructor(private wc: WebContainer) {}

  // 统一终端入口：协议命令（ps / kill / cwd / ping / exit）直接命中；
  // 其余命令作为 run 发送，由 host 统一路由到真 Node 或 Lifo。
  async terminal(command: string, opts?: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    const trimmed = command.trim();
    if (trimmed === 'ps' || trimmed === 'cwd' || trimmed === 'ping' || trimmed === 'exit') {
      return this.exec(trimmed, undefined, timeoutMs);
    }
    const killMatch = /^kill\s+(\d+)$/.exec(trimmed);
    if (killMatch) {
      return this.exec('kill', { pid: Number(killMatch[1]) }, timeoutMs);
    }
    return this.exec('run', { command, ...opts }, timeoutMs);
  }

  async exec(cmd: string, opts?: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    const id = ++this.id;
    await this.wc.fs.writeFile('/cmd.json', JSON.stringify({ id, cmd, opts }));
    const resultFile = `/result-${id}.json`;
    const start = Date.now();
    for (;;) {
      try {
        const raw = await this.wc.fs.readFile(resultFile, 'utf8');
        const m = JSON.parse(raw);
        // 读到即删：每个请求独立结果文件，避免与迟到的异步写入互相覆盖
        try {
          await this.wc.fs.rm(resultFile);
        } catch {
          /* 清理失败不影响 */
        }
        return m;
      } catch {
        /* 结果未就绪 */
      }
      if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${cmd}`);
      await sleep(150);
    }
  }
}

async function ensureTerminalHost(wc: WebContainer): Promise<TerminalClient> {
  // host.js 由 Vite 预打包并提供；容器里没有就注入
  try {
    await wc.fs.readFile('/host.js');
  } catch {
    const src = await (await fetch('/host.js')).text();
    await wc.fs.writeFile('/host.js', src);
    log(`✅ 已注入 host.js (${(src.length / 1024).toFixed(0)} KB)`);
  }
  log('→ 拉起常驻 host 进程 (node host.js)');
  await wc.spawn('node', ['host.js']);
  const client = new TerminalClient(wc);
  for (let i = 0; i < 40; i++) {
    try {
      const p = await client.exec('ping', undefined, 2000);
      if (p.kind === 'pong') return client;
    } catch {
      /* host 未就绪 */
    }
    await sleep(300);
  }
  throw new Error('host 无响应');
}

// ─── 测试 ───
let pass = 0;
let fail = 0;
function verdict(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string) {
  log(`\n── ${title} ──`);
}

async function main() {
  try {
    statusEl.textContent = 'booting WebContainer…';
    const wc = await WebContainer.boot();
    log('✅ WebContainer booted');

    // 浏览器先写一个"项目文件"（TE3 / TE5 管道会用到）
    await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');
    log('✅ wc.fs.writeFile(/browser-wrote.txt)');

    const t = await ensureTerminalHost(wc);
    log('✅ host 就绪（自动拉起成功）\n');

    // ─── 基础协议 ───
    section('基础协议');
    const p1 = await t.exec('ping');
    verdict('P1 ping', p1.kind === 'pong');

    const p2 = await t.exec('cwd');
    const hostCwd = String(p2.cwd ?? '');
    verdict('P2 cwd（统一 cwd = process.cwd()）', p2.ok && hostCwd.startsWith('/'), hostCwd);

    // ─── 共享文件系统（已实测结论，回归验证）───
    section('共享文件系统');
    const fs1 = await t.terminal('cat /workspace/browser-wrote.txt');
    verdict(
      'FS1 lifo 读浏览器文件',
      fs1.ok && fs1.runtime === 'lifo' && String(fs1.stdout ?? '').includes('hello from browser'),
      String(fs1.stdout ?? '').trim().slice(0, 60)
    );

    const fs2 = await t.terminal('echo "persistent-host-write" > /workspace/lifo-wrote.txt');
    const back = await wc.fs.readFile('/lifo-wrote.txt', 'utf8');
    verdict('FS2 浏览器读回 lifo 写的文件', fs2.ok && back.trim() === 'persistent-host-write', JSON.stringify(back.trim()));

    const fs3 = await t.terminal('node -e "console.log(process.cwd())"');
    verdict('FS3 node 子进程 cwd 与 host 统一', fs3.ok && String(fs3.stdout ?? '').trim() === hostCwd, String(fs3.stdout ?? '').trim());

    const fs4a = await t.terminal('cd /workspace');
    const fs4b = await t.terminal('pwd');
    verdict('FS4 lifo cwd 跨命令持久', fs4a.ok && fs4b.ok && String(fs4b.stdout ?? '').trim() === '/workspace', String(fs4b.stdout ?? '').trim());

    // ─── TerminalExecutor 统一路由 ───
    section('TerminalExecutor 统一路由');

    // TE1: node 前缀 → 真 Node 子进程，参数数组从命令串解析
    const te1 = await t.terminal('node -e "console.log(21*2)"');
    verdict(
      'TE1 node -e 21*2 → stdout=42 / runtime=node',
      te1.ok && String(te1.stdout ?? '').trim() === '42' && te1.runtime === 'node',
      `runtime=${te1.runtime} stdout=${String(te1.stdout ?? '').trim()}`
    );

    // TE2: npm 前缀 → 真 Node 子进程（PATH 解析）
    const te2 = await t.terminal('npm --version');
    verdict('TE2 npm --version → runtime=node', te2.ok && te2.runtime === 'node', `runtime=${te2.runtime} ${String(te2.stdout ?? '').trim().slice(0, 30)}`);

    // TE3: 非 node 前缀 → Lifo Unix 工具
    const te3 = await t.terminal('grep -i lifo /workspace/browser-wrote.txt');
    verdict(
      'TE3 grep -i lifo → runtime=lifo',
      te3.ok && te3.runtime === 'lifo' && String(te3.stdout ?? '').toLowerCase().includes('lifo'),
      `runtime=${te3.runtime} ${String(te3.stdout ?? '').trim().slice(0, 50)}`
    );

    // TE4: ps 进程表应列出刚才的 node 子进程
    const te4 = await t.terminal('ps');
    const procs: any[] = Array.isArray(te4.processes) ? te4.processes : [];
    const nodeProc = procs.find((pr) => String(pr.cmd ?? '').startsWith('node'));
    verdict('TE4 ps 列出 node 子进程', !!nodeProc && nodeProc.pid > 0, nodeProc ? `pid=${nodeProc.pid} "${nodeProc.cmd}" [${nodeProc.status}]` : '未找到 node 子进程');

    // TE5: 管道仍走 Lifo
    const te5 = await t.terminal('cat /workspace/browser-wrote.txt | wc -c');
    verdict('TE5 管道 cat|wc → runtime=lifo / 74', te5.ok && te5.runtime === 'lifo' && String(te5.stdout ?? '').trim() === '74', `runtime=${te5.runtime} stdout=${String(te5.stdout ?? '').trim()}`);

    // TE6: kill 长驻 node 子进程（先挂起，再 ps 找到 pid 并 kill）
    try {
      await t.terminal('node -e "setInterval(()=>{},1000)"', undefined, 1500); // 预期超时：命令未结束
    } catch {
      /* 预期行为：浏览器侧先超时，host 子进程仍在进程表里 */
    }
    const psAfterStart = await t.terminal('ps');
    const longProc = (psAfterStart.processes ?? []).find(
      (pr: any) => String(pr.cmd ?? '').startsWith('node') && pr.status === 'running'
    );
    if (longProc) {
      const k = await t.terminal(`kill ${longProc.pid}`);
      verdict('TE6 kill 长驻 node 子进程', k.ok && k.killed === true, `pid=${longProc.pid} ${k.message ?? ''}`);
      await sleep(300);
      const psAfterKill = await t.terminal('ps');
      const after = (psAfterKill.processes ?? []).find((pr: any) => pr.pid === longProc.pid);
      verdict('TE6b kill 后进程状态为 exited', !after || after.status === 'exited', JSON.stringify(after ?? `pid=${longProc.pid} 已不在表中`));
    } else {
      verdict('TE6 kill 长驻 node 子进程', false, 'ps 未找到长驻 node 子进程');
    }

    // ─── 已知边界（网络/生态，慢且可能受环境限制，仅供参考，不计入 PASS/FAIL）───
    section('已知边界（仅供参考）');
    try {
      const b1 = await t.terminal('curl -s -m 12 https://example.com', undefined, 20000);
      log(`ℹ️ B1 curl 直连 example.com → exit=${b1.exitCode} ok=${b1.ok} ${String(b1.stdout || b1.stderr || '').slice(0, 60)}`);
    } catch (e) {
      log(`ℹ️ B1 curl 直连 example.com → ${String(e).slice(0, 80)}`);
    }
    try {
      const b2 = await t.terminal('curl -s -m 20 https://r.jina.ai/https://example.com', undefined, 25000);
      log(`ℹ️ B2 curl 走 r.jina.ai → ok=${b2.ok} ${String(b2.stdout || b2.stderr || '').slice(0, 60)}`);
    } catch (e) {
      log(`ℹ️ B2 curl 走 r.jina.ai → ${String(e).slice(0, 80)}`);
    }
    try {
      const b3 = await t.terminal('lifo search git', undefined, 20000);
      log(`ℹ️ B3 lifo search git → ok=${b3.ok} ${String(b3.stdout || b3.stderr || '').slice(0, 60)}`);
    } catch (e) {
      log(`ℹ️ B3 lifo search git → ${String(e).slice(0, 80)}`);
    }
    try {
      const b4 = await t.terminal('ln -s /workspace/browser-wrote.txt /workspace/mylink.txt && ls -la /workspace');
      log(`ℹ️ B4 symlink 降级 → ok=${b4.ok} ${String(b4.stdout || b4.stderr || '').slice(0, 80)}`);
    } catch (e) {
      log(`ℹ️ B4 symlink 降级 → ${String(e).slice(0, 80)}`);
    }

    // ─── 优雅退出 ───
    const pEnd = await t.terminal('exit');
    verdict('P3 exit 握手', pEnd.kind === 'bye');

    statusEl.innerHTML = `完成 — <span class="${fail ? 'fail' : 'ok'}">PASS ${pass} / FAIL ${fail}</span>`;
  } catch (e) {
    statusEl.textContent = '❌ 初始化失败';
    log(`❌ ${e}`);
  }
}

main();
