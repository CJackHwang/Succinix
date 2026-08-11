// 场景套件：数据库与服务生命周期（O11 拆分自 scenarios.mjs）。
import { check } from '../lib/harness.mjs';

const TINBASE_SERVICE_ROLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
async function s3(h) {
  const checks = [];
  // 1. db start（首次含 npm install tinbase，重活）
  const ds = await h.run('db start', 200000);
  check(checks, 'db start (wasm)', ds.handled === true && ds.output.includes('Database ready'), ds.output ? ds.output.slice(-120) : '');
  const url = await h.waitFor('window.__succinixScenario.ports.get(3001) || null', 15000);
  check(checks, 'port 3001 in ready list', typeof url === 'string', url);

  // 2. node 脚本：建表 + 插数据 + 读回（真实 SQL / REST）
  const script = `
const BASE='http://127.0.0.1:3001';
const KEY='${TINBASE_SERVICE_ROLE}';
const H={'apikey':KEY,'content-type':'application/json'};
(async()=>{
  try {
    const c=await fetch(BASE+'/admin/v1/sql',{method:'POST',headers:H,body:JSON.stringify({query:'CREATE TABLE IF NOT EXISTS s3_todo (id serial primary key, note text)'})});
    const ins=await fetch(BASE+'/rest/v1/s3_todo',{method:'POST',headers:H,body:JSON.stringify({note:'s3-persist-marker'})});
    const rd=await fetch(BASE+'/rest/v1/s3_todo?select=note',{headers:H});
    console.log('CREATE='+c.status+' INSERT='+ins.status+' READ='+rd.status+' '+await rd.text());
  } catch(e) { console.log('ERR '+String(e)); }
})();
`;
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s3-db.mjs', ${JSON.stringify(script)})`);
  const r = await h.run('node s3-db.mjs', 60000);
  const so = String(r.stdout || '');
  check(checks, 'SQL create + REST insert + read real', r.ok === true && so.includes('CREATE=200') && so.includes('INSERT=201') && so.includes('s3-persist-marker'), so.trim().slice(0, 160));

  // 3. db stop
  const st = await h.run('db stop');
  check(checks, 'db stop', st.handled === true && st.output.includes('stopped'), st.output ? st.output.trim().slice(0, 120) : '');

  // 4. db start 再起（同会话 tinbase 已装，跳过 install）
  const ds2 = await h.run('db start', 120000);
  check(checks, 'db start (restart)', ds2.handled === true && ds2.output.includes('Database ready'), ds2.output ? ds2.output.slice(-120) : '');

  // 5. 数据跨重启仍在（持久化）
  const readScript = `
const BASE='http://127.0.0.1:3001';
const KEY='${TINBASE_SERVICE_ROLE}';
const H={'apikey':KEY,'content-type':'application/json'};
(async()=>{
  try {
    const rd=await fetch(BASE+'/rest/v1/s3_todo?select=note',{headers:H});
    console.log('READ_STATUS='+rd.status+' '+await rd.text());
  } catch(e) { console.log('ERR '+String(e)); }
})();
`;
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s3-read.mjs', ${JSON.stringify(readScript)})`);
  const r2 = await h.run('node s3-read.mjs', 60000);
  const so2 = String(r2.stdout || '');
  check(checks, 'data persists across db restart', r2.ok === true && so2.includes('READ_STATUS=200') && so2.includes('s3-persist-marker'), so2.trim().slice(0, 160));

  // 清理
  await h.run('db stop');
  await h.evalValue(`(async () => { const fs = window.__succinixScenario.wc.fs; for (const f of ['/s3-db.mjs','/s3-read.mjs']) { try { await fs.rm(f); } catch {} } return true; })()`);
  return checks;
}

async function s4(h) {
  const checks = [];
  // 1. enable tinbase
  const en = await h.run('service enable tinbase');
  check(checks, 'service enable tinbase', en.handled === true && en.output.includes('enabled'), en.output ? en.output.trim().slice(0, 120) : '');

  // 2. 刷新 → boot 自动拉起
  await h.reloadAndWait(180000);
  const st = await h.run('service status tinbase');
  // 诊断：进程表（含 outputTail）+ boot 日志尾部（记录 autostart 实际发生了什么）
  const diagPs = await h.run('ps');
  const diagLog = await h.run('log -n 20');
  const diagProcs = (diagPs.processes ?? [])
    .map((p) => `${p.pid}:${p.status}${p.outputTail ? '[' + String(p.outputTail).split('\n').filter(Boolean).slice(-2).join('|') + ']' : ''}`)
    .join(' || ') || 'none';
  const diagDetail = `state=${st.output.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').find((l) => l.includes('state')) || '?'}; procs=${diagProcs}; log=${String(diagLog.output || '').split('\n').filter((l) => /service|tinbase|FAIL|BOOT/i.test(l)).slice(-4).join(' | ')}`;
  check(checks, 'boot autostart pulls tinbase up', st.handled === true && st.output.includes('running'), diagDetail.slice(0, 400));

  // 3. disable → 刷新不再拉起
  const dis = await h.run('service disable tinbase');
  check(checks, 'service disable tinbase', dis.handled === true && dis.output.includes('disabled'), dis.output ? dis.output.trim().slice(0, 120) : '');
  await h.reloadAndWait(120000);
  const st2 = await h.run('service status tinbase');
  check(checks, 'disabled service not autostarted', st2.handled === true && st2.output.includes('stopped'), st2.output ? st2.output.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 160) : '');
  return checks;
}

export const scenarios = [
  { id: 'S3', name: 'database full lifecycle', run: s3 },
  { id: 'S4', name: 'service autostart', run: s4 },
];
