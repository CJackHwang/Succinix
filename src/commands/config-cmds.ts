// 系统配置命令域：env / settings（O1 拆分）。
import { readEnvFile, getEnvVar, setEnvVar, unsetEnvVar, getSetting, setSetting, resetSetting, listSettings, validateSetting, SETTING_KEYS, DEFAULT_SETTINGS } from '../config.js';
import { GRAY, RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
// ─── 系统配置（TASK10）：env / settings ───
// 两者都落在容器 FS（/etc/succinix.env、/etc/succinix.settings），随快照持久，重启保留。

// env：查看 / 设置 / 删除环境变量。
//   env              列出全部（key=value 对齐，值可含 =）
//   env <key>        查看单个（不存在显示 not set）
//   env <key>=<val>  设置
//   env -u <key>     删除
export async function envCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId;
  const prefix = ctx.statePrefix;
  if (args.length === 0) {
    const map = await readEnvFile(wc.fs, inst, prefix);
    if (map.size === 0) {
      term.writeln('(no environment variables set)');
      return;
    }
    const keys = [...map.keys()].sort();
    const width = Math.max(...keys.map((k) => k.length));
    for (const key of keys) {
      term.writeln(`${key.padEnd(width)}=${map.get(key) ?? ''}`);
    }
    return;
  }
  const arg = args[0];
  if (arg === '-u' || arg === '--unset') {
    const key = args[1];
    if (!key) {
      term.writeln('usage: env -u <key>');
      return;
    }
    const removed = await unsetEnvVar(wc.fs, key, inst, prefix);
    term.writeln(removed ? `unset ${key}` : `${key} is not set`);
    return;
  }
  const eq = arg.indexOf('=');
  if (eq === -1) {
    // 查看单个
    const value = await getEnvVar(wc.fs, arg, inst, prefix);
    term.writeln(value !== undefined ? `${arg}=${value}` : `${arg} is not set`);
    return;
  }
  // 设置：按第一个 = 切分，值允许含 =；值含空格时（token 被空白拆开）join 剩余 token，
  // 杜绝静默截断（M2：env FOO=hello world 应存 'hello world'，而不是截断成 'hello'）。
  const key = arg.slice(0, eq);
  const first = arg.slice(eq + 1);
  const restTokens = args.slice(1);
  const value = restTokens.length > 0 ? `${first} ${restTokens.join(' ')}` : first;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    term.writeln(`${RED}env: invalid variable name '${key}'${RESET}`);
    return;
  }
  await setEnvVar(wc.fs, key, value, inst, prefix);
  term.writeln(`set ${key}=${value}`);
}

// settings：查看 / 设置 / 恢复系统设置。
//   settings               列出全部
//   settings <key>         查看
//   settings <key> <val>   设置
//   settings reset <key>   恢复默认
export async function settingsCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId;
  const prefix = ctx.statePrefix;
  if (args.length === 0) {
    const entries = await listSettings(wc.fs, inst, prefix);
    const width = Math.max(...entries.map((e) => e.key.length), 1);
    for (const e of entries) {
      const marker = e.isDefault ? `${GRAY}(default)${RESET}` : '';
      term.writeln(`  ${e.key.padEnd(width)}  ${e.value}${marker ? '  ' + marker : ''}`);
    }
    return;
  }
  if (args[0] === 'reset') {
    const key = args[1];
    if (!key) {
      term.writeln('usage: settings reset <key>');
      return;
    }
    if (!(key in DEFAULT_SETTINGS)) {
      term.writeln(`${RED}unknown setting: ${key}${RESET}`);
      return;
    }
    const removed = await resetSetting(wc.fs, key, inst, prefix);
    const def = DEFAULT_SETTINGS[key];
    term.writeln(removed ? `reset ${key} to default (${def})` : `${key} is already at default (${def})`);
    applySettingRuntime(ctx, key, def);
    return;
  }
  const key = args[0];
  if (!(key in DEFAULT_SETTINGS)) {
    term.writeln(`${RED}unknown setting: ${key}${RESET}`);
    term.writeln(`known settings: ${SETTING_KEYS.join(', ')}`);
    return;
  }
  if (args.length === 1) {
    const value = await getSetting(wc.fs, key, inst, prefix);
    const def = DEFAULT_SETTINGS[key];
    term.writeln(`${key}=${value}${value === def ? ' (default)' : ''}`);
    return;
  }
  const value = args.slice(1).join(' ');
  const err = validateSetting(key, value);
  if (err) {
    term.writeln(`${RED}settings: ${err}${RESET}`);
    return;
  }
  await setSetting(wc.fs, key, value, inst, prefix);
  term.writeln(`set ${key}=${value}`);
  applySettingRuntime(ctx, key, value);
}

// 运行时应用设置：font-size 立即改 xterm 字号并重算布局（FitAddon）。
// preview-port / default-workspace 在各自消费点生效（db start / boot），无需即时动作。
function applySettingRuntime(ctx: CommandContext, key: string, value: string): void {
  if (key !== 'font-size') return;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 8 && n <= 72) {
    ctx.term.options.fontSize = n;
    ctx.fit();
  }
}
