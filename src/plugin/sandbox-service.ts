// invariant: dsh ctx.sandbox provider as an execution-world confinement seam.
// confine is synchronous and fail-closed; real node subprocesses are never
// wrapped, and danger-full-access is not accepted as a confined policy.
import { canonicalExecutionPath } from './fs-service.js';
import {
  SandboxUnavailableError,
  type ConfinedArgv,
  type ConfinedSandboxMode,
  type SandboxMode,
  type RunnerFailureRule,
  type SandboxExecutionPolicy,
  type SandboxPolicy,
  type SandboxProvider,
} from './dsh-types.js';

const LIFO_DENIAL_SIGNATURES = [
  'permission denied',
  'read-only file system',
  'EACCES',
  'EROFS',
] as const;

const LIFO_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [
  {
    allowedExitCodes: [126, 127],
    fatalSignatures: ['command not found', 'sandbox unavailable'],
    informationalLines: [''],
  },
];

export interface SandboxServiceDeps {
  available: boolean | (() => boolean);
  workspaceRoot?: string;
}

export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode === 'read-only') return [];
  const root = canonicalExecutionPath(policy.workspaceRoot);
  return root === '/workspace' ? ['/workspace', '/tmp'] : [root, '/tmp'];
}

export class SuccinixSandboxService implements SandboxProvider {
  private readonly available: boolean | (() => boolean);
  private readonly defaultWorkspaceRoot: string;

  constructor(private readonly deps: SandboxServiceDeps) {
    this.available = deps.available;
    this.defaultWorkspaceRoot = canonicalExecutionPath(deps.workspaceRoot ?? '/workspace');
  }

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const available = typeof this.available === 'function' ? this.available() : this.available;
    if (!available) {
      throw new SandboxUnavailableError(policy.mode, 'host runtime is not ready');
    }
    if ((policy as { readonly mode: SandboxMode }).mode === 'danger-full-access') {
      throw new SandboxUnavailableError(policy.mode as ConfinedSandboxMode, 'danger-full-access is not a confined policy');
    }
    if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
      throw new SandboxUnavailableError(policy.mode, 'empty argv');
    }
    if (/^(node|npm|npx)$/.test(argv[0])) {
      throw new SandboxUnavailableError(policy.mode, `real ${argv[0]} subprocesses cannot be fenced per call`);
    }
    const root = canonicalExecutionPath(policy.workspaceRoot ?? this.defaultWorkspaceRoot);
    return {
      argv: ['succinix-sandbox', '--mode', policy.mode, '--workspace', root, ...argv],
      enforcement: 'full',
      denialSignatures: [...LIFO_DENIAL_SIGNATURES],
      runnerFailureRules: LIFO_RUNNER_FAILURE_RULES.map((rule) => ({ ...rule, allowedExitCodes: [...(rule.allowedExitCodes ?? [])] })),
    };
  }
}
