// 终端色单一事实来源（P2-6）：main / commands / boot-ui / tests 复用。
// 之前 4 处各定义一份 AMBER/RED/GRAY/RESET，任何调色（如暗橙改色）要同步改 4 个文件，
// 漏一个就出现终端颜色不一致。现在只改这里，其余文件 import。
export const AMBER = '\x1b[33m';
export const RED = '\x1b[31m';
export const GRAY = '\x1b[90m';
export const RESET = '\x1b[0m';
