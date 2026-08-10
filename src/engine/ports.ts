// 页面级端口事件分发（D2）：WebContainer 的 server-ready / port(close) 事件只带
// (port, url)，无实例归属。同页多实例共享单 host（单 host 不变量）时，若每个执行器
// 各自 wc.on(...) 注册，第二个实例永远收不到事件（WeakSet 去重后只剩首个回调）。
// 本模块把「wc 事件绑定」与「实例订阅」解耦：
//   1. 页面级维护一份 ready registry（Map<port, url>，事件到达即登记，与归属无关）；
//   2. 实例按 instanceId 订阅钩子（重复订阅覆盖，防重试叠加；退订防泄漏）；
//   3. 无法归属的端口只留在页面级，不进任何实例视图（实例视图按期望端口过滤，
//      见 src/instance/ports.ts 的 InstancePortRegistry.portsFor）。
// 引擎层自包含：不 import 应用/实例层（归属过滤由订阅方自行决定）。
import type { WebContainer } from '@webcontainer/api';

export interface PortEventHooks {
  onServerReady?: (port: number, url: string) => void;
  onServerClosed?: (port: number) => void;
}

export class PagePortRegistry {
  private ready = new Map<number, string>();
  private hooksByInstance = new Map<string, PortEventHooks>();
  private bound = new WeakSet<WebContainer>();

  /** 页面级就绪端口源（server-ready 到达即登记；无归属/待归属端口都在这里）。 */
  readyPorts(): Map<number, string> {
    return this.ready;
  }

  /** 订阅/替换某实例的端口事件钩子。同实例重复订阅 = 覆盖（R3.2 重试不叠加）；
   *  返回退订函数（幂等，仅当钩子仍是本次注册的那份时生效）。 */
  subscribe(instanceId: string, hooks: PortEventHooks): () => void {
    this.hooksByInstance.set(instanceId, hooks);
    return () => {
      if (this.hooksByInstance.get(instanceId) === hooks) this.hooksByInstance.delete(instanceId);
    };
  }

  /** 直接退订某实例（D3：restart/dispose 清实例订阅；与 subscribe 返回的句柄等效）。 */
  unsubscribe(instanceId: string): void {
    this.hooksByInstance.delete(instanceId);
  }

  /** 测试辅助：清空页面级就绪端口与实例订阅（wc 绑定去重保留，不影响单测隔离）。 */
  reset(): void {
    this.ready.clear();
    this.hooksByInstance.clear();
  }

  /** 绑定 wc 的 server-ready / port 事件（同一 wc 只绑一次；重试 bootEngineHost 不叠加监听器）。 */
  bind(wc: WebContainer): void {
    if (this.bound.has(wc)) return;
    this.bound.add(wc);
    wc.on('server-ready', (port, url) => this.dispatchReady(port, url));
    wc.on('port', (port, type) => {
      if (type === 'close') this.dispatchClosed(port);
    });
  }

  private dispatchReady(port: number, url: string): void {
    this.ready.set(port, url);
    for (const hooks of this.hooksByInstance.values()) hooks.onServerReady?.(port, url);
  }

  private dispatchClosed(port: number): void {
    this.ready.delete(port);
    for (const hooks of this.hooksByInstance.values()) hooks.onServerClosed?.(port);
  }
}

// 页面级单例：同页所有 host/executor/实例共享（每个页面上下文一份模块状态）。
export const pagePorts = new PagePortRegistry();
