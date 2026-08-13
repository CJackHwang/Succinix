import { Context, ValidationError } from '@deepseek-ai/cordis';
import { WebContainer } from '@webcontainer/api';

const output = document.getElementById('log') as HTMLPreElement;
let logText = '';
const fiberStateNames = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const;

function log(text: string, kind: 'ok' | 'fail' | 'muted' | 'plain' = 'plain'): void {
  const cls = kind === 'plain' ? '' : ` ${kind}`;
  logText += `<span class="${cls}">${text}</span>\n`;
  output.innerHTML = logText;
}

function schema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'cordis-poc',
      validate(value: unknown) {
        if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
          return { issues: [{ message: 'config.ok must be a boolean' }] };
        }
        return { value };
      },
    },
  };
}

async function lifecycle(): Promise<void> {
  const ctx = new Context();

  const service = {
    fs: {
      sandboxMode: 'workspace-write',
      resolve: async () => ({ targetKey: '/workspace', displayPath: '/workspace' }),
    },
    sandbox: {
      confine: () => ({ argv: ['succinix-sandbox'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }),
    },
    terminals: {
      listBackends: () => ['fake'],
    },
    sessionPersistence: {
      supportsRawArtifacts: true,
      list: async () => [],
    },
  };
  let consumerValue: Record<string, unknown> | null = null;
  const provider = {
    name: 'dsh-poc-provider',
    apply(ctx: Context) {
      ctx.provide('fs', service.fs);
      ctx.provide('sandbox', service.sandbox);
      ctx.provide('terminals', service.terminals);
      ctx.provide('sessionPersistence', service.sessionPersistence);
    },
  };
  const consumer = {
    name: 'dsh-consumer',
    inject: ['fs', 'sandbox', 'terminals', 'sessionPersistence'],
    apply(ctx: Context) {
      consumerValue = { fs: ctx.fs, sandbox: ctx.sandbox, terminals: ctx.terminals, persistence: ctx.sessionPersistence };
    },
  };

  const providerFiber = ctx.plugin(provider);
  await providerFiber;
  const consumerFiber = ctx.plugin(consumer);
  await consumerFiber;
  log(`provider state: ${fiberStateNames[providerFiber.state]}`, 'ok');
  log(`consumer state: ${fiberStateNames[consumerFiber.state]}`, 'ok');
  const injectedOk =
    consumerValue?.fs === service.fs &&
    consumerValue.sandbox === service.sandbox &&
    consumerValue.terminals === service.terminals &&
    consumerValue.persistence === service.sessionPersistence;
  log(`consumer injected dsh services: ${injectedOk ? 'ok' : 'mismatch'}`, 'ok');

  const configFiber = ctx.plugin({ name: 'config-poc', Config: schema(), apply(_ctx: Context, config: { ok: boolean }) { log(`config validated: ${JSON.stringify(config)}`, 'ok'); } }, { ok: true });
  await configFiber;
  try {
    const badFiber = ctx.plugin({ name: 'config-bad', Config: schema(), apply() {} }, { ok: 'no' });
    await badFiber;
    log('config validation: expected rejection', 'fail');
  } catch (error) {
    log(`config validation rejected: ${error instanceof ValidationError ? 'ValidationError' : String(error)}`, 'ok');
  }

  await providerFiber.dispose();
  await consumerFiber.dispose();
  log(`provider after dispose: ${fiberStateNames[providerFiber.state]}`, 'ok');
  log(`consumer after dispose: ${fiberStateNames[consumerFiber.state]}`, 'ok');
  const keysGone = ['fs', 'sandbox', 'terminals', 'sessionPersistence'].every((key) => ctx.get(key, false) === undefined);
  log(`service lookup after provider dispose: ${keysGone ? 'unavailable (ok)' : 'available (wrong)'}`, 'ok');
}

async function webcontainer(): Promise<void> {
  const wc = await WebContainer.boot();
  const proc = await wc.spawn('node', ['-e', 'console.log("poc:node-ok")']);
  const reader = proc.output.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const code = await proc.exit;
  log(`WebContainer node exit: ${code}`, 'ok');
  log(`WebContainer node output: ${chunks.join('').trim()}`, 'ok');
}

async function main(): Promise<void> {
  try {
    await lifecycle();
    log('dsh core lifecycle: PASS', 'ok');
  } catch (error) {
    log(`dsh core lifecycle: FAIL (${String(error)})`, 'fail');
    return;
  }
  try {
    await webcontainer();
    log('WebContainer + Cordis coexistence: PASS', 'ok');
  } catch (error) {
    log(`WebContainer + Cordis coexistence: FAIL (${String(error)})`, 'fail');
  }
}

void main();
