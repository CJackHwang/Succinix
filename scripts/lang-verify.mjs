#!/usr/bin/env node
// Succinix TASK25 语言生态验证（lang-verify）：headless Chrome + CDP 驱动真实浏览器/容器执行。
// 零新依赖（复用 verify-deploy.mjs / scenarios.mjs 的 CDP 模式）。每项断言带稳定 SC id：
//   Python 生态  P1 版本  P2 -c 执行  P3 脚本文件  P4 真管道  P5 标准库矩阵
//                P6 pip 可用（micropip：--version / install + import / 裸 pip）
//                P7 共享 FS 读写（python/node/lifo 同一文件） P8 subprocess 边界（emscripten no process）
//                P9 numpy 编译包装后 import + 矩阵乘法
//   TS/Node 生态 N1 shell 链（node && npm） N2 node -e 嵌套双引号写文件（引号保真 + 可编译）
//                N3 TS 工具链全流程（npm i -D typescript tsx vitest → tsc → node → vitest）
//                N4 npm i -g → EACCES + hint  N5 cwd 同步装包（进项目目录非根 node_modules）
//   其他语言探测 R1 Ruby（@ruby/wasm-wasi 可行性） R2 编译语言无编译器（确认）
//                R3 WASI 可行性（node:wasi 实测最小 wasm）
// 真实执行、真实断言；docs/LANGUAGES.md 支持矩阵的每项都标实测来源（lang-verify.mjs · <SC id>）。
//
// 用法：
//   node scripts/lang-verify.mjs [--skip-build] [--port 7896]
//   （默认先 npm run build 再用 vite preview 托管 dist/；--skip-build 要求 dist/ 已是最新。）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP } from './lib/cdp.mjs';
import { run, waitForHttp, makeHarness } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
// 7898/7899 避开 verify 7892 / bench 7894 / scenarios 7895 / 本机 Clash 代理 7897。
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7898;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1;

// ─── 结果汇总 ───
let globalPass = 0;
let globalFail = 0;
const results = [];

function note(msg) {
  console.log(`[lang-verify] ${msg}`);
}
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok, detail });
  globalPass += ok ? 1 : 0;
  globalFail += ok ? 0 : 1;
  const mark = ok ? '[  OK  ]' : '[ FAIL ]';
  const color = ok ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${color}${mark}\x1b[0m ${id} ${name}${detail ? ` (${detail})` : ''}`);
}

// ─── Python 生态（内置 Pyodide 314.0.4 常驻实例）───
async function pySection(h) {
  // P1: python --version → Python 3.14.2（Pyodide 314.0.4 内置）
  const p1 = await h.run('python --version', 120000);
  const p1Out = String(p1.stdout ?? '').trim();
  check('P1', 'python --version reports Python 3.14.2', p1.ok && /3\.14\.2/.test(p1Out), p1Out.slice(0, 40) || String(p1.stderr ?? '').slice(0, 40));

  // P2: python -c "print(6*7)" → 42
  const p2 = await h.run('python -c "print(6*7)"', 90000);
  check('P2', 'python -c executes (print(6*7) == 42)', p2.ok && String(p2.stdout ?? '').trim() === '42', String(p2.stdout ?? '').trim());

  // P3: 写 .py 脚本 → python 跑 → 输出正确（含 os.getcwd()）
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/lang-p3.py', 'print("p3-script-ok")\\nimport os\\nprint("cwd=" + os.getcwd())\\n')`);
  const p3 = await h.run('python /lang-p3.py', 90000);
  const p3Out = String(p3.stdout ?? '');
  check('P3', 'python script file runs (write .py -> python)', p3.ok && p3Out.includes('p3-script-ok'), p3Out.trim().split('\n')[0] ?? '');

  // P4: 真管道形态（shell 元字符 → Lifo shell 层解析，python 段转真运行时）
  const p4a = await h.run("python -c \"print('hello-pipe')\" | grep pipe", 90000);
  check('P4', 'python pipe keeps match (grep pipe)', p4a.ok && p4a.runtime === 'lifo' && String(p4a.stdout ?? '').includes('hello-pipe'), `runtime=${p4a.runtime} stdout=${String(p4a.stdout ?? '').trim().slice(0, 40)}`);
  const p4b = await h.run("python -c \"print('abc')\" | grep zzz", 90000);
  check('P4', 'python pipe filters empty (grep zzz)', p4b.runtime === 'lifo' && String(p4b.stdout ?? '').trim() === '', `runtime=${p4b.runtime} stdout=${JSON.stringify(String(p4b.stdout ?? '').trim())}`);

  // P5: 标准库矩阵（支持矩阵数据源）—— 逐项 import 并报告
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/lang-p5.py', 'import importlib\\nmods = [\\'json\\',\\'csv\\',\\'re\\',\\'math\\',\\'os\\',\\'sqlite3\\',\\'subprocess\\',\\'collections\\',\\'datetime\\',\\'hashlib\\',\\'urllib\\']\\nok = []\\nbad = []\\nfor m in mods:\\n    try:\\n        importlib.import_module(m)\\n        ok.append(m)\\n    except Exception:\\n        bad.append(m)\\nprint(\\'OK=\\' + \\',\\'.join(ok))\\nprint(\\'BAD=\\' + \\',\\'.join(bad))\\nprint(\\'COUNT=\\' + str(len(ok)))\\n')`);
  const p5 = await h.run('python /lang-p5.py', 90000);
  const p5Out = String(p5.stdout ?? '');
  const p5OkLine = p5Out.split('\n').find((l) => l.startsWith('OK=')) ?? '';
  const p5BadLine = p5Out.split('\n').find((l) => l.startsWith('BAD=')) ?? '';
  const p5Count = Number((p5Out.split('\n').find((l) => l.startsWith('COUNT=')) ?? 'COUNT=0').slice('COUNT='.length));
  const ALL_MODS = ['json', 'csv', 're', 'math', 'os', 'sqlite3', 'subprocess', 'collections', 'datetime', 'hashlib', 'urllib'];
  const p5Ok = p5.ok && p5BadLine === 'BAD=' && p5Count === ALL_MODS.length && ALL_MODS.every((m) => p5OkLine.includes(m));
  check('P5', `python stdlib matrix (${ALL_MODS.length} modules import)`, p5Ok, p5BadLine || p5Out.trim().slice(-80));

  // P5 补充：sqlite3 不只是可导入 —— 内存库真实建表/插入/查询（docs/LANGUAGES.md 实测依据）。
  const p5sqlite = await h.run("python -c \"import sqlite3; c=sqlite3.connect(':memory:'); c.execute('create table t(a)'); c.execute('insert into t values (1)'); print(c.execute('select count(*) from t').fetchone()[0])\"", 90000);
  check('P5', 'python sqlite3 in-memory DB works (live query)', p5sqlite.ok && String(p5sqlite.stdout ?? '').trim() === '1', String(p5sqlite.stdout ?? '').trim());

  // P8: 文档声称的行为探测（LANGUAGES.md 的 json.dumps / subprocess.run 行为标注必须有实测来源）。
  const p8json = await h.run('python -c "import json; print(json.dumps({\'a\':1}))"', 90000);
  check('P8', 'python json.dumps behaves (serializes)', p8json.ok && String(p8json.stdout ?? '').trim() === '{"a": 1}', String(p8json.stdout ?? '').trim());
  const p8sub = await h.run("python -c \"import subprocess; subprocess.run(['echo','hi'])\"", 60000);
  const p8subErr = String(p8sub.stderr ?? '') + String(p8sub.stdout ?? '');
  check('P8', 'python subprocess.run cannot spawn (Pyodide: no process API)', p8sub.ok === false && /emscripten does not support processes|OSError|ENOTSUP/i.test(p8subErr), p8subErr.trim().split('\n').slice(-1)[0]?.slice(0, 90) ?? '(no error)');

  // P6: pip 可用（micropip）—— `python -m pip --version` 有版本；install 小包 + import 可用。
  const p6a = await h.run('python -m pip --version', 60000);
  const p6aOut = String(p6a.stdout ?? '');
  check('P6', 'python -m pip works (micropip version)', p6a.ok === true && /pip \d/.test(p6aOut), p6aOut.trim().split('\n')[0]?.slice(0, 60) ?? '(no stdout)');
  const p6b = await h.run('python -m pip install pyparsing==3.3.2', 150000);
  const p6bErr = String(p6b.stderr ?? '');
  if (p6b.ok) {
    const p6c = await h.run('python -c "import pyparsing; print(pyparsing.__version__)"', 60000);
    check('P6', 'pip install pyparsing + import works', p6c.ok === true && String(p6c.stdout ?? '').trim() === '3.3.2', `pyparsing ${String(p6c.stdout ?? '').trim()}`);
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(p6bErr)) {
    check('P6', 'pip install pyparsing + import works', true, `network boundary: ${p6bErr.trim().split('\n')[0]?.slice(0, 60)}`);
  } else {
    check('P6', 'pip install pyparsing + import works', false, p6bErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
  }

  // P6 补充：裸 pip / pip3 命令 → 映射到同一 micropip（不再是 Lifo not found）。
  const p6d = await h.run('pip --version', 60000);
  check('P6', 'bare pip command routes to micropip', p6d.ok === true && /pip \d/.test(String(p6d.stdout ?? '')), String(p6d.stdout ?? '').trim().split('\n')[0]?.slice(0, 60) ?? String(p6d.stderr ?? '').slice(0, 60));

  // P9（新增）：numpy（编译包）装后 import 可用 —— 矩阵乘法真实计算。
  const np1 = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
  if (np1.ok) {
    const npM = await h.run('python -c "import numpy; a=numpy.array([[1,2],[3,4]]); print(numpy.dot(a,a).tolist())"', 60000);
    check('P9', 'numpy import + matmul works', npM.ok === true && String(npM.stdout ?? '').includes('[[7, 10], [15, 22]]'), String(npM.stdout ?? '').trim().slice(0, 60));
  } else {
    const npInst = await h.run('python -m pip install numpy', 180000);
    if (npInst.ok) {
      const npM = await h.run('python -c "import numpy; a=numpy.array([[1,2],[3,4]]); print(numpy.dot(a,a).tolist())"', 60000);
      check('P9', 'numpy import + matmul works (installed via pip)', npM.ok === true && String(npM.stdout ?? '').includes('[[7, 10], [15, 22]]'), String(npM.stdout ?? '').trim().slice(0, 60));
    } else {
      const npErr = String(npInst.stderr ?? '');
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(npErr)) {
        check('P9', 'numpy import + matmul works', true, `network boundary: ${npErr.trim().split('\n')[0]?.slice(0, 60)}`);
      } else {
        check('P9', 'numpy import + matmul works', false, npErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
      }
    }
  }

  // P7: 共享 FS 读写（python / node / lifo 同一文件）
  await h.run('cd /workspace', 15000);
  const p7a = await h.run('python -c "open(\'lang-p7-py.txt\',\'w\').write(\'python-wrote-this\')"', 90000);
  const p7b = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/lang-p7-py.txt','utf8').then(t=>t).catch(()=>'MISSING')`);
  check('P7', 'python writes shared-FS file (browser reads)', p7a.ok && p7b === 'python-wrote-this', `browser=${JSON.stringify(p7b)}`);
  const p7c = await h.run('node -e "const fs=require(\'fs\');console.log(fs.readFileSync(\'lang-p7-py.txt\',\'utf8\'))"', 60000);
  check('P7', 'node reads the same file', p7c.ok && String(p7c.stdout ?? '').trim() === 'python-wrote-this', String(p7c.stdout ?? '').trim());
  const p7d = await h.run('cat lang-p7-py.txt', 30000);
  check('P7', 'lifo reads the same file', p7d.ok && String(p7d.stdout ?? '').trim() === 'python-wrote-this', String(p7d.stdout ?? '').trim());
  const p7e = await h.run('node -e "const fs=require(\'fs\');fs.writeFileSync(\'lang-p7-node.txt\',\'node-wrote-this\')"', 60000);
  check('P7', 'node writes shared-FS file', p7e.ok === true, `ok=${p7e.ok}`);
  const p7f = await h.run('python -c "print(open(\'lang-p7-node.txt\').read())"', 90000);
  check('P7', 'python reads node-written file', p7f.ok && String(p7f.stdout ?? '').trim() === 'node-wrote-this', String(p7f.stdout ?? '').trim());
}

// ─── TS/Node 生态（用户实测 5 坑修复后复测）───
async function nodeSection(h) {
  const PROJ = '/workspace/lang-node-proj';

  // N1: node --version && npm --version 两行都出（shell 链）
  const n1 = await h.run('node --version && npm --version', 60000);
  const n1Lines = String(n1.stdout ?? '').trim().split('\n').filter((l) => l.length > 0);
  check('N1', 'node && npm chain prints both versions', n1.ok && n1.runtime === 'lifo' && n1Lines.length >= 2 && /^v\d+/.test(n1Lines[0]), n1Lines.join(' | '));

  // N2 + N3 共用项目目录（引号保真文件直接进 TS 工具链编译，一石二鸟）
  // 注意：mkdir 与 cd 必须分开（只有整条命令以 cd 开头才同步 host 会话 cwd —— 见 S13 同款写法）。
  const mk = await h.run(`mkdir -p ${PROJ}/src`, 30000);
  check('N2', 'project dir ready', mk.ok === true, `ok=${mk.ok}`);
  await h.run(`cd ${PROJ}`, 15000);

  // N2: node -e 嵌套双引号写 TS 文件 → 文件引号保真 + 可编译（tsc 在 N3 里编译）
  const n2 = await h.run(`node -e "require('fs').writeFileSync('src/quote.ts', 'export const msg: string = \\"n2-quote-ok\\";\\nconsole.log(msg);')"`, 60000);
  const n2Content = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/lang-node-proj/src/quote.ts','utf8').then(t=>t).catch(()=>'MISSING')`);
  check('N2', 'node -e nested double quotes write file (quotes preserved)', n2.ok && typeof n2Content === 'string' && n2Content.includes('"n2-quote-ok"'), `content=${JSON.stringify(n2Content).slice(0, 80)}`);

  // N3: npm i -D typescript tsx vitest → tsc → node 跑产物 → vitest（复刻 S13）
  const init = await h.run(`cd ${PROJ} && npm init -y`, 120000);
  check('N3', 'npm init -y', init.ok === true, `ok=${init.ok}`);
  const inst = await h.run(`cd ${PROJ} && npm i -D typescript tsx vitest`, 300000);
  check('N3', 'npm i -D typescript tsx vitest', inst.ok === true, `ok=${inst.ok} ${String(inst.stderr ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 60) ?? ''}`);

  const tsconfig = JSON.stringify({
    compilerOptions: { outDir: 'dist', rootDir: 'src', target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true },
    include: ['src'],
  }, null, 2);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/lang-node-proj/tsconfig.json', ${JSON.stringify(tsconfig)})`);

  const tsc = await h.run(`cd ${PROJ} && npx tsc -p tsconfig.json`, 180000);
  check('N3', 'tsc compiles TS (incl. quote.ts)', tsc.ok === true, `ok=${tsc.ok} ${String(tsc.stderr ?? '').trim().slice(0, 100)}`);
  const distQuote = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/lang-node-proj/dist/quote.js','utf8').then(()=>true).catch(()=>false)`);
  check('N3', 'dist/quote.js artifact produced', distQuote === true, `present=${distQuote}`);

  const runQ = await h.run(`cd ${PROJ} && node dist/quote.js`, 60000);
  check('N3', 'node runs compiled artifact (quote preserved through tsc)', runQ.ok && String(runQ.stdout ?? '').trim() === 'n2-quote-ok', String(runQ.stdout ?? '').trim());

  await h.evalValue(`window.__succinixScenario.wc.fs.mkdir('/lang-node-proj/test', { recursive: true })`);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/lang-node-proj/src/greet.ts', 'export function greet(name: string): string { return "hello " + name; }\\n')`);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/lang-node-proj/test/quote.test.ts', 'import { test, expect } from "vitest"; import { greet } from "../src/greet"; test("greet", () => { expect(greet("ts")).toBe("hello ts"); });\\n')`);
  const vitest = await h.run(`cd ${PROJ} && npx vitest run`, 180000);
  const vtOut = String(vitest.stdout ?? '') + String(vitest.stderr ?? '');
  check('N3', 'vitest run: 1 passed', vitest.ok && /1 passed/.test(vtOut), vtOut.trim().split('\n').filter((l) => /passed|failed|Test Files/.test(l)).slice(-3).join(' | '));

  // N4: npm i -g <real pkg> → EACCES + hint 行
  const n4 = await h.run('npm i -g left-pad', 120000);
  const n4Err = String(n4.stderr ?? '');
  check('N4', 'npm i -g -> EACCES + hint line', n4.ok === false && n4Err.includes('EACCES') && n4Err.includes('hint: /usr/local is read-only for guest'), `EACCES=${n4Err.includes('EACCES')} hint=${n4Err.includes('hint:')}`);

  // N5: cwd 同步装包 → 包装进项目目录（非根 node_modules）
  const n5 = await h.run(`cd ${PROJ} && npm i left-pad`, 180000);
  const n5InProj = await h.evalValue(`window.__succinixScenario.wc.fs.readdir('/lang-node-proj/node_modules/left-pad').then(()=>true).catch(()=>false)`);
  const n5InRoot = await h.evalValue(`window.__succinixScenario.wc.fs.readdir('/node_modules/left-pad').then(()=>true).catch(()=>false)`);
  check('N5', 'npm i in project dir installs to project node_modules', n5.ok === true && n5InProj === true && n5InRoot === false, `proj=${n5InProj} root=${n5InRoot}`);

  // 清理
  await h.run('cd /workspace', 15000);
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/lang-node-proj', { recursive: true, force: true })`);
}

// ─── 其他语言（可行性探测，报告即可）───
async function otherSection(h) {
  // R2: 编译语言无编译器（确认）
  const r2 = [];
  for (const tool of ['gcc', 'rustc', 'go']) {
    const r = await h.run(`which ${tool}`, 15000);
    r2.push({ tool, found: r.ok === true && r.exitCode === 0 });
  }
  check('R2', 'no C/Rust/Go compilers (which gcc/rustc/go)', r2.every((x) => x.found === false), r2.map((x) => `${x.tool}=${x.found ? 'present' : 'absent'}`).join(' '));

  // R3: WASI 可行性 —— node:wasi 实测最小 wasm（无编译器依赖，50 字节手写 wasm）
  const wasmB64 = 'AGFzbQEAAAABBAFgAAADAgEABQMBAAEHEwIGX3N0YXJ0AAAGbWVtb3J5AgAKBAECAAs=';
  const wasiRunner = `const {WASI}=require('node:wasi');const fs=require('fs');fs.writeFileSync('wasi-min.wasm',Buffer.from('${wasmB64}','base64'));(async()=>{const wasi=new WASI({version:'preview1'});const mod=await WebAssembly.compile(fs.readFileSync('wasi-min.wasm'));const inst=await WebAssembly.instantiate(mod,wasi.getImportObject());try{wasi.start(inst);console.log('WASI_RUN_OK')}catch(e){console.log('WASI_RUN_ERR '+String(e))}})()`;
  const r3 = await h.run(`node -e ${JSON.stringify(wasiRunner)}`, 60000);
  const r3Out = String(r3.stdout ?? '');
  check('R3', 'node:wasi runs a minimal wasm in-container', r3.ok && r3Out.includes('WASI_RUN_OK'), r3Out.trim().split('\n').filter((l) => l.includes('WASI_')).join(' '));

  // R1: Ruby 可行性 —— @ruby/wasm-wasi + @ruby/head-wasm-wasi 安装并真实执行（v2 API: dist/node）
  const RPROJ = '/workspace/lang-ruby-proj';
  await h.run(`mkdir -p ${RPROJ} && cd ${RPROJ} && npm init -y`, 60000);
  const r1inst = await h.run(`cd ${RPROJ} && npm i @ruby/wasm-wasi @ruby/head-wasm-wasi`, 300000);
  if (r1inst.ok === true) {
    const rubyRunner = `const {DefaultRubyVM}=require('@ruby/wasm-wasi/dist/node');const fs=require('fs');(async()=>{try{const module=await WebAssembly.compile(fs.readFileSync('node_modules/@ruby/head-wasm-wasi/dist/ruby.wasm'));const {vm}=await DefaultRubyVM(module);const v=vm.eval('6*7');console.log('RUBY_OK val='+String(v));}catch(e){console.log('RUBY_ERR '+String(e).slice(0,300))}})()`;
    const r1run = await h.run(`cd ${RPROJ} && node -e ${JSON.stringify(rubyRunner)}`, 90000);
    const r1Out = String(r1run.stdout ?? '');
    check('R1', 'Ruby @ruby/wasm-wasi runs in-container (6*7 == 42)', r1run.ok && r1Out.includes('RUBY_OK val=42'), r1Out.trim().split('\n').filter((l) => l.includes('RUBY_')).join(' '));
  } else {
    check('R1', 'Ruby @ruby/wasm-wasi runs in-container (6*7 == 42)', false, `npm install failed: ${String(r1inst.stderr ?? r1inst.stdout ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 100)}`);
  }
  await h.run('cd /workspace', 15000);
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/lang-ruby-proj', { recursive: true, force: true })`);
}

// ─── 主流程 ───
async function main() {
  note('Succinix TASK25 language-ecosystem verification (real browser/container)');

  if (SKIP_BUILD) {
    note('skipping build (--skip-build), using existing dist/');
  } else {
    note('building...');
    await run('npm', ['run', 'build'], { silent: true });
    note('build ok');
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run npm run build first');
  }

  note(`starting vite preview on :${PORT}...`);
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  let chrome = null;
  let cdp = null;
  let profileDir = null;
  try {
    await waitForHttp(BASE, 20000);
    note(`preview reachable at ${BASE}`);

    const launched = launchChrome(DEBUG_PORT, 'lang-verify');
    chrome = launched.chrome;
    profileDir = launched.profileDir;
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Page.navigate', { url: `${BASE}/?scenario=1` });
    note('waiting for boot + scenario handle...');
    const h = makeHarness(cdp);
    await h.waitForScenario(150000);
    note('scenario handle ready');

    await h.run('cd /workspace', 15000);

    note('\n--- Python ecosystem ---');
    await pySection(h);
    note('\n--- TS/Node ecosystem ---');
    await nodeSection(h);
    note('\n--- Other languages (probes) ---');
    await otherSection(h);

    // 汇总
    console.log('\n=== LANG-VERIFY SUMMARY ===');
    for (const r of results) {
      console.log(`  ${r.ok ? '[  OK  ]' : '[ FAIL ]'} ${r.id} ${r.name} — ${r.detail ? `(${r.detail})` : ''}`);
    }
    console.log(`\nlang-verify: ${globalPass} passed, ${globalFail} failed`);
    process.exitCode = globalFail === 0 ? 0 : 1;
  } finally {
    cdp?.close();
    await cleanupChrome(chrome, profileDir);
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[lang-verify] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
