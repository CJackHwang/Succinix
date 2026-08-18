import type { ChildProcess } from 'node:child_process';

export interface BrowserPorts {
  previewPort: number;
  debugPort: number;
}

export interface ChromeCleanup {
  pid: number | undefined;
  termination: string;
  exited: boolean;
  descendantsBefore: unknown[];
  descendantsAfter: unknown[];
  processGroupBefore: unknown[];
  processGroupAfter: unknown[];
  trackedProcessesAfter: unknown[];
  profileRemoved: boolean;
}

export function allocateBrowserPorts(previewPort?: number): Promise<BrowserPorts>;
export function cleanupChrome(
  chrome: ChildProcess | undefined,
  profileDir: string | undefined,
  options?: { timeoutMs?: number },
): Promise<ChromeCleanup>;
