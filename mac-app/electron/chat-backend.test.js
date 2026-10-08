const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { completeAgentChat } = require("./chat-backend");

test("默认模型报错时保留错误，绝不静默转用 CLI", async () => {
  let cliCalled = false;
  await assert.rejects(completeAgentChat({ agent: { provider: "openai" }, messages: [{ content: "测试" }] }, {
    completeModel: async () => { throw new Error("还没有 OpenAI API Key"); },
    runCli: async () => { cliCalled = true; return { ok: true, text: "错误回退" }; },
  }), /还没有 OpenAI/);
  assert.equal(cliCalled, false);
});

test("每种 CLI 后台默认可写执行，并收到团队上下文和稳定对话编号", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-chat-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const backend of ["codex", "claude", "cursor"]) {
    let request;
    const result = await completeAgentChat({
      agent: { id: backend, backend, name: "设计师", role: "页面设计", persona: "根据需求提供方案" },
      messages: [{ role: "user", content: "用户：完成安卓应用" }, { role: "assistant", content: "工程师：安装包可生成" }],
      workspace: temp,
      threadKey: "room:main",
    }, {
      runCli: async (options) => { request = options; return { ok: true, text: "可以继续" }; },
    });
    assert.deepEqual(result, { text: "可以继续", via: backend });
    assert.equal(request.harness, backend);
    assert.equal(request.interaction, "agent");
    assert.equal(request.threadKey, "room:main");
    assert.equal(request.agentId, backend);
    assert.match(request.prompt, /工程师：安装包可生成/);
    assert.match(request.prompt, /直接修改文件和运行命令/);
    assert.equal(request.prompt.includes("只读"), false);
    assert.equal(request.prompt.includes("只属于你的"), false);
    assert.equal(fs.statSync(request.cwd).isDirectory(), true);
  }
});

test("明确绑定的无效工作区不能悄悄换成临时目录", async () => {
  let invoked = false;
  await assert.rejects(completeAgentChat({ agent: { backend: "cursor" }, messages: [{ content: "测试" }], workspace: "/chorus/does-not-exist" }, {
    runCli: async () => { invoked = true; return { ok: true, text: "ok" }; },
  }), /工作区不存在/);
  assert.equal(invoked, false);
});

test("CLI 实际失败不能被返回为成功讨论", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-chat-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  await assert.rejects(completeAgentChat({ agent: { backend: "codex" }, messages: [{ content: "测试" }], workspace: temp }, {
    runCli: async () => ({ ok: false, text: "账号额度已用完" }),
  }), /额度已用完/);
});

test("后台类型错误和空对话在调用 CLI 前就被拒绝", async () => {
  await assert.rejects(completeAgentChat({ agent: { backend: "invalid" }, messages: [{ content: "测试" }] }), /讨论后台/);
  await assert.rejects(completeAgentChat({ agent: { backend: "claude" }, messages: [] }), /对话内容为空/);
});

test("CLI 讨论完整保留历史及 512KB 附件尾标记，超限不调用后台", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-chat-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const history = "h".repeat(150000) + "HISTORY_TAIL";
  const attachment = "a".repeat(512 * 1024) + "ATTACHMENT_TAIL";
  for (const backend of ["codex", "claude", "cursor"]) {
    let prompt;
    let called = false;
    const context = {
      runCli: async (options) => { called = true; prompt = options.prompt; return { ok: true, text: "完整接收" }; },
    };
    const agent = { id: backend, backend, name: "工程师" };
    await completeAgentChat({ agent, workspace: temp, messages: [{ content: history }, { content: attachment }] }, context);
    assert.equal(prompt.includes(history), true);
    assert.equal(prompt.endsWith("ATTACHMENT_TAIL"), true);
    called = false;
    await assert.rejects(completeAgentChat({ agent, workspace: temp, messages: [{ content: "x".repeat(1024 * 1024 + 1) }] }, context), /不能超过 1 MB/);
    assert.equal(called, false);
  }
});

test("CLI 未设置工作区时自动创建成员目录，团队成员互相隔离", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-default-chat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const members = [{ id: "a", name: "架构师", backend: "codex" }, { id: "b", name: "工程师", backend: "codex" }];
  const directories = [];
  for (const agent of members) {
    await completeAgentChat({ agent, messages: [{ content: "创建成员文件" }], threadKey: "room:shared" }, {
      workspaceRoot: root, workspaceAgents: members,
      runCli: async (request) => { directories.push(request.cwd); fs.writeFileSync(path.join(request.cwd, "member.txt"), agent.id); return { ok: true, text: "完成" }; },
    });
  }
  assert.notEqual(directories[0], directories[1]);
  assert.equal(path.basename(directories[0]), "架构师");
  assert.equal(path.basename(directories[1]), "工程师");
  assert.equal(fs.readFileSync(path.join(directories[0], "member.txt"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(directories[1], "member.txt"), "utf8"), "b");
});

test("直连模型不校验或创建目录，CLI 自动目录与执行模型互不混淆", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-model-directory-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "not-created");
  const agent = { id: "writer", name: "写作者", backend: "model", model: "direct-model", harnessModel: "cli-model", workspace: "/another-device/project", workspaceMode: "auto" };
  await completeAgentChat({ agent, messages: [{ content: "你好" }] }, { workspaceRoot: root, completeModel: async (request) => { assert.equal(request.model, "direct-model"); return "完成"; } });
  assert.equal(fs.existsSync(root), false);
  await completeAgentChat({ agent: { ...agent, backend: "codex" }, workspace: agent.workspace, messages: [{ content: "你好" }] }, {
    workspaceRoot: root,
    workspaceAgents: [{ id: "model-only", name: "纯对话成员", backend: "model", harness: "none" }],
    runCli: async (request) => {
      assert.equal(request.harnessModel, "cli-model");
      assert.equal(request.model, undefined);
      assert.equal(request.cwd, path.join(fs.realpathSync(root), "写作者"));
      return { ok: true, text: "完成" };
    },
  });
  assert.deepEqual(fs.readdirSync(root), ["写作者"]);
});

test("模型和三种 CLI 后台原样传递累计文本回调及取消信号", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-progress-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const backend of ["model", "codex", "claude", "cursor"]) {
    const updates = [];
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      onText: (text) => updates.push(text),
      completeModel: async (_agent, _messages, _keys, options) => { assert.equal(options.signal, controller.signal); options.onText("模型片段"); return "模型完成"; },
      runCli: async (_request, _paths, options) => { assert.equal(options.signal, controller.signal); options.onText("CLI 片段"); return { ok: true, text: "CLI 完成" }; },
    };
    await completeAgentChat({ agent: { backend }, workspace: temp, messages: [{ content: "测试" }] }, context);
    assert.deepEqual(updates, [backend === "model" ? "模型片段" : "CLI 片段"]);
  }
});
