// Shell 分词（shlex 语义）—— host 与浏览器自检共享的纯函数模块。
// node/npm/npx/python 命令由 host 分词后直启子进程；转义引号按 shlex 处理：
//   - 引号内 `\"` → 字面 `"`（不进字符串边界判断）
//   - `\\` → 字面 `\`；单引号内 `\'` → 字面 `'`
//   - 未闭合引号 → 抛错 `unterminated quote in command`（不静默截断）
//   - 引号外空白分词、引号内空白保留（现状行为保持）
// 引号外反斜杠按 shlex posix 转义下一字符（`\ ` → 空格）；引号内只转义 shell 特殊字符
// （双引号内 `"`/`\`/`$`/`` ` ``，单引号内 `'`/`\`），使 `-e "console.log('a\nb')"`
// 这类代码里的 `\n` 保持原样传给运行时，不被吞掉。

// 双引号内反斜杠转义的字符集（shlex posix）
const DOUBLE_QUOTE_ESCAPES = '\\"$`';
// 单引号内反斜杠转义的字符集（任务语义：`\'` → `'`；`\\` → `\`）
const SINGLE_QUOTE_ESCAPES = "\\'";

export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (quote === '"') {
      if (ch === '\\' && i + 1 < n && DOUBLE_QUOTE_ESCAPES.includes(command[i + 1])) {
        cur += command[i + 1];
        i += 2;
      } else if (ch === '"') {
        quote = null;
        i += 1;
      } else {
        cur += ch;
        i += 1;
      }
    } else if (quote === "'") {
      if (ch === '\\' && i + 1 < n && SINGLE_QUOTE_ESCAPES.includes(command[i + 1])) {
        cur += command[i + 1];
        i += 2;
      } else if (ch === "'") {
        quote = null;
        i += 1;
      } else {
        cur += ch;
        i += 1;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
    } else if (ch === '\\') {
      // 引号外：反斜杠转义下一字符（shlex posix）。行尾孤立反斜杠保留字面。
      if (i + 1 < n) {
        cur += command[i + 1];
        i += 2;
      } else {
        cur += '\\';
        i += 1;
      }
    } else if (ch === ' ' || ch === '\t') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      i += 1;
    } else {
      cur += ch;
      i += 1;
    }
  }
  if (quote) throw new Error('unterminated quote in command');
  if (cur) tokens.push(cur);
  return tokens;
}

// 独立 token 级 shell 元字符检测：node/python 系命令含这些 token 时，整条命令回退给 Lifo shell
// 解析（管道/重定向/链）。只查"顶层 argv 分割后的独立 token"——引号内 `a|b` 是单一 token，
// 不触发；`node -e "console.log('a|b')"` 里的 `|` 在引号内不误判。
// 覆盖任务列出的独立 token（&& / || / | / > / >> / < / 2> / 2>&1 / ; / & / $( ），
// 以及真实 shell 同样解析的粘连形态：`>file` / `>>log` / `<in` / `2>err` / `2>>log` /
// `$(cmd`，TASK24 复审补 fd 重定向粘连形态 `1>out` / `1>>log` / `&>out`（1>/&> 都指
// 重定向 stdout 或 stdout+stderr，同样需要回退 shell 解析）。
export function hasShellMetaToken(tokens: string[]): boolean {
  return tokens.some((tok) => {
    if (tok === '&&' || tok === '||' || tok === '|' || tok === '>' || tok === '>>' ||
      tok === '<' || tok === '2>' || tok === '2>&1' || tok === ';' || tok === '&' || tok === '$(') {
      return true;
    }
    return /^(>>?|<<?|[0-9]+>>?|[0-9]+<<?|&>>?)/.test(tok) || tok.startsWith('$(');
  });
}

/** 检测未引用的 here-document 操作符；当前 userland 明确不支持该 shell 特性。 */
export function hasUnsupportedHereDocument(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '<' && command[index + 1] === '<') {
      return true;
    }
  }
  return false;
}

// 分词兜底：未闭合引号等语法错误给出明确报错，不静默截断、不抛到协议层（O3 拆分）。
export function tryTokenize(command: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  try {
    return { ok: true, tokens: tokenize(command) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
