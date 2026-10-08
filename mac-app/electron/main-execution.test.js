const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { RunRegistry } = require("./run-registry");

const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

/** 加载主进程执行边界；参数为可注入依赖；返回隔离上下文；不启动 Electron 或用户 CLI。 */
function mainContext(dependencies = {}) {
  const context = {
    Buffer, AbortSignal,
    gatewaySnapshot: { agents: [], rooms: [], settings: { localExecution: true } },
    runs: new RunRegistry(),
    terminals: { closeAll() {} },
    log: { info() {} },
    getHarnessSettings: () => ({}),
    sessionStore: () => ({}),
    ...dependencies,
  };
  for (const name of ["updateGatewayConfig", "harnessRequest", "openTerminal"]) {
    const fn = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(fn, `主进程缺少 ${name}`);
    vm.runInNewContext(`this.${name} = ${fn}`, context);
  }
  return context;
}

test("取消主电脑资格会中止桌面和网关任务并关闭全部终端，迟到任务不能继续执行", async () => {
  const signals = [];
  let closed = 0;
  const context = mainContext({
    terminals: { closeAll: () => { closed += 1; } },
    runHarness: (_payload, _paths, { signal }) => new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new Error("任务已停止")), { once: true });
    }),
  });
  const local = context.harnessRequest({ runId: "desktop-task", harness: "codex" });
  const remote = context.harnessRequest({ runId: "gateway-task", harness: "cursor" }, { signal: new AbortController().signal });
  context.updateGatewayConfig({ agents: [], rooms: [], settings: { localExecution: false } });
  await assert.rejects(local, /任务已停止/);
  await assert.rejects(remote, /任务已停止/);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal(closed, 1);
  await assert.rejects(context.harnessRequest({ runId: "late-task", harness: "codex" }), /开启本机执行/);
  assert.throws(() => context.openTerminal({ harness: "codex" }), /开启本机执行/);
  context.updateGatewayConfig({ agents: [], rooms: [], settings: { localExecution: false } });
  assert.equal(closed, 1);
});

test("主进程从成员配置补全模型和自动目录标记，显式请求保持优先", async () => {
  const requests = [];
  const context = mainContext({ runHarness: async (payload) => { requests.push(payload); return { ok: true, text: "完成" }; } });
  context.updateGatewayConfig({ agents: [{ id: "coder", name: "工程师", backend: "codex", harnessModel: "account-model", workspace: "/foreign/project", workspaceMode: "auto" }], rooms: [], settings: { localExecution: true } });
  await context.harnessRequest({ harness: "codex", agentId: "coder" });
  assert.equal(requests[0].harnessModel, "account-model");
  assert.equal(requests[0].agentName, "工程师");
  assert.equal(requests[0].workspaceMode, "auto");
  await context.harnessRequest({ harness: "codex", agentId: "coder", harnessModel: "override-model", workspaceMode: "project", cwd: "/local/project" });
  assert.equal(requests[1].harnessModel, "override-model");
  assert.equal(requests[1].cwd, "/local/project");
  assert.equal(requests[1].workspaceMode, "project");
});
