// 浏览器脚本共享工具（O6 拆分）：sleep / run / waitForHttp / makeHarness / makeTab。
// verify-deploy / verify-bootgate / bench / scenarios / lang-verify / instance-demo 共用。
import { spawn } from 'node:child_process';
import { evalValue } from './cdp.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 子进程工具：exit 0 = 成功，否则 reject。
export function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      stdio: opts.stdio ?? (opts.silent ? 'ignore' : 'inherit'),
      ...opts.spawn,
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// 轮询 HTTP 直到可访问（vite preview 就绪探测）。
export async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw lastErr ?? new Error(`timeout waiting for ${url}`);
}

// ─── 场景句柄（给每个场景的驱动器）───
export function makeHarness(cdp) {
  const h = {
    cdp,
    // 在页面里执行表达式（awaitPromise），返回 by-value。
    async evalValue(expression) {
      return evalValue(cdp, expression);
    },
    // 跑一条真实命令：与终端 execute() 同分发路径（browser 拦截 → host RPC）。
    async run(cmd, timeoutMs) {
      const expr = `(async () => JSON.stringify(await window.__succinixScenario.run(${JSON.stringify(cmd)}, ${timeoutMs ?? 'undefined'})))()`;
      return JSON.parse(await evalValue(cdp, expr));
    },
    // spawn 后台进程（真实 client.spawn 路径）。
    async spawn(cmd) {
      const expr = `(async () => JSON.stringify(await window.__succinixScenario.client.spawn(${JSON.stringify(cmd)})))()`;
      return JSON.parse(await evalValue(cdp, expr));
    },
    // 轮询页面条件，满足返回真值；超时抛错。
    async waitFor(condExpr, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          const v = await evalValue(cdp, condExpr);
          if (v) return v;
          last = v;
        } catch (e) {
          last = e;
        }
        await sleep(300);
      }
      throw new Error(`waitFor timeout: ${condExpr} (last=${String(last).slice(0, 120)})`);
    },
    // 等场景句柄就绪（初次导航后 / 每次 reload 后）。句柄在 boot 完成时注册。
    async waitForScenario(timeoutMs = 120000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const v = await evalValue(cdp, '!!window.__succinixScenario && window.__succinixScenario.booted === true');
          if (v) return;
        } catch {
          /* 导航期间上下文销毁：下一轮再试 */
        }
        await sleep(400);
      }
      throw new Error(`scenario handle did not become ready within ${timeoutMs}ms`);
    },
    // 刷新页面（保持 ?scenario=1），等重新 boot + 句柄就绪。
    async reloadAndWait(timeoutMs = 120000) {
      try {
        await cdp.send('Page.reload', { ignoreCache: true });
      } catch {
        /* 导航中 */
      }
      await h.waitForScenario(timeoutMs);
    },
  };
  return h;
}

// 页面句柄：?instance=<id>&scenario=1 的 tab（instance-demo 用）。
export function makeTab(cdp, id) {
  const t = {
    id,
    cdp,
    async eval(expression) {
      return evalValue(cdp, expression);
    },
    async run(cmd, timeoutMs) {
      const expr = `(async () => JSON.stringify(await window.__succinixScenario.run(${JSON.stringify(cmd)}, ${timeoutMs ?? 'undefined'})))()`;
      return JSON.parse(await evalValue(cdp, expr));
    },
    async waitForScenario(timeoutMs = 180000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const v = await evalValue(cdp, '!!window.__succinixScenario && window.__succinixScenario.booted === true');
          if (v) return;
        } catch {
          /* 导航期间上下文销毁：下一轮再试 */
        }
        await sleep(400);
      }
      throw new Error(`tab ${id}: scenario handle did not become ready within ${timeoutMs}ms`);
    },
    async reloadAndWait(timeoutMs = 180000) {
      try {
        await cdp.send('Page.reload', { ignoreCache: true });
      } catch {
        /* 导航中 */
      }
      // 先等旧页面销毁（导航开始、句柄消失），再等新 boot 完成 —— 直接轮询句柄会
      // 命中导航前残留的旧句柄而提前返回（页面随后进入 ~8s boot，句柄再次缺失）。
      const goneDeadline = Date.now() + 30000;
      while (Date.now() < goneDeadline) {
        try {
          const v = await evalValue(cdp, '!window.__succinixScenario');
          if (v === true) break;
        } catch {
          /* 导航中上下文销毁：视为已消失 */
          break;
        }
        await sleep(200);
      }
      await t.waitForScenario(timeoutMs);
    },
  };
  return t;
}
