// CDP 共享客户端（O6 拆分）：verify-deploy / verify-bootgate / bench / scenarios /
// lang-verify / instance-demo 共用。零新依赖 —— Node 22 全局 WebSocket。

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小 CDP 客户端（无新依赖，Node 22 全局 WebSocket）。
export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP websocket failed to open'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.listeners.delete(method);
    };
  }
}

async function waitForDebugEndpoint(debugPort) {
  let versionUrl = '';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const v = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (v.ok) {
        versionUrl = (await v.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 尚未就绪 */
    }
    await wait(300);
  }
  if (!versionUrl) throw new Error(`Chrome DevTools endpoint did not come up on :${debugPort}`);
  return versionUrl;
}

async function findPageTarget(debugPort) {
  let pageUrl = '';
  for (let i = 0; i < 20 && !pageUrl; i++) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    pageUrl = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl || '';
    if (!pageUrl) await wait(200);
  }
  if (!pageUrl) throw new Error('no page target available via CDP');
  return pageUrl;
}

// 连到指定 target 的 WebSocket（启用 Page + Runtime）。
export async function connectTargetCDP(wsUrl) {
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

// 等调试端口就绪，连到第一个 page target（verify-deploy / bench / scenarios / lang-verify 用）。
export async function connectPageCDP(debugPort) {
  await waitForDebugEndpoint(debugPort);
  return connectTargetCDP(await findPageTarget(debugPort));
}

// 等调试端口就绪，连到 browser 级 endpoint（instance-demo 用 Target.createTarget 建多 tab）。
export async function connectBrowserCDP(debugPort) {
  const versionUrl = await waitForDebugEndpoint(debugPort);
  const cdp = new CDP(versionUrl);
  await cdp.open();
  return cdp;
}

// 在页面里跑一个 async 表达式并取回 by-value 结果。
export async function evalValue(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown';
    throw new Error(`page eval failed: ${desc.slice(0, 400)}`);
  }
  return res.result.value;
}
