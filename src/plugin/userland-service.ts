// invariant: Cordis 注册只发布结构化数据；命令始终由 WebContainer 内的 Lifo 执行。
import {
  createUserlandRegistry,
  writeUserlandRegistrySnapshot,
  type UserlandRegistry,
  type UserlandRegistryFs,
} from '../userland/index.js';

export interface SuccinixUserlandService extends UserlandRegistry {
  /** 等待最新注册表已发布到 WebContainer，再执行依赖它的命令。 */
  flush(): Promise<void>;
}

export interface SuccinixUserlandServiceOptions {
  getFs(): UserlandRegistryFs | null;
}

export function createSuccinixUserlandService(options: SuccinixUserlandServiceOptions): SuccinixUserlandService {
  const registry = createUserlandRegistry();
  let pending = Promise.resolve();

  const publish = (): Promise<void> => {
    pending = pending.catch(() => {}).then(async () => {
      const fs = options.getFs();
      if (fs) await writeUserlandRegistrySnapshot(fs, registry.snapshot());
    });
    return pending;
  };
  const publishLater = (): void => { void publish().catch(() => {}); };
  const withPublish = (register: () => () => void): (() => void) => {
    const release = register();
    publishLater();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      publishLater();
    };
  };

  return {
    listCommands: () => registry.listCommands(),
    listCommandDefinitions: () => registry.listCommandDefinitions(),
    registerCommand: (command) => withPublish(() => registry.registerCommand(command)),
    registerPackage: (source) => withPublish(() => registry.registerPackage(source)),
    registerServiceTemplate: (template) => withPublish(() => registry.registerServiceTemplate(template)),
    capabilities: () => registry.capabilities(),
    listPackages: () => registry.listPackages(),
    listServiceTemplates: () => registry.listServiceTemplates(),
    snapshot: () => registry.snapshot(),
    flush: publish,
  };
}
