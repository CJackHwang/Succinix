// 服务管理共享类型（O8 拆分自 services.ts）。
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';

export interface ServiceDef {
  name: string;
  /** 原始命令模板（可含 ${PORT} 占位符，启动时替换为 preview-port） */
  command: string;
  /** 服务端口（状态展示 + 就绪等待用）；无端口为 null */
  port: number | null;
}

export interface ServiceState {
  def: ServiceDef;
  state: 'running' | 'stopped';
  pid?: number;
  /** 有效端口：会话内启动记录值优先，否则动态解析（命令含 ${PORT} 按 preview-port）；无端口 null */
  effectivePort: number | null;
  /** running 且有端口时的预览 URL */
  url?: string;
}

export interface ServiceContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  /** 实例上下文（M2，additive）：服务定义/自启文件与 settings 按实例解析；缺省 = 默认实例 */
  instanceId?: string;
  /** 状态根前缀覆盖（M5，additive）：缺省 = DM-12 内置前缀 */
  statePrefix?: string;
}

export interface ServiceActionResult {
  ok: boolean;
  message: string;
  pid?: number;
}
