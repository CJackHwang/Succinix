// invariant: opens execution-world interactive terminals without a browser shell.
import type { SuccinixInstance } from './types.js';

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 在执行世界中打开交互终端；此处没有浏览器侧 shell 或缓冲区。 */
export async function openInstanceInteractiveTerminal(
  instance: SuccinixInstance,
  cwd?: string,
) {
  if (cwd !== undefined) {
    const result = await instance.executor.exec(`cd ${quoteShellArg(cwd)}`, { instanceId: instance.instanceId });
    if (!result.ok) throw new Error(String(result.stderr ?? result.error ?? `cannot change directory to ${cwd}`));
  }
  const interactive = instance.executor.interactive;
  if (!interactive) throw new Error('interactive terminal is unavailable in this execution world');
  return interactive.open({ instanceId: instance.instanceId, cols: 80, rows: 24 });
}
