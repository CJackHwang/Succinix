import { describe, expect, it } from 'vitest';
import { Sandbox } from '@lifo-sh/core';
import {
  USERLAND_CAPABILITY_CONTRACTS,
  USERLAND_DENY_EXIT_CODE,
  USERLAND_DENYLIST,
  USERLAND_DENYLIST_CONTRACTS,
  defaultUserlandCapabilities,
  deniedCommandCapability,
  denylistedCommandResult,
} from '../src/userland/profile.js';
import { createUserlandRegistry } from '../src/userland/registry.js';

describe('userland capability contracts', () => {
  it('assigns every published capability one unique, data-driven contract', () => {
    const capabilities = defaultUserlandCapabilities();
    const contractsByCommand = new Map(USERLAND_CAPABILITY_CONTRACTS.map((contract) => [contract.command, contract]));
    const ids = USERLAND_CAPABILITY_CONTRACTS.map((contract) => contract.id);
    const testIds = USERLAND_CAPABILITY_CONTRACTS.map((contract) => contract.testId);

    expect(USERLAND_CAPABILITY_CONTRACTS).toHaveLength(capabilities.length);
    expect(new Set(ids)).toHaveLength(ids.length);
    expect(new Set(testIds)).toHaveLength(testIds.length);

    for (const capability of capabilities) {
      const contract = contractsByCommand.get(capability.name);
      expect(contract, capability.name).toBeDefined();
      expect(capability.contractId).toBe(contract!.id);
      expect(contract!.testId).toBe(`userland.contract.${contract!.id}`);
      expect(contract!.execution).toBe(capability.execution);
      expect(contract!.stdin).toBeDefined();
      expect(contract!.pipe).toBeDefined();
      expect(contract!.glob).toBeDefined();
      expect(contract!.relativePath).toBeDefined();
      expect(contract!.help).toBeDefined();
      expect(contract!.invalidArgs).toBeDefined();
      expect(contract!.exitCode).toBeDefined();
      expect(contract!.maxOutputBytes).toBeGreaterThan(0);
      expect(contract!.binary).toBeDefined();
    }
  });

  it('preserves capability contract IDs through the public registry snapshot', () => {
    const snapshot = createUserlandRegistry().capabilities();
    const contractIds = snapshot.commands.map((command) => command.contractId);

    expect(contractIds).not.toContain(undefined);
    expect(new Set(contractIds)).toHaveLength(contractIds.length);
    expect(snapshot.commands.map((command) => command.contractId)).toEqual(
      expect.arrayContaining(USERLAND_CAPABILITY_CONTRACTS.map((contract) => contract.id)),
    );
  });

  it('records the script and interactive command boundaries without overstating stdin support', () => {
    const contracts = new Map(USERLAND_CAPABILITY_CONTRACTS.map((contract) => [contract.command, contract]));

    expect(contracts.get('sh')).toMatchObject({
      stdin: 'shell-stream-where-supported',
      pipe: 'shell-composition',
      glob: 'shell-expanded',
      relativePath: 'cwd-relative-where-applicable',
      help: 'usage-only',
      invalidArgs: 'usage-exit-2',
      exitCode: 'script-exit-propagated',
      binary: 'byte-stream-where-applicable',
    });
    expect(contracts.get('bash')).toMatchObject({
      invalidArgs: 'bash-banner-or-usage-exit-2',
      exitCode: 'zero-banner-or-script-exit-propagated',
    });
    expect(contracts.get('vi')).toMatchObject({ stdin: 'interactive-raw', execution: 'interactive' });
    expect(contracts.get('cd')).toMatchObject({ stdin: 'not-applicable', relativePath: 'cwd-relative-where-applicable' });
  });

  it('keeps every denylisted command out of the capability table and fail-closed', () => {
    const capabilities = defaultUserlandCapabilities();
    const contractsByCommand = new Map(USERLAND_DENYLIST_CONTRACTS.map((contract) => [contract.command, contract]));

    for (const name of USERLAND_DENYLIST) {
      const contract = contractsByCommand.get(name);
      expect(capabilities.some((capability) => capability.name === name), name).toBe(false);
      expect(contract, name).toBeDefined();
      expect(contract!.testId).toBe(`userland.contract.${contract!.id}`);
      expect(deniedCommandCapability(name)).toMatchObject({
        name,
        contractId: contract!.id,
        status: 'unsupported',
        exitCodeContract: `${USERLAND_DENY_EXIT_CODE} (command unavailable in this environment)`,
      });
      expect(denylistedCommandResult(name)).toMatchObject({ ok: false, exitCode: USERLAND_DENY_EXIT_CODE });
    }
  });
});

describe('Lifo shell contract scenarios', () => {
  it('supports stdin, pipes, redirects, glob expansion, variables, relative paths, binary data, and exit codes', async () => {
    const sandbox = await Sandbox.create({ cwd: '/workspace' });
    sandbox.kernel.vfs.mkdir('/workspace', { recursive: true });

    const combined = await sandbox.commands.run([
      'mkdir -p contract-glob',
      'touch contract-glob/item.txt',
      'printf "alpha\\nbeta\\n" | grep beta > relative.txt',
      'NAME=world; printf "hello %s\\n" "$NAME" >> relative.txt',
      'printf "%s\\n" contract-glob/*.txt >> relative.txt',
      'cat relative.txt',
    ].join(' && '));
    expect(combined).toMatchObject({ exitCode: 0, stderr: '' });
    expect(combined.stdout).toBe('beta\nhello world\ncontract-glob/item.txt\n');

    const stdin = await sandbox.commands.run('grep beta', { stdin: 'alpha\nbeta\n' });
    expect(stdin).toMatchObject({ exitCode: 0, stdout: 'beta\n', stderr: '' });

    const binary = await sandbox.commands.run('printf "SABJ\\n" | base64 -d - > bytes.bin');
    expect(binary).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
    expect([...sandbox.kernel.vfs.readFile('/workspace/bytes.bin')]).toEqual([72, 0, 73]);

    const failed = await sandbox.commands.run('false');
    expect(failed).toMatchObject({ exitCode: 1, stdout: '', stderr: '' });
  });
});
