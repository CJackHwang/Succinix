// Terminal SDK 共享 UI 接口（D1）：BootUI 是宿主与 boot 编排层之间的最小渲染契约。
// 接口定义下沉到 SDK（build-engine-package 会把 terminal SDK bundle 成自包含产物，
// 应用层 DOM/xterm 实现不得进入包内）；createBootUI（xterm 实现）保留在应用层
// src/boot-ui.ts，从本模块导入接口。

export type LogKind = 'ok' | 'note' | 'skip' | 'fail' | 'info';

export interface BootUI {
  /** 追加一行自检日志到终端（marker 按 kind 着色，其余暖白默认色） */
  log(text: string, kind?: LogKind): void;
  /** 系统信息网格（独立应用已移除渲染：no-op；SDK 宿主可自行决定） */
  systemInfo(lines: string[]): void;
  /** boot（及可选自检）完成：移除（隐藏的）错误页 DOM 并立即返回 */
  complete(): Promise<void>;
  /** 环境不适配：显示专业英文错误页并停留（不做任何降级 / 兜底） */
  fail(reasons: string[], opts?: { header?: string; footer?: string }): void;
}
