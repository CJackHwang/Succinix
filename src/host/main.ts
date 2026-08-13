// Succinix host app entry: a Cordis Context composed from @succinix/engine and
// the app-level plugins below.
import { Context } from '@deepseek-ai/cordis';
import { appPlugins, engineConfig, enginePluginEntry } from './plugins.js';

async function main(): Promise<void> {
  const ctx = new Context();
  const engineFiber = ctx.plugin(enginePluginEntry, engineConfig);
  const appFibers = appPlugins.map((plugin) => ctx.plugin(plugin));
  await Promise.all([engineFiber, ...appFibers]);

  const container = ctx.get('succinix-app-container') as
    | { start(): Promise<unknown> }
    | undefined;
  if (!container) throw new Error('succinix-app-container is not available');
  await container.start();
}

void main().catch((error) => {
  console.error('[host] startup failed:', error);
});
