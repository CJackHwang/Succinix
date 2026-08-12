// CommandContext：本地命令的统一上下文（浏览器侧命令拦截的入参契约，O1 拆分）。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { PersistContext, SuccinixPluginState, TerminalClient } from '@succinix/engine';

export interface SuccinixPluginSummary {
  name: string;
  fibers: Array<{ state: string }>;
}

export interface CommandContext {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL */
  ports: Map<number, string>;
  term: Terminal;
  /** 字号等布局变更后重建 xterm 视图（main.ts 注入 FitAddon.fit） */
  fit: () => void;
  /** 当前 host 进程句柄（main.ts 的 host 重启路径 kill 用；自检构造的假 context 可缺省） */
  hostProc?: WebContainerProcess;
  /** 实例上下文（M2/M5，additive）：本地命令的状态文件/持久化按实例解析；缺省 = 默认实例 */
  instanceId?: string;
  /** 状态根前缀覆盖（M5，additive）：缺省 = DM-12 内置前缀 */
  statePrefix?: string;
  /** 实例持久化上下文（M2/M5，additive）：snapshot 命令按实例存取；缺省 = 模块级默认实例 */
  persist?: PersistContext;
  /** 用户标识（U1，additive）：?user=<id> 模式注入；缺省 = guest（独立应用现状）。与
   *  instanceId 等价（内部同一字段），此处仅用于 whoami 等身份展示命令 */
  userId?: string;
  /** 实例级重置回调（M4/M5，additive）：多实例模式 reboot = 清该实例状态并重 boot，不刷新宿主页面；
   *  缺省 = 整页刷新（demo 单页单实例路径，Tab 即实例，刷新 = 实例级重置） */
  onInstanceReset?: () => void | Promise<void>;
  /** 实例停止回调（M4/M5，additive）：多实例模式 shutdown = 停当前实例，不动其他实例 */
  onInstanceStop?: () => void | Promise<void>;
  /** 可管理性视图（C4）：succinix status 的数据源 */
  succinixState?: SuccinixPluginState;
  /** 可管理性视图（C4）：succinix plugins 的数据源 */
  succinixPlugins?: SuccinixPluginSummary[];
}
