// 自检域：共享文件系统 + 会话 cwd 同步（O5 拆分）。
import { verdict } from './runner.js';
import type { TestContext } from './runner.js';

export async function runFilesystem(ctx: TestContext, hostCwd: string): Promise<void> {
  const { wc, client, term } = ctx;
  // ─── 共享文件系统（Filesystem）───
  const fs1 = await client.terminal('cat /workspace/browser-wrote.txt');
  verdict(
    term,
    'Filesystem',
    'browser -> lifo (shared file readable)',
    fs1.ok && fs1.runtime === 'lifo' && String(fs1.stdout ?? '').includes('hello from browser'),
    String(fs1.stdout ?? '').trim().slice(0, 60)
  );

  const fs2 = await client.terminal('echo "persistent-host-write" > /workspace/lifo-wrote.txt');
  const back = await wc.fs.readFile('/lifo-wrote.txt', 'utf8');
  verdict(term, 'Filesystem', 'lifo -> browser (shared file writable)', fs2.ok && back.trim() === 'persistent-host-write', JSON.stringify(back.trim()));

  const fs3 = await client.terminal('node -e "console.log(process.cwd())"');
  verdict(term, 'Filesystem', 'node child cwd unified', fs3.ok && String(fs3.stdout ?? '').trim() === hostCwd, String(fs3.stdout ?? '').trim());

  const fs4a = await client.terminal('cd /workspace');
  const fs4b = await client.terminal('pwd');
  verdict(term, 'Filesystem', 'lifo cwd persists across commands', fs4a.ok && fs4b.ok && String(fs4b.stdout ?? '').trim() === '/workspace', String(fs4b.stdout ?? '').trim());

  // ─── 会话 cwd 同步（TASK23）：cd 成功后 host 会话 cwd 跟随，node 子进程 spawn cwd 一致 ───
  const cdSync1 = await client.terminal('cd /workspace');
  const cdSync2 = await client.exec('cwd');
  // TASK24（自检崩溃根因）：/workspace 是 Lifo 挂载视图，真实容器 FS 没有该路径；host 对
  // node 子进程用 spawnCwd() 映射回真实路径（/workspace → process.cwd()），node 的
  // process.cwd() 报真实路径（= hostCwd），而不是 /workspace。
  const cdSync3 = await client.terminal('node -e "console.log(process.cwd())"');
  verdict(
    term,
    'Filesystem',
    'cd syncs session cwd (node child cwd follows)',
    cdSync1.ok && String(cdSync2.cwd ?? '') === '/workspace' && String(cdSync3.stdout ?? '').trim() === hostCwd,
    `session=${String(cdSync2.cwd)} node=${String(cdSync3.stdout ?? '').trim()}`
  );

  // TASK24 复审（cwd 持久化双根修复）：cd 同步会话 cwd 后 host 把它写到浏览器可见的
  // /etc/succinix.cwd（= host process.cwd()/etc/succinix.cwd，随快照持久）。若仍写 node 虚拟
  // 系统根 /etc/...（只读），浏览器 wc.fs 读不到 → 刷新后 cwd 丢失。断言文件内容 = 会话 cwd。
  const cwdFile = await wc.fs.readFile('/etc/succinix.cwd', 'utf8').catch(() => '');
  verdict(
    term,
    'Filesystem',
    'cwd persisted to /etc/succinix.cwd (browser view)',
    cwdFile.trim() === '/workspace',
    `cwdFile=${JSON.stringify(cwdFile.trim())}`
  );

  // cd 到不存在目录：Lifo 报错（exit≠0），会话 cwd 不变。
  const cdBad = await client.terminal('cd /definitely-not-a-dir-xyz');
  const cwdAfterBad = await client.exec('cwd');
  verdict(
    term,
    'Filesystem',
    'failed cd keeps session cwd',
    cdBad.ok === false && String(cwdAfterBad.cwd ?? '') === '/workspace',
    `exit=${cdBad.exitCode} session=${String(cwdAfterBad.cwd)}`
  );

  // 恢复原始会话 cwd（自检不残留 cwd 状态变更；原始值可能是真实路径（Lifo VFS 不可见），
  // 统一回默认 /workspace，自检语义即"回到默认工作区"）。
  await client.terminal('cd /workspace');
}
