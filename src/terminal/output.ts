/** Minimal output sink used by application boot/status renderers. */
export interface TerminalOutput {
  write(data: string): void;
  clear(): void;
}
