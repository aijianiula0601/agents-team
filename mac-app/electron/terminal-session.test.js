const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TerminalSessionManager, buildInteractiveCommand } = require("./terminal-session");
const { acquireHarnessWorkspace, validateWorkspace } = require("./harness");

function fixture(options = {}) {
  const calls = [];
  const events = [];
  const processes = [];
  const pty = {
    spawn(cmd, args, spawnOptions) {
      calls.push({ cmd, args, options: spawnOptions });
      const dataListeners = new Set();
      const exitListeners = new Set();
      const process = {
        pid: 12345, input: [], sizes: [], signals: [],
        write(data) { this.input.push(data); },
        resize(cols, rows) { this.sizes.push({ cols, rows }); },
        kill(signal) { this.signals.push(signal); this.exit(0, 15); },
        onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
        onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
        data(data) { for (const listener of [...dataListeners]) listener(data); },
        exit(exitCode, signal = 0) { for (const listener of [...exitListeners]) listener({ exitCode, signal }); },
      };
      processes.push(process);
      return process;
    },
  };
  const manager = new TerminalSessionManager({
    pty, onEvent: (event) => events.push(event),
    resolveExecutable: (harness) => `/bin/${harness}`,
    validateWorkspace: (cwd) => { if (!cwd) throw new Error("请先选择工作区"); return cwd; },
    childEnv: () => ({ PATH: "/bin", CI: "true", EXAMPLE: "retained" }),
    acquireWorkspace: () => () => {},
    killProcessTree: (process, signal) => process.kill(signal),
    ...options,
  });
  return { manager, calls, processes, events };
}

test("三个交互终端直接启动 TUI，不强制只读或跳过审批", () => {
  assert.deepEqual(buildInteractiveCommand("codex", "/bin/codex", "/tmp/work"), { cmd: "/bin/codex", args: ["-C", "/tmp/work"] });
  assert.deepEqual(buildInteractiveCommand("cursor", "/bin/agent", "/tmp/work"), { cmd: "/bin/agent", args: ["--workspace", "/tmp/work"] });
  assert.deepEqual(buildInteractiveCommand("claude", "/bin/claude", "/tmp/work"), { cmd: "/bin/claude", args: [] });
  assert.throws(() => buildInteractiveCommand("unknown", "/bin/sh", "/tmp/work"), /未知/);
});

test("已知聊天会话使用原生 resume 接续，不能将选项伪装成会话编号", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  assert.deepEqual(buildInteractiveCommand("codex", "/bin/codex", "/tmp/work", id).args, ["resume", id, "-C", "/tmp/work"]);
  assert.deepEqual(buildInteractiveCommand("cursor", "/bin/agent", "/tmp/work", id).args, ["--resume", id, "--workspace", "/tmp/work"]);
  assert.deepEqual(buildInteractiveCommand("claude", "/bin/claude", "/tmp/work", id).args, ["--resume", id]);
  const { manager } = fixture();
  const session = manager.open({ harness: "codex", cwd: "/tmp/work", resumeSessionId: id });
  assert.equal(session.resumeSessionId, id);
  assert.throws(() => manager.open({ harness: "codex", cwd: "/tmp/work", resumeSessionId: "--dangerously-bypass-approvals-and-sandbox" }), /会话编号/);
  manager.closeAll();
});

test("PTY 使用显式工作区与真实终端环境", () => {
  const { manager, calls } = fixture();
  const result = manager.open({ harness: "codex", cwd: "/tmp/work", agentId: "a1", cols: 120, rows: 40 });
  assert.equal(result.status, "running");
  assert.equal(result.agentId, "a1");
  assert.equal(calls[0].options.cwd, "/tmp/work");
  assert.equal(calls[0].options.cols, 120);
  assert.equal(calls[0].options.rows, 40);
  assert.equal(calls[0].options.env.TERM, "xterm-256color");
  assert.equal(calls[0].options.env.CI, undefined);
  assert.equal(calls[0].options.env.EXAMPLE, "retained");
  manager.closeAll();
});

test("原始 ANSI、中文、方向键和 Ctrl+C 在终端完整往返", () => {
  const { manager, processes, events } = fixture();
  const { sessionId } = manager.open({ harness: "cursor", cwd: "/tmp/work" });
  const output = "\u001b[32m完整 Agent终端\u001b[0m\r\n❯ ";
  processes[0].data(output);
  assert.deepEqual(events[0], { sessionId, type: "data", data: output, startOffset: 0, nextOffset: output.length });
  assert.equal(manager.read(sessionId).output, output);
  manager.write(sessionId, "你好\r\u001b[A\u0003");
  assert.deepEqual(processes[0].input, ["你好\r\u001b[A\u0003"]);
  manager.resize(sessionId, { cols: 80, rows: 24 });
  assert.deepEqual(processes[0].sizes, [{ cols: 80, rows: 24 }]);
  manager.closeAll();
});

test("增量读取与滚动缓冲不会把新输出重复追加或拆开代理对", () => {
  const { manager, processes } = fixture({ maxBufferLength: 7 });
  const { sessionId } = manager.open({ harness: "codex", cwd: "/tmp/work" });
  processes[0].data("012345");
  const first = manager.read(sessionId);
  processes[0].data("😀中abc");
  assert.equal(manager.read(sessionId, { after: first.nextOffset }).output, "😀中abc");
  const resumed = manager.read(sessionId);
  assert.equal(resumed.reset, true);
  assert.equal(resumed.output, "5😀中abc");
  assert.equal(resumed.nextOffset, 12);
  assert.equal(manager.read(sessionId, { after: resumed.nextOffset }).output, "");
  processes[0].data("Z");
  assert.equal(manager.read(sessionId).output, "😀中abcZ");
  processes[0].data("Y");
  assert.equal(manager.read(sessionId).output, "中abcZY");
  manager.closeAll();
});

test("同一 Agent 重新打开复用活动进程，更换工作区须明确关闭", () => {
  const { manager, calls } = fixture();
  const options = { harness: "codex", cwd: "/tmp/work", agentId: "a1" };
  const original = manager.open(options);
  assert.equal(manager.open(options).sessionId, original.sessionId);
  assert.equal(calls.length, 1);
  assert.throws(() => manager.open({ ...options, cwd: "/tmp/other" }), /先关闭/);
  assert.throws(() => manager.open({ ...options, harness: "cursor" }), /先关闭/);
  manager.closeAll();
});

test("CLI 退出保留结果与退出码，再次打开启动新进程", () => {
  const { manager, processes, calls, events } = fixture();
  const options = { harness: "codex", cwd: "/tmp/work", agentId: "a1" };
  const original = manager.open(options);
  processes[0].data("done");
  processes[0].exit(2, 0);
  assert.equal(manager.read(original.sessionId).status, "exited");
  assert.equal(manager.read(original.sessionId).exitCode, 2);
  assert.equal(events.at(-1).type, "exit");
  assert.throws(() => manager.write(original.sessionId, "hi"), /已经退出/);
  assert.notEqual(manager.open(options).sessionId, original.sessionId);
  assert.equal(calls.length, 2);
  manager.closeAll();
});

test("同一 Agent 在不同聊天中的终端身份与历史会话不混用", () => {
  const { manager, calls } = fixture();
  const options = { harness: "codex", cwd: "/tmp/work", agentId: "a1" };
  const privateSession = manager.open({ ...options, threadKey: "agent:a1", resumeSessionId: "private-session" });
  const teamSession = manager.open({ ...options, threadKey: "room:r1", resumeSessionId: "team-session" });
  assert.notEqual(privateSession.sessionId, teamSession.sessionId);
  assert.equal(teamSession.threadKey, "room:r1");
  assert.equal(teamSession.resumeSessionId, "team-session");
  assert.equal(calls.length, 2);
  manager.closeAll();
});

test("关闭会话释放监听与进程，迟到输出不会重新出现", () => {
  const { manager, processes, events } = fixture();
  const { sessionId } = manager.open({ harness: "cursor", cwd: "/tmp/work" });
  assert.deepEqual(manager.close(sessionId), { closed: true });
  assert.deepEqual(processes[0].signals, ["SIGTERM"]);
  processes[0].data("late output");
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "closed");
  assert.deepEqual(manager.close(sessionId), { closed: false });
  assert.equal(manager.list().length, 0);
});

test("会话数量、输入长度、读取位置和尺寸边界都在后台校验", () => {
  const { manager } = fixture({ maxSessions: 1 });
  assert.throws(() => manager.open({ harness: "codex", cwd: "", workspaceMode: "project" }), /项目目录/);
  assert.throws(() => manager.open({ harness: "codex", cwd: "/tmp/work", rows: 0 }), /尺寸/);
  assert.throws(() => manager.open({ harness: "model", cwd: "/tmp/work" }), /未知/);
  const { sessionId } = manager.open({ harness: "codex", cwd: "/tmp/work" });
  assert.throws(() => manager.open({ harness: "cursor", cwd: "/tmp/work" }), /最多/);
  assert.throws(() => manager.write(sessionId, "中".repeat(22000)), /64 KB/);
  assert.throws(() => manager.write(sessionId, {}), /输入/);
  assert.throws(() => manager.resize(sessionId, { cols: 501, rows: 10 }), /尺寸/);
  assert.throws(() => manager.read(sessionId, { after: -1 }), /位置/);
  assert.throws(() => manager.read(sessionId, { after: 1 }), /位置/);
  assert.throws(() => manager.read(sessionId, null), /参数/);
  assert.throws(() => manager.write("invented", "hi"), /编号/);
  manager.closeAll();
});

test("CLI 启动失败不留下幽灵会话", () => {
  const { manager } = fixture({ pty: { spawn() { throw new Error("spawn failed"); } } });
  assert.throws(() => manager.open({ harness: "codex", cwd: "/tmp/work" }), /spawn failed/);
  assert.equal(manager.list().length, 0);
});

test("PTY 与自动聊天执行共用工作区写锁，退出、关闭和启动失败都会释放", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-pty-lock-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { manager, processes } = fixture({ acquireWorkspace: acquireHarnessWorkspace, validateWorkspace });
  const options = { harness: "codex", cwd: workspace };
  const first = manager.open(options);
  assert.throws(() => acquireHarnessWorkspace(workspace, "agent"), /正在执行/);
  assert.throws(() => manager.open({ ...options, harness: "cursor" }), /正在执行/);
  processes[0].exit(0);
  const second = manager.open(options);
  manager.close(second.sessionId);
  const release = acquireHarnessWorkspace(workspace, "agent");
  release();
  manager.close(first.sessionId);
  const failed = fixture({ acquireWorkspace: acquireHarnessWorkspace, validateWorkspace, pty: { spawn() { throw new Error("spawn failed"); } } }).manager;
  assert.throws(() => failed.open(options), /spawn failed/);
  acquireHarnessWorkspace(workspace, "agent")();
});

test("终端将模型传入 CLI，活动终端不能静默更换模型", () => {
  const { manager, calls } = fixture({ resolveWorkspace: () => "/local/managed/coder" });
  const request = { harness: "codex", agentId: "coder", workspaceMode: "auto", cwd: "/foreign/computer/project", harnessModel: "account-model" };
  const session = manager.open(request);
  assert.equal(session.cwd, "/local/managed/coder");
  assert.equal(session.harnessModel, "account-model");
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "account-model");
  assert.throws(() => manager.open({ ...request, harnessModel: "different-model" }), /先关闭/);
  manager.closeAll();
  for (const harness of ["codex", "claude", "cursor"]) {
    const command = buildInteractiveCommand(harness, `/bin/${harness}`, "/tmp/work", "existing-session", "account-model");
    assert.equal(command.args[command.args.indexOf("--model") + 1], "account-model");
    assert.equal(command.args.includes("existing-session"), true);
  }
});
