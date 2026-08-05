// 启动覆盖层渲染器（呈现层）：负责 DOM 居中覆盖层（boot splash）的所有渲染。
// 职责：自检日志区追加与自动向上滚动、系统信息两列网格、环境错误页、淡出并显示终端。
// 与业务逻辑分离（boot.ts 只调用这里的渲染接口，不直接碰 DOM / xterm）。
import type { Terminal } from '@xterm/xterm';

export type LogKind = 'ok' | 'note' | 'skip' | 'fail' | 'info';

export interface BootUI {
  /** 追加一行自检日志到覆盖层日志区（新行从底部追加，旧的自动向上滚动） */
  log(text: string, kind?: LogKind): void;
  /** 填充系统信息两列网格 */
  systemInfo(lines: string[]): void;
  /** boot（及可选自检）完成：淡出覆盖层并显示终端；返回时覆盖层已移除 */
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

// 创建覆盖层渲染器：绑定 index.html 里的 #boot-overlay 结构。
export function createBootUI(): BootUI {
  const overlay = document.getElementById('boot-overlay');
  const logEl = document.getElementById('boot-log');
  const sysinfoEl = document.getElementById('boot-sysinfo');
  const errorHeadEl = document.getElementById('boot-error-head');
  const errorListEl = document.getElementById('boot-error-list');
  const errorFootEl = document.getElementById('boot-error-foot');
  if (!overlay || !logEl || !sysinfoEl || !errorHeadEl || !errorListEl || !errorFootEl) {
    throw new Error('boot overlay DOM missing');
  }
  // 非空别名：TS 的 null 收窄不会跨闭包保留，先落定具体类型再进各渲染函数。
  const bootOverlay: HTMLElement = overlay;
  const bootLog: HTMLElement = logEl;
  const bootSysinfo: HTMLElement = sysinfoEl;
  const bootErrorHead: HTMLElement = errorHeadEl;
  const bootErrorList: HTMLElement = errorListEl;
  const bootErrorFoot: HTMLElement = errorFootEl;
  let completed = false;

  // 追加一行日志：新行从底部追加，旧的自动向上滚动（overflow hidden 无滚动条）。
  function log(text: string, kind?: LogKind): void {
    const { text: clean, marker, kind: cls } = parseLogLine(text);
    const effective = kind ?? cls;
    if (clean.trim() === '') {
      const gap = document.createElement('div');
      gap.className = 'log-gap';
      bootLog.appendChild(gap);
    } else {
      const line = document.createElement('div');
      line.className = `log-line kind-${effective}`;
      if (marker) {
        const m = document.createElement('span');
        m.className = 'mark';
        m.textContent = marker;
        line.appendChild(m);
        const rest = document.createElement('span');
        rest.className = 'rest';
        rest.textContent = clean.slice(marker.length);
        line.appendChild(rest);
      } else {
        line.textContent = clean;
      }
      bootLog.appendChild(line);
    }
    bootLog.scrollTop = bootLog.scrollHeight;
  }

  // 系统信息：`Key: value` 解析成两列网格（键暗灰右对齐、值暖白）。
  function systemInfo(lines: string[]): void {
    bootSysinfo.textContent = '';
    for (const line of lines) {
      const idx = line.indexOf(': ');
      if (idx === -1) {
        const full = document.createElement('div');
        full.className = 'si-full';
        full.textContent = line;
        bootSysinfo.appendChild(full);
        continue;
      }
      const key = document.createElement('div');
      key.className = 'si-key';
      key.textContent = line.slice(0, idx);
      const value = document.createElement('div');
      value.className = 'si-value';
      value.textContent = line.slice(idx + 2);
      bootSysinfo.append(key, value);
    }
  }

  // boot 完成：先显示终端（与覆盖层淡出交叉渐显），再淡出覆盖层并移除。
  function complete(): Promise<void> {
    if (completed) return Promise.resolve();
    completed = true;
    const terminal = document.getElementById('terminal');
    if (terminal) terminal.style.visibility = 'visible';
    bootOverlay.classList.add('boot-fade');
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        bootOverlay.remove();
        resolve();
      };
      bootOverlay.addEventListener('transitionend', (ev) => {
        if (ev.target === bootOverlay && ev.propertyName === 'opacity') finish();
      }, { once: true });
      // 兜底：即使 transitionend 未触发（如标签页切后台），也按时移除。
      // TASK18：与 CSS 淡出 400ms→200ms 对齐，兜底 550ms→300ms。
      setTimeout(finish, 300);
    });
  }

  // 环境不适配错误页：隐藏信息/日志区，只留大标题 + [FAIL] 行 + 说明，且不淡出。
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

// 轻量 Terminal 替身：把 writeln/write 转发到覆盖层日志区。
// 用于 ?test=1 时把自检输出改道到覆盖层（tests.ts 断言逻辑不动，只换输出目标）。
// TASK16：冒烟测试会触发 clear，补一个无副作用 no-op（覆盖层无清屏语义）。
export function overlayTerminalShim(ui: BootUI): Pick<Terminal, 'writeln' | 'write' | 'clear'> {
  return {
    writeln(line: string): void {
      ui.log(line);
    },
    write(data: string): void {
      ui.log(data);
    },
    clear(): void {
      /* 覆盖层日志区没有清屏概念，no-op */
    },
  };
}
