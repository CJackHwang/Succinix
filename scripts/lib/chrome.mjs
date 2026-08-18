// Shared Chrome discovery, lifecycle, and failure diagnostics for browser gates.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STDERR_LIMIT_BYTES = 64 * 1024;
const PAGE_EVENT_LIMIT = 100;

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** Allocate an unused localhost TCP port for one browser-gate invocation. */
export async function allocatePort(preferredPort = 0) {
  if (!Number.isSafeInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
    throw new Error(`invalid TCP port: ${preferredPort}`);
  }
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: preferredPort }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('could not allocate a TCP port');
    return address.port;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

/** Allocate distinct preview and DevTools ports. A non-zero preview port is strict. */
export async function allocateBrowserPorts(previewPort = 0) {
  const preview = await allocatePort(previewPort);
  let debug = await allocatePort(0);
  while (debug === preview) debug = await allocatePort(0);
  return { previewPort: preview, debugPort: debug };
}

/**
 * Starts Chrome in its own process group. stderr is retained in a bounded
 * buffer so failed browser gates report a cause instead of only a missing CDP
 * hook. Existing callers can keep destructuring `{ chrome, profileDir }`.
 */
export function launchChrome(debugPort, label = 'succinix') {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('headless Chrome not found');
  if (!Number.isSafeInteger(debugPort) || debugPort <= 0 || debugPort > 65535) {
    throw new Error(`invalid Chrome DevTools port: ${debugPort}`);
  }
  const profileDir = mkdtempSync(join(tmpdir(), `succinix-${label}-`));
  const stderr = createBoundedLog(STDERR_LIMIT_BYTES);
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    'about:blank',
  ], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const state = { startedAt: new Date().toISOString(), exitCode: null, signal: null, stderr };
  chrome.stderr?.on('data', (chunk) => stderr.append(chunk));
  chrome.once('exit', (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });
  return { chrome, profileDir, debugPort, state };
}

/** Register CDP console/exception events and retain their bounded tail. */
export function attachPageDiagnostics(cdp) {
  const events = [];
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pushEvent(events, { type: 'exception', detail: describeException(message.params?.exceptionDetails) });
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params?.type;
      if (type === 'error' || type === 'warning') {
        pushEvent(events, { type: `console:${type}`, detail: describeConsoleArgs(message.params?.args) });
      }
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params?.entry;
      if (entry?.level === 'error' || entry?.level === 'warning') {
        pushEvent(events, { type: `log:${entry.level}`, detail: String(entry.text ?? '').slice(0, 1000) });
      }
    }
  };
  cdp.ws.addEventListener('message', onMessage);
  return {
    events,
    dispose() { cdp.ws.removeEventListener('message', onMessage); },
  };
}

/**
 * Write a failure-only artifact with page, Chrome, process-tree and port data.
 * The caller owns the returned directory and should retain it only on failure.
 */
export async function writeBrowserFailureDiagnostics({ label, error, cdp, pageDiagnostics, chromeRun, previewPort, debugPort }) {
  const diagnosticsRoot = process.env.SUCCINIX_DIAGNOSTICS_DIR;
  if (diagnosticsRoot) mkdirSync(diagnosticsRoot, { recursive: true });
  const directory = mkdtempSync(join(diagnosticsRoot ?? tmpdir(), `succinix-${label}-diagnostics-`));
  const page = await capturePageState(cdp, directory);
  const chrome = await inspectChrome(chromeRun, debugPort);
  const preview = await inspectPort(previewPort);
  const report = {
    createdAt: new Date().toISOString(),
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
    ports: { preview, debug: chrome.debugPort },
    chrome,
    page,
    pageEvents: pageDiagnostics?.events ?? [],
  };
  const reportPath = join(directory, 'diagnostics.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { directory, reportPath, screenshotPath: page.screenshotPath };
}

/** Wait for Chrome and its process group before deleting the temporary profile. */
export async function cleanupChrome(chrome, profileDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pid = chrome?.pid;
  const before = await inspectProcessTree(pid);
  const processGroupBefore = await inspectProcessGroup(pid);
  const trackedPids = before.map((process) => process.pid).filter(Number.isSafeInteger);
  let termination = 'not-started';
  if (chrome && (chrome.exitCode === null && chrome.signalCode === null || processGroupBefore.length > 0)) {
    termination = signalChromeGroup(chrome, 'SIGTERM') ? 'SIGTERM' : 'SIGTERM-failed';
    const gracefulTimeoutMs = Math.min(timeoutMs, 5_000);
    const groupExited = await waitForProcessGroupExit(pid, gracefulTimeoutMs);
    const trackedExited = await waitForProcessesExit(trackedPids, gracefulTimeoutMs);
    if (!groupExited || !trackedExited) {
      termination = signalChromeGroup(chrome, 'SIGKILL') ? 'SIGKILL' : 'SIGKILL-failed';
      signalProcesses(trackedPids, 'SIGKILL');
      const forceTimeoutMs = Math.max(1_000, timeoutMs - gracefulTimeoutMs);
      await Promise.all([
        waitForProcessGroupExit(pid, forceTimeoutMs),
        waitForProcessesExit(trackedPids, forceTimeoutMs),
      ]);
    }
  }
  const after = await inspectProcessTree(pid);
  const processGroupAfter = await inspectProcessGroup(pid);
  const trackedProcessesAfter = await inspectLiveProcesses(trackedPids);
  let profileRemoved = false;
  if (profileDir && processGroupAfter.length === 0 && trackedProcessesAfter.length === 0) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      profileRemoved = !existsSync(profileDir);
    } catch {
      profileRemoved = false;
    }
  }
  return {
    pid,
    termination,
    exited: chrome ? chrome.exitCode !== null || chrome.signalCode !== null : true,
    descendantsBefore: before,
    descendantsAfter: after,
    processGroupBefore,
    processGroupAfter,
    trackedProcessesAfter,
    profileRemoved,
  };
}

async function capturePageState(cdp, directory) {
  const state = {
    url: null,
    title: null,
    readyState: null,
    boot: null,
    bodyTextTail: null,
    screenshotPath: null,
    captureError: null,
  };
  if (!cdp) return state;
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        boot: {
          benchHook: !!window.__succinixBench,
          scenarioHook: !!window.__succinixScenario,
          bootTimes: window.__bootTimes ?? null,
          overlayPresent: !!document.getElementById('boot-overlay'),
        },
        bodyTextTail: String(document.body?.innerText ?? '').slice(-4000),
      })`,
      returnByValue: true,
    });
    Object.assign(state, result.result?.value ?? {});
  } catch (error) {
    state.captureError = `page state: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (typeof screenshot.data === 'string') {
      state.screenshotPath = join(directory, 'page.png');
      writeFileSync(state.screenshotPath, Buffer.from(screenshot.data, 'base64'));
    }
  } catch (error) {
    state.captureError = [state.captureError, `screenshot: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
  }
  return state;
}

async function inspectChrome(chromeRun, debugPort) {
  const chrome = chromeRun?.chrome ?? chromeRun;
  const state = chromeRun?.state;
  const pid = chrome?.pid;
  return {
    pid,
    startedAt: state?.startedAt ?? null,
    exitCode: state?.exitCode ?? chrome?.exitCode ?? null,
    signal: state?.signal ?? chrome?.signalCode ?? null,
    stderrTail: state?.stderr?.value() ?? '',
    debugPort: await inspectPort(debugPort),
    processTree: await inspectProcessTree(pid),
    processGroup: await inspectProcessGroup(pid),
  };
}

async function inspectPort(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return { port, listeners: [], error: 'not assigned' };
  const command = await captureCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], 2_000);
  return {
    port,
    listeners: command.stdout.split('\n').filter(Boolean).slice(-20),
    ...(command.error ? { error: command.error } : {}),
  };
}

async function inspectProcessTree(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || process.platform === 'win32') return [];
  const command = await captureCommand('ps', ['-axo', 'pid=,ppid=,stat=,command='], 2_000, 1024 * 1024);
  if (command.error) return [{ pid: rootPid, error: command.error }];
  const processes = command.stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), state: match[3], command: match[4].slice(0, 300) } : null;
  }).filter(Boolean);
  const descendantIds = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const process of processes) {
      if (descendantIds.has(process.ppid) && !descendantIds.has(process.pid)) {
        descendantIds.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process) => descendantIds.has(process.pid));
}

async function inspectProcessGroup(groupId) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || process.platform === 'win32') return [];
  const command = await captureCommand('ps', ['-axo', 'pid=,pgid=,ppid=,stat=,command='], 2_000, 1024 * 1024);
  if (command.error) return [{ pid: groupId, error: command.error }];
  return command.stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? {
      pid: Number(match[1]),
      pgid: Number(match[2]),
      ppid: Number(match[3]),
      state: match[4],
      command: match[5].slice(0, 300),
    } : null;
  }).filter(Boolean).filter((entry) => entry.pgid === groupId);
}

function signalChromeGroup(chrome, signal) {
  try {
    if (chrome.pid && process.platform !== 'win32') {
      process.kill(-chrome.pid, signal);
      return true;
    }
    return chrome.kill(signal);
  } catch {
    try {
      return chrome.kill(signal);
    } catch {
      return false;
    }
  }
}

async function waitForProcessGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await inspectProcessGroup(groupId)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await inspectProcessGroup(groupId)).length === 0;
}

async function waitForProcessesExit(pids, timeoutMs) {
  if (pids.length === 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await inspectLiveProcesses(pids)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await inspectLiveProcesses(pids)).length === 0;
}

async function inspectLiveProcesses(pids) {
  const unique = [...new Set(pids.filter(Number.isSafeInteger))];
  if (unique.length === 0 || process.platform === 'win32') return [];
  const command = await captureCommand('ps', ['-p', unique.join(','), '-o', 'pid=,stat=,command='], 2_000);
  if (command.error) return unique.map((pid) => ({ pid, error: command.error }));
  return command.stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), state: match[2], command: match[3].slice(0, 300) } : null;
  }).filter(Boolean).filter((process) => !process.state.startsWith('Z'));
}

function signalProcesses(pids, signal) {
  for (const pid of new Set(pids.filter(Number.isSafeInteger))) {
    try { process.kill(pid, signal); } catch { /* process already exited */ }
  }
}

function captureCommand(command, args, timeoutMs, outputLimit = 32 * 1024) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      finish({ stdout: '', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, outputLimit); });
    child.once('error', (error) => finish({ stdout, error: error.message }));
    child.once('close', (code) => finish({ stdout, ...(code === 0 || code === 1 ? {} : { error: `${command} exited ${code}` }) }));
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ stdout, error: `${command} timed out` });
    }, timeoutMs).unref();
  });
}

function createBoundedLog(limit) {
  let value = '';
  return {
    append(chunk) { value = appendBounded(value, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk), limit); },
    value() { return value; },
  };
}

function appendBounded(value, addition, limit) {
  const next = value + addition;
  if (Buffer.byteLength(next, 'utf8') <= limit) return next;
  return Buffer.from(next, 'utf8').subarray(-limit).toString('utf8');
}

function pushEvent(events, event) {
  events.push({ at: new Date().toISOString(), ...event });
  if (events.length > PAGE_EVENT_LIMIT) events.splice(0, events.length - PAGE_EVENT_LIMIT);
}

function describeConsoleArgs(args) {
  return (args ?? []).map((arg) => {
    if (typeof arg?.value === 'string') return arg.value;
    if (arg?.value !== undefined) return JSON.stringify(arg.value);
    return arg?.description ?? arg?.type ?? '';
  }).join(' ').slice(0, 1000);
}

function describeException(details) {
  return String(details?.exception?.description ?? details?.text ?? 'unknown page exception').slice(0, 1000);
}
