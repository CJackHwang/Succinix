// Stable Linux userland compatibility profile.  Entries are descriptive data;
// execution remains in WebContainer/Lifo and is intentionally not implemented in
// the browser layer.

export type UserlandCommandStatus = 'native' | 'adapter' | 'partial' | 'unsupported';
export type UserlandRuntime = 'lifo' | 'node' | 'python' | 'ruby' | 'wasi';
export type UserlandExecution = 'batch' | 'interactive' | 'both';
export type UserlandStdinContract = 'shell-stream-where-supported' | 'interactive-raw' | 'not-applicable';
export type UserlandPipeContract = 'shell-composition' | 'not-applicable';
export type UserlandGlobContract = 'shell-expanded' | 'not-applicable';
export type UserlandPathContract = 'cwd-relative-where-applicable' | 'not-applicable';
export type UserlandHelpContract = 'command-specific' | 'usage-only' | 'not-applicable';
export type UserlandInvalidArgsContract = 'non-zero-exit' | 'usage-exit-2' | 'bash-banner-or-usage-exit-2' | 'fixed-126-denied';
export type UserlandExitCodeContract = 'zero-success-nonzero-failure' | 'script-exit-propagated' | 'zero-banner-or-script-exit-propagated' | 'fixed-126-denied';
export type UserlandBinaryContract = 'byte-stream-where-applicable' | 'text-stream' | 'not-applicable';

export interface UserlandCapabilityContract {
  id: string;
  testId: string;
  command: string;
  stdin: UserlandStdinContract;
  pipe: UserlandPipeContract;
  glob: UserlandGlobContract;
  relativePath: UserlandPathContract;
  help: UserlandHelpContract;
  invalidArgs: UserlandInvalidArgsContract;
  exitCode: UserlandExitCodeContract;
  maxOutputBytes: number;
  binary: UserlandBinaryContract;
  execution: UserlandExecution;
}

export interface UserlandCommandCapability {
  name: string;
  contractId?: string;
  status: UserlandCommandStatus;
  runtime: UserlandRuntime;
  execution: UserlandExecution;
  supportedFlags?: string[];
  exitCodeContract?: string;
  limitations?: string[];
}

export const USERLAND_PROFILE = 'succinix-linux-userland/0.7' as const;
export const USERLAND_DENY_EXIT_CODE = 126;
export const USERLAND_MAX_OUTPUT_BYTES = 1024 * 1024;

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

type NativeCommandName = (typeof nativeCommands)[number];

const interactiveCommands = new Set<NativeCommandName>(['cd', 'export', 'set', 'unset', 'vi', 'nano']);
const rawInputCommands = new Set<NativeCommandName>(['vi', 'nano']);
const statefulShellCommands = new Set<NativeCommandName>(['cd', 'export', 'set', 'unset']);
const byteStreamCommands = new Set<NativeCommandName>(['cat', 'tee', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'base64', 'xxd']);

function nativeExecution(name: NativeCommandName): UserlandExecution {
  return interactiveCommands.has(name) ? 'interactive' : 'both';
}

function nativeContractId(name: NativeCommandName): string {
  return `userland.command.${name === '[' ? 'bracket-test' : name}`;
}

function contractForNativeCommand(name: NativeCommandName): UserlandCapabilityContract {
  const execution = nativeExecution(name);
  const hasRawInput = rawInputCommands.has(name);
  const isStateful = statefulShellCommands.has(name);
  const isScript = name === 'sh' || name === 'bash';
  const id = nativeContractId(name);
  return {
    id,
    testId: `userland.contract.${id}`,
    command: name,
    stdin: hasRawInput ? 'interactive-raw' : isStateful ? 'not-applicable' : 'shell-stream-where-supported',
    pipe: isStateful ? 'not-applicable' : 'shell-composition',
    glob: 'shell-expanded',
    relativePath: name === 'export' || name === 'set' || name === 'unset' ? 'not-applicable' : 'cwd-relative-where-applicable',
    help: isScript ? 'usage-only' : 'command-specific',
    invalidArgs: name === 'bash' ? 'bash-banner-or-usage-exit-2' : isScript ? 'usage-exit-2' : 'non-zero-exit',
    exitCode: name === 'bash' ? 'zero-banner-or-script-exit-propagated' : isScript ? 'script-exit-propagated' : 'zero-success-nonzero-failure',
    maxOutputBytes: USERLAND_MAX_OUTPUT_BYTES,
    binary: byteStreamCommands.has(name) || isScript ? 'byte-stream-where-applicable' : 'text-stream',
    execution,
  };
}

function contractForDenylistedCommand(name: string): UserlandCapabilityContract {
  const id = `userland.denied.${name}`;
  return {
    id,
    testId: `userland.contract.${id}`,
    command: name,
    stdin: 'not-applicable',
    pipe: 'not-applicable',
    glob: 'not-applicable',
    relativePath: 'not-applicable',
    help: 'not-applicable',
    invalidArgs: 'fixed-126-denied',
    exitCode: 'fixed-126-denied',
    maxOutputBytes: USERLAND_MAX_OUTPUT_BYTES,
    binary: 'not-applicable',
    execution: 'batch',
  };
}

export const USERLAND_CAPABILITY_CONTRACTS: readonly UserlandCapabilityContract[] = nativeCommands.map(contractForNativeCommand);
export const USERLAND_DENYLIST_CONTRACTS: readonly UserlandCapabilityContract[] = denylistedCommands.map(contractForDenylistedCommand);

const contractsByCommand = new Map(USERLAND_CAPABILITY_CONTRACTS.map((contract) => [contract.command, contract]));
const deniedContractsByCommand = new Map(USERLAND_DENYLIST_CONTRACTS.map((contract) => [contract.command, contract]));

export function defaultUserlandCapabilities(): UserlandCommandCapability[] {
  return nativeCommands.map((name) => ({
    name,
    contractId: contractsByCommand.get(name)!.id,
    status: name === 'bash' ? 'partial' : name === 'git' ? 'adapter' : 'native',
    runtime: 'lifo',
    execution: nativeExecution(name),
    exitCodeContract: name === 'bash' ? '0 when the supported script completes; non-zero on unsupported syntax' : '0 on success, non-zero on invalid input or execution failure',
    ...(name === 'bash' ? { limitations: ['Succinix shell: bash-compatible userland subset', 'Here-documents are unsupported'] } : {}),
    ...(name === 'git' ? { limitations: ['HTTPS/isomorphic-git workflow; SSH transport is unsupported'] } : {}),
  }));
}

export function deniedCommandCapability(name: string): UserlandCommandCapability {
  const contract = deniedContractsByCommand.get(name) ?? contractForDenylistedCommand(name);
  return {
    name,
    contractId: contract.id,
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
