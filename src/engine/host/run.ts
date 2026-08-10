// host run 域（O3 拆分）：统一路由（node|npm|npx → 真 Node；python → daemon；其余 → Lifo）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { hasShellMetaToken, tryTokenize } from '../tokenize.js';
import { registerProcess } from '../host-procs.js';
import { pythonDaemon, PYTHON_DAEMON_JS } from '../python-daemon-client.js';
import { WORKSPACE_MOUNT, PIP_PREFIX_RE, classifyPrefix, classifyRoute, pythonRuntimeArgs, mapDataDirArgs, lifoSpawndCwd, lifoCwdToSessionCwd, capOutput, withEaccesHint, CD_PREFIX_RE } from '../host-route.js';
import { getSessionCwd, setSessionCwd, mergedEnv, currentInstanceId, spawnCwd } from './config.js';
import { attachOutputCollector, spawnChild } from './spawn.js';
import { writeResult, instanceOf, type CommandRequest } from './rpc.js';

// Lifo 命令默认超时（与 node 子进程的 NODE_TIMEOUT_MS 分开：纯 Lifo 命令一般秒级完成）。
const LIFO_TIMEOUT_MS = 25000;

// TASK18：Lifo 内核懒加载 + 延迟预热（评估成本后的选择）。
// @lifo-sh/core 单独 bundle（lifo-core.js，~1MB），解析执行都慢；若静态 import 进 host.js，
// host 启动就要解析整个 1MB bundle，实测 boot 探活 ping 被拖慢 ~640ms。
// 因此：host.js 保持轻量（RPC/进程表/node 子进程），Lifo 内核经动态 import('../lifo-core.js')
// 在首次使用时加载；并延迟预热（setTimeout 150ms，host 响应完首批 ping 后在后台加载）。
// 协议不变：只把内核加载从"启动阻塞"改为"延迟预热 + 首次使用懒加载"。
let sandboxPromise: Promise<Awaited<ReturnType<typeof import('../lifo-core.js').Sandbox.create>>> | null = null;

function getSandbox(): Promise<Awaited<ReturnType<typeof import('../lifo-core.js').Sandbox.create>>> {
  if (!sandboxPromise) {
    sandboxPromise = import('../lifo-core.js')
      .then(({ Sandbox }) =>
        Sandbox.create({
          // TASK23：初始 cwd = /workspace 挂载点（默认是 /home/user，Lifo VFS 私有路径），
          // 让 Lifo 起始 cwd 与会话 cwd（process.cwd()）一致 —— pwd / node 子进程口径统一。
          cwd: WORKSPACE_MOUNT,
          mounts: [
            {
              virtualPath: '/workspace',
              hostPath: process.cwd(),
              fsModule: fs as never,
            },
          ],
        })
      )
      .then((sandbox) => {
        // TASK24 坑 1：node 系命令含 shell 元字符时整条回退给 Lifo shell 执行。Lifo 内置
        // node/npm/npx 是进程内 JS 解释器（报自己的版本号），不是真 node —— 这里注册转发
        // 命令，把 Lifo shell 里的 node/npm/npx 段直启真二进制（cwd/环境与会话 cwd 对齐），
        // stdout/stderr 写进 Lifo 命令上下文流（Lifo shell 已把它们接到管道/重定向）。
        // 递归防护：转发命令直接 spawn 真二进制，不再回 host 分派 → 不会二次回退。
        registerRealBinaryCommands(sandbox);
        return sandbox;
      })
      .catch((e) => {
        // 预热/首用失败（如 lifo-core.js 尚未注入完成）：清空缓存，下次调用重试。
        sandboxPromise = null;
        throw e;
      });
  }
  return sandboxPromise;
}

// 在 Lifo 内核里注册 node/npm/npx/python/python3 转发命令（覆盖内置 JS 解释器 shim）。
// 每个命令把 ctx.args 直传给真二进制（python 是 node 加载运行时脚本），输出累积后写入
// ctx.stdout/stderr（管道/链在 shell 层已接好，写 ctx 流即进管道）。stderr 累积以支持 EACCES 提示追加。
// cwd 用 Lifo 命令上下文的 VFS cwd 映射回 host 真实路径（链内 `cd /workspace/sub` 也能跟随，
// 与 runNode 的 spawnCwd(instanceId) 语义一致）；非 /workspace 的 Lifo 私有路径回落会话 cwd。
function registerRealBinaryCommands(
  sandbox: Awaited<ReturnType<typeof import('../lifo-core.js').Sandbox.create>>
): void {
  // M2：Lifo 混合链的 node/python 转发在「当前在途请求」的实例上下文里执行（单 host 串行
  // 处理请求，currentInstanceId() 即请求所属实例）；cwd/环境按该实例解析。
  const lifoSpawnCwd = (vfsCwd: string): string => lifoSpawndCwd(vfsCwd, getSessionCwd(currentInstanceId()), process.cwd());
  // 共享转发：spawn 一个真实子进程，stdout/stderr 累积后写入 Lifo 命令上下文流；
  // 超时/中断（Lifo shell 的 signal）时子进程一并杀掉。
  // V1 H1-2：把 Lifo 混合链拉起的 node/npm/npx 真实子进程登记进 host 进程表（host-procs.ts），
  // 使前台 `cd <root> && npm test` 这类混合链命令的活跃子进程在 ps() 可见、kill 可终止——
  // 此前它们只在 Lifo shell 内部运行，UI 进程表完全不可见。
  // TASK-CISOL（R1）：登记时带上 spawn 的启动 cwd（realCwd），host-procs 据此判定容器归属
  // （cd /workspace/c-<id> 前缀 → 子进程 cwd 落在容器根 → scope=container + containerId）。
  const forward = (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; signal?: AbortSignal | null },
    child: ReturnType<typeof spawn>,
    cmd: string,
    realCwd: string
  ): Promise<number> => {
    // M5：Lifo 混合链转发进程同样按请求实例显式归属（cwd 可能是容器 home，无状态根段）。
    const pid = registerProcess(cmd, child, realCwd, currentInstanceId());
    // both：既累积（写 ctx 流）也追加进程表（ps/kill 可见）。
    const out = attachOutputCollector(child, pid, 'both');
    const onAbort = () => child.kill();
    ctx.signal?.addEventListener('abort', onAbort);
    return new Promise<number>((resolve) => {
      child.on('close', (code) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        ctx.stdout.write(out.stdout());
        ctx.stderr.write(withEaccesHint(out.stderr()));
        resolve(code ?? -1);
      });
      child.on('error', (e: Error) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        ctx.stderr.write(String(e));
        resolve(-1);
      });
    });
  };

  for (const name of ['node', 'npm', 'npx']) {
    sandbox.commands.register(name, async (ctx) => {
      const realCwd = lifoSpawnCwd(ctx.cwd);
      const child = spawn(name, ctx.args, { cwd: realCwd, env: mergedEnv(currentInstanceId()) });
      return forward(ctx, child, [name, ...ctx.args].join(' '), realCwd);
    });
  }
  // TASK27：python/pip 命令含 shell 元字符时整条经 Lifo shell 执行（真管道），python 段
  // 转发到常驻 Pyodide daemon（python-daemon-client）。资产未注入时给明确错误，与 runPython 一致。
  const pythonForward = async (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; cwd: string },
    args: string[]
  ): Promise<number> => {
    if (!fs.existsSync(PYTHON_DAEMON_JS)) {
      ctx.stderr.write(
        'python runtime failed to load: assets not injected yet — run any other command first, or refresh the page (the runtime is injected on first use)'
      );
      return -1;
    }
    const r = await pythonDaemon.exec(args, lifoSpawnCwd(ctx.cwd), PYTHON_TIMEOUT_MS);
    ctx.stdout.write(r.stdout);
    ctx.stderr.write(withEaccesHint(r.stderr));
    return r.exitCode;
  };
  for (const name of ['python', 'python3']) {
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, pythonRuntimeArgs(ctx.args, process.cwd())));
  }
  for (const name of ['pip', 'pip3']) {
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, ['-m', 'pip', ...ctx.args]));
  }
}

// 延迟预热：host 模块加载完成 + 首批 ping 响应后启动内核加载（见上注释）。
// 预热失败（lifo-core.js 可能还在注入中）时静默，首个 Lifo 命令会重试。
setTimeout(() => {
  void getSandbox().catch(() => {});
}, 150);

// python 命令默认超时（比 node 子进程宽松）：首个命令含 daemon 懒启动 + 可能的重装恢复，
// pip install 走网络拉 wheel —— 120s 内可完成；daemon 内部也有同等超时兜底。
const PYTHON_TIMEOUT_MS = 150000;

// 统一路由：node|npm|npx → spawn 真 Node；其余 → lifo sandbox。
// TASK24 坑 1：node 系命令含 shell 元字符（&& / | / > / 2>&1 ...）时，整条命令回退给
// Lifo shell 执行 —— Lifo 的 shell 层解析管道/重定向/链，各 node 段经 registerRealBinaryCommands
// 转回真 node/npm/npx（见 getSandbox）。结果 runtime 仍标 'lifo'（shell 层执行），文档注明。
// 纯 node 命令（无元字符）行为不变（直启子进程）。路由判定抽到 host-route.ts（P1-4）。
export async function dispatchRun(req: CommandRequest): Promise<void> {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: 'empty command', runtime: 'lifo' });
    return;
  }
  const inst = instanceOf(req);
  const prefix = classifyPrefix(command);
  if (prefix !== 'lifo') {
    // node/python/pip 系才分词做 shell 元字符检查（与旧行为一致：纯 Lifo 命令不经过
    // 分词，未闭合引号交给 Lifo shell 自己处理）。
    const t = tryTokenize(command);
    if (!t.ok) {
      writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, inst);
      return;
    }
    const route = classifyRoute(command, hasShellMetaToken(t.tokens));
    if (route === 'node') {
      runNode(command, req.opts, req.id, inst); // 立即返回；子进程结束时异步写结果
      return;
    }
    if (route === 'python') {
      await runPython(command, req.opts, req.id, inst); // daemon 响应后写结果
      return;
    }
    await runLifo(command, req.opts, req.id, inst); // 混合链：Lifo shell 层执行
    return;
  }
  await runLifo(command, req.opts, req.id, inst);
}

// 真 Node 子进程：命令串 → 简单分词 → spawn(prog, args, { cwd: spawnCwd(currentInstanceId()) })。
// 结果带 runtime: 'node'。进程登记进进程表，可被 ps / kill 管理。
function runNode(command: string, opts: Record<string, unknown> | undefined, reqId: number, instanceId: string): void {
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, instanceId);
    return;
  }
  // M5：绝对路径数据目录参数（tinbase --data-dir）按浏览器视角映射到 host 真实根
  // （实测：node 进程的容器根没有 /workspace，浏览器 wc.fs `/` == process.cwd()，
  // 浏览器 `/workspace/x` 的真实位置是 process.cwd()/workspace/x），见 host-route.mapDataDirArgs。
  const [prog, ...args] = mapDataDirArgs(t.tokens, process.cwd());
  spawnChild(prog, args, opts, reqId, 'node', instanceId);
}

// TASK27：python / python3 / pip / pip3 命令 → 发往常驻 Pyodide daemon（python-daemon-client）。
// 纯 python/pip 命令（无 shell 元字符）走这里；含管道/重定向的混合链由 dispatchRun 转给
// Lifo shell（python/pip 段再经 registerRealBinaryCommands 转发到同一 daemon —— 实例状态共享）。
// 资产未注入时给明确错误，系统不崩（装不坏：python 不依赖用户 npm install）。
async function runPython(command: string, opts: Record<string, unknown> | undefined, reqId: number, instanceId: string): Promise<void> {
  if (!fs.existsSync(PYTHON_DAEMON_JS)) {
    writeResult(reqId, {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr:
        'python runtime failed to load: assets not injected yet — run any other command first, or refresh the page (the runtime is injected on first use)',
      runtime: 'node',
    }, instanceId);
    return;
  }
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, instanceId);
    return;
  }
  const [, ...rawArgs] = t.tokens; // 丢弃 python/python3/pip/pip3 前缀
  const args = PIP_PREFIX_RE.test(command) ? ['-m', 'pip', ...rawArgs] : pythonRuntimeArgs(rawArgs, process.cwd());
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : PYTHON_TIMEOUT_MS;
  const r = await pythonDaemon.exec(args, spawnCwd(currentInstanceId()), timeoutMs);
  writeResult(reqId, {
    ok: r.exitCode === 0,
    exitCode: r.exitCode,
    stdout: capOutput(r.stdout),
    stderr: withEaccesHint(capOutput(r.stderr)),
    runtime: 'node',
  }, instanceId);
}

// Lifo sandbox：Unix 工具（grep / cat / wc / echo / curl ...）。结果带 runtime: 'lifo'。
// TASK23：cd 成功后把会话 cwd 同步到 Lifo 新 cwd（仅 /workspace 下 —— 映射 host 真实路径），
// 并持久化 /etc/succinix.cwd；cd 到不存在目录 → Lifo 报错（exit≠0），会话 cwd 不变。
async function runLifo(command: string, opts: Record<string, unknown> | undefined, reqId: number, instanceId: string): Promise<void> {
  try {
    const timeout = typeof opts?.timeout === 'number' ? opts.timeout : LIFO_TIMEOUT_MS;
    // 首次使用才 await sandbox 初始化（懒加载兜底；延迟预热通常已让内核就绪）。
    const sandbox = await getSandbox();
    const r = await sandbox.commands.run(command, { timeout });
    const payload: Record<string, unknown> = {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      // TASK18 输出上限：Lifo 结果同样截断，保证结果文件有界。
      stdout: capOutput(r.stdout),
      stderr: capOutput(r.stderr),
      runtime: 'lifo',
    };
    if (r.exitCode === 0 && CD_PREFIX_RE.test(command)) {
      const lifoCwd = sandbox.cwd;
      // cd 后 Lifo cwd → 会话 cwd（TASK23 同步；`cd /` 映射到工作区根 /workspace —— 否则
      // isUnderWorkspace('/') 为 false、会话 cwd 不更新，"回到根目录"不可达。决策见 host-route.ts）。
      const effectiveCwd = lifoCwdToSessionCwd(lifoCwd);
      if (effectiveCwd !== null) {
        setSessionCwd(currentInstanceId(), effectiveCwd);
        // 结果带会话 cwd 字段（新增可选协议字段，向后兼容）。
        payload.cwd = effectiveCwd;
      }
    }
    writeResult(reqId, payload, instanceId);
  } catch (e) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: String(e).slice(0, 200), runtime: 'lifo' }, instanceId);
  }
}
