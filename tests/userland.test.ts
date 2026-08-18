import { describe, expect, it } from 'vitest';
import {
  USERLAND_DENY_EXIT_CODE,
  USERLAND_PROFILE,
  type UserlandCommandDefinition,
  createUserlandRegistry,
  denylistedCommandResult,
  isDenylistedCommand,
} from '../src/userland/index.js';
import {
  applyUserlandRegistryToSandbox,
  createSandboxUserlandRegistry,
} from '../src/engine/host/userland.js';
import { createSuccinixUserlandService } from '../src/plugin/userland-service.js';
import { USERLAND_REGISTRY_PATH } from '../src/userland/index.js';

function command(name: string, source: UserlandCommandDefinition['source']): UserlandCommandDefinition {
  return { name, status: 'native', runtime: 'lifo', execution: 'both', source };
}

describe('userland compatibility profile', () => {
  it('publishes the stable profile and the explicit kernel-dependent denylist', () => {
    const registry = createUserlandRegistry();
    const snapshot = registry.capabilities();
    expect(snapshot.profile).toBe(USERLAND_PROFILE);
    expect(snapshot.commands.length).toBeGreaterThanOrEqual(40);
    expect(snapshot.denylist).toContain('chmod');
    expect(snapshot.commands.find((command) => command.name === 'bash')?.limitations).toContain('Here-documents are unsupported');
    expect(isDenylistedCommand('/usr/bin/chmod')).toBe(true);
    expect(denylistedCommandResult('chmod')).toEqual({ ok: false, exitCode: USERLAND_DENY_EXIT_CODE, stderr: 'succinix: chmod: command unavailable in this environment\n' });
  });

  it('registers execution-world extensions and releases them exactly once', () => {
    const registry = createUserlandRegistry();
    const release = registry.registerCommand(command('hello-userland', { kind: 'shell', command: 'echo hello' }));
    expect(registry.listCommands().some((command) => command.name === 'hello-userland')).toBe(true);
    release();
    release();
    expect(registry.listCommands().some((command) => command.name === 'hello-userland')).toBe(false);
    expect(() => registry.registerCommand(command('sudo', { kind: 'shell', command: 'echo no' }))).toThrow(/denylisted/);
    expect(() => registry.registerCommand(command('broken', { kind: 'browser-function' } as never))).toThrow(/unsupported command source/);
  });

  it('applies structured commands to the Lifo command registry and unregisters them on release', async () => {
    const registry = createUserlandRegistry();
    registry.registerCommand(command('hello-userland', { kind: 'shell', command: 'echo hello' }));
    const registered = new Map<string, (ctx: never) => Promise<number>>();
    const unregistered: string[] = [];
    const release = applyUserlandRegistryToSandbox({
      commands: { register: (name, handler) => { registered.set(name, handler as never); } },
      shell: { getRegistry: () => ({ unregister: (name: string) => { unregistered.push(name); } }) },
    }, registry);

    expect(registered.has('hello-userland')).toBe(true);
    release();
    release();
    expect(unregistered).toEqual(['hello-userland']);
  });

  it('runs third-party interactive commands through public CommandContext stdin and raw mode', async () => {
    const registry = createUserlandRegistry();
    registry.registerCommand({ ...command('raw-probe', { kind: 'builtin', id: 'raw-stdin-probe' }), execution: 'interactive' });
    let handler: ((ctx: never) => Promise<number>) | undefined;
    applyUserlandRegistryToSandbox({
      commands: { register: (_name, registered) => { handler = registered as never; } },
      shell: { getRegistry: () => ({ unregister: () => undefined }) },
    }, registry);

    const output: string[] = [];
    const modes: boolean[] = [];
    const code = await handler!({
      args: [],
      env: {},
      cwd: '/workspace',
      stdout: { write: (text: string) => output.push(text) },
      stderr: { write: (text: string) => output.push(text) },
      signal: new AbortController().signal,
      stdin: { read: async () => 'typed', readAll: async () => 'typed' },
      setRawMode: (enabled: boolean) => { modes.push(enabled); },
    } as never);

    expect(code).toBe(0);
    expect(output.join('')).toBe('typed\n');
    expect(modes).toEqual([true, false]);
  });

  it('serializes third-party declarations and restores them into a new sandbox registry', () => {
    const registry = createUserlandRegistry();
    registry.registerCommand(command('hello-userland', { kind: 'shell', command: 'echo hello' }));
    registry.registerPackage({ name: 'lifo-demo', source: 'lifo', version: '1.2.3', integrity: `sha256-${'a'.repeat(64)}` });
    registry.registerServiceTemplate({
      name: 'userland-worker',
      runtime: 'node',
      command: 'node worker.js',
      description: 'Userland worker',
    });

    const restored = createSandboxUserlandRegistry(registry.snapshot());

    expect(restored.listCommandDefinitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hello-userland', source: { kind: 'shell', command: 'echo hello' } }),
    ]));
    expect(restored.listPackages()).toEqual([
      expect.objectContaining({ name: 'lifo-demo', source: 'lifo', version: '1.2.3', integrity: `sha256-${'a'.repeat(64)}` }),
    ]);
    expect(restored.listServiceTemplates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'userland-worker', command: 'node worker.js' }),
    ]));
  });

  it('rejects third-party package registrations without a payload digest', () => {
    const registry = createUserlandRegistry();
    expect(() => registry.registerPackage({ name: 'unchecked', source: 'npm' } as never))
      .toThrow('package.integrity must be a sha256 payload digest');
  });

  it('publishes structured registrations through the execution-world mailbox', async () => {
    const files = new Map<string, string>();
    const userland = createSuccinixUserlandService({
      getFs: () => ({
        mkdir: async () => undefined,
        writeFile: async (path, content) => { files.set(path, content); },
        rename: async (from, to) => { files.set(to, files.get(from) ?? ''); files.delete(from); },
      }),
    });
    userland.registerCommand(command('mailbox-command', { kind: 'shell', command: 'echo mailbox' }));
    await userland.flush();

    const published = JSON.parse(files.get(USERLAND_REGISTRY_PATH) ?? '{}');
    expect(published.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mailbox-command', source: { kind: 'shell', command: 'echo mailbox' } }),
    ]));
  });
});
