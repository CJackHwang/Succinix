// host-route.ts 纯逻辑单测（P1-4）：路由判定 / 路径映射 / 截断 / EACCES 提示 / pid 解析。
// 这些逻辑此前只靠浏览器 e2e 覆盖，抽取后纳入 vitest 门禁，重构 host.ts 时有回归保护。
import { describe, it, expect } from 'vitest';
import {
  isUnderWorkspace,
  classifyPrefix,
  classifyRoute,
  vfsToReal,
  spawnCwdFor,
  resolveBrowserPath,
  pythonRuntimeArgs,
  mapDataDirArgs,
  lifoSpawndCwd,
  lifoCwdToSessionCwd,
  browserPathToLifoCwd,
  sessionCwdToBrowserPath,
  sessionCwdPromptLabel,
  canKillProcess,
  capOutput,
  MAX_OUTPUT_BYTES,
  withEaccesHint,
  parseKillPid,
  shouldRemoveCmdFile,
  CD_PREFIX_RE,
} from '../src/engine/host-route.js';

const ROOT = '/home/wc-1';

describe('classifyPrefix / classifyRoute（路由判定）', () => {
  it('node/npm/npx 前缀 → node', () => {
    expect(classifyPrefix('node script.js')).toBe('node');
    expect(classifyPrefix('npm install')).toBe('node');
    expect(classifyPrefix('npx tinbase')).toBe('node');
    expect(classifyPrefix('node')).toBe('node'); // 仅命令名，无参数
  });

  it('python/python3/pip/pip3 前缀 → python', () => {
    expect(classifyPrefix('python -c "print(1)"')).toBe('python');
    expect(classifyPrefix('python3 x.py')).toBe('python');
    expect(classifyPrefix('pip install x')).toBe('python');
    expect(classifyPrefix('pip3 list')).toBe('python');
  });

  it('其余命令 → lifo', () => {
    expect(classifyPrefix('echo hi')).toBe('lifo');
    expect(classifyPrefix('grep foo')).toBe('lifo');
    expect(classifyPrefix('')).toBe('lifo');
  });

  it('不误判包含 node 的普通命令（nonode 不算 node 前缀）', () => {
    expect(classifyPrefix('nonode')).toBe('lifo');
    expect(classifyPrefix('node-extra arg')).toBe('lifo'); // node 后必须空格/行尾
  });

  it('node/python 含 shell 元字符 → 回退 lifo（混合链）', () => {
    expect(classifyRoute('node -e "x" && ls', true)).toBe('lifo');
    expect(classifyRoute('npm install | head', true)).toBe('lifo');
    expect(classifyRoute('python -c x | grep y', true)).toBe('lifo');
  });

  it('纯 node/python 命令（无元字符）→ 保持原路', () => {
    expect(classifyRoute('node script.js', false)).toBe('node');
    expect(classifyRoute('python -c x', false)).toBe('python');
    expect(classifyRoute('echo hi', true)).toBe('lifo'); // lifo 不受元字符影响
    expect(classifyRoute('echo hi', false)).toBe('lifo');
  });
});

describe('路径映射（TASK23/TASK24 双根）', () => {
  it('isUnderWorkspace 判定挂载边界', () => {
    expect(isUnderWorkspace('/workspace')).toBe(true);
    expect(isUnderWorkspace('/workspace/sub')).toBe(true);
    expect(isUnderWorkspace('/workspacex')).toBe(false);
    expect(isUnderWorkspace('/tmp')).toBe(false);
  });

  it('vfsToReal：/workspace → root，/workspace/foo → root/foo，其余原样', () => {
    expect(vfsToReal('/workspace', ROOT)).toBe(ROOT);
    expect(vfsToReal('/workspace/foo/bar', ROOT)).toBe(`${ROOT}/foo/bar`);
    expect(vfsToReal('/tmp', ROOT)).toBe('/tmp');
    expect(vfsToReal('/etc/succinix.env', ROOT)).toBe('/etc/succinix.env'); // 非 VFS 路径原样
  });

  it('spawnCwdFor：会话 cwd 映射为 spawn 真实 cwd', () => {
    expect(spawnCwdFor('/workspace', ROOT)).toBe(ROOT);
    expect(spawnCwdFor('/workspace/sub', ROOT)).toBe(`${ROOT}/sub`);
    expect(spawnCwdFor('/tmp', ROOT)).toBe('/tmp'); // Lifo 私有路径原样（会挂起，宿主侧已知边界）
  });

  it('resolveBrowserPath：/foo 与 /workspace/foo 都映射到 root/foo', () => {
    expect(resolveBrowserPath('/script.py', ROOT)).toBe(`${ROOT}/script.py`);
    expect(resolveBrowserPath('/workspace/script.py', ROOT)).toBe(`${ROOT}/script.py`);
    expect(resolveBrowserPath('/workspace', ROOT)).toBe(`${ROOT}/`);
    expect(resolveBrowserPath('rel/script.py', ROOT)).toBe('rel/script.py'); // 相对路径原样
  });

  it('pythonRuntimeArgs：脚本模式映射绝对路径，-c/--version 原样', () => {
    expect(pythonRuntimeArgs(['/script.py', '--arg'], ROOT)).toEqual([`${ROOT}/script.py`, '--arg']);
    expect(pythonRuntimeArgs(['/workspace/x.py'], ROOT)).toEqual([`${ROOT}/x.py`]);
    expect(pythonRuntimeArgs(['-c', 'print(1)'], ROOT)).toEqual(['-c', 'print(1)']);
    expect(pythonRuntimeArgs(['--version'], ROOT)).toEqual(['--version']);
    expect(pythonRuntimeArgs(['script.py'], ROOT)).toEqual(['script.py']); // 相对路径不映射
  });

  it('mapDataDirArgs：--data-dir 浏览器视角绝对路径映射到 host 真实根（node 容器根无 /workspace）', () => {
    // 双写法：`--data-dir <path>` 与 `--data-dir=<path>`。
    expect(mapDataDirArgs(['start', '--port', '3001', '--data-dir', '/workspace/.succinix-c-1/tinbase'], ROOT)).toEqual([
      'start',
      '--port',
      '3001',
      '--data-dir',
      `${ROOT}/workspace/.succinix-c-1/tinbase`,
    ]);
    expect(mapDataDirArgs(['start', '--data-dir=/workspace/.succinix-c-1/tinbase'], ROOT)).toEqual([
      'start',
      `--data-dir=${ROOT}/workspace/.succinix-c-1/tinbase`,
    ]);
    // /workspace 根本身 → root/workspace；浏览器绝对路径一律 root+p；相对路径原样。
    expect(mapDataDirArgs(['--data-dir', '/workspace'], ROOT)).toEqual(['--data-dir', `${ROOT}/workspace`]);
    expect(mapDataDirArgs(['--data-dir', '/tmp/tb'], ROOT)).toEqual(['--data-dir', `${ROOT}/tmp/tb`]);
    expect(mapDataDirArgs(['--data-dir', 'rel/tb'], ROOT)).toEqual(['--data-dir', 'rel/tb']);
    expect(mapDataDirArgs(['start', '--port', '3001'], ROOT)).toEqual(['start', '--port', '3001']);
  });

  it('lifoSpawndCwd：Lifo VFS cwd → host 真实路径，非 /workspace 回落会话 cwd', () => {
    expect(lifoSpawndCwd('/workspace', '/workspace', ROOT)).toBe(ROOT);
    expect(lifoSpawndCwd('/workspace/sub', '/workspace', ROOT)).toBe(`${ROOT}/sub`);
    expect(lifoSpawndCwd('/tmp', '/workspace', ROOT)).toBe(spawnCwdFor('/workspace', ROOT)); // 回落会话 cwd
    expect(lifoSpawndCwd('/tmp', '/workspace/x', ROOT)).toBe(spawnCwdFor('/workspace/x', ROOT));
  });

  it('browserPathToLifoCwd：浏览器状态根映射到同一宿主目录的 Lifo cwd', () => {
    const browserStateRoot = '/workspace/.succinix-c-1';
    const lifoCwd = browserPathToLifoCwd(browserStateRoot);
    expect(lifoCwd).toBe('/workspace/workspace/.succinix-c-1');
    expect(lifoSpawndCwd(lifoCwd, lifoCwd, ROOT)).toBe(`${ROOT}/workspace/.succinix-c-1`);
  });

  it('sessionCwdToBrowserPath：会话 cwd（Lifo 视图）→ 浏览器可读路径（P5-16 复审，Tab 补全用）', () => {
    // 浏览器 `/` == host process.cwd() == Lifo /workspace 挂载点
    expect(sessionCwdToBrowserPath('/workspace')).toBe('/');
    expect(sessionCwdToBrowserPath('/workspace/proj')).toBe('/proj');
    expect(sessionCwdToBrowserPath('/workspace/a/b')).toBe('/a/b');
    // host 真实路径（未 cd 的初始 cwd，浏览器视图即根）与 Lifo 私有路径 → 回落根
    expect(sessionCwdToBrowserPath('/home/wc-123')).toBe('/');
    expect(sessionCwdToBrowserPath('/tmp')).toBe('/');
    expect(sessionCwdToBrowserPath('/')).toBe('/');
  });

  it('sessionCwdPromptLabel：cd 后提示符随目录更新（~ = /workspace）', () => {
    // ~ = /workspace（工作区根，提示符初始 ~ 所指）
    expect(sessionCwdPromptLabel('/workspace')).toBe('~');
    expect(sessionCwdPromptLabel('/workspace/proj')).toBe('~/proj');
    expect(sessionCwdPromptLabel('/workspace/a/b')).toBe('~/a/b');
    // host 真实路径（初始 cwd，即工作区根的真实路径视图）→ 回落 ~
    expect(sessionCwdPromptLabel('/home/wc-123')).toBe('~');
    expect(sessionCwdPromptLabel('/workspacex')).toBe('~'); // 前缀误判防护
  });

  it('sessionCwdPromptLabel：多用户 home 参数优先（U1，cwd === home → ~）', () => {
    const home = '/workspace/workspace/users/a'; // 浏览器 /workspace/users/a 的 Lifo 视图
    expect(sessionCwdPromptLabel(home, home)).toBe('~');
    expect(sessionCwdPromptLabel(`${home}/proj`, home)).toBe('~/proj');
    expect(sessionCwdPromptLabel(`${home}/a/b`, home)).toBe('~/a/b');
    // 不在 home 下：回落工作区根语义（/workspace 下仍按 ~ 前缀，其余 ~）。
    expect(sessionCwdPromptLabel('/workspace', home)).toBe('~');
    expect(sessionCwdPromptLabel('/workspace/proj', home)).toBe('~/proj');
    expect(sessionCwdPromptLabel('/home/wc-123', home)).toBe('~');
    expect(sessionCwdPromptLabel('/workspacex', home)).toBe('~'); // 前缀误判防护
  });

  it('sessionCwdPromptLabel：缺省 home = /workspace（guest 现状全等）', () => {
    expect(sessionCwdPromptLabel('/workspace')).toBe('~');
    expect(sessionCwdPromptLabel('/workspace/x')).toBe('~/x');
  });

  it('lifoCwdToSessionCwd：cd 后 Lifo cwd → 会话 cwd（cd / 映射回工作区根）', () => {
    // /workspace 下原样同步
    expect(lifoCwdToSessionCwd('/workspace')).toBe('/workspace');
    expect(lifoCwdToSessionCwd('/workspace/proj')).toBe('/workspace/proj');
    // Lifo VFS 根 / → 工作区根（否则 cd / 后会话 cwd 不更新，"回到根目录"不可达）
    expect(lifoCwdToSessionCwd('/')).toBe('/workspace');
    // Lifo 私有路径（无 host 等价物）→ null（不同步）
    expect(lifoCwdToSessionCwd('/tmp')).toBeNull();
    expect(lifoCwdToSessionCwd('/home/user')).toBeNull();
    expect(lifoCwdToSessionCwd('/workspacex')).toBeNull(); // 前缀误判防护
  });
});

describe('capOutput（输出截断）', () => {
  it('未超上限原样返回', () => {
    expect(capOutput('hello')).toBe('hello');
    expect(capOutput('', 10)).toBe('');
  });

  it('超出上限保留尾部', () => {
    const s = 'a'.repeat(MAX_OUTPUT_BYTES + 10);
    const out = capOutput(s);
    expect(out.length).toBe(MAX_OUTPUT_BYTES);
    expect(out.endsWith('a')).toBe(true);
  });

  it('自定义上限（测试/小缓冲场景）', () => {
    expect(capOutput('abcdef', 4)).toBe('cdef');
    expect(capOutput('abc', 4)).toBe('abc');
  });
});

describe('canKillProcess（U1 kill 越权拒绝，host 侧收口）', () => {
  const procs = [
    { scope: 'system', containerId: undefined },
    { scope: 'container', containerId: '.succinix-a' },
    { scope: 'container', containerId: '.succinix-b' },
    { scope: 'container', containerId: 'a' }, // CISOL 兼容命名空间（c-<id> 段即 id）
    { scope: 'unknown', containerId: undefined },
  ] as Array<{ scope?: string; containerId?: string }>;

  it('default instance may kill anything (current behavior unchanged)', () => {
    for (const p of procs) expect(canKillProcess(p, 'default')).toBe(true);
    expect(canKillProcess(undefined, 'default')).toBe(true);
  });

  it('instance/user may kill only its own processes (state-root .succinix-<id> and legacy c-<id>)', () => {
    expect(canKillProcess(procs[1], 'a')).toBe(true); // .succinix-a
    expect(canKillProcess(procs[3], 'a')).toBe(true); // cwd c-a 段（id == a）
    expect(canKillProcess(procs[2], 'a')).toBe(false); // .succinix-b → 跨用户拒绝
  });

  it('system processes and unattributed processes are never killable by non-default instances', () => {
    expect(canKillProcess(procs[0], 'a')).toBe(false); // system
    expect(canKillProcess(procs[4], 'a')).toBe(false); // unknown
    expect(canKillProcess(undefined, 'a')).toBe(false); // 进程不存在
  });

  it('same rule applies to user ids (userId == instanceId)', () => {
    expect(canKillProcess({ scope: 'container', containerId: '.succinix-b' }, 'b')).toBe(true);
    expect(canKillProcess({ scope: 'container', containerId: '.succinix-a' }, 'b')).toBe(false);
  });
});

describe('withEaccesHint（EACCES 提示）', () => {
  it('stderr 含 EACCES + /usr/local → 追加 hint 行', () => {
    const out = withEaccesHint('EACCES: permission denied, access \'/usr/local/lib\'\n');
    expect(out).toContain('hint: /usr/local is read-only for guest');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('不含 EACCES 或 /usr/local → 原样返回', () => {
    expect(withEaccesHint('EACCES: something else')).toBe('EACCES: something else');
    expect(withEaccesHint('/usr/local not mentioned')).toBe('/usr/local not mentioned');
    expect(withEaccesHint('plain error')).toBe('plain error');
    expect(withEaccesHint('')).toBe('');
  });

  it('自定义 hint 可注入', () => {
    expect(withEaccesHint('EACCES /usr/local', 'MY HINT')).toBe('EACCES /usr/local\nMY HINT\n');
  });
});

describe('parseKillPid（kill pid 解析）', () => {
  it('opts.pid 优先', () => {
    expect(parseKillPid('kill 999', 42)).toBe(42);
    expect(parseKillPid('kill 999', '42')).toBe(42); // 字符串数字也可
  });

  it('字符串形式 "kill 1234" 回落', () => {
    expect(parseKillPid('kill 1234', undefined)).toBe(1234);
    expect(parseKillPid('kill 0007', undefined)).toBe(7);
  });

  it('无法解析 → NaN', () => {
    expect(Number.isNaN(parseKillPid('kill abc', undefined))).toBe(true);
    expect(Number.isNaN(parseKillPid('', undefined))).toBe(true);
  });

  it('pid <= 0 由调用方（dispatchKill）拒绝：parseKillPid 原样返回 0', () => {
    expect(parseKillPid('kill 0', undefined)).toBe(0);
    expect(parseKillPid('kill 12', 0)).toBe(12); // opts 0 非法（需 >0）→ 回落字符串形式
  });
});

describe('CD_PREFIX_RE（cd 同步判定）', () => {
  it('只匹配整条命令以 cd 开头', () => {
    expect(CD_PREFIX_RE.test('cd /workspace')).toBe(true);
    expect(CD_PREFIX_RE.test('cd')).toBe(true);
    expect(CD_PREFIX_RE.test('cdx')).toBe(false);
    expect(CD_PREFIX_RE.test('echo cd')).toBe(false);
  });
});

describe('shouldRemoveCmdFile（P0-2 /cmd.json 删除决策）', () => {
  it('文件内容仍是刚处理的请求 → 删除', () => {
    expect(shouldRemoveCmdFile(5, JSON.stringify({ id: 5, cmd: 'run' }))).toBe(true);
  });

  it('被更新的请求覆盖（id 不同，如 pingDirect/interruptDirect 直接写入）→ 保留待下轮处理', () => {
    expect(shouldRemoveCmdFile(5, JSON.stringify({ id: 6, cmd: 'ping' }))).toBe(false);
    expect(shouldRemoveCmdFile(5, JSON.stringify({ id: 6, cmd: 'interrupt' }))).toBe(false);
  });

  it('文件已不存在（null）→ 无需再删', () => {
    expect(shouldRemoveCmdFile(5, null)).toBe(false);
  });

  it('内容损坏 / id 缺失 / 非数字 id → 不删（下轮重读，解析错误由读取路径兜底）', () => {
    expect(shouldRemoveCmdFile(5, 'not json')).toBe(false);
    expect(shouldRemoveCmdFile(5, JSON.stringify({ cmd: 'run' }))).toBe(false);
    expect(shouldRemoveCmdFile(5, JSON.stringify({ id: '5', cmd: 'run' }))).toBe(false);
  });
});
