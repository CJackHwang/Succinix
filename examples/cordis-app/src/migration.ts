// Runnable 0.4.0 -> 0.5.0 migration surface example.
import { Context } from 'cordis';
import enginePlugin, {
  type SuccinixConfig,
  type SuccinixService,
} from '@succinix/engine';

export interface MigrationSurfaceResult {
  ok: boolean;
  detail: string;
}

function hasSurfaceMember(service: object, key: string): boolean {
  return (
    Object.getOwnPropertyDescriptor(service, key) !== undefined ||
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), key) !== undefined
  );
}

export async function runMigrationSurface(storeKey: string): Promise<MigrationSurfaceResult> {
  const config: SuccinixConfig = {
    hostJsUrl: '/engine/host.js',
    lifoCoreUrl: '/engine/lifo-core.js',
    pythonAssetsUrl: '/pyodide/',
    container: { mode: 'external' },
    defaultInstance: {
      instanceId: 'migration-demo',
      persistence: { dbName: 'cordis-app-contract', storeKey },
    },
    terminal: { timeoutMs: 120000, bootGate: false },
    lifecycle: { disposeMode: 'soft', flushOnPageHide: false },
  };
  const ctx = new Context();
  const fiber = ctx.plugin(enginePlugin, config);
  await fiber;
  try {
    const service = ctx.succinix as SuccinixService;
    const required = [
      'executor',
      'terminal',
      'snapshot',
      'persist',
      'workspace',
      'ports',
      'services',
      'capabilities',
      'instance',
      'container',
    ];
    const missing = required.filter((key) => !hasSurfaceMember(service, key));
    const ok =
      enginePlugin.name === 'succinix' &&
      typeof enginePlugin.apply === 'function' &&
      !!enginePlugin.Config &&
      missing.length === 0 &&
      typeof service.ensureInstance === 'function' &&
      typeof service.onServerReady === 'function' &&
      typeof service.onServerClosed === 'function' &&
      typeof service.terminal.create === 'function';
    return {
      ok,
      detail: ok ? 'migration surface mapped' : `missing members: ${missing.join(', ')}`,
    };
  } finally {
    await fiber.dispose();
  }
}
