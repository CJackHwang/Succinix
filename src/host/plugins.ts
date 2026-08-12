// Static in-memory plugin tree for the Succinix host app.
import enginePlugin from '@succinix/engine';
import type { SuccinixConfig } from '@succinix/engine';
import containerPlugin from './plugins/container.js';
import commandsPlugin from './plugins/commands.js';
import devhooksPlugin from './plugins/devhooks.js';
import selftestPlugin from './plugins/selftest.js';
import snapshotPlugin from './plugins/snapshot.js';
import terminalPlugin from './plugins/terminal.js';
import watchdogPlugin from './plugins/watchdog.js';

export const engineConfig: SuccinixConfig = {};

export const enginePluginEntry = enginePlugin;

export const appPlugins = [
  terminalPlugin,
  commandsPlugin,
  snapshotPlugin,
  watchdogPlugin,
  selftestPlugin,
  devhooksPlugin,
  containerPlugin,
] as const;
