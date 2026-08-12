// 命令日志采集（对齐既有 /var/log/succinix.log 行为）（O2 拆分）。
import type { CommandLogEntry } from '@succinix/engine';
import { log } from '../log.js';

// ─── 命令日志采集（对齐既有 /var/log/succinix.log 行为）───
// host 命令由 TerminalClient.onCommand（boot 注入）落盘；本地命令由 session.onCommand 落盘；
// 错误由 session.onCommandError 落盘（phase 区分 python 注入失败与 RPC 失败）。
export function makeSessionLogger(): {
  onCommand: (entry: { command: string; exit: number | null; runtime: string }) => void;
  onCommandError: (command: string, error: string, phase: 'local' | 'pre' | 'rpc') => void;
} {
  return {
    onCommand: (entry) => {
      if (entry.runtime === 'browser' && !/^log\s+clear\b/.test(entry.command)) {
        void log('INFO', `cmd: ${entry.command} exit=0 runtime=browser`);
      }
    },
    onCommandError: (command, error, phase) => {
      void log('ERROR', phase === 'pre' ? `cmd: ${command} python asset inject failed: ${error}` : `cmd: ${command} error: ${error}`);
    },
  };
}

// host 命令日志采集（boot 注入；过滤纯轮询 ps，避免刷屏）。
export function makeClientLogger(): (entry: CommandLogEntry) => void {
  return (entry) => {
    if (entry.command.trim() !== 'ps') {
      void log('INFO', `cmd: ${entry.command} exit=${entry.exit} runtime=${entry.runtime}`);
    }
  };
}
