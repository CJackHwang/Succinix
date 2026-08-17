// Stable Linux userland compatibility profile.  Entries are descriptive data;
// execution remains in WebContainer/Lifo and is intentionally not implemented in
// the browser layer.

export type UserlandCommandStatus = 'native' | 'adapter' | 'partial' | 'unsupported';
export type UserlandRuntime = 'lifo' | 'node' | 'python' | 'ruby' | 'wasi';
export type UserlandExecution = 'batch' | 'interactive' | 'both';

export interface UserlandCommandCapability {
  name: string;
  status: UserlandCommandStatus;
  runtime: UserlandRuntime;
  execution: UserlandExecution;
  supportedFlags?: string[];
  exitCodeContract?: string;
  limitations?: string[];
}

export const USERLAND_PROFILE = 'succinix-linux-userland/0.7' as const;
export const USERLAND_DENY_EXIT_CODE = 126;

const nativeCommands = [
  'echo', 'printf', 'true', 'false', 'test', '[', 'env', 'export', 'set', 'unset', 'command', 'which', 'pwd', 'cd',
  'ls', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'cat', 'head', 'tail', 'tee', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'grep', 'sed', 'awk', 'find', 'xargs', 'basename', 'dirname', 'realpath', 'mktemp', 'date', 'sleep', 'seq', 'du', 'df',
  'file', 'diff', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'base64', 'sha256sum', 'md5sum', 'column', 'xxd', 'id', 'groups',
  'printenv', 'expr', 'ps', 'systemctl', 'sh', 'bash', 'vi', 'nano', 'git', 'curl', 'wget', 'dig', 'host', 'netstat', 'ss', 'ip',
] as const;

const denylistedCommands = [
  'chmod', 'chown', 'ln', 'mount', 'umount', 'sudo', 'su', 'useradd', 'groupadd', 'iptables', 'ifconfig', 'route',
  'ping', 'ssh', 'gcc', 'clang', 'rustc', 'go',
] as const;

export const USERLAND_DENYLIST: readonly string[] = denylistedCommands;

export function defaultUserlandCapabilities(): UserlandCommandCapability[] {
  return nativeCommands.map((name) => ({
    name,
    status: name === 'bash' ? 'partial' : name === 'git' ? 'adapter' : 'native',
    runtime: 'lifo',
    execution: name === 'cd' || name === 'export' || name === 'set' || name === 'unset' ? 'interactive' : name === 'vi' || name === 'nano' ? 'interactive' : 'both',
    exitCodeContract: name === 'bash' ? '0 when the supported script completes; non-zero on unsupported syntax' : '0 on success, non-zero on invalid input or execution failure',
    ...(name === 'bash' ? { limitations: ['Succinix shell: bash-compatible userland subset', 'Here-documents are unsupported'] } : {}),
    ...(name === 'git' ? { limitations: ['HTTPS/isomorphic-git workflow; SSH transport is unsupported'] } : {}),
  }));
}

export function deniedCommandCapability(name: string): UserlandCommandCapability {
  return {
    name,
    status: 'unsupported',
    runtime: 'lifo',
    execution: 'batch',
    exitCodeContract: `${USERLAND_DENY_EXIT_CODE} (command unavailable in this environment)`,
    limitations: ['The command is denylisted because this browser-native environment has no kernel or permission model'],
  };
}

export function isDenylistedCommand(name: string): boolean {
  const token = name.trim().split(/\s+/, 1)[0] ?? '';
  const base = token.slice(token.lastIndexOf('/') + 1);
  return USERLAND_DENYLIST.includes(base);
}

export function denylistedCommandResult(name: string): { ok: false; exitCode: number; stderr: string } {
  const token = name.trim().split(/\s+/, 1)[0] ?? name;
  const base = token.slice(token.lastIndexOf('/') + 1);
  return { ok: false, exitCode: USERLAND_DENY_EXIT_CODE, stderr: `succinix: ${base}: command unavailable in this environment\n` };
}

export interface UserlandCapabilitySnapshot {
  profile: typeof USERLAND_PROFILE;
  commands: UserlandCommandCapability[];
  denylist: string[];
}
