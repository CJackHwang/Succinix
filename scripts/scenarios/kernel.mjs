// 场景套件：内核行为（O11 拆分自 scenarios.mjs）。
import { check, sleep } from '../lib/harness.mjs';
import { evalValue } from '../lib/cdp.mjs';

async function s6(h) {
  const checks = [];
  const expr = `(async () => {
    const s = window.__succinixScenario;
    const cmds = [
      'node -e "setTimeout(()=>console.log(\\'OUT-A\\'),1200)"',
      'node -e "setTimeout(()=>console.log(\\'OUT-B\\'),300)"',
      'node -e "setTimeout(()=>console.log(\\'OUT-C\\'),800)"',
    ];
    const results = await Promise.all(cmds.map(async (c) => {
      try { return await s.client.terminal(c, undefined, 30000); }
      catch (e) { return { ok: false, stdout: '', exitCode: -1, error: String(e) }; }
    }));
    return JSON.stringify(results.map((r) => ({ ok: r.ok, stdout: String(r.stdout || '').trim(), exitCode: r.exitCode })));
  })()`;
  const raw = await h.evalValue(expr);
  const results = JSON.parse(raw);
  const allOk = results.every((r) => r.ok === true);
  check(checks, '3 queued long commands all return', allOk, `ok=${results.map((r) => r.ok).join(',')}`);
  const outs = results.map((r) => r.stdout);
  const noInterleave =
    outs[0] === 'OUT-A' && outs[1] === 'OUT-B' && outs[2] === 'OUT-C';
  check(checks, 'queue serialization preserves per-command output', noInterleave, JSON.stringify(outs));
  return checks;
}

async function s7(h) {
  const checks = [];
  // Lifo seq 1 10000（若内核有 seq；否则回落 node 循环）
  const probe = await h.run('seq 1 3');
  const hasSeq = probe.ok === true && String(probe.stdout).trim() === '1\n2\n3';
  if (hasSeq) {
    const r = await h.run('seq 1 10000', 30000);
    const lines = String(r.stdout || '').trim().split('\n').filter((l) => l.length > 0);
    check(checks, 'seq 1 10000 complete (Lifo)', r.ok === true && lines.length === 10000, `lines=${lines.length} bytes=${String(r.stdout).length}`);
  } else {
    const r = await h.run('node -e "for(let i=1;i<=10000;i++)console.log(i)"', 60000);
    const lines = String(r.stdout || '').trim().split('\n').filter((l) => l.length > 0);
    check(checks, '10000 lines via node', r.ok === true && lines.length === 10000, `lines=${lines.length}`);
  }

  // node 输出 2MB+ → 触发 1MB 上限裁剪，有界返回不 OOM、不卡死
  const big = await h.run(`node -e "console.log('x'.repeat(2*1024*1024))"`, 60000);
  const len = String(big.stdout || '').length;
  check(checks, '2MB output capped at 1MB', len <= 1024 * 1024 + 1, `bytes=${len}`);
  check(checks, 'big output returns bounded (no OOM/hang)', big.exitCode !== undefined, `exit=${big.exitCode} ok=${big.ok}`);
  return checks;
}

async function s9(h) {
  const checks = [];
  // 未知命令：英文报错，不挂死
  const u = await h.run('xyz-unknown-cmd-42', 15000);
  check(checks, 'unknown command errors cleanly', u.ok === false, `ok=${u.ok} exit=${u.exitCode}`);
  check(checks, 'unknown command error in English', /[a-z]/i.test(String(u.stderr || u.error || '')), String(u.stderr || u.error || '').trim().slice(0, 60));

  // 不存在目录
  const nd = await h.run('cat /nonexistent-dir-xyz/file.txt', 15000);
  check(checks, 'nonexistent dir errors cleanly', nd.ok === false && nd.exitCode !== 0, `exit=${nd.exitCode}`);

  // 网络失败（无 CORS curl）：有界返回，不挂死，英文提示
  const curl = await h.run('curl -s -m 12 https://example.com', 20000);
  check(checks, 'network failure returns bounded', curl.ok === false || curl.exitCode !== undefined, `exit=${curl.exitCode} ok=${curl.ok}`);
  check(checks, 'network failure has message', String(curl.stdout || curl.stderr || '').length > 0, String(curl.stdout || curl.stderr || '').slice(0, 60));
  return checks;
}

async function s10(h) {
  const checks = [];
  // 写标记文件 + 强制落盘
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s10-marker.txt','s10-survives')`);
  await h.run('snapshot now', 60000);

  // reboot → 页面真实 reload
  const rb = await h.run('reboot', 10000);
  check(checks, 'reboot triggered', rb.handled === true && rb.output.includes('Rebooting'), rb.output ? rb.output.trim() : '');

  // TASK25 防回归：reboot 是 setTimeout(300) 调 location.reload()。waitForScenario 可能在旧页面
  //（booted 仍 true）上立即返回，随后 reload 才落下来打到下一个场景 → 句柄丢失（S11+ 全崩）。
  // 必须先等到导航真的开始（eval 抛"context destroyed" 或句柄消失）再等新 boot。
  let navigating = false;
  const navDeadline = Date.now() + 15000;
  while (Date.now() < navDeadline && !navigating) {
    try {
      const alive = await evalValue(h.cdp, '!!window.__succinixScenario');
      if (alive === false) navigating = true;
    } catch {
      navigating = true; // context destroyed == 导航已开始
    }
    if (!navigating) await sleep(100);
  }
  if (!navigating) throw new Error('reboot navigation did not begin within 15s');

  // 等 reload + 重新 boot + 句柄就绪
  await h.waitForScenario(120000);

  // 文件仍在
  const m = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s10-marker.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'file survives reboot', m === 's10-survives', m);

  // 服务状态合理：进程表可用且干净（无孤儿 running）
  const ps = await h.run('ps');
  const procs = Array.isArray(ps.processes) ? ps.processes : [];
  const running = procs.filter((p) => p.status === 'running');
  check(checks, 'process table clean after reboot', Array.isArray(procs) && running.length === 0, `total=${procs.length} running=${running.length}`);

  // 清理
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s10-marker.txt', { force: true })`);
  return checks;
}

export const scenarios = [
  { id: 'S6', name: 'concurrency stress', run: s6 },
  { id: 'S7', name: 'big output (bounded)', run: s7 },
  { id: 'S9', name: 'error paths', run: s9 },
  { id: 'S10', name: 'environment boundary (reboot)', run: s10 },
];
