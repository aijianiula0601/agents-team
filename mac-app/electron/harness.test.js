const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { HarnessSessions } = require("./harness-sessions");
const { acquireHarnessWorkspace, buildCommand, extractOutput, runHarness, validateExecutablePath, validateWorkspace } = require("./harness");

/**
 * 确认 Codex 命令是非交互、限定工作区，并且最终回复会写到指定文件。
 */
test("codex 命令使用 exec 和非交互审批", () => {
  const command = buildCommand("codex", "/usr/bin/codex", "hello", "/tmp/ws", { outputFile: "/tmp/out.txt" });
  assert.equal(command.args[0], "exec");
  assert.equal(command.args.includes("--approve-for-me"), true);
  assert.equal(command.args.includes("--output-last-message"), true);
  assert.equal(command.args.includes("-s"), false);
  assert.equal(command.args.at(-1), "-");
  assert.equal(command.stdin, "hello");
  assert.equal(command.outputFile, "/tmp/out.txt");
});

/**
 * 确认 Cursor CLI 会信任工作区并限定目录，避免无界面时停在确认提示。
 */
test("cursor 命令带上 trust、force 和工作区", () => {
  const command = buildCommand("cursor", "/usr/bin/agent", "改一下说明", "/tmp/ws");
  assert.deepEqual(command.args.slice(0, 3), ["-p", "--output-format", "stream-json"]);
  assert.equal(command.args.includes("--stream-partial-output"), true);
  assert.equal(command.args.includes("--trust"), true);
  assert.equal(command.args.includes("--force"), true);
  assert.equal(command.args.includes("--workspace"), true);
  assert.equal(command.args.at(-1), "/tmp/ws");
  assert.equal(command.args.includes("改一下说明"), false);
  assert.equal(command.stdin, "改一下说明");
});

/**
 * 确认不存在的自定义路径会被拒绝，临时目录可以通过工作区校验。
 */
test("路径校验拒绝无效 CLI，并接受可写目录", () => {
  assert.throws(() => validateExecutablePath("/tmp/chorus-missing-cli", "Codex", "codex"), /不存在或不可执行/);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-ws-"));
  assert.equal(validateWorkspace(workspace), fs.realpathSync(workspace));
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * 确认额度耗尽时只保留可操作的说明，不把启动日志整段贴进群聊。
 */
test("codex 额度错误会被整理成说明", () => {
  const text = extractOutput(
    "codex",
    "",
    "OpenAI Codex v0.155.1\nERROR: Your workspace is out of credits. Ask your workspace owner to refill in order to continue.\nERROR: Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    false,
  );
  assert.match(text, /额度已用完/);
  assert.equal(text.includes("OpenAI Codex"), false);
});

/**
 * 确认讨论模式走 Cursor 的只读 ask，不会带上会改文件的 force。
 */
test("显式请求 ask 时 Cursor 保留只读兼容接口", () => {
  const command = buildCommand("cursor", "/usr/bin/agent", "你好", "/tmp/ws", { interaction: "ask" });
  assert.equal(command.args.includes("--mode"), true);
  assert.equal(command.args.includes("ask"), true);
  assert.equal(command.args.includes("--force"), false);
});

/**
 * 确认 Cursor 未登录时提示去设置里登录，而不是只抛英文堆栈。
 */
test("cursor 未登录时提示去设置里登录", () => {
  const text = extractOutput("cursor", "", "Error: Authentication required. Please run 'agent login' first.", false);
  assert.match(text, /尚未登录/);
});

test("显式请求 ask 时 Codex 和 Claude 保留只读兼容接口", () => {
  const codex = buildCommand("codex", "/usr/bin/codex", "问题", "/tmp/ws", { interaction: "ask" });
  assert.equal(codex.args.includes("read-only"), true);
  assert.equal(codex.args.includes("--approve-for-me"), false);
  const claude = buildCommand("claude", "/usr/bin/claude", "问题", "/tmp/ws", { interaction: "ask" });
  assert.equal(claude.args.includes("plan"), true);
  assert.equal(claude.args.includes("acceptEdits"), false);
  assert.equal(claude.args[claude.args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(claude.args.includes("--verbose"), true);
  assert.equal(claude.args.includes("--include-partial-messages"), true);
});

test("Codex JSONL 仅提取最终答复，结构化错误保留实际原因", () => {
  const output = [
    { type: "thread.started", thread_id: "test" },
    { type: "item.completed", item: { type: "agent_message", text: "真实回复" } },
  ].map(JSON.stringify).join("\n");
  assert.equal(extractOutput("codex", output, "启动日志", true), "真实回复");
  assert.match(extractOutput("codex", JSON.stringify({ type: "turn.failed", error: { message: "Authentication required" } }), "", false), /尚未登录/);
  assert.match(extractOutput("claude", JSON.stringify({ type: "result", is_error: true, result: "model unavailable" }), "", false), /model unavailable/);
});

function fakeCli(t, name, script) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-harness-"));
  const executable = path.join(workspace, name);
  fs.writeFileSync(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { workspace, executable };
}

test("退出失败时 Codex 的部分结果文件不能遮蔽真实错误", async (t) => {
  const { workspace, executable } = fakeCli(t, "codex", `
    const fs = require("fs");
    const args = process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "部分结果，不代表成功");
    process.stderr.write("ERROR: Authentication required\\n");
    process.exit(1);
  `);
  const result = await runHarness({ harness: "codex", cwd: workspace, prompt: "本地测试" }, { codex: executable });
  assert.equal(result.ok, false);
  assert.match(result.text, /尚未登录/);
  assert.equal(result.text.includes("部分结果"), false);
});

test("CLI JSON 显示失败时，即使退出码为 0 也不能成功", async (t) => {
  const { workspace, executable } = fakeCli(t, "claude", 'console.log(JSON.stringify({ type: "result", is_error: true, result: "quota exceeded" }));');
  const result = await runHarness({ harness: "claude", cwd: workspace, prompt: "本地测试" }, { claude: executable });
  assert.deepEqual(result, { ok: false, text: "quota exceeded" });
});

test("同一工作区可并行只读讨论，写入执行仍保持互斥", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", 'setTimeout(() => console.log(JSON.stringify({ type: "result", result: "完成" })), 150);');
  const paths = { cursor: executable };
  const request = { harness: "cursor", cwd: workspace, prompt: "本地测试", interaction: "ask" };
  const first = runHarness(request, paths);
  const second = runHarness(request, paths);
  await assert.rejects(runHarness({ ...request, interaction: "agent" }, paths), /正在执行/);
  const results = await Promise.all([first, second]);
  assert.equal(results.every((result) => result.ok && result.text === "完成"), true);
  assert.equal((await runHarness({ ...request, interaction: "agent" }, paths)).ok, true);
});

test("取消会结束真实子进程，释放工作区后可以重试", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const paths = { cursor: executable };
  const request = { harness: "cursor", cwd: workspace, prompt: "本地测试" };
  const pending = runHarness(request, paths, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 60);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, /任务已停止/);
  fs.writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({ result: "重试成功" }));\n`, { mode: 0o700 });
  assert.deepEqual(await runHarness(request, paths), { ok: true, text: "重试成功" });
});

test("原型字段不能被识别成可执行的 Harness", async () => {
  await assert.rejects(runHarness({ harness: "toString", prompt: "测试", cwd: os.tmpdir() }), /未知的 Harness/);
});

test("三种 CLI 的讨论和执行都通过 stdin 完整收到 512KB 附件", async (t) => {
  const prompt = "任务：检查两个附件\n" + "a".repeat(256 * 1024) + "\nFIRST_TAIL\n" + "b".repeat(256 * 1024) + "\nSECOND_TAIL";
  const digest = crypto.createHash("sha256").update(prompt).digest("hex");
  const expected = `${Buffer.byteLength(prompt, "utf8")}:${digest}:SECOND_TAIL`;
  for (const [harness, name] of [["codex", "codex"], ["claude", "claude"], ["cursor", "cursor-agent"]]) {
    const { workspace, executable } = fakeCli(t, name, `
      const chunks = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => {
        const input = Buffer.concat(chunks);
        const digest = require("crypto").createHash("sha256").update(input).digest("hex");
        const result = input.length + ":" + digest + ":" + input.toString("utf8").slice(-11);
        const output = ${JSON.stringify(harness)} === "codex"
          ? { type: "item.completed", item: { type: "agent_message", text: result } }
          : { type: "result", result };
        console.log(JSON.stringify(output));
      });
    `);
    for (const interaction of ["ask", "agent"]) {
      const command = buildCommand(harness, executable, prompt, workspace, { interaction });
      assert.equal(command.stdin, prompt);
      assert.equal(command.args.includes(prompt), false);
      assert.deepEqual(await runHarness({ harness, cwd: workspace, prompt, interaction }, { [harness]: executable }), { ok: true, text: expected });
    }
  }
});

test("CLI 输入超过 1MB 按 UTF-8 字节明确拒绝，不启动子进程", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", 'require("fs").writeFileSync("must-not-start", "started");');
  for (const prompt of ["x".repeat(1024 * 1024 + 1), "中".repeat(400000)]) {
    await assert.rejects(runHarness({ harness: "cursor", cwd: workspace, prompt }, { cursor: executable }), /不能超过 1 MB/);
  }
  assert.equal(fs.existsSync(path.join(workspace, "must-not-start")), false);
});

test("三种 CLI 正确恢复指定会话，保留可写执行参数和 stdin", () => {
  for (const harness of ["codex", "cursor", "claude"]) {
    const command = buildCommand(harness, `/usr/bin/${harness}`, "修改上次文件", "/tmp/ws", { sessionId: "session-123" });
    assert.equal(command.stdin, "修改上次文件");
    assert.equal(command.args.includes("session-123"), true);
    assert.equal(command.args.includes(harness === "codex" ? "resume" : "--resume"), true);
    assert.equal(command.args.includes("read-only"), false);
    assert.equal(command.args.includes("plan"), false);
    assert.equal(command.args.includes("ask"), false);
  }
});

test("Codex 会话编号不会被长工具日志挤掉，下一轮真实子进程使用 resume", async (t) => {
  const { workspace, executable } = fakeCli(t, "codex", `
    const fs = require("fs");
    const args = process.argv.slice(2);
    const resumed = args.includes("resume");
    process.stdin.resume();
    process.stdin.on("end", () => {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "test-session-123" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(50000) } }));
      if (resumed && args[args.indexOf("resume") + 1] !== "test-session-123") process.exit(2);
      fs.writeFileSync("acceptance.txt", resumed ? "changed" : "created");
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resumed ? "已修改" : "已创建" } }));
    });
  `);
  const sessions = new HarnessSessions();
  const request = { harness: "codex", cwd: workspace, prompt: "本地回归测试", threadKey: "private:coder", agentId: "coder" };
  assert.deepEqual(await runHarness(request, { codex: executable }, { sessions }), { ok: true, text: "已创建", sessionId: "test-session-123", resumed: false });
  assert.equal(fs.readFileSync(path.join(workspace, "acceptance.txt"), "utf8"), "created");
  assert.deepEqual(await runHarness(request, { codex: executable }, { sessions }), { ok: true, text: "已修改", sessionId: "test-session-123", resumed: true });
  assert.equal(fs.readFileSync(path.join(workspace, "acceptance.txt"), "utf8"), "changed");
});

test("Cursor 和 Claude 的 JSON 会话编号可恢复，完整回复不被日志缓冲区截断", async (t) => {
  for (const [harness, name] of [["cursor", "cursor-agent"], ["claude", "claude"]]) {
    const { workspace, executable } = fakeCli(t, name, `
      process.stdin.resume();
      process.stdin.on("end", () => console.log(JSON.stringify({ type: "result", session_id: "json-session-123", result: process.argv.includes("--resume") ? "第二轮" : "x".repeat(50000) + "FINAL_TAIL" })));
    `);
    const sessions = new HarnessSessions();
    const request = { harness, cwd: workspace, prompt: "本地回归测试", conversationId: "room:main" };
    const first = await runHarness(request, { [harness]: executable }, { sessions });
    assert.equal(first.text.length, 50010);
    assert.equal(first.text.endsWith("FINAL_TAIL"), true);
    assert.equal(first.sessionId, "json-session-123");
    assert.deepEqual(await runHarness(request, { [harness]: executable }, { sessions }), { ok: true, text: "第二轮", sessionId: "json-session-123", resumed: true });
  }
});

test("恢复会话失败保留原始错误，不重新创建会话伪装成功", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", `
    process.stdin.resume();
    process.stdin.on("end", () => console.log(JSON.stringify({ type: "result", session_id: "cursor-session-123", is_error: process.argv.includes("--resume"), result: process.argv.includes("--resume") ? "Session is unavailable" : "第一轮" })));
  `);
  const sessions = new HarnessSessions();
  const request = { harness: "cursor", cwd: workspace, prompt: "本地回归测试", threadKey: "room:main" };
  assert.equal((await runHarness(request, { cursor: executable }, { sessions })).ok, true);
  assert.deepEqual(await runHarness(request, { cursor: executable }, { sessions }), { ok: false, text: "Session is unavailable", sessionId: "cursor-session-123", resumed: true });
});

test("原生终端租约和后台编码互斥，关闭租约后后台可执行", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", 'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ result: "真实子进程执行完成" })));');
  const release = acquireHarnessWorkspace(workspace);
  t.after(release);
  const request = { harness: "cursor", cwd: workspace, prompt: "本地互斥检查" };
  await assert.rejects(runHarness(request, { cursor: executable }), /关闭终端/);
  assert.throws(() => acquireHarnessWorkspace(workspace), /正在执行/);
  release();
  release();
  assert.deepEqual(await runHarness(request, { cursor: executable }), { ok: true, text: "真实子进程执行完成" });
});

test("所有 CLI 模型选择独立传入 --model，禁止参数注入", () => {
  for (const harness of ["codex", "claude", "cursor"]) {
    const command = buildCommand(harness, `/bin/${harness}`, "你好", "/tmp/ws", { harnessModel: "account-model", sessionId: "existing-session" });
    assert.equal(command.args[command.args.indexOf("--model") + 1], "account-model");
    assert.equal(command.stdin, "你好");
    assert.throws(() => buildCommand(harness, `/bin/${harness}`, "你好", "/tmp/ws", { harnessModel: "--dangerous" }), /模型编号/);
  }
});

test("运行 CLI 无需先选目录，自动模式忽略远端路径并传递选定模型", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", `
    process.stdin.resume();
    process.stdin.on("end", () => {
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ result: JSON.stringify({ cwd: process.cwd(), model: args[args.indexOf("--model") + 1] }) }));
    });
  `);
  const root = path.join(workspace, "managed");
  for (const cwd of [undefined, "/another-computer/project"]) {
    const result = await runHarness({ harness: "cursor", agentId: "coder", agentName: "工程师", workspaceMode: "auto", cwd, harnessModel: "account-model", prompt: "你好" }, { cursor: executable }, { workspaceRoot: root });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.text), { cwd: path.join(fs.realpathSync(root), "工程师"), model: "account-model" });
  }
});

/**
 * 启动等待前端确认才结束的流式测试 CLI。
 * @param {object} t 测试上下文
 * @param {string} harness 内核类型
 * @param {object[]} events 逐行发送的事件，最后一项为最终结果
 * @returns {{workspace: string, executable: string}} 临时工作区和 CLI 路径
 * 注意事项：每个 JSON 行拆成两次写入；最终结果必须在 onText 已写入确认文件后才发送。
 */
function streamingCli(t, harness, events) {
  return fakeCli(t, harness === "cursor" ? "cursor-agent" : harness, `
    const fs = require("fs");
    const events = ${JSON.stringify(events)};
    const final = events.pop();
    let index = 0;
    // ------------ 模拟分片 stdout，最终结果等待真实流式回调确认 ---------------
    function send() {
      if (index === events.length) {
        const timer = setInterval(() => {
          if (!fs.existsSync("stream-ack")) return;
          clearInterval(timer);
          process.stdout.write(JSON.stringify(final));
        }, 10);
        return;
      }
      const line = JSON.stringify(events[index++]) + "\\n";
      const split = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, split));
      setTimeout(() => { process.stdout.write(line.slice(split)); send(); }, 5);
    }
    process.stdin.resume();
    process.stdin.on("end", send);
  `);
}

/** 验证 Cursor 的字符增量先于最终结果到达，并排除工具前后重复快照；无外部 CLI 或网络依赖。 */
test("Cursor 碎片流实时累计，忽略 flush 并去重最终结果", { timeout: 5000 }, async (t) => {
  const events = [
    { type: "system", subtype: "init", session_id: "cursor-stream-session" },
    { type: "user", message: { content: [{ type: "text", text: "用户输入不能显示为回复" }] } },
    { type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "正在" }] } },
    { type: "assistant", timestamp_ms: 2, message: { content: [{ type: "text", text: "处理" }] } },
    { type: "assistant", timestamp_ms: 3, model_call_id: "call-1", message: { content: [{ type: "text", text: "正在处理" }] } },
    { type: "tool_call", subtype: "completed", result: "工具日志不能显示为回复" },
    { type: "assistant", timestamp_ms: 4, message: { content: [{ type: "text", text: "，完成" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "正在处理，完成" }] } },
    { type: "result", result: "正在处理，完成" },
  ];
  const { workspace, executable } = streamingCli(t, "cursor", events);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const updates = [];
  const result = await runHarness({ harness: "cursor", cwd: workspace, prompt: "流式测试" }, { cursor: executable }, {
    signal: controller.signal,
    onText(text) {
      updates.push(text);
      if (text === "正在处理，完成") fs.writeFileSync(path.join(workspace, "stream-ack"), "received");
    },
  });
  assert.deepEqual(updates, ["正在", "正在处理", "正在处理，完成"]);
  assert.deepEqual(result, { ok: true, text: "正在处理，完成", sessionId: "cursor-stream-session", resumed: false });
});

/** 验证 Claude 的主会话文本流、快照及 result 覆盖；思考、子任务和可重试错误不污染最终答案。 */
test("Claude 流式文本跨消息累计，最终结果保持原始契约", { timeout: 5000 }, async (t) => {
  const events = [
    { type: "system", subtype: "api_retry", error: "overloaded", message: "Retrying request" },
    { type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "不可展示" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "段" } } },
    { type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "第一段" }] } },
    { type: "stream_event", parent_tool_use_id: "child-tool", event: { type: "content_block_delta", delta: { type: "text_delta", text: "子任务不可混入" } } },
    { type: "result", parent_tool_use_id: "child-tool", is_error: true, result: "子任务错误由主任务处理" },
    { type: "stream_event", event: { type: "message_start", message: { id: "message-2" } } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "最终" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "答复" } } },
    { type: "assistant", message: { id: "message-2", content: [{ type: "text", text: "最终答复" }] } },
    { type: "result", result: "最终答复" },
  ];
  const { workspace, executable } = streamingCli(t, "claude", events);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const updates = [];
  const result = await runHarness({ harness: "claude", cwd: workspace, prompt: "流式测试" }, { claude: executable }, {
    signal: controller.signal,
    onText(text) {
      updates.push(text);
      if (text === "第一段\n\n最终答复") fs.writeFileSync(path.join(workspace, "stream-ack"), "received");
    },
  });
  assert.deepEqual(updates, ["第一", "第一段", "第一段\n\n最终", "第一段\n\n最终答复", "最终答复"]);
  assert.deepEqual(result, { ok: true, text: "最终答复" });
});

/** 验证 Codex 在进程结束前消费更新和已完成消息；重复 completed 不重复追加，返回值仍是最后答复。 */
test("Codex JSONL 实时发布消息更新，保留最后答复", { timeout: 5000 }, async (t) => {
  const events = [
    { type: "item.started", item: { id: "item-1", type: "agent_message", text: "" } },
    { type: "item.updated", item: { id: "item-1", type: "agent_message", text: "正在处理" } },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "正在处理" } },
    { type: "item.completed", item: { id: "tool-1", type: "command_execution", text: "隐藏工具日志" } },
    { type: "item.completed", item: { id: "item-2", type: "agent_message", text: "已完成" } },
    { type: "turn.completed" },
  ];
  const { workspace, executable } = streamingCli(t, "codex", events);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const updates = [];
  const result = await runHarness({ harness: "codex", cwd: workspace, prompt: "流式测试" }, { codex: executable }, {
    signal: controller.signal,
    onText(text) {
      updates.push(text);
      if (text === "正在处理\n\n已完成") fs.writeFileSync(path.join(workspace, "stream-ack"), "received");
    },
  });
  assert.deepEqual(updates, ["正在处理", "正在处理\n\n已完成"]);
  assert.deepEqual(result, { ok: true, text: "已完成" });
});

/** 验证 31 分钟虚拟时间不会触发默认截止；取消仍终止真实子进程，并可再次获取工作区写锁。 */
test("长任务超过 30 分钟无默认截止，手动取消后释放工作区", { timeout: 5000 }, async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", `
    process.stdout.write(JSON.stringify({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "任务已启动" }] } }) + "\\n");
    setInterval(() => {}, 1000);
  `);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sentSignals = [];
  const originalKill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid, signal) => { sentSignals.push(signal); return originalKill(pid, signal); });
  const controller = new AbortController();
  t.after(() => controller.abort());
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const pending = runHarness({ harness: "cursor", cwd: workspace, prompt: "长任务测试" }, { cursor: executable }, { signal: controller.signal, onText: notifyStarted });
  const rejected = assert.rejects(pending, /任务已停止/);
  assert.equal(await started, "任务已启动");
  t.mock.timers.tick(31 * 60 * 1000);
  assert.deepEqual(sentSignals, []);
  assert.throws(() => acquireHarnessWorkspace(workspace), /正在执行/);
  controller.abort();
  await rejected;
  assert.deepEqual(sentSignals, ["SIGTERM"]);
  const release = acquireHarnessWorkspace(workspace);
  release();
});

/** 验证流式监听失败不破坏执行和工作区租约；参数由测试上下文提供，无外部依赖。 */
test("流式回调异常不影响最终结果和工作区释放", async (t) => {
  const { workspace, executable } = fakeCli(t, "cursor-agent", 'process.stdout.write(JSON.stringify({ type: "result", result: "成功" }));');
  const result = await runHarness({ harness: "cursor", cwd: workspace, prompt: "回调异常测试" }, { cursor: executable }, { onText() { throw new Error("模拟窗口关闭"); } });
  assert.deepEqual(result, { ok: true, text: "成功" });
  const release = acquireHarnessWorkspace(workspace);
  release();
});
