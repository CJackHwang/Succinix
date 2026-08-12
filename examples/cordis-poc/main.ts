import { Context, FiberState, ValidationError } from 'cordis';
import LoggerConsole from '@cordisjs/plugin-logger-console';
import MemoryDatabase from '@cordisjs/plugin-database-memory';
import { WebContainer } from '@webcontainer/api';

const output = document.getElementById('log') as HTMLPreElement;
let logText = '';

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
  ctx.plugin(LoggerConsole, { colors: false });
  ctx.plugin(MemoryDatabase);

  const service = { name: 'poc-succinix' };
  let consumerValue: unknown = null;
  const provider = {
    name: 'succinix-poc',
    apply(ctx: Context) {
      ctx.provide('succinix', service);
    },
  };
  const consumer = {
    name: 'succinix-consumer',
    inject: ['succinix'],
    apply(ctx: Context) {
      consumerValue = ctx.succinix;
    },
  };

  const providerFiber = ctx.plugin(provider);
  await providerFiber;
  const consumerFiber = ctx.plugin(consumer);
  await consumerFiber;
  log(`provider state: ${FiberState[providerFiber.state]}`, 'ok');
  log(`consumer state: ${FiberState[consumerFiber.state]}`, 'ok');
  log(`consumer injected service: ${consumerValue === service ? 'ok' : 'mismatch'}`, 'ok');

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
  log(`provider after dispose: ${FiberState[providerFiber.state]}`, 'ok');
  log(`consumer after dispose: ${FiberState[consumerFiber.state]}`, 'ok');
  log(`service lookup after provider dispose: ${ctx.get('succinix', false) === undefined ? 'unavailable (ok)' : 'available (wrong)'}`, 'ok');
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
    log('Cordis core lifecycle: PASS', 'ok');
  } catch (error) {
    log(`Cordis core lifecycle: FAIL (${String(error)})`, 'fail');
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
