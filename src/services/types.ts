// 服务管理共享类型（O8 拆分自 services.ts）。
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';

export interface ServiceDef {
  /** 执行世界 ServiceManager 中的 unit 名称。 */
  name: string;
  /** 执行世界保存并执行的命令。 */
  command: string;
  /** 服务端口；无端口为 null。 */
  port: number | null;
}

export interface ServiceState {
  def: ServiceDef;
  state: 'running' | 'stopped';
  pid?: number;
  /** 执行世界报告的服务端口；无端口为 null。 */
  effectivePort: number | null;
  /** running 且有端口时的预览 URL */
  url?: string;
}

export interface ServiceContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  /** 实例上下文；缺省 = 默认实例。 */
  instanceId?: string;
  /** 状态根前缀覆盖（M5，additive）：缺省 = DM-12 内置前缀 */
  statePrefix?: string;
}

export interface ServiceActionResult {
  ok: boolean;
  message: string;
  pid?: number;
  /** 执行世界在动作后确认的服务端口。 */
  port?: number;
}
