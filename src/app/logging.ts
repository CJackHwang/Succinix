// 命令日志采集（对齐既有 /var/log/succinix.log 行为）（O2 拆分）。
// v0.7：命令与错误消息在落盘前统一脱敏（token/password/npm auth/env secret/URL query secret）。
import type { CommandLogEntry } from '@succinix/engine';
import { log } from '../log.js';
import { redactCommand } from '../redact.js';

// host 命令日志采集（boot 注入；过滤纯轮询 ps，避免刷屏）。
export function makeClientLogger(): (entry: CommandLogEntry) => void {
  return (entry) => {
    if (entry.command.trim() !== 'ps') {
      void log('INFO', `cmd: ${redactCommand(entry.command)} exit=${entry.exit} runtime=${entry.runtime}`);
    }
  };
}
