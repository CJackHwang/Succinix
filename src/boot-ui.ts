// 启动渲染器（呈现层）：boot 日志全程写入 xterm 终端，环境错误页仍为 DOM。
// 职责：将自检日志（[  OK  ] / [ FAIL ] / [SKIP] / [ .... ]）按现有 MARKER 映射着色后
// 写入终端；systemInfo 为 no-op（去掉系统信息网格）；fail() 显示 DOM 错误页并停留。
// 与业务逻辑分离（boot.ts 只调用这里的渲染接口，不直接碰 DOM / xterm）。
import type { Terminal } from '@xterm/xterm';
import { AMBER, RED, GRAY, RESET } from './theme.js';

export type LogKind = 'ok' | 'note' | 'skip' | 'fail' | 'info';

export interface BootUI {
  /** 追加一行自检日志到 xterm 终端（marker 按 kind 着色，其余暖白默认色） */
  log(text: string, kind?: LogKind): void;
  /** 系统信息网格已移除：no-op（boot.ts 的调用保留，不产生输出） */
  systemInfo(lines: string[]): void;
  /** boot（及可选自检）完成：移除（隐藏的）错误页 DOM 并立即返回；终端全程可见，无淡出 */
  complete(): Promise<void>;
  /** 环境不适配：显示专业英文错误页并停留（不做任何降级 / 兜底） */
  fail(reasons: string[], opts?: { header?: string; footer?: string }): void;
}

// 覆盖层日志行前置状态标记（与终端保持一致：纯 ASCII、暗橙 / 暗红 / 暗灰）
const MARKERS = ['[  OK  ]', '[ FAIL ]', '[SKIP]', '[ .... ]', '[preview]'] as const;

// marker → 视觉类型。TASK18：把原先三元链里 [preview] 隐式落到默认 'ok' 的冗余分支，
// 改为显式映射表 —— [preview] 与 [  OK  ] 同为暗橙 ok 类，语义一目了然，无隐藏默认分支。
const MARKER_KIND: Record<(typeof MARKERS)[number], LogKind> = {
  '[  OK  ]': 'ok',
  '[ FAIL ]': 'fail',
  '[SKIP]': 'skip',
  '[ .... ]': 'note',
  '[preview]': 'ok',
};

// 终端色（自 src/theme.ts 单一来源：33m 暗橙、31m 暗红、90m 暗灰，与 main/commands/tests 一致）

// kind → 终端前景色：ok 暗橙 / fail 暗红 / note+skip 暗灰 / info 默认暖白（不加色）。
const KIND_COLOR: Record<LogKind, string> = {
  ok: AMBER,
  fail: RED,
  note: GRAY,
  skip: GRAY,
  info: '',
};

// 从（可能带 ANSI 的）原始行解析出纯净文本 + 状态标记 + 类型。
function parseLogLine(raw: string): { text: string; marker: string | null; kind: LogKind } {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\r?\n/, '');
  const marker = MARKERS.find((m) => text.startsWith(m)) ?? null;
  if (marker) {
    return { text, marker, kind: MARKER_KIND[marker] };
  }
  // ANSI 兜底：按颜色归类（31m 红 / 33m 橙 / 90m 灰）
  if (raw.includes('\x1b[31m')) return { text, marker: null, kind: 'fail' };
  if (raw.includes('\x1b[33m')) return { text, marker: null, kind: 'ok' };
  if (raw.includes('\x1b[90m')) return { text, marker: null, kind: 'note' };
  return { text, marker: null, kind: 'info' };
}

// 创建终端版启动渲染器：绑定 index.html 里的 #boot-overlay（仅错误页）。
export function createBootUI(term: Terminal): BootUI {
  const overlay = document.getElementById('boot-overlay');
  const errorHeadEl = document.getElementById('boot-error-head');
  const errorListEl = document.getElementById('boot-error-list');
  const errorFootEl = document.getElementById('boot-error-foot');
  if (!overlay || !errorHeadEl || !errorListEl || !errorFootEl) {
    throw new Error('boot error overlay DOM missing');
  }
  // 非空别名：TS 的 null 收窄不会跨闭包保留，先落定具体类型再进各渲染函数。
  const bootOverlay: HTMLElement = overlay;
  const bootErrorHead: HTMLElement = errorHeadEl;
  const bootErrorList: HTMLElement = errorListEl;
  const bootErrorFoot: HTMLElement = errorFootEl;
  let completed = false;

  // 追加一行日志到终端：marker 部分按 kind 着色，其余暖白默认色；空行保留。
  function log(text: string, kind?: LogKind): void {
    const { text: clean, marker, kind: cls } = parseLogLine(text);
    const effective = kind ?? cls;
    const color = KIND_COLOR[effective];
    if (marker) {
      term.writeln(`${color}${marker}${RESET}${clean.slice(marker.length)}`);
    } else if (clean.trim() === '') {
      term.writeln('');
    } else {
      term.writeln(color ? `${color}${clean}${RESET}` : clean);
    }
  }

  // 系统信息网格已移除（R1）：no-op —— boot.ts 的 ui.systemInfo 调用保留，不产生输出。
  function systemInfo(_lines: string[]): void {
    /* 去大标题/系统信息：不再渲染系统信息网格 */
  }

  // boot 完成：终端全程可见，无需淡出；仅移除（隐藏的）错误页 DOM 并立即返回。
  // 移除时机可被 scripts/bench.mjs 的 MutationObserver 捕获（overlayRemoved 打点）。
  function complete(): Promise<void> {
    if (completed) return Promise.resolve();
    completed = true;
    bootOverlay.remove();
    return Promise.resolve();
  }

  // 环境不适配错误页：显示 DOM 错误页并停留（不写终端、不淡出）。
  function fail(reasons: string[], opts?: { header?: string; footer?: string }): void {
    if (completed || !bootOverlay.isConnected) return;
    bootOverlay.classList.add('boot-error-mode');
    if (opts?.header) bootErrorHead.textContent = opts.header;
    if (opts?.footer) {
      bootErrorFoot.textContent = '';
      const parts = opts.footer.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) bootErrorFoot.appendChild(document.createElement('br'));
        bootErrorFoot.appendChild(document.createTextNode(part));
      });
    }
    bootErrorList.textContent = '';
    for (const reason of reasons) {
      const row = document.createElement('div');
      row.className = 'boot-error-line';
      const m = document.createElement('span');
      m.className = 'mark';
      m.textContent = '[FAIL]';
      const rest = document.createElement('span');
      rest.className = 'rest';
      rest.textContent = ` ${reason}`;
      row.append(m, rest);
      bootErrorList.appendChild(row);
    }
  }

  return { log, systemInfo, complete, fail };
}
