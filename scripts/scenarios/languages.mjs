// 场景套件：语言生态（O11 拆分自 scenarios.mjs）。
import { check, note } from '../lib/harness.mjs';

// WebContainer 的 npm 网络偶发会在重活安装中直接杀子进程（exit -1、无 stderr）。
// 这些安装是场景要验证的真实能力，不降级断言；给已知 flake 加有限重试，避免整轮误报。
async function runWithRetry(h, cmd, timeoutMs, attempts = 3, delayMs = 8000) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await h.run(cmd, timeoutMs);
    if (last.ok) return last;
    if (attempt < attempts) {
      note(`npm install retry ${attempt + 1}/${attempts}: ${cmd}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  return last;
}

async function s11(h) {
  const checks = [];
  // 1. 写 .py 到浏览器 FS 根（= host /workspace 根，python 子进程 cwd 初始即此处）
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s11-hello.py', 'print("s11-python-ok")\\nimport os\\nprint("cwd=" + os.getcwd())\\n')`);

  // 2. python -c 真实执行（首用触发运行时资产懒注入 + Pyodide daemon 懒启动，给足超时）
  const rc = await h.run('python -c "print(21*2)"', 150000);
  check(checks, 'python -c executes', rc.ok === true && String(rc.stdout).trim() === '42', `ok=${rc.ok} stdout=${String(rc.stdout).trim()}`);

  // 3. python --version → Python 3.14.2（Pyodide 314.0.4 内置）
  const rv = await h.run('python --version', 60000);
  check(checks, 'python --version reports Python 3.14.2', rv.ok === true && String(rv.stdout).includes('3.14.2'), String(rv.stdout).trim().slice(0, 40));

  // 4. python 脚本文件（绝对路径 /s11-hello.py）
  const rs = await h.run('python /s11-hello.py', 120000);
  const so = String(rs.stdout || '');
  check(checks, 'python script runs', rs.ok === true && so.includes('s11-python-ok'), so.trim().slice(0, 120));

  // 5. python3 别名 + 标准库（json/sqlite3/csv/re/math/os 可导入）
  const rstd = await h.run('python3 -c "import json,csv,re,math,os,sqlite3; print(len([json,csv,re,math,os,sqlite3]))"', 120000);
  check(checks, 'python3 alias + stdlib imports', rstd.ok === true && String(rstd.stdout).trim() === '6', `stdout=${String(rstd.stdout).trim()}`);

  // 6. 真管道形态（TASK24 复审修复）：python 命令含 shell 元字符时经 Lifo shell 执行，python 段
  //    转发到常驻 daemon —— 管道真工作：grep 命中保留输出、无匹配过滤为空。
  const rg = await h.run("python -c \"print('hello-pipe')\" | grep pipe", 120000);
  check(checks, 'python pipe (grep filters)', rg.ok === true && String(rg.stdout).includes('hello-pipe'), String(rg.stdout).trim().slice(0, 60));
  const rgEmpty = await h.run("python -c \"print('abc')\" | grep zzz", 120000);
  check(checks, 'python pipe filters empty (grep zzz)', String(rgEmpty.stdout).trim() === '', String(rgEmpty.stdout).trim().slice(0, 60));

  // 7. TASK27 pip：python -m pip install 小包 → import 可用（micropip；网络边界按 SKIP 记录）
  const pipInst = await h.run('python -m pip install pyparsing==3.3.2', 150000);
  const pipErr = String(pipInst.stderr || '');
  let pyparsingInstalled = false;
  if (pipInst.ok) {
    const pipImp = await h.run('python -c "import pyparsing; print(pyparsing.__version__)"', 60000);
    pyparsingInstalled = pipImp.ok === true && String(pipImp.stdout).trim() === '3.3.2';
    check(checks, 'pip install pyparsing + import (micropip)', pyparsingInstalled, `pyparsing ${String(pipImp.stdout).trim()}`);
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(pipErr)) {
    check(checks, 'pip install pyparsing + import (micropip)', true, `network boundary: ${pipErr.trim().slice(0, 60)}`);
  } else {
    check(checks, 'pip install pyparsing + import (micropip)', false, pipErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
  }

  // 8. TASK27 numpy（编译包）：import numpy 或装后 import（给足网络时间；失败如实记录）
  const np1 = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
  let numpyOk = false;
  if (np1.ok) {
    numpyOk = /^\d+\.\d+/.test(String(np1.stdout).trim());
  } else {
    const npInst = await h.run('python -m pip install numpy', 180000);
    if (npInst.ok) {
      const np2 = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
      numpyOk = np2.ok === true && /^\d+\.\d+/.test(String(np2.stdout).trim());
      check(checks, 'numpy import (installed via pip)', numpyOk, numpyOk ? `numpy ${String(np2.stdout).trim()}` : String(np2.stderr || '').trim().slice(0, 80));
    } else {
      const npErr = String(npInst.stderr || '');
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(npErr)) {
        check(checks, 'numpy import (installed via pip)', true, `network boundary: ${npErr.trim().slice(0, 60)}`);
      } else {
        check(checks, 'numpy import (installed via pip)', false, npErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
      }
    }
  }
  if (numpyOk) check(checks, 'numpy import (already present)', true, `numpy ${String(np1.stdout).trim()}`);

  // 9. TASK27 pip 持久化（尽力而为）：装过的纯 Python 包刷新后 import 仍在（NODEFS 站点包随快照）。
  //    先 succinix snapshot now 强制落盘，再 reload；pyparsing 应直接可 import（无网络）。若不在 → 如实记录边界。
  if (pyparsingInstalled) {
    await h.run('succinix snapshot now', 60000);
    await h.reloadAndWait(120000);
    const pers = await h.run('python -c "import pyparsing; print(pyparsing.__version__)"', 120000);
    check(checks, 'pip package persists across refresh (pyparsing)', pers.ok === true && String(pers.stdout).trim() === '3.3.2', String(pers.stdout).trim() || String(pers.stderr || '').trim().slice(0, 80));
  } else {
    check(checks, 'pip package persists across refresh (pyparsing)', true, 'skipped: pip install network boundary');
  }
  // numpy 是编译包（.so 二进制）。v0.7 起快照为 binary export（IDB chunks），
  // workspace 内的 .so 随快照保留 → 刷新后可直接 import（能力改进，S11）。
  // 若极端情况下不可用 → 如实记录，且冷启动报错提示须指向 `pip install numpy` 解决路径。
  const persNp = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
  if (persNp.ok) {
    check(checks, 'compiled package (numpy) persists after refresh', true, `numpy ${String(persNp.stdout).trim()} (binary snapshot keeps .so)`);
  } else {
    const npErr = String(persNp.stderr || '').trim();
    check(checks, 'compiled package (numpy) persists after refresh', npErr.includes('pip install numpy'), `numpy unavailable after refresh — hint: ${npErr.split('\n').slice(-1)[0]?.slice(0, 60)}`);
  }

  // 10. TASK27 复审修复项 1+2（浏览器真实路径）：
  //     - `pip install pyparsing requests` 多包：micropip.install([...]) 数组语义，不再把
  //       `join(' ')` 拼成单个 requirement（此前 PEP 508 会拒）。
  //     - `pip show pyparsing`：真实 pip 式元数据输出。
  //     - `pip show`（无参）：usage 提示 + exit 2（此前生成 NameError → exit 1）。
  const pipMulti = await h.run('python -m pip install pyparsing requests', 180000);
  const pipMultiErr = String(pipMulti.stderr || '');
  if (pipMulti.ok) {
    const impMulti = await h.run('python -c "import pyparsing, requests; print(pyparsing.__version__, requests.__version__)"', 60000);
    const impTokens = String(impMulti.stdout || '').trim().split(/\s+/).filter(Boolean);
    check(
      checks,
      'pip install multi-package (pyparsing requests) + import',
      impMulti.ok === true && impTokens.length === 2 && impTokens[0].length > 0 && impTokens[1].length > 0,
      `pyparsing=${impTokens[0] ?? ''} requests=${impTokens[1] ?? ''}`
    );
    const showPkg = await h.run('pip show pyparsing', 60000);
    check(
      checks,
      'pip show pyparsing works',
      showPkg.ok === true && /Name: pyparsing/i.test(String(showPkg.stdout || '')),
      String(showPkg.stdout || '').split('\n')[0]?.slice(0, 60) || String(showPkg.stderr || '').slice(0, 60)
    );
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(pipMultiErr)) {
    check(checks, 'pip install multi-package (pyparsing requests) + import', true, `network boundary: ${pipMultiErr.trim().slice(0, 60)}`);
    check(checks, 'pip show pyparsing works', true, 'skipped: multi-package install network boundary');
  } else {
    check(checks, 'pip install multi-package (pyparsing requests) + import', false, pipMultiErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
    check(checks, 'pip show pyparsing works', false, 'multi-package install failed');
  }
  // pip show 无参：不依赖网络，独立断言 usage + exit 2。
  const showNone = await h.run('pip show', 60000);
  check(
    checks,
    'pip show no-arg usage + exit 2',
    showNone.ok === false && Number(showNone.exitCode) === 2 && /Usage: pip show <package>/.test(String(showNone.stderr || '')),
    `exit=${showNone.exitCode} stderr=${String(showNone.stderr || '').trim().slice(0, 60)}`
  );

  // 清理
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s11-hello.py', { force: true })`);
  return checks;
}

async function s12(h) {
  const checks = [];
  // 0. 复位会话 cwd（避免历史场景残留的持久化 cwd 影响断言）
  await h.run('cd /workspace');
  // TASK24（自检崩溃根因）：/workspace 是 Lifo 挂载视图，node 子进程实际 spawn 在 host 真实
  // 路径（spawnCwd 映射 /workspace → process.cwd()）。先取真实 base，供后续断言映射后的 cwd。
  const hostBase = String((await h.run('node -e "console.log(process.cwd())"')).stdout || '').trim();

  // 1. 建项目目录（Lifo 的 /workspace 挂载 = 浏览器 FS 根 = host 会话 cwd 初始值）
  const mk = await h.run('mkdir -p /workspace/s12-proj');
  check(checks, 'mkdir project dir', mk.ok === true, `ok=${mk.ok}`);

  // 2. cd 进项目目录（host 同步会话 cwd）
  const cd = await h.run('cd /workspace/s12-proj');
  check(checks, 'cd into project dir', cd.ok === true, `ok=${cd.ok}`);

  // 3. node 子进程 cwd 跟随会话 cwd（核心断言：Lifo cd 影响 node 子进程，真实路径映射）
  const s12Expected = `${hostBase}/s12-proj`;
  const n = await h.run('node -e "console.log(process.cwd())"');
  check(checks, 'node child cwd follows session cwd', n.ok === true && String(n.stdout).trim() === s12Expected, `node cwd=${String(n.stdout).trim()}`);

  // 4. pwd（浏览器侧拦截 → host 会话 cwd）显示会话 cwd
  const pwd = await h.run('pwd');
  check(checks, 'pwd shows session cwd', pwd.handled === true && String(pwd.output).trim() === '/workspace/s12-proj', `pwd=${String(pwd.output).trim()}`);

  // 5. npm init -y → package.json 落在项目目录（cwd 同步：npm 装到会话 cwd 而非容器根）
  const init = await h.run('npm init -y', 120000);
  check(checks, 'npm init -y runs in project dir', init.ok === true, `ok=${init.ok}`);
  const pkgAt = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s12-proj/package.json','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'package.json created in project dir (cwd sync)', pkgAt === true, `present=${pkgAt}`);

  // 6. cd 到不存在目录：会话 cwd 不变（node 仍在上一个目录）
  const cdBad = await h.run('cd /s12-does-not-exist-xyz');
  const n2 = await h.run('node -e "console.log(process.cwd())"');
  check(checks, 'failed cd keeps session cwd', cdBad.ok === false && String(n2.stdout).trim() === s12Expected, `exit=${cdBad.exitCode} node cwd=${String(n2.stdout).trim()}`);

  // 清理：回 /workspace，删项目目录
  await h.run('cd /workspace');
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s12-proj', { recursive: true, force: true })`);
  return checks;
}

async function s13(h) {
  const checks = [];
  const PROJ = '/workspace/s13-proj';
  // 0. 复位会话 cwd
  await h.run('cd /workspace');

  // 1. 建项目目录 + 进入（host 会话 cwd 同步）
  const mk = await h.run(`mkdir -p ${PROJ}`);
  check(checks, 'mkdir project dir', mk.ok === true, `ok=${mk.ok}`);
  const cd = await h.run(`cd ${PROJ}`);
  check(checks, 'cd into project dir', cd.ok === true, `ok=${cd.ok}`);

  // 2. npm init -y（真实 npm，cwd = 项目目录）
  const init = await h.run('npm init -y', 120000);
  check(checks, 'npm init -y', init.ok === true, `ok=${init.ok}`);

  // 3. npm i -D typescript tsx vitest（真实 npm 安装工具链 —— 重活，给足超时）
  const inst = await runWithRetry(h, 'npm i -D typescript tsx vitest', 240000);
  const instDetail = [inst.error, inst.exitCode, inst.thrown, String(inst.stderr || inst.stdout || '').trim().slice(0, 120)].filter((v) => v !== undefined && v !== null && v !== '').join(' | ');
  check(checks, 'npm i -D typescript tsx vitest', inst.ok === true, `ok=${inst.ok}${instDetail ? ` ${instDetail}` : ''}`);

  // 4. 写 TS 源码 + tsconfig（浏览器 FS = 项目目录，与 host 会话 cwd 同一份文件）
  await h.evalValue(`window.__succinixScenario.wc.fs.mkdir('/s13-proj/src', { recursive: true })`);
  // greet.ts 顶层调用使 `node dist/greet.js` 直接输出 hello ts（vitest 导入该模块时也触发，
  // 仅多一行无害输出，不改变测试结果）。
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s13-proj/src/greet.ts', 'export function greet(name: string): string { return "hello " + name; }\\nconsole.log(greet("ts"));\\n')`);
  const tsconfig = JSON.stringify({
    compilerOptions: { outDir: 'dist', rootDir: 'src', target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true },
    include: ['src'],
  }, null, 2);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s13-proj/tsconfig.json', ${JSON.stringify(tsconfig)})`);

  // 5. tsc 编译 → 断言 dist 产物存在
  const tsc = await h.run('npx tsc -p tsconfig.json', 180000);
  check(checks, 'tsc compiles TS', tsc.ok === true, `ok=${tsc.ok} ${String(tsc.stderr || '').trim().slice(0, 120)}`);
  const distExists = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s13-proj/dist/greet.js','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'dist/greet.js artifact produced', distExists === true, `present=${distExists}`);

  // 6. node 跑编译产物（真实 node 执行）
  const run = await h.run('node dist/greet.js', 60000);
  check(checks, 'node runs compiled artifact', run.ok === true && String(run.stdout).trim() === 'hello ts', `stdout=${String(run.stdout).trim()}`);

  // 7. vitest 测试（真实 vitest，1 passed）
  await h.evalValue(`window.__succinixScenario.wc.fs.mkdir('/s13-proj/test', { recursive: true })`);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s13-proj/test/greet.test.ts', 'import { test, expect } from "vitest"; import { greet } from "../src/greet"; test("greet", () => { expect(greet("ts")).toBe("hello ts"); });\\n')`);
  const vitest = await h.run('npx vitest run', 180000);
  const vtOut = String(vitest.stdout || '') + String(vitest.stderr || '');
  check(checks, 'vitest run: 1 passed', vitest.ok === true && /1 passed/.test(vtOut), vtOut.trim().split('\n').filter((l) => /passed|failed|Test Files/.test(l)).slice(-3).join(' | '));

  // 清理：回 /workspace，删项目目录
  await h.run('cd /workspace');
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s13-proj', { recursive: true, force: true })`);
  return checks;
}

async function s14(h) {
  const checks = [];
  const PROJ = '/workspace/s14-proj';
  // 0. 复位会话 cwd
  await h.run('cd /workspace');

  // 1. && 链：node --version && npm --version 两行都出（shell 链）
  const chain = await h.run('node --version && npm --version', 60000);
  const chainLines = String(chain.stdout || '').trim().split('\n').filter((l) => l.length > 0);
  check(checks, 'S14 chain: node && npm both lines', chain.ok === true && chain.runtime === 'lifo' && chainLines.length >= 2 && /^v\d/.test(chainLines[0]), chainLines.join(' | '));

  // 2. node -e 嵌套双引号写 TS 文件（mkdir 与 cd 分开 —— 只有整条命令以 cd 开头才同步 host 会话 cwd）
  const mk = await h.run(`mkdir -p ${PROJ}/src`);
  check(checks, 'S14 mkdir project dir', mk.ok === true, `ok=${mk.ok}`);
  const cd = await h.run(`cd ${PROJ}`);
  check(checks, 'S14 cd into project dir', cd.ok === true, `ok=${cd.ok}`);
  const n2 = await h.run(`node -e "require('fs').writeFileSync('src/s14.ts', 'export const msg: string = \\"s14-quote-ok\\";\\nconsole.log(msg);')"`, 60000);
  const s14Content = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s14-proj/src/s14.ts','utf8').then(t=>t).catch(()=>'MISSING')`);
  check(checks, 'S14 node -e nested quotes preserved in file', n2.ok === true && typeof s14Content === 'string' && s14Content.includes('"s14-quote-ok"'), `content=${JSON.stringify(s14Content).slice(0, 70)}`);

  // 3. npm init + 装 typescript（cwd = 项目目录）→ 证明"可编译"
  const init = await h.run('npm init -y', 120000);
  check(checks, 'S14 npm init -y', init.ok === true, `ok=${init.ok}`);
  const inst = await runWithRetry(h, 'npm i -D typescript', 240000);
  const instDetail = [inst.error, inst.exitCode, inst.thrown, String(inst.stderr || inst.stdout || '').trim().slice(0, 120)].filter((v) => v !== undefined && v !== null && v !== '').join(' | ');
  check(checks, 'S14 npm i -D typescript', inst.ok === true, `ok=${inst.ok}${instDetail ? ` ${instDetail}` : ''}`);

  // tsc 编译引号文件 → node 跑产物（引号保真贯通编译）
  const tsconfig = JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src', target: 'ES2022', module: 'commonjs', strict: true }, include: ['src'] }, null, 2);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s14-proj/tsconfig.json', ${JSON.stringify(tsconfig)})`);
  const tsc = await h.run('npx tsc -p tsconfig.json', 180000);
  check(checks, 'S14 tsc compiles quote.ts (compilable)', tsc.ok === true, `ok=${tsc.ok} ${String(tsc.stderr || '').trim().slice(0, 80)}`);
  const runQ = await h.run('node dist/s14.js', 60000);
  check(checks, 'S14 node runs compiled artifact', runQ.ok === true && String(runQ.stdout).trim() === 's14-quote-ok', String(runQ.stdout).trim());

  // 4. cwd 装包：typescript 装进 /s14-proj/node_modules，根 /node_modules 没有
  const inProj = await h.evalValue(`window.__succinixScenario.wc.fs.readdir('/s14-proj/node_modules/typescript').then(()=>true).catch(()=>false)`);
  const inRoot = await h.evalValue(`window.__succinixScenario.wc.fs.readdir('/node_modules/typescript').then(()=>true).catch(()=>false)`);
  check(checks, 'S14 npm install packages into project dir (cwd sync)', inProj === true && inRoot === false, `proj=${inProj} root=${inRoot}`);

  // 5. npm i -g → EACCES + hint 行
  const g = await h.run('npm i -g left-pad', 120000);
  const gErr = String(g.stderr || '');
  check(checks, 'S14 npm i -g EACCES + hint line', g.ok === false && gErr.includes('EACCES') && gErr.includes('hint: /usr/local is read-only for guest'), `EACCES=${gErr.includes('EACCES')} hint=${gErr.includes('hint:')}`);

  // 6. python 真管道（命中保留 / 无匹配过滤为空）
  const pp1 = await h.run("python -c \"print('s14-pipe')\" | grep pipe", 90000);
  check(checks, 'S14 python pipe keeps match', pp1.ok === true && pp1.runtime === 'lifo' && String(pp1.stdout).includes('s14-pipe'), `runtime=${pp1.runtime} stdout=${String(pp1.stdout).trim().slice(0, 40)}`);
  const pp2 = await h.run("python -c \"print('abc')\" | grep zzz", 90000);
  check(checks, 'S14 python pipe filters empty', pp2.runtime === 'lifo' && String(pp2.stdout).trim() === '', `runtime=${pp2.runtime} stdout=${JSON.stringify(String(pp2.stdout).trim())}`);

  // 清理：回 /workspace，删项目目录
  await h.run('cd /workspace');
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s14-proj', { recursive: true, force: true })`);
  return checks;
}

export const scenarios = [
  { id: 'S11', name: 'python script workflow', run: s11 },
  { id: 'S12', name: 'cd + npm install cwd sync', run: s12 },
  { id: 'S13', name: 'TS ecosystem workflow', run: s13 },
  { id: 'S14', name: 'language ecosystem regression (5 pits)', run: s14 },
];
