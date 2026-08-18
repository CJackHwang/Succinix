import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Command } from '@lifo-sh/core';
import { PROCESS_TERMINATION_GRACE_MS, killProcess, registerProcess } from '../host-procs.js';
import { mergedEnv } from './config.js';
import { requestBrowserControl } from './control.js';
import {
  createSystemctlCommand,
  SERVICE_ENABLEMENT_ROOT,
  serviceCommandFromUnitText,
  serviceEnablementMarker,
} from './service-world.js';
import { SERVICE_TEMPLATES } from '../../services/templates.js';

const servicePackageInstalls = new Map<string, Promise<void>>();
const PORT_CONTROL_TIMEOUT_MS = 2_000;

export interface ServiceCommandBridgeOptions {
  /** Translate Lifo-local service PIDs before they leave the execution world. */
  projectPid?: (localPid: number, name: string) => number | undefined;
}

/**
 * 将 Lifo ServiceManager 接到浏览器独有的端口、快照控制面。命令本身仍在
 * WebContainer 内执行；这里不保存任何服务或端口状态。
 */
export function createServiceCommandBridge(
  serviceManager: Parameters<typeof createSystemctlCommand>[0],
  instanceId: string,
  requestControl: typeof requestBrowserControl = requestBrowserControl,
  options: ServiceCommandBridgeOptions = {},
): Command {
  const servicePorts = new Map<string, number>();
  const expectedReadyGenerations = new Map<string, number>();
  const waitForServiceReady = async (name: string, ctx: Parameters<Command>[0]): Promise<boolean> => {
    if (!serviceManager) return false;
    const port = servicePort(name, ctx) ?? null;
    if (port === null) return true;
    const deadline = Date.now() + 60000;
    const activeGraceDeadline = Date.now() + 1500;
    const expectedGeneration = expectedReadyGenerations.get(name);
    while (Date.now() < deadline) {
      if (expectedGeneration !== undefined) {
        try {
          const result = await requestControl('ports', instanceId, { timeoutMs: PORT_CONTROL_TIMEOUT_MS }) as {
            ports?: Array<{ port?: unknown; url?: unknown; generation?: unknown }>;
          };
          if ((result.ports ?? []).some((entry) =>
            entry.port === port &&
            typeof entry.url === 'string' &&
            typeof entry.generation === 'number' &&
            Number.isInteger(entry.generation) &&
            entry.generation > expectedGeneration,
          )) return true;
        } catch {
          // 已连接的控制桥短暂读取失败时，保留本轮代次门槛并继续等待。
        }
      } else {
        // SDK 嵌入可不带页面控制桥。此时 Lifo ServiceManager 是唯一可用的
        // 生命周期事实源；一小段宽限后允许其 active 状态完成启动。
        const active = serviceManager.status(name).active;
        if (Date.now() >= activeGraceDeadline && (active === 'active' || active === 'activating')) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  };
  const ensureServicePackage = async (name: string, ctx: Parameters<Command>[0]): Promise<void> => {
    const unit = `/etc/systemd/system/${name}.service`;
    const command = ctx.vfs.exists(unit) ? serviceCommandFromUnitText(ctx.vfs.readFileString(unit)) ?? '' : '';
    const match = command.match(/^npx\s+(\S+)/);
    if (!match || fs.existsSync(path.join(process.cwd(), 'node_modules', match[1]))) return;
    const packageName = match[1];
    let install = servicePackageInstalls.get(packageName);
    if (!install) {
      install = new Promise<void>((resolve, reject) => {
        const child = spawn('npm', ['install', '--no-save', packageName], {
          cwd: process.cwd(),
          env: mergedEnv(instanceId),
          stdio: 'ignore',
        });
        const pid = registerProcess(`npm install --no-save ${packageName}`, child, process.cwd(), instanceId, {
          runtime: 'node',
          internal: true,
        });
        const timer = setTimeout(() => {
          killProcess(pid, PROCESS_TERMINATION_GRACE_MS, 'SIGTERM');
          reject(new Error(`package install timed out: ${packageName}`));
        }, 120000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(path.join(process.cwd(), 'node_modules', packageName))) resolve();
          else reject(new Error(`package install failed: ${packageName} (exit=${code ?? -1})`));
        });
      }).finally(() => servicePackageInstalls.delete(packageName));
      servicePackageInstalls.set(packageName, install);
    }
    await install;
  };
  const servicePort = (name: string, ctx: Parameters<Command>[0]): number | undefined => {
    const templatePort = SERVICE_TEMPLATES.find((entry) => entry.name === name)?.port;
    if (templatePort !== undefined && templatePort !== null) return templatePort;
    const unit = `/etc/systemd/system/${name}.service`;
    if (!ctx.vfs.exists(unit)) return undefined;
    const text = ctx.vfs.readFileString(unit);
    const match = /(?:^# SuccinixPort=|--port(?:\s+|=)|\.listen\(\s*)(\d{1,5})\b/m.exec(text);
    const port = Number(match?.[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  };
  const expectServicePort = async (name: string, ctx: Parameters<Command>[0]): Promise<void> => {
    await ensureServicePackage(name, ctx);
    const port = servicePort(name, ctx);
    if (port === undefined) {
      expectedReadyGenerations.delete(name);
      return;
    }
    servicePorts.set(name, port);
    // 浏览器控制桥在纯 SDK 嵌入中是可选的。Lifo ServiceManager 负责服务生命周期，
    // 缺失页面桥不得把健康的执行世界服务变成 30 秒启动超时。
    try {
      const result = await requestControl('ports', instanceId, { timeoutMs: PORT_CONTROL_TIMEOUT_MS, args: { mode: 'expect', port } }) as { generation?: unknown };
      if (typeof result.generation === 'number' && Number.isInteger(result.generation) && result.generation >= 0) {
        expectedReadyGenerations.set(name, result.generation);
      } else {
        expectedReadyGenerations.delete(name);
      }
    } catch {
      expectedReadyGenerations.delete(name);
      // SDK 服务客户端会自行登记实例端口期望。
    }
  };
  const releaseServicePort = async (name: string): Promise<void> => {
    const port = servicePorts.get(name);
    if (port === undefined) return;
    servicePorts.delete(name);
    expectedReadyGenerations.delete(name);
    try {
      await requestControl('ports', instanceId, { timeoutMs: PORT_CONTROL_TIMEOUT_MS, args: { mode: 'release', port } });
    } catch {
      // 浏览器侧清理尽力而为；执行世界服务已经停止。
    }
  };
  const persistServiceEnablement = async (name: string, enabled: boolean, ctx: Parameters<Command>[0]): Promise<void> => {
    const marker = serviceEnablementMarker(name);
    if (enabled) {
      ctx.vfs.mkdir(SERVICE_ENABLEMENT_ROOT, { recursive: true });
      ctx.vfs.writeFile(marker, 'enabled\n');
    } else if (ctx.vfs.exists(marker)) {
      ctx.vfs.unlink(marker);
    }
    try {
      await requestControl('snapshot', instanceId, { timeoutMs: 500, args: { mode: 'save' } });
    } catch {
      // SDK 嵌入可经自己的快照服务显式持久化。
    }
  };
  return createSystemctlCommand(serviceManager, {
    beforeStart: expectServicePort,
    afterStop: releaseServicePort,
    waitForReady: waitForServiceReady,
    onEnablementChange: persistServiceEnablement,
    projectPid: options.projectPid,
  });
}
