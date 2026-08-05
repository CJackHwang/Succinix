// 双 host 不变量（TASK19）：重启 host 必须先 kill 旧 host 再 spawn 新 host。
// 否则新旧两个 host 会同时轮询 /cmd.json —— 两个都读请求、都写结果文件，命令结果不确定。
// 提取成可测的纯流程：main.ts 的 restartHost 复用；自检用假句柄直接断言 kill 先于 spawn。
export async function respawnWithKillFirst<T>(
  killOld: () => void,
  spawnNew: () => Promise<T>
): Promise<T> {
  // kill 旧 host 必须在 spawn 新 host 之前（单 host 不变量）。旧句柄失效时 kill 是 no-op。
  try {
    killOld();
  } catch {
    /* 旧 host 句柄失效：忽略，继续 spawn 新 host */
  }
  return await spawnNew();
}
