// 每实例端口视图（M4）：WebContainer 的 server-ready/close 事件只带 (port, url)，无实例归属。
// 同页多实例靠"实例期望端口集合"归属：实例启动带端口的服务/db 时 expect(port)（来自本实例
// spawn 的端口），端口就绪后该实例的 ports 视图才包含它；无法归属的端口只进页面级 registry
// （不进入任何实例视图，如实标注）。双 tab 各 host 事件天然隔离，本机制只在同页路径生效。
import { DEFAULT_INSTANCE_ID } from './paths.js';

export class InstancePortRegistry {
  private expected = new Map<string, Set<number>>();

  /** 实例期望某端口（服务/db 启动成功后登记）。 */
  expect(instanceId: string, port: number): void {
    let set = this.expected.get(instanceId);
    if (!set) {
      set = new Set();
      this.expected.set(instanceId, set);
    }
    set.add(port);
  }

  /** 释放期望（服务/db 停止）。 */
  release(instanceId: string, port: number): void {
    this.expected.get(instanceId)?.delete(port);
  }

  /** 端口是否已被**其他**实例期望（同页端口冲突检测；自身实例不算冲突）。 */
  hasConflict(instanceId: string, port: number): string | null {
    for (const [id, set] of this.expected) {
      if (id !== instanceId && set.has(port)) return id;
    }
    return null;
  }

  /** 实例端口视图 = 期望集合 ∩ 页面级就绪端口；默认实例 = 页面级全部（现状行为全等）。 */
  portsFor(instanceId: string, pagePorts: Map<number, string>): Map<number, string> {
    if (instanceId === DEFAULT_INSTANCE_ID) return pagePorts;
    const view = new Map<number, string>();
    for (const port of this.expected.get(instanceId) ?? []) {
      const url = pagePorts.get(port);
      if (url !== undefined) view.set(port, url);
    }
    return view;
  }

  /** 测试辅助：实例期望端口集合快照。 */
  expectedFor(instanceId: string): number[] {
    return [...(this.expected.get(instanceId) ?? [])].sort((a, b) => a - b);
  }
}

// 页面级单例（跨命令共享：ports 命令 / db / service 各自登记与查询）。
export const instancePorts = new InstancePortRegistry();
