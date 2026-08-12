// 自检域：系统配置（env / settings 生命周期）（O5 拆分）。
import { verdict } from './runner.js';
import type { TestContext } from './runner.js';
import { readEnvFile, getEnvVar, setEnvVar, unsetEnvVar, getSetting, setSetting, resetSetting } from '../config.js';
import { loadSnapshot, saveSnapshot } from '@succinix/engine';

export async function runConfig(ctx: TestContext): Promise<void> {
  const { wc, client, term } = ctx;
  // ─── 系统配置（Config，TASK10）：env 与 settings 生命周期 ───
  // env: set TEST_VAR → 读回（内存 + 落盘 /etc/succinix.env）→ delete，无残留。
  const cfgEnvKey = 'TEST_VAR';
  await setEnvVar(wc.fs, cfgEnvKey, 'selftest-value');
  const cfgEnvRead = await getEnvVar(wc.fs, cfgEnvKey);
  const cfgEnvFile = (await readEnvFile(wc.fs)).get(cfgEnvKey);
  verdict(
    term,
    'Config',
    'env set/get lifecycle',
    cfgEnvRead === 'selftest-value' && cfgEnvFile === 'selftest-value',
    `TEST_VAR=${cfgEnvRead}`
  );

  // TASK24 复审（/etc 双根核对）：env 文件落在 process.cwd()/etc/succinix.env，host 必须读对位置
  // 合并进子进程 env —— node 子进程能读到刚设置的变量即证明合并真生效（此前读虚拟系统根，
  // 变量从未进子进程）。
  const cfgEnvNode = await client.terminal('node -e "console.log(process.env.TEST_VAR)"');
  verdict(
    term,
    'Config',
    'env merged into node child (process.env)',
    cfgEnvNode.ok && String(cfgEnvNode.stdout ?? '').trim() === 'selftest-value',
    `TEST_VAR=${String(cfgEnvNode.stdout ?? '').trim()}`
  );
  const cfgEnvDel = await unsetEnvVar(wc.fs, cfgEnvKey);
  const cfgEnvAfter = await getEnvVar(wc.fs, cfgEnvKey);
  verdict(
    term,
    'Config',
    'env delete lifecycle',
    cfgEnvDel === true && cfgEnvAfter === undefined,
    `removed=${cfgEnvDel}`
  );

  // H1 回归：等长值修改必须强制落盘。快照签名只看文件数+总字节（内容盲），
  // 'aaaaa'→'bbbbb' 等长替换不改变签名 → 自动快照会跳过写；依赖 setEnvVar 写盘后强制保存。
  // 先保存一次快照收录旧值（模拟"旧值已被持久化"的真实前置），再等长替换，
  // loadSnapshot 若仍读回旧值即说明修改未落盘（重启回滚）。
  const cfgEqlKey = 'TEST_EQLEN';
  await setEnvVar(wc.fs, cfgEqlKey, 'aaaaa');
  await saveSnapshot(wc.fs); // 快照先收录 'aaaaa'（此后等长替换不再改变文件数/总字节）
  await setEnvVar(wc.fs, cfgEqlKey, 'bbbbb'); // 同长度替换：内容盲签名不变，必须靠强制保存
  await loadSnapshot(wc.fs); // 从快照恢复，校验新值已收录
  const cfgEqlAfter = await getEnvVar(wc.fs, cfgEqlKey);
  verdict(
    term,
    'Config',
    'equal-length env change persists (force snapshot)',
    cfgEqlAfter === 'bbbbb',
    `${cfgEqlKey}=${cfgEqlAfter}`
  );
  await unsetEnvVar(wc.fs, cfgEqlKey); // 清理，零残留

  // settings: 设 preview-port 9999 → 读回 → reset 回默认 3001。
  await setSetting(wc.fs, 'preview-port', '9999');
  const cfgPortSet = await getSetting(wc.fs, 'preview-port');
  verdict(term, 'Config', 'settings read/write', cfgPortSet === '9999', `preview-port=${cfgPortSet}`);
  const cfgPortReset = await resetSetting(wc.fs, 'preview-port');
  const cfgPortAfter = await getSetting(wc.fs, 'preview-port');
  verdict(
    term,
    'Config',
    'settings reset restores default',
    cfgPortReset === true && cfgPortAfter === '3001',
    `preview-port=${cfgPortAfter}`
  );
}
