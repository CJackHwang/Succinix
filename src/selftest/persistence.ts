// 自检域：持久化 + 工作区（O5 拆分）。
import { verdict } from './runner.js';
import type { TestContext } from './runner.js';
import { saveSnapshot, loadSnapshot } from '../persist.js';
import { getCurrentWorkspace, listWorkspaces, buildWorkspaceList, workspaceCreate, workspaceSwitch, workspaceRemove } from '../commands.js';

export async function runPersistence(ctx: TestContext): Promise<void> {
  const { wc, term } = ctx;
  // ─── 持久化（Persistence）───
  // 自检会真实写入快照 —— 这是特性（自检也验证了持久化）。断言放 Filesystem 区。
  const pers1 = await saveSnapshot(wc.fs);
  verdict(term, 'Persistence', 'snapshot saved', pers1.meta.fileCount > 0, `${pers1.meta.fileCount} files`);

  const pers2 = await loadSnapshot(wc.fs);
  const restoredText = pers2 ? await wc.fs.readFile('/browser-wrote.txt', 'utf8') : '';
  const loadable = !!pers2 && pers2.fileCount === pers1.meta.fileCount && restoredText.includes('hello from browser');
  verdict(term, 'Persistence', 'snapshot loadable', loadable, pers2 ? `restored ${pers2.fileCount} files` : 'no snapshot to restore');

  // ─── 工作区（Workspace，TASK7）：多工作区隔离 ───
  const wsCurrent = await getCurrentWorkspace(wc.fs);
  const wsNames = await listWorkspaces(wc.fs);
  const wsText = buildWorkspaceList(wsCurrent, wsNames).join('\n');
  const wsListOk = wsNames.includes(wsCurrent ?? 'main') && wsText.includes('(current)') && wsText.startsWith('Workspaces');
  verdict(term, 'Workspace', 'list workspaces', wsListOk, `current=${wsCurrent ?? 'none'} count=${wsNames.length}`);

  // 生命周期：创建临时工作区 → 切换 → 读 .current 验证 → 删除，清理干净不留残留。
  // 记录原始当前工作区，结束时恢复原状（自检不改变用户工作区状态）。
  const wsOriginal = (await getCurrentWorkspace(wc.fs)) ?? 'main';
  const WS_TEST = 'selftest-ws';
  const wsC = await workspaceCreate(wc.fs, WS_TEST);
  verdict(term, 'Workspace', 'create workspace', wsC.ok && (await listWorkspaces(wc.fs)).includes(WS_TEST), wsC.message);

  const wsS = await workspaceSwitch(wc.fs, WS_TEST);
  const wsAfterSwitch = await getCurrentWorkspace(wc.fs);
  verdict(term, 'Workspace', 'switch updates .current', wsS.ok && wsAfterSwitch === WS_TEST, `current=${wsAfterSwitch}`);

  // 保护：禁止删除 main 与当前工作区。
  const wsProtectMain = await workspaceRemove(wc.fs, 'main', wsAfterSwitch, true);
  verdict(term, 'Workspace', 'main workspace protected', !wsProtectMain.ok, wsProtectMain.message);

  const wsProtectCur = await workspaceRemove(wc.fs, WS_TEST, wsAfterSwitch, true);
  verdict(term, 'Workspace', 'current workspace protected', !wsProtectCur.ok, wsProtectCur.message);

  // 清理：切回原工作区再删 selftest-ws，.current 恢复原状，无残留。
  await workspaceSwitch(wc.fs, wsOriginal);
  const wsR = await workspaceRemove(wc.fs, WS_TEST, wsOriginal, true);
  const wsAfterRm = await listWorkspaces(wc.fs);
  const wsFinalCurrent = await getCurrentWorkspace(wc.fs);
  verdict(
    term,
    'Workspace',
    'remove workspace + cleanup',
    wsR.ok && !wsAfterRm.includes(WS_TEST) && wsFinalCurrent === wsOriginal,
    wsR.message
  );
}
