import { WebContainer } from '@webcontainer/api';

const statusEl = document.getElementById('status')!;
const outputEl = document.getElementById('output')!;
const log = (s: string) => {
  outputEl.textContent += s + '\n';
  outputEl.scrollTop = outputEl.scrollHeight;
};

// ─── Lifo host client: auto-launches with the WebContainer ───
// Uses file-based RPC over the shared filesystem (stdin was unreliable in the
// test environment; FS channel is proven bidirectional).
class LifoClient {
  private id = 0;

  constructor(private wc: WebContainer) {}

  async exec(cmd: string, opts?: any, timeoutMs = 30000): Promise<any> {
    const id = ++this.id;
    await this.wc.fs.writeFile('/cmd.json', JSON.stringify({ id, cmd, opts }));
    const start = Date.now();
    for (;;) {
      try {
        const raw = await this.wc.fs.readFile('/result.json', 'utf8');
        const m = JSON.parse(raw);
        if (m.id === id) return m;
      } catch {
        /* result not ready yet */
      }
      if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${cmd}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async close() {
    await this.exec('__exit__', {}, 3000);
  }
}

async function ensureLifoHost(wc: WebContainer): Promise<LifoClient> {
  // host.js is pre-bundled and served by Vite; write into the container if absent
  try {
    await wc.fs.readFile('/host.js');
  } catch {
    const src = await (await fetch('/host.js')).text();
    await wc.fs.writeFile('/host.js', src);
    log(`✅ 已注入 host.js (${(src.length / 1024).toFixed(0)} KB)`);
  }
  log('→ 拉起常驻 host 进程 (node host.js)');
  await wc.spawn('node', ['host.js']);
  const client = new LifoClient(wc);
  for (let i = 0; i < 40; i++) {
    try {
      const p = await client.exec('__ping__', {}, 2000);
      if (p.kind === 'pong') return client;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300));
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

async function main() {
  try {
    statusEl.textContent = 'booting WebContainer…';
    const wc = await WebContainer.boot();
    log('✅ WebContainer booted');

    // 浏览器先写一个"项目文件"
    await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');
    log('✅ wc.fs.writeFile(/browser-wrote.txt)');

    // Lifo 随 WC 自动拉起
    const lifo = await ensureLifoHost(wc);
    log('✅ host 就绪（自动拉起成功）\n');

    // T1: 协议连通
    const p1 = await lifo.exec('__ping__');
    verdict('T1 持久协议 ping', p1.kind === 'pong');

    // T2: 共享 FS（浏览器 → lifo）
    const p2 = await lifo.exec('cat /workspace/browser-wrote.txt');
    verdict('T2 lifo 读浏览器文件', p2.ok && p2.stdout.includes('hello from browser'), p2.stdout.trim().slice(0, 60));

    // T3: 共享 FS（lifo → 浏览器）
    const p3 = await lifo.exec('echo "persistent-host-write" > /workspace/lifo-wrote.txt');
    const back = await wc.fs.readFile('/lifo-wrote.txt', 'utf-8');
    verdict('T3 浏览器读回 lifo 写的文件', p3.ok && back.trim() === 'persistent-host-write', JSON.stringify(back.trim()));

    // T4: cwd 跨命令持久
    await lifo.exec('cd /workspace');
    const p4 = await lifo.exec('pwd');
    const p4b = await lifo.exec('pwd');
    verdict('T4 cwd 跨命令持久', p4.ok && p4b.ok && p4b.stdout.trim() === '/workspace', p4b.stdout.trim());

    // T5: 管道
    const p5 = await lifo.exec('cat /workspace/browser-wrote.txt | wc -c');
    verdict('T5 管道 cat|wc', p5.ok && p5.stdout.trim() === '74', p5.stdout.trim());

    // T6: ★ curl 直连普通网站（无 CORS 头）——CORS 行为测试
    try {
      const p6 = await lifo.exec('curl -s -m 15 https://example.com');
      verdict('T6 curl 直连 example.com（无 CORS 头）', p6.ok && p6.stdout.includes('<title>Example Domain</title>'), `exit=${p6.exitCode} ${p6.stdout.slice(0, 60) || p6.stderr.slice(0, 60)}`);
    } catch (e) {
      verdict('T6 curl 直连 example.com', false, String(e).slice(0, 80));
    }

    // T7: curl 走 Jina（CORS 友好代理）
    try {
      const p7 = await lifo.exec('curl -s -m 20 https://r.jina.ai/https://example.com');
      verdict('T7 curl 走 r.jina.ai 代理', p7.ok && p7.stdout.includes('Example Domain'), p7.stdout.slice(0, 60) || p7.stderr.slice(0, 60));
    } catch (e) {
      verdict('T7 curl 走 r.jina.ai', false, String(e).slice(0, 80));
    }

    // T8: node 兼容层
    const p8 = await lifo.exec('node -e "console.log(6*7)"');
    verdict('T8 lifo 的 node 兼容层', p8.ok && p8.stdout.trim() === '42', p8.stdout.trim() || p8.stderr.trim().slice(0, 60));

    // T9: symlink 在 WC 虚拟 FS 上的表现（高级特性降级测试）
    const p9 = await lifo.exec('ln -s browser-wrote.txt /workspace/mylink.txt && ls -la /workspace');
    verdict('T9 symlink 创建', p9.ok && p9.stdout.includes('mylink'), p9.stdout.includes('mylink') ? 'link 已创建' : p9.stderr.slice(0, 80));

    // T10: lifo pkg 生态（search 网络查询）
    try {
      const p10 = await lifo.exec('lifo search git', {}, 20000);
      verdict('T10 lifo pkg search git', p10.ok && p10.stdout.toLowerCase().includes('lifo-pkg-git'), p10.stdout.slice(0, 60) || p10.stderr.slice(0, 60));
    } catch (e) {
      verdict('T10 lifo pkg search', false, String(e).slice(0, 80));
    }

    // T12-T14: ★ TerminalExecutor 前提 — host 拉起真 Node/npm 子进程
    const p12 = await lifo.exec('__spawn_test__', {}, 40000);
    if (p12.ok && p12.r1) {
      verdict('T12 node 子进程（stdout/stderr/exit=3）', p12.r1.code === 3 && p12.r1.out === 'child-42', JSON.stringify(p12.r1));
    } else {
      verdict('T12 node 子进程', false, JSON.stringify(p12).slice(0, 150));
    }
    verdict('T13 npm --version 子进程（PATH 解析）', !!p12.r2 && !p12.r2.error && p12.r2.code === 0, JSON.stringify(p12.r2 || p12).slice(0, 120));
    verdict('T14 spawnSync node', !!p12.r3 && p12.r3.code === 0 && p12.r3.out === 'sync-ok', JSON.stringify(p12.r3 || p12).slice(0, 120));

    // T11: 优雅退出
    const p11 = await lifo.exec('__exit__');
    verdict('T11 优雅退出协议', p11.kind === 'bye');

    statusEl.innerHTML = `完成 — <span class="${fail ? 'fail' : 'ok'}">PASS ${pass} / FAIL ${fail}</span>`;
  } catch (e) {
    statusEl.textContent = '❌ 初始化失败';
    log(`❌ ${e}`);
  }
}

main();