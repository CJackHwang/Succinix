// 自检域：内置语言运行时（python / pip / npm EACCES / lang 列表）（O5 拆分）。
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';
import { ensurePythonRuntime } from '@succinix/engine';
import { tryHandleLocalCommand } from '../commands/index.js';
import { captureTerm, makeDispatchBase } from './info.js';

export async function runLanguages(ctx: TestContext): Promise<void> {
  const { wc, client, term } = ctx;
  const dispatchBase = makeDispatchBase(ctx);
  // ─── 内置语言运行时（Languages，TASK27）：python 真实执行 + pip + lang 列表 ───
  // Pyodide 资产首用懒注入：自检真实跑 python 前先确保运行时已注入（首次注入 ~13MB，稍慢）。
  try {
    await ensurePythonRuntime(wc);
  } catch (e) {
    verdict(term, 'Languages', 'python runtime inject', false, String(e).slice(0, 120));
  }
  const py1 = await client.terminal('python -c "print(6*7)"', undefined, 90000);
  verdict(
    term,
    'Languages',
    'python -c real execution',
    py1.ok && String(py1.stdout ?? '').trim() === '42' && py1.runtime === 'node',
    `runtime=${py1.runtime} stdout=${String(py1.stdout ?? '').trim()}`
  );

  // 标准库支持矩阵抽检：json/csv/re/math/os/sqlite3 全部可导入。
  const py2 = await client.terminal(
    'python -c "import json,csv,re,math,os,sqlite3; print(len([json,csv,re,math,os,sqlite3]))"',
    undefined,
    60000
  );
  verdict(
    term,
    'Languages',
    'python stdlib imports (json/csv/re/math/os/sqlite3)',
    py2.ok && String(py2.stdout ?? '').trim() === '6',
    String(py2.stdout ?? '').trim()
  );

  // python3 别名 + --version 输出 Python 3.14（Pyodide 314.0.4 内置）。
  const py3 = await client.terminal('python3 --version', undefined, 60000);
  verdict(
    term,
    'Languages',
    'python3 alias + version',
    py3.ok && String(py3.stdout ?? '').includes('3.14'),
    String(py3.stdout ?? '').trim().slice(0, 40)
  );

  // TASK24 复审（python 假管道修复）：含 shell 元字符的 python 命令经 Lifo shell 执行，python
  // 段转真运行时 —— 管道真工作。grep 无匹配 → 空输出；grep 命中 → 输出保留。此前 `| grep ...`
  // 被静默当 python 参数吞掉（print(1) | grep 2 会输出 1 而非空）。
  const pyPipe1 = await client.terminal('python -c "print(1)" | grep 2', undefined, 60000);
  verdict(
    term,
    'Languages',
    'python pipe filters empty (grep 2)',
    pyPipe1.runtime === 'lifo' && String(pyPipe1.stdout ?? '').trim() === '',
    `runtime=${pyPipe1.runtime} stdout=${JSON.stringify(String(pyPipe1.stdout ?? '').trim())}`
  );
  const pyPipe2 = await client.terminal('python -c "print(42)" | grep 42', undefined, 60000);
  verdict(
    term,
    'Languages',
    'python pipe keeps match (grep 42)',
    pyPipe2.ok && pyPipe2.runtime === 'lifo' && String(pyPipe2.stdout ?? '').trim() === '42',
    `runtime=${pyPipe2.runtime} stdout=${String(pyPipe2.stdout ?? '').trim()}`
  );

  // TASK27：pip 可用 —— `python -m pip --version` 返回 micropip 版本（不再是"不可用"报错）。
  const pyPip = await client.terminal('python -m pip --version', undefined, 60000);
  verdict(
    term,
    'Languages',
    'python -m pip works (micropip)',
    pyPip.ok && /pip \d/.test(String(pyPip.stdout ?? '')),
    String(pyPip.stdout ?? '').trim().split('\n')[0]?.slice(0, 90) ?? '(no stdout)'
  );

  // TASK25：python 扩展标准库（支持矩阵数据源，lang-verify P5 之外补自检覆盖）。
  const pyX = await client.terminal(
    'python -c "import subprocess,collections,datetime,hashlib,urllib; print(len([subprocess,collections,datetime,hashlib,urllib]))"',
    undefined,
    60000
  );
  verdict(
    term,
    'Languages',
    'python extended stdlib (subprocess/collections/datetime/hashlib/urllib)',
    pyX.ok && String(pyX.stdout ?? '').trim() === '5',
    String(pyX.stdout ?? '').trim()
  );

  // TASK25：python 读写共享 FS 文件（与 Lifo/node 同一文件）。会话 cwd 已复位 /workspace，
  // python 相对路径写入 = 浏览器根 /selftest-py.txt；node 同 cwd 读回同一文件。
  const pyFs = await client.terminal('python -c "open(\'selftest-py.txt\',\'w\').write(\'py-wrote\')"', undefined, 60000);
  const pyFsRead = await wc.fs.readFile('/selftest-py.txt', 'utf8').catch(() => '');
  const pyFsNode = await client.terminal('node -e "const fs=require(\'fs\');console.log(fs.readFileSync(\'selftest-py.txt\',\'utf8\'))"', undefined, 30000);
  verdict(
    term,
    'Languages',
    'python shared-FS write/read (browser + node)',
    pyFs.ok && pyFsRead.trim() === 'py-wrote' && String(pyFsNode.stdout ?? '').trim() === 'py-wrote',
    `browser=${JSON.stringify(pyFsRead.trim())} node=${String(pyFsNode.stdout ?? '').trim()}`
  );
  await wc.fs.rm('/selftest-py.txt', { force: true }).catch(() => {});

  // TASK27：pip 真实可用 —— pip install 一个小包 → import 可用（micropip，网络拉 wheel）。
  // 网络不可达（jsdelivr/PyPI）按已知边界 SKIP，不假报成功。
  const pipInst = await client.terminal('python -m pip install pyparsing==3.3.2', undefined, 90000);
  const pipInstErr = String(pipInst.stderr ?? '');
  if (pipInst.ok) {
    const pipImp = await client.terminal('python -c "import pyparsing; print(pyparsing.__version__)"', undefined, 60000);
    verdict(
      term,
      'Languages',
      'pip install pyparsing + import (micropip)',
      pipImp.ok && String(pipImp.stdout ?? '').trim().length > 0,
      `pyparsing ${String(pipImp.stdout ?? '').trim().slice(0, 40)}`
    );
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(pipInstErr)) {
    boundary(term, 'Languages', 'pip install pyparsing + import (micropip)', `network boundary: ${pipInstErr.trim().slice(0, 60)}`);
  } else {
    verdict(term, 'Languages', 'pip install pyparsing + import (micropip)', false, pipInstErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
  }

  // TASK25：npm i -g → EACCES + 可操作 hint 行（权限语义不变，只追加提示）。
  // 网络不可达（registry 解析失败）按已知边界 SKIP，不假报成功。
  const eacces = await client.terminal('npm i -g left-pad', undefined, 60000);
  const eaccesErr = String(eacces.stderr ?? '');
  if (eaccesErr.includes('EACCES')) {
    verdict(
      term,
      'Languages',
      'npm i -g EACCES + hint line',
      eaccesErr.includes('hint: /usr/local is read-only for guest'),
      `EACCES=${eaccesErr.includes('EACCES')} hint=${eaccesErr.includes('hint:')}`
    );
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN/i.test(eaccesErr)) {
    boundary(term, 'Languages', 'npm i -g EACCES + hint', `network boundary: ${eaccesErr.trim().slice(0, 60)}`);
  } else {
    verdict(term, 'Languages', 'npm i -g EACCES + hint', false, `unexpected: exit=${eacces.exitCode} ${eaccesErr.trim().slice(0, 80)}`);
  }

  // lang 列表经命令分发路径断言（浏览器侧命令）。
  const capLang = captureTerm();
  const handledLang = await tryHandleLocalCommand({ ...dispatchBase, term: capLang.term }, 'lang');
  const langText = capLang.lines.join('\n');
  verdict(
    term,
    'Languages',
    'lang list',
    handledLang && langText.includes('python') && langText.includes('node') && langText.includes('typescript'),
    langText.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  );

  const capLangPy = captureTerm();
  const handledLangPy = await tryHandleLocalCommand({ ...dispatchBase, term: capLangPy.term }, 'lang python');
  verdict(
    term,
    'Languages',
    'lang python version',
    handledLangPy && capLangPy.lines.join('').includes('Python 3.14'),
    capLangPy.lines.join('').trim()
  );
}
