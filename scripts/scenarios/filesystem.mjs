// 场景套件：文件系统与持久化（O11 拆分自 scenarios.mjs）。
import { check, note } from '../lib/harness.mjs';

async function s5(h) {
  const checks = [];
  // 诊断：boot 后 /ws 初始内容（确认 main 是否存在）
  const wsInit = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/ws', { withFileTypes: true }); } catch (e) { return 'NO_WS: ' + String(e); }
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(',');
  })()`);
  note(`[S5] /ws at start: ${wsInit}`);
  await h.run('workspace create proj-a');
  await h.run('workspace create proj-b');
  await h.run('workspace switch proj-a');
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/ws/proj-a/a.txt','a-file-content')`);

  await h.run('workspace switch proj-b');
  const aInB = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-b/a.txt','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'proj-b does not see proj-a file', aInB === false, `a.txt visible in proj-b: ${aInB}`);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/ws/proj-b/b.txt','b-file-content')`);

  await h.run('workspace switch proj-a');
  const aTxt = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-a/a.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'proj-a file intact after switch', aTxt === 'a-file-content', aTxt);
  const bInA = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-a/b.txt','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'proj-a does not see proj-b file', bInA === false, `b.txt visible in proj-a: ${bInA}`);

  // 刷新后状态保留
  await h.reloadAndWait(120000);
  const wsDiag = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/ws', { withFileTypes: true }); } catch (e) { return 'NO_WS: ' + String(e); }
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(',');
  })()`);
  note(`[S5] /ws after refresh: ${wsDiag}`);
  const cur = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/.current','utf8').catch(()=>'')`);
  check(checks, 'current workspace retained after refresh', cur.trim() === 'proj-a', `current=${cur.trim()}`);
  const aAfter = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-a/a.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'proj-a file retained after refresh', aAfter === 'a-file-content', aAfter);

  // 清理：切回 main，删除两个测试工作区
  const swMain = await h.run('workspace switch main');
  const rmA = await h.run('workspace rm proj-a --yes');
  const rmB = await h.run('workspace rm proj-b --yes');
  const wsList = await h.run('workspace');
  check(
    checks,
    'workspace cleanup',
    swMain.handled === true && rmA.handled === true && rmB.handled === true && !wsList.output.includes('proj-a') && !wsList.output.includes('proj-b'),
    `switch=${swMain.output.trim().slice(0, 40)} | rmA=${rmA.output.trim().slice(0, 40)} | rmB=${rmB.output.trim().slice(0, 40)} | list=${wsList.output.trim().split('\n').slice(0, 3).join('; ')}`
  );
  return checks;
}

async function s8(h) {
  const checks = [];
  // 写 300 个文件
  const n = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    await fs.mkdir('/pstress', { recursive: true });
    for (let i = 0; i < 300; i++) await fs.writeFile('/pstress/f' + i + '.txt', 'content-' + i + '-padding-padding-padding');
    return 300;
  })()`);
  check(checks, '300 files written', n === 300, `n=${n}`);

  // snapshot now（强制落盘）
  const sn = await h.run('snapshot now', 60000);
  check(checks, 'snapshot now', sn.handled === true && sn.output.includes('Snapshot saved'), sn.output ? sn.output.trim().slice(0, 140) : '');

  // 刷新 → 全恢复 + 抽样校验
  await h.reloadAndWait(120000);
  const counts = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/pstress'); } catch { return { count: -1, samples: {} }; }
    const samples = {};
    for (const f of ['f0.txt','f150.txt','f299.txt']) {
      try { samples[f] = await fs.readFile('/pstress/' + f, 'utf8'); } catch (e) { samples[f] = 'MISSING'; }
    }
    return { count: entries.length, samples };
  })()`);
  check(checks, 'all 300 files restored after refresh', counts.count === 300, `count=${counts.count}`);
  const sampleOk =
    counts.samples['f0.txt'] === 'content-0-padding-padding-padding' &&
    counts.samples['f150.txt'] === 'content-150-padding-padding-padding' &&
    counts.samples['f299.txt'] === 'content-299-padding-padding-padding';
  check(checks, 'sampled file content consistent', sampleOk === true, JSON.stringify(counts.samples));

  // 清理
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/pstress', { recursive: true, force: true })`);
  await h.run('snapshot now', 60000);
  return checks;
}

export const scenarios = [
  { id: 'S5', name: 'multi-workspace isolation', run: s5 },
  { id: 'S8', name: 'persistence stress (300 files)', run: s8 },
];
