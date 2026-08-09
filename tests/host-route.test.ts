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
  lifoSpawndCwd,
  capOutput,
  MAX_OUTPUT_BYTES,
  withEaccesHint,
  parseKillPid,
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

  it('lifoSpawndCwd：Lifo VFS cwd → host 真实路径，非 /workspace 回落会话 cwd', () => {
    expect(lifoSpawndCwd('/workspace', '/workspace', ROOT)).toBe(ROOT);
    expect(lifoSpawndCwd('/workspace/sub', '/workspace', ROOT)).toBe(`${ROOT}/sub`);
    expect(lifoSpawndCwd('/tmp', '/workspace', ROOT)).toBe(spawnCwdFor('/workspace', ROOT)); // 回落会话 cwd
    expect(lifoSpawndCwd('/tmp', '/workspace/x', ROOT)).toBe(spawnCwdFor('/workspace/x', ROOT));
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
