// App-level boot helpers shared by the Cordis host assembly.
import type { WebContainer } from '@webcontainer/api';
import type {
  TerminalClient,
  TerminalBoot,
} from '@succinix/engine';
import { DEFAULT_INSTANCE_ID, userHomePath } from '@succinix/engine';
import type { AppBootStepsContext } from '../boot-steps.js';
import type { BootUI } from '../boot-ui.js';
import { log } from '../log.js';
import { SUCCINIX_VERSION } from '../version.js';

export interface InstanceRequest {
  id: string | null;
  userMode: boolean;
  demo: boolean;
}

// ?user=<id> and ?instance=<id> share the same demo field; ?user additionally
// enables per-user home and prompt semantics. default stays on the single-user path.
export function resolveInstanceRequest(params: URLSearchParams): InstanceRequest {
  const userId = params.get('user');
  const instanceId = params.get('instance');
  const id = userId ?? instanceId;
  const demo = Boolean(id) && id !== DEFAULT_INSTANCE_ID;
  return {
    id: demo ? (id as string) : null,
    userMode: demo && userId !== null && userId !== '',
    demo,
  };
}

export function makeAppBoot(ui: BootUI, opts: { testMode?: boolean } = {}): TerminalBoot {
  const testMode = opts.testMode ?? false;
  return {
    testMode,
    ok: (msg) => {
      ui.log(`[  OK  ] ${msg ?? 'ok'}`, 'ok');
      void log('BOOT', msg ?? 'ok');
    },
    note: (msg) => {
      ui.log(`[ .... ] ${msg ?? 'note'}`, 'note');
      void log('BOOT', msg ?? 'note');
    },
    failStep: (msg) => {
      ui.log(`[ FAIL ] ${msg ?? 'fail'}`, 'fail');
      void log('BOOT', msg ?? 'fail');
    },
    noteOnly: (msg) => ui.log(`[ .... ] ${msg}`, 'note'),
    boot: async () => null,
  };
}

export interface AppStepsParams {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  instanceId: string;
  userMode?: boolean;
  skipHostReady?: boolean;
}

export function makeAppStepsContext(params: AppStepsParams): AppBootStepsContext {
  return {
    wc: params.wc,
    client: params.client,
    ports: params.ports,
    instanceId: params.instanceId,
    userHome: params.userMode ? userHomePath(params.instanceId) : undefined,
    skipHostReady: params.skipHostReady ?? true,
  };
}

export const WELCOME_BANNER =
  `Succinix ${SUCCINIX_VERSION} — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor\n` +
  `Type 'help' to see available commands.`;
