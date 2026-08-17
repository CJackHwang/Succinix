import type { ITerminal } from '@lifo-sh/core';

interface TerminalContext {
  terminal: {
    attach(terminal: ITerminal): void;
    detach(terminal?: ITerminal): void;
  };
  terminalSessionId?: string;
}

function terminalSessionId(terminal?: ITerminal): string | undefined {
  const session = terminal as ITerminal & { sessionId?: unknown } | undefined;
  return typeof session?.sessionId === 'string' ? session.sessionId : undefined;
}

/** Browser terminal device attach/detach only; shell state remains in TerminalHub. */
export async function attachTerminalContext(
  contexts: ReadonlyMap<string, Promise<TerminalContext>>,
  instanceId: string,
  terminal: ITerminal,
): Promise<void> {
  const context = await contexts.get(instanceId);
  if (!context) return;
  context.terminalSessionId = terminalSessionId(terminal);
  context.terminal.attach(terminal);
}

export async function detachTerminalContext(
  contexts: ReadonlyMap<string, Promise<TerminalContext>>,
  instanceId: string,
  terminal?: ITerminal,
): Promise<void> {
  const pending = contexts.get(instanceId);
  if (!pending) return;
  try {
    const context = await pending;
    context.terminal.detach(terminal);
    const sessionId = terminalSessionId(terminal);
    if (sessionId === undefined || context.terminalSessionId === sessionId) context.terminalSessionId = undefined;
  } catch {
    // host respawn 期间的旧上下文无需再接收设备清理。
  }
}
