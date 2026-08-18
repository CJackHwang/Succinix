// Runnable 0.4.0/0.5.0 -> 0.7.0 migration surface example.
import { Context } from '@deepseek-ai/cordis';
import enginePlugin, {
  type SuccinixConfig,
} from '@succinix/engine';

export interface MigrationSurfaceResult {
  ok: boolean;
  detail: string;
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
    lifecycle: { disposeMode: 'soft', flushOnPageHide: false },
  };
  const ctx = new Context();
  const fiber = ctx.plugin(enginePlugin, config);
  await fiber;
  try {
    const host = ctx.get('succinix', false) as
      | { boot: unknown; attach: unknown; ensureInstance: unknown }
      | undefined;
    const fs = ctx.get('fs', false) as { sandboxMode?: string } | undefined;
    const sandbox = ctx.get('sandbox', false) as { confine?: unknown } | undefined;
    const terminals = ctx.get('terminals', false) as { listBackends?: () => string[] } | undefined;
    const persistence = ctx.get('sessionPersistence', false) as { supportsRawArtifacts?: boolean } | undefined;
    const ok =
      enginePlugin.name === 'succinix' &&
      typeof enginePlugin.apply === 'function' &&
      !!enginePlugin.Config &&
      !!host &&
      typeof host.boot === 'function' &&
      typeof host.attach === 'function' &&
      typeof host.ensureInstance === 'function' &&
      fs?.sandboxMode === 'workspace-write' &&
      typeof sandbox?.confine === 'function' &&
      Array.isArray(terminals?.listBackends?.()) &&
      persistence?.supportsRawArtifacts === true;
    return {
      ok,
      detail: ok ? 'Cordis migration surface mapped' : 'Cordis services are not fully mapped',
    };
  } finally {
    await fiber.dispose();
  }
}
