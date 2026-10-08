const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const C = require("../shared/web/conversation");

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/model-client.js"), "utf8");
const APP_SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const AGENTS = [
  { id: "designer", name: "设计师" },
  { id: "engineer", name: "工程师" },
  { id: "reviewer", name: "审查员" },
];
const MODEL_AGENT = {
  id: "synthetic", name: "测试员", role: "集成测试", persona: "仅用于本地测试",
  backend: "model", provider: "custom", model: "synthetic-model", endpoint: "https://model.example.test/v1", temperature: 0.7,
};
const QUESTION = [{ role: "user", content: "本地合成测试，不发送真实对话" }];

function loadClient(options = {}) {
  const calls = [];
  const request = options.request || (async () => ({ status: 200, data: JSON.stringify({ choices: [{ message: { content: "测试成功" } }] }) }));
  const context = {
    ChorusConversation: C,
    AbortController, TextEncoder, TextDecoder,
    clearTimeout,
    setTimeout: options.timeoutMs ? (callback) => setTimeout(callback, options.timeoutMs) : setTimeout,
    fetch: options.fetch || (() => { throw new Error("原生请求不应调用浏览器 fetch"); }),
    Capacitor: options.web ? undefined : {
      getPlatform: () => "android",
      Plugins: { CapacitorHttp: { request: (payload) => { calls.push(payload); return request(payload); } } },
    },
  };
  vm.runInNewContext(CLIENT_SOURCE, context, { filename: "model-client.js" });
  return { complete: context.ChorusModelClient.complete, calls };
}

function appFunctions(names, context) {
  const source = names.map((name) => {
    const match = APP_SOURCE.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, `${name} 应保持为可独立验证的函数`);
    return `${match[0]}; this.${name} = ${name};`;
  }).join("\n");
  vm.runInNewContext(source, context, { filename: "app.js" });
  return context;
}

function frontendState(overrides = {}) {
  return {
    version: "0.4.0", agents: [], rooms: [], desktopAgentIds: [], desktopRoomIds: [],
    desktopConnectionInfo: null, connectionBusy: false, sending: false, panelMode: "agent",
    settings: { localExecution: true, apiKeys: { openai: "phone-key", custom: "phone-custom-key" }, desktopConnection: { baseUrl: "http://192.168.1.2:47631", token: "synthetic-token" } },
    ...overrides,
  };
}

test("CLI Agent 允许自动工作区，后台与执行内核始终一致", () => {
  assert.equal(C.validateAgent({ name: "编程员", backend: "codex", workspace: "" }, []).harness, "codex");
  const draft = C.validateAgent({ name: "编程员", backend: "cursor", harness: "claude", workspace: "/synthetic/project" }, []);
  assert.equal(draft.harness, "cursor");
});

test("电脑准备默认工作区时保留显式路径，并将实际目录补回成员", async () => {
  const agents = [{ id: "a", name: "架构师", backend: "codex", workspace: "" }, { id: "b", name: "工程师", backend: "codex", workspace: "/old/project" }];
  const state = frontendState({ agents, accountScope: "account-a" });
  let roster;
  const context = appFunctions(["prepareDesktopWorkspaces"], {
    state, conversationEpoch: 0, isPrimaryDevice: () => true,
    window: { chorusDesktop: { prepareAgentWorkspaces: async (items) => { roster = items; return items.map((agent) => ({ id: agent.id, workspace: agent.workspace || `/default/${agent.name}` })); } } },
  });
  assert.equal(await context.prepareDesktopWorkspaces(), true);
  assert.equal(agents[0].workspace, "/default/架构师");
  assert.equal(agents[1].workspace, "/old/project");
  assert.equal(roster.length, 2);
  assert.equal(await context.prepareDesktopWorkspaces(), false);
});

test("手机不创建工作区，晚到默认路径不能覆盖切换账号或用户已改的路径", async () => {
  const agent = { id: "a", name: "工程师", backend: "codex", workspace: "" };
  const state = frontendState({ agents: [agent], accountScope: "account-a" });
  let finish, calls = 0;
  const context = appFunctions(["prepareDesktopWorkspaces"], {
    state, conversationEpoch: 0, primary: false, isPrimaryDevice: () => context.primary,
    window: { chorusDesktop: { prepareAgentWorkspaces: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } } },
  });
  assert.equal(await context.prepareDesktopWorkspaces(), false);
  assert.equal(calls, 0);
  context.primary = true;
  const stale = context.prepareDesktopWorkspaces();
  state.accountScope = "account-b";
  finish([{ id: "a", workspace: "/default/工程师" }]);
  assert.equal(await stale, false);
  assert.equal(agent.workspace, "");
  const edited = context.prepareDesktopWorkspaces();
  agent.workspace = "/user/chosen";
  finish([{ id: "a", workspace: "/default/工程师" }]);
  assert.equal(await edited, false);
  assert.equal(agent.workspace, "/user/chosen");
});

test("同一团队的回复传入各自成员目录，不使用团队旧共享目录", async () => {
  const agents = [{ ...MODEL_AGENT, id: "a", name: "架构师", backend: "codex", workspace: "" }, { ...MODEL_AGENT, id: "b", name: "工程师", backend: "codex", workspace: "" }];
  const state = frontendState({ agents });
  const payloads = [];
  const context = appFunctions(["prepareDesktopWorkspaces", "produceReply"], {
    state, conversationEpoch: 0, isPrimaryDevice: () => true, HARNESS_LABEL: { codex: "Codex" },
    window: { chorusDesktop: { prepareAgentWorkspaces: async (items) => items.map((item) => ({ id: item.id, workspace: item.workspace || `/default/${item.name}` })), completeChat: async (payload) => { payloads.push(payload); return { text: "完成", via: "codex" }; } } },
    desktopManagedAgent: () => false, usingDesktopAgent: () => false, buildModelMessages: () => QUESTION,
    publishGatewayConfig: async () => {}, hasDesktopModelStorage: () => true,
  });
  const team = { key: "room:shared", team: true, owner: { name: "团队", workspace: "/old/shared" } };
  for (const agent of agents) await context.produceReply(agent, "同一任务", { mode: "discuss", context: team });
  assert.deepEqual(payloads.map((payload) => payload.workspace), ["/default/架构师", "/default/工程师"]);
  assert.ok(payloads.every((payload) => payload.threadKey === "room:shared"));
});

test("网关配置白名单不包含模型凭据、连接令牌、线程或附件", () => {
  const snapshot = C.gatewaySnapshot([{ ...MODEL_AGENT, apiKey: "agent-secret", keys: { custom: "custom-secret" }, messages: [{ text: "私聊正文" }], backend: "cursor", harness: "none", workspace: "/synthetic/project" }], [{ id: "team", name: "开发组", agentIds: ["synthetic"], messages: [{ text: "团队正文" }], token: "room-secret" }], false);
  assert.equal(snapshot.agents[0].harness, "cursor");
  assert.equal(snapshot.settings.localExecution, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|messages|私聊正文|团队正文|apiKey|token/);
  assert.deepEqual(Object.keys(snapshot.settings), ["localExecution"]);
});

test("导入桌面白名单配置保持同 ID 线程引用，并保留手机独立 Agent 与团队", () => {
  const privateThread = [{ id: "p1", from: "you", text: "私聊上下文", attachments: [{ name: "说明.md", text: "私密附件" }] }];
  const teamThread = [{ id: "t1", from: "you", text: "团队上下文" }];
  const local = { id: "phone-only", name: "手机模型", backend: "model", messages: [{ text: "手机线程" }] };
  const result = C.importGatewayConfig([{ ...MODEL_AGENT, messages: privateThread }, local], [{ id: "team", name: "旧团队", agentIds: ["synthetic"], messages: teamThread }, { id: "phone-team", name: "手机团队", agentIds: ["phone-only"] }], {
    agents: [{ ...MODEL_AGENT, role: "更新角色", backend: "codex", workspace: "/mac/project", messages: [{ text: "不可导入的 Mac 私聊" }], apiKey: "不可导入的凭据" }],
    rooms: [{ id: "team", name: "更新团队", agentIds: ["synthetic", "unknown"], messages: [{ text: "不可导入的 Mac 团队记录" }] }], settings: { localExecution: false, apiKeys: { custom: "Mac-key" } },
  });
  assert.equal(result.agents[0].messages, privateThread);
  assert.equal(result.rooms[0].messages, teamThread);
  assert.equal(result.agents[0].workspace, "/mac/project");
  assert.equal(result.agents[1], local);
  assert.equal(result.rooms[1].id, "phone-team");
  assert.deepEqual(result.rooms[0].agentIds, ["synthetic"]);
  assert.deepEqual(result.remoteAgentIds, ["synthetic"]);
  assert.deepEqual(result.remoteRoomIds, ["team"]);
  assert.equal(result.localExecution, false);
  assert.doesNotMatch(JSON.stringify(result), /不可导入|Mac-key/);
});

test("默认 CLI 聊天在发送前校验本机执行、工作区和桌面连接", () => {
  const agent = { id: "cli", name: "编程员", backend: "codex", harness: "codex", workspace: "/synthetic/project" };
  const state = frontendState();
  const context = appFunctions(["desktopManagedAgent", "usingDesktopAgent", "validateSend"], { state, window: { chorusDesktop: { completeChat() {} } }, HARNESS_LABEL: { codex: "Codex" }, isPrimaryDevice: () => true });
  assert.equal(context.validateSend("discuss", [agent]), "");
  state.settings.localExecution = false;
  assert.match(context.validateSend("discuss", [agent]), /本机执行已关闭/);
  state.settings.localExecution = true;
  assert.match(context.validateSend("discuss", [{ ...agent, workspace: "" }]), /工作区/);
  context.window.chorusDesktop = undefined;
  assert.match(context.validateSend("discuss", [agent]), /连接 Mac/);
  state.desktopAgentIds = ["cli"];
  state.desktopConnectionInfo = { capabilities: { chat: true } };
  assert.equal(context.validateSend("discuss", [agent]), "");
  state.panelMode = "room"; state.activeRoomId = "phone-team";
  assert.match(context.validateSend("discuss", [agent]), /团队尚未在 Mac 配置/);
  state.desktopRoomIds = ["phone-team"];
  assert.equal(context.validateSend("discuss", [agent]), "");
  state.desktopConnectionInfo = null;
  assert.match(context.validateSend("discuss", [agent]), /重新连接/);
});

test("已撤销的 Mac 模型 Agent 保留线程，但不能偷偷改用手机密钥请求", async () => {
  const original = { ...MODEL_AGENT, desktopManaged: true, messages: [{ from: "you", text: "保留的旧线程" }] };
  const imported = C.importGatewayConfig([original], [], { agents: [{ id: "replacement", name: "新 Mac 成员", backend: "model" }], rooms: [] });
  assert.equal(imported.agents[1].messages, original.messages);
  assert.equal(imported.agents[1].desktopManaged, true);
  const state = frontendState({ agents: imported.agents, desktopAgentIds: imported.remoteAgentIds, desktopConnectionInfo: { capabilities: { chat: true } } });
  let called = false;
  const context = appFunctions(["desktopManagedAgent", "usingDesktopAgent", "validateSend", "produceReply"], { state, window: {}, isPrimaryDevice: () => true, HARNESS_LABEL: {}, buildModelMessages: () => QUESTION, completeChatInPage: async () => { called = true; } });
  assert.match(context.validateSend("discuss", [original]), /白名单/);
  await assert.rejects(context.produceReply(original, "合成任务", { context: { key: "agent:synthetic" } }), /白名单已失效/);
  assert.equal(called, false);
});

test("Mac CLI 聊天发送稳定线程标识与工作区，安全存储存在时不复制密钥", async () => {
  let payload;
  const state = frontendState();
  const agent = { ...MODEL_AGENT, backend: "codex", harness: "codex", workspace: "/synthetic/project" };
  const context = appFunctions(["produceReply"], {
    state, window: { chorusDesktop: { completeChat: async (value) => { payload = value; return { text: "真实后端结果", via: "codex" }; } } },
    desktopManagedAgent: () => false, usingDesktopAgent: () => false, publishGatewayConfig: async () => {}, hasDesktopModelStorage: () => true,
    buildModelMessages: () => QUESTION, backendLabel: () => "Codex", HARNESS_LABEL: { codex: "Codex" },
  });
  const result = await context.produceReply(agent, "合成任务", { mode: "discuss", context: { key: "room:team", team: true, owner: { name: "测试团队" } }, runId: "synthetic-run" });
  assert.equal(payload.threadKey, "room:team");
  assert.equal(payload.agentId, agent.id);
  assert.equal(payload.workspace, agent.workspace);
  assert.equal(payload.agent.backend, "codex");
  assert.equal(payload.runId, "synthetic-run");
  assert.equal(payload.keys, undefined);
  assert.match(payload.agent.persona, /测试团队/);
  assert.equal(result.text, "真实后端结果");
});

test("旧执行消息重试也携带稳定线程标识，不重建一个无关 CLI 会话", async () => {
  let payload;
  const state = frontendState();
  const context = appFunctions(["produceReply"], {
    state, window: { chorusDesktop: { runHarness: async (value) => { payload = value; return { ok: true, text: "执行输出" }; } } },
    desktopManagedAgent: () => false, usingDesktopAgent: () => false, publishGatewayConfig: async () => {}, buildModelMessages: () => QUESTION,
    HARNESS_LABEL: { codex: "Codex" },
  });
  await context.produceReply({ ...MODEL_AGENT, harness: "codex", workspace: "/synthetic/project" }, "合成任务", { mode: "execute", context: { key: "agent:synthetic", team: false }, runId: "synthetic-run" });
  assert.equal(payload.threadKey, "agent:synthetic");
  assert.equal(payload.agentId, "synthetic");
  assert.match(payload.prompt, /本地合成测试/);
});

test("手机聊天只发送网关允许的标识和上下文，不发送本机或模型凭据", async () => {
  let request;
  const state = frontendState({ activeRuns: new Map([["synthetic-run", {}]]) });
  const context = appFunctions(["produceReply"], {
    state, window: {}, desktopManagedAgent: () => true, usingDesktopAgent: () => true, buildModelMessages: () => QUESTION,
    ChorusGatewayClient: { request: async (...args) => { request = args; return { text: "Mac 实际输出", via: "cursor" }; } },
    HARNESS_LABEL: { cursor: "Cursor" }, backendLabel: () => "Cursor",
  });
  const result = await context.produceReply({ ...MODEL_AGENT, backend: "cursor", workspace: "/mac/project", apiKey: "agent-secret" }, "合成任务", { mode: "discuss", context: { key: "room:team" }, runId: "synthetic-run" });
  assert.equal(request[1], "POST"); assert.equal(request[2], "/chat");
  assert.deepEqual(Object.keys(request[3]).sort(), ["agentId", "messages", "mode", "runId", "threadKey"]);
  assert.equal(request[3].threadKey, "room:team");
  assert.doesNotMatch(JSON.stringify(request[3]), /phone-key|phone-custom|synthetic-token|agent-secret|workspace|provider/);
  assert.equal(state.activeRuns.get("synthetic-run").connection.token, "synthetic-token");
  assert.equal(result.text, "Mac 实际输出");
});

test("手机停止发送到启动任务时的 Mac，即使当前连接字段已改变", async () => {
  let request, aborted = false;
  const state = frontendState({ sending: true, activeRunId: "active-run", activeRunConnection: { baseUrl: "http://192.168.1.7:47631", token: "original-token" }, requestController: { abort() { aborted = true; } } });
  state.activeRuns = new Map([[state.activeRunId, { connection: state.activeRunConnection, controller: state.requestController }]]);
  const context = appFunctions(["stopRun"], { state, window: {}, updateComposer() {}, toast() {}, readableError: String, ChorusGatewayClient: { request: async (...args) => { request = args; } } });
  await context.stopRun();
  assert.equal(aborted, true);
  assert.equal(request[0].token, "original-token");
  assert.equal(request[2], "/cancel"); assert.equal(request[3].runId, "active-run");
  assert.equal(state.stopRequested, true);
});

test("停止发生在配置 IPC 等待期间时，绝不继续启动原生 CLI", async () => {
  let release, called = false;
  const controller = new AbortController();
  const context = appFunctions(["produceReply"], { state: frontendState(), window: { chorusDesktop: { completeChat: async () => { called = true; } } }, desktopManagedAgent: () => false, usingDesktopAgent: () => false, buildModelMessages: () => QUESTION, publishGatewayConfig: () => new Promise((resolve) => { release = resolve; }) });
  const pending = context.produceReply({ ...MODEL_AGENT, backend: "codex" }, "合成任务", { mode: "discuss", context: { key: "agent:synthetic" }, signal: controller.signal });
  controller.abort(); release();
  await assert.rejects(pending, /任务已停止/);
  assert.equal(called, false);
});

test("桌面配置导入等待网络时开始发送，不能替换线程、选择或凭据", async () => {
  let release, applied = false;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const state = frontendState({ selectedAgentId: "original", activeRoomId: "original-room" });
  const before = JSON.stringify(state.settings.apiKeys);
  const context = appFunctions(["connectDesktop"], { state, desktopConnectionEpoch: 0, C: { importGatewayConfig() { applied = true; } },
    ChorusGatewayClient: { connection: (config) => config, request: async (_config, _method, route) => route === "/info" ? { protocolVersion: 1, capabilities: { chat: true } } : new Promise((resolve) => { release = resolve; requestStarted(); }) },
    toast() {}, readableError: String, updateComposer() {}, $: () => ({ classList: { contains: () => false } }),
  });
  const pending = context.connectDesktop();
  await started;
  state.sending = true; release({ agents: [{ id: "replacement" }], rooms: [] });
  await pending;
  assert.equal(applied, false);
  assert.equal(state.selectedAgentId, "original");
  assert.equal(state.activeRoomId, "original-room");
  assert.equal(JSON.stringify(state.settings.apiKeys), before);
  assert.equal(state.connectionBusy, false);
});

test("远程终端 adapter 固定连接并按网关白名单传输，不让手机覆盖 Mac 工作区", async () => {
  const calls = [];
  const state = frontendState();
  const context = appFunctions(["terminalAdapter"], { state, window: {}, usingDesktopAgent: () => true, ChorusGatewayClient: { request: async (...args) => { calls.push(args); } } });
  const adapter = context.terminalAdapter({ id: "cli" });
  state.settings.desktopConnection.token = "new-token";
  await adapter.open({ harness: "cursor", cwd: "/cannot-override", threadKey: "room:team", cols: 90, rows: 24 });
  await adapter.write("terminal-1", "合成输入\r");
  await adapter.resize("terminal-1", { cols: 100, rows: 30 });
  await adapter.read("terminal-1", { after: 10 });
  await adapter.close("terminal-1");
  assert.equal(calls[0][0].token, "synthetic-token");
  assert.equal(calls[0][2], "/terminal/open");
  assert.deepEqual(Object.keys(calls[0][3]).sort(), ["agentId", "cols", "rows", "threadKey"]);
  assert.equal(calls[1][3].data, "合成输入\r");
  assert.equal(calls[3][2], "/terminal/terminal-1?after=10");
  assert.equal(calls[4][2], "/terminal/close");
});

test("0.3 本机数据迁移恢复为0.4后台语义并保留模型凭据和手机连接", () => {
  const state = frontendState({ agents: [], rooms: [], drafts: {} });
  const saved = { agents: [{ ...MODEL_AGENT, backend: "cursor", harness: "none", workspace: "/mac/project", messages: [{ from: "you", text: "原始私聊" }] }], rooms: [{ id: "team", name: "开发组", agentIds: ["synthetic"], messages: [{ from: "you", text: "原始团队" }] }], settings: { apiKeys: { custom: "phone-persisted-key" }, desktopConnection: { baseUrl: "http://192.168.1.7:47631", token: "saved-gateway-token" } }, desktopAgentIds: ["synthetic", "nonexistent"], desktopRoomIds: ["team"], composerMode: "execute", selectedAgentId: "synthetic", activeRoomId: "team", drafts: { "agent:synthetic": { text: "未发草稿" } } };
  const context = appFunctions(["loadPersisted"], { state, window: { innerWidth: 600 }, HARNESS_LABEL: { none: "仅模型", cursor: "Cursor" }, localStorage: { getItem: () => JSON.stringify(saved) }, hasDesktopModelStorage: () => false, normalizeStoredMessages: (messages, id) => C.normalizeMessages(messages, [id]), C, normalizeRelayBaseUrl: () => "", DEFAULT_RELAY_BASE_URL: "https://relay.example.test", console });
  context.loadPersisted();
  assert.equal(state.agents[0].harness, "cursor");
  assert.equal(state.composerMode, "discuss");
  assert.equal(state.settings.apiKeys.custom, "phone-persisted-key");
  assert.equal(state.settings.desktopConnection.token, "saved-gateway-token");
  assert.deepEqual([...state.desktopAgentIds], ["synthetic"]);
  assert.equal(state.drafts["agent:synthetic"].text, "未发草稿");
  assert.equal(state.rooms[0].messages[0].text, "原始团队");
});

for (const desktop of [false, true]) {
  test(`${desktop ? "电脑" : "手机"}空账号及退出存档重新加载不复活示例成员和团队`, () => {
    for (const loggedIn of [false, true]) {
      const state = frontendState({ agents: [{ ...MODEL_AGENT, id: "seed-architect" }], rooms: [{ id: "seed-team", agentIds: ["seed-architect"] }], activeRoomId: "seed-team", user: null });
      const saved = {
        agents: [], rooms: [], activeRoomId: "", selectedAgentId: "", drafts: {},
        accountScope: loggedIn ? "https://relay.example.test:empty-account" : "",
        user: loggedIn ? { email: "empty@example.test", name: "空账号", provider: "email", verified: true } : null,
        settings: { apiKeys: {}, relayBaseUrl: "https://relay.example.test", desktopConnection: {} },
      };
      const context = appFunctions(["normalizeRelayAccount", "loadPersisted"], {
        state, window: { innerWidth: 600, ...(desktop ? { chorusDesktop: {} } : {}) },
        HARNESS_LABEL: { none: "仅模型", codex: "Codex", claude: "Claude Code", cursor: "Cursor" },
        localStorage: { getItem: () => JSON.stringify(saved) }, hasDesktopModelStorage: () => desktop,
        normalizeStoredMessages: (messages, id) => C.normalizeMessages(messages, [id]), C,
        normalizeRelayBaseUrl: () => "", DEFAULT_RELAY_BASE_URL: "https://relay.example.test",
        console: { error(_message, error) { throw error; } },
      });
      context.loadPersisted();
      assert.equal(state.agents.length, 0); assert.equal(state.rooms.length, 0); assert.equal(state.activeRoomId, "");
      assert.equal(state.accountScope, saved.accountScope); assert.equal(Object.keys(state.drafts).length, 0);
      assert.equal(state.user?.email || "", loggedIn ? "empty@example.test" : "");
    }
  });
}

test("成员团队字段缺省或没有存档时才保留原有示例", () => {
  for (const raw of [null, JSON.stringify({ drafts: {} })]) {
    const agents = [{ ...MODEL_AGENT }], rooms = [{ id: "seed-team", agentIds: ["synthetic"] }];
    const state = frontendState({ agents, rooms });
    const context = appFunctions(["loadPersisted"], {
      state, window: { innerWidth: 600 }, localStorage: { getItem: () => raw },
      HARNESS_LABEL: { none: "仅模型", codex: "Codex", claude: "Claude Code", cursor: "Cursor" },
      hasDesktopModelStorage: () => false, C, normalizeStoredMessages: (messages, id) => C.normalizeMessages(messages, [id]),
      normalizeRelayBaseUrl: () => "", DEFAULT_RELAY_BASE_URL: "https://relay.example.test",
      console: { error(_message, error) { throw error; } },
    });
    context.loadPersisted();
    assert.equal(state.agents, agents); assert.equal(state.rooms, rooms);
  }
});

test("Mac 持久化0.4数据与网关发布分开，系统存储密钥不进入本机JSON", () => {
  let saved, published = 0;
  const state = frontendState({ agents: [MODEL_AGENT], rooms: [{ id: "team", name: "团队", agentIds: ["synthetic"], messages: [{ text: "团队消息" }] }], drafts: { "agent:synthetic": { text: "未发草稿" } }, legacyDesktopKeys: null });
  const context = appFunctions(["persistApp"], { state, publishGatewayConfig: async () => { published++; }, hasDesktopModelStorage: () => true, localStorage: { setItem: (key, value) => { assert.equal(key, "chorus-app"); saved = JSON.parse(value); } }, scheduleRelayPush() {}, toast() {}, console });
  context.persistApp();
  assert.equal(published, 1);
  assert.equal(saved.version, "0.4.0");
  assert.equal(saved.settings.apiKeys, undefined);
  assert.equal(saved.rooms[0].messages[0].text, "团队消息");
  assert.equal(saved.drafts["agent:synthetic"].text, "未发草稿");
  assert.doesNotMatch(JSON.stringify(saved), /phone-key|phone-custom-key/);
});

test("配置 IPC 顺序执行且重复快照不会发布，较旧配置不会晚到覆盖新配置", async () => {
  const releases = [], calls = [];
  const context = appFunctions(["publishGatewayConfig"], {
    window: { chorusDesktop: { updateGatewayConfig: (snapshot) => { calls.push(snapshot); return new Promise((resolve) => releases.push(resolve)); } } },
    gatewayConfigSignature: "", gatewayConfigQueue: Promise.resolve(), gatewayConfig: () => ({ agents: [{ workspace: context.workspace }], rooms: [], settings: { localExecution: true } }), workspace: "/one",
  });
  const first = context.publishGatewayConfig();
  assert.equal(context.publishGatewayConfig(), first);
  context.workspace = "/two";
  const second = context.publishGatewayConfig();
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agents[0].workspace, "/one");
  releases[0](); await first; await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].agents[0].workspace, "/two");
  releases[1](); await second;
});

test("直连 Mac 生效后，中转站晚到快照不能覆盖已导入的桌面配置", async () => {
  let finish, applied = false;
  const state = frontendState({ relaySession: { deviceToken: "relay-token", revision: 1 } });
  const context = appFunctions(["pullRelayState"], { state, relayRequest: () => new Promise((resolve) => { finish = resolve; }), saveRelaySession() {}, applyRelaySnapshot() { applied = true; }, console: { info() {} } });
  const pending = context.pullRelayState();
  state.desktopConnectionInfo = { name: "Chorus" };
  finish({ revision: 2, state: { agents: [{ id: "relay-overwrite" }] } });
  assert.equal(await pending, false);
  assert.equal(applied, false);
  assert.equal(state.relaySession.revision, 1);
});

test("启动同步等待网络期间开始发送，快照使用合并路径并推进版本", async () => {
  let finishRequest;
  let applied = false;
  const state = { sending: false, relaySession: { deviceToken: "synthetic-token", revision: 1 } };
  const context = appFunctions(["pullRelayState"], {
    state, relayRequest: () => new Promise((resolve) => { finishRequest = resolve; }),
    saveRelaySession() {}, applyRelaySnapshot() { applied = true; }, refreshRelayView() {}, prepareDesktopWorkspaces: async () => false,
  });
  const pending = context.pullRelayState();
  state.sending = true;
  finishRequest({ revision: 2, state: { agents: [{ id: "remote-agent" }] } });
  assert.equal(await pending, true);
  assert.equal(applied, true);
  assert.equal(state.relaySession.revision, 2);
});

test("旧模式入口不再切换执行语义，CLI 能力由 Agent 后台决定", () => {
  const source = APP_SOURCE.match(/\$\("#btnComposerMode"\)\.addEventListener\("click", \(\) => \{([\s\S]*?)\n    \}\);/)[1];
  const state = { composerMode: "execute" };
  let updated = 0;
  const context = { state, updateComposer() { updated++; } };
  vm.runInNewContext(`this.toggleMode = () => { ${source} }`, context);
  context.toggleMode();
  assert.equal(state.composerMode, "discuss");
  context.toggleMode();
  assert.equal(state.composerMode, "discuss");
  assert.equal(updated, 2);
});

test("团队接力时后序成员读到具名的前序观点和当前任务", () => {
  const thread = [{ id: "u1", from: "you", text: "实现一个记账应用" }];
  const first = C.modelMessages(thread, AGENTS[0], AGENTS, "实现一个记账应用", true);
  assert.deepEqual(first, [{ role: "user", content: "实现一个记账应用" }]);
  thread.push({ id: "d1", from: "designer", text: "先展示支出趋势，再放录入入口" });
  const second = C.modelMessages(thread, AGENTS[1], AGENTS, "实现一个记账应用", true);
  assert.match(second.at(-1).content, /实现一个记账应用/);
  assert.match(second.at(-1).content, /\[设计师\]\n先展示支出趋势，再放录入入口/);
  assert.equal(second.at(-1).role, "user");
  thread.push({ id: "e1", from: "engineer", text: "用独立模块保存账目" });
  const own = C.modelMessages(thread, AGENTS[1], AGENTS, "补充测试方案", true);
  assert.equal(own.find((message) => message.content === "用独立模块保存账目")?.role, "assistant");
});

test("私聊过滤其他成员，团队和另一段私聊的数据不会混入", () => {
  const privateThread = [
    { id: "u1", from: "you", text: "个人需求甲" },
    { id: "d1", from: "designer", text: "私聊设计方案" },
    { id: "e1", from: "engineer", text: "历史混入的其他成员内容" },
  ];
  const before = JSON.stringify(privateThread);
  const privateMessages = C.modelMessages(privateThread, AGENTS[0], AGENTS, "继续个人需求甲", false);
  const text = JSON.stringify(privateMessages);
  assert.match(text, /私聊设计方案/);
  assert.doesNotMatch(text, /历史混入/);
  assert.doesNotMatch(text, /另一个线程/);
  const other = C.modelMessages([{ id: "u2", from: "you", text: "另一个线程" }], AGENTS[1], AGENTS, "另一个线程", false);
  assert.doesNotMatch(JSON.stringify(other), /个人需求甲|私聊设计方案/);
  assert.equal(JSON.stringify(privateThread), before);
});

test("重试从失败位置截断，不把之后的新任务或原错误送给模型", () => {
  const thread = [
    { id: "u1", from: "you", text: "第一次任务" },
    { id: "d1", from: "designer", text: "首位成员的方案" },
    { id: "failed", from: "engineer", text: "错误：额度不足", error: true, requestId: "u1" },
    { id: "u2", from: "you", text: "完全不同的第二次任务" },
    { id: "e2", from: "engineer", text: "第二次任务的结果" },
  ];
  const text = JSON.stringify(C.modelMessages(thread, AGENTS[1], AGENTS, "第一次任务", true, "failed"));
  assert.match(text, /第一次任务/);
  assert.match(text, /首位成员的方案/);
  assert.doesNotMatch(text, /额度不足|第二次任务/);
  assert.equal(text.match(/第一次任务/g).length, 1);
});

test("中文点名识别中文标点，避免相似前缀和正则字符误匹配", () => {
  assert.deepEqual(C.responders("@工程师，请实现；@审查员。请检查", AGENTS, "mention").map((agent) => agent.id), ["engineer", "reviewer"]);
  assert.deepEqual(C.responders("@设计师甲请回应", AGENTS, "mention"), []);
  assert.deepEqual(C.responders("没有点名", AGENTS, "mention"), []);
  assert.deepEqual(C.responders("没有点名", AGENTS, "free"), AGENTS);
  const special = [{ id: "cpp", name: "C++" }];
  assert.deepEqual(C.responders("@C++: 检查", special, "mention"), special);
  assert.deepEqual(C.responders("@C: 检查", special, "mention"), []);
});

test("恢复私聊保留重试信息和附件，同时去掉其他成员的历史消息", () => {
  const restored = C.normalizeMessages([
    { id: "u1", from: "you", text: "读取附件", attachments: [{ name: "说明.md", size: 12, text: "附件正文" }] },
    { id: "failed", from: "engineer", text: "已停止", error: true, requestId: "u1", mode: "execute" },
    { id: "other", from: "reviewer", text: "另一位成员的内容" },
  ], ["engineer"]);
  assert.deepEqual(restored.map((message) => message.id), ["u1", "failed"]);
  assert.equal(restored[1].requestId, "u1");
  assert.equal(restored[1].mode, "execute");
  assert.equal(restored[1].error, true);
  assert.match(C.content(restored[0]), /说明.md.*附件正文/s);
});

test("非法 URL 与嵌入的凭据被拒绝，局域网服务地址可以保存", () => {
  for (const url of ["not a url", "javascript:alert(1)", "file:///private/model", "ftp://model.example.test", "https://user:secret@model.example.test/v1"]) {
    assert.throws(() => C.endpoint(url), /有效|HTTP|用户名|密码/);
  }
  assert.equal(C.endpoint("http://192.168.1.10:11434/"), "http://192.168.1.10:11434");
  assert.equal(C.endpoint("https://model.example.test/v1/?ignored=yes#fragment"), "https://model.example.test/v1");
});

test("Agent 名称不能使点名含糊，自定义模型必须有模型 ID 和合法地址", () => {
  const base = { ...MODEL_AGENT, name: "新成员" };
  assert.throws(() => C.validateAgent({ ...base, name: "工程师" }, AGENTS), /已存在/);
  assert.throws(() => C.validateAgent({ ...base, name: "成员 甲" }, AGENTS), /空格/);
  assert.throws(() => C.validateAgent({ ...base, name: "@成员" }, AGENTS), /@/);
  assert.throws(() => C.validateAgent({ ...base, model: "" }, AGENTS), /模型 ID/);
  assert.throws(() => C.validateAgent({ ...base, endpoint: "file:///model" }, AGENTS), /HTTP/);
  assert.equal(C.validateAgent({ ...base, endpoint: "https://model.example.test/v1/" }, AGENTS).endpoint, "https://model.example.test/v1");
});

test("自定义服务无密钥也能请求，并且绝不收到 OpenAI 或 Anthropic 密钥", async () => {
  const { complete, calls } = loadClient();
  const keys = { openai: "openai-private-key", anthropic: "anthropic-private-key", custom: "" };
  assert.equal(await complete(MODEL_AGENT, QUESTION, keys), "测试成功");
  assert.equal(calls[0].url, "https://model.example.test/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.doesNotMatch(JSON.stringify(calls[0]), /openai-private-key|anthropic-private-key/);
  assert.equal(calls[0].data.model, "synthetic-model");
});

test("自定义服务只发送自己的密钥，认证错误里的密钥不会进入展示文本", async () => {
  const keys = { openai: "openai-private-key", custom: "custom-private-key" };
  const { complete, calls } = loadClient({ request: async () => ({ status: 401, data: JSON.stringify({ error: { message: "invalid key custom-private-key" } }) }) });
  await assert.rejects(complete(MODEL_AGENT, QUESTION, keys), (error) => {
    assert.match(error.message, /HTTP 401.*invalid key/);
    assert.doesNotMatch(error.message, /custom-private-key|openai-private-key/);
    return true;
  });
  assert.equal(calls[0].headers.Authorization, "Bearer custom-private-key");
  assert.doesNotMatch(JSON.stringify(calls[0]), /openai-private-key/);
});

test("Android 取消会立即结束等待，晚到的原生成功响应不能变成成功结果", async () => {
  let release;
  const { complete, calls } = loadClient({ request: () => new Promise((resolve) => { release = resolve; }) });
  const controller = new AbortController();
  const pending = complete(MODEL_AGENT, QUESTION, {}, controller.signal);
  const rejected = assert.rejects(pending, /任务已停止/);
  controller.abort();
  await rejected;
  assert.equal(calls[0].connectTimeout > 0, true);
  assert.equal(calls[0].readTimeout, 120000);
  assert.equal(calls[0].disableRedirects, true);
  release({ status: 200, data: JSON.stringify({ choices: [{ message: { content: "不应交付的晚到响应" } }] }) });
  await Promise.resolve();
  await assert.rejects(pending, /任务已停止/);
});

test("Android 长时间无数据会超时，即使原生 HTTP 不响应 AbortSignal", async () => {
  const { complete } = loadClient({ timeoutMs: 15, request: () => new Promise(() => {}) });
  await assert.rejects(complete(MODEL_AGENT, QUESTION, {}), /长时间未返回数据/);
});

test("一个模型请求的取消不会取消另一段独立请求", async () => {
  const native = new Map();
  const { complete } = loadClient({ request: (payload) => new Promise((resolve) => { native.set(payload.data.messages.at(-1).content, resolve); }) });
  const controller = new AbortController();
  const first = complete(MODEL_AGENT, [{ role: "user", content: "私聊甲" }], {}, controller.signal);
  const rejected = assert.rejects(first, /任务已停止/);
  const second = complete(MODEL_AGENT, [{ role: "user", content: "私聊乙" }], {});
  controller.abort();
  native.get("私聊乙")({ status: 200, data: JSON.stringify({ choices: [{ message: { content: "私聊乙回复" } }] }) });
  await rejected;
  assert.equal(await second, "私聊乙回复");
  native.get("私聊甲")({ status: 200, data: JSON.stringify({ choices: [{ message: { content: "晚到甲回复" } }] }) });
});

test("浏览器响应也使用明确模型，推理模型省略不兼容的 temperature", async () => {
  let request;
  const { complete } = loadClient({ web: true, fetch: async (url, options) => {
    request = { url, ...options };
    return { status: 200, ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "合成回复" }] } }] }) };
  } });
  assert.equal(await complete({ ...MODEL_AGENT, provider: "openai", model: "gpt-5" }, QUESTION, { openai: "openai-test-key", custom: "custom-test-key" }), "合成回复");
  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer openai-test-key");
  assert.equal(JSON.parse(request.body).temperature, undefined);
  assert.equal(request.redirect, "error");
});

/** 功能：构造实际字节流供浏览器客户端解析；参数：chunks 为字节片段；返回：fetch 兼容响应；注意事项：采用真实 ReadableStream 验证 UTF-8 边界。 */
function streamingResponse(chunks) {
  return { status: 200, ok: true, body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
}

/** 功能：验证真实 SSE 增量、中文断包与多行 data；参数：无；返回：异步测试；注意事项：最终内容从所有分片累计而来。 */
test("浏览器 SSE 跨字节和多行事件持续累计正文", async () => {
  const encoder = new TextEncoder();
  const raw = encoder.encode('data: {"choices":[\ndata: {"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n');
  const chunks = Array.from(raw, (byte) => Uint8Array.of(byte));
  const output = [];
  const { complete } = loadClient({ web: true, fetch: async () => streamingResponse(chunks) });
  assert.equal(await complete(MODEL_AGENT, QUESTION, {}, undefined, (text) => output.push(text)), "你好世界");
  assert.deepEqual(output, ["你好", "你好世界"]);
});

/** 功能：验证不同模型协议只展示正文；参数：无；返回：异步测试；注意事项：每种服务必须提供自身完成标记。 */
test("Anthropic 和 Ollama 流持续显示正文并验证结束标记", async () => {
  const samples = [
    { provider: "anthropic", keys: { anthropic: "test-key" }, wire: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"测试"}}\n\ndata: {"type":"message_stop"}\n\n' },
    { provider: "local", keys: {}, wire: '{"message":{"content":"测试"},"done":false}\n{"message":{"content":""},"done":true}\n' },
  ];
  for (const sample of samples) {
    const output = [];
    const { complete } = loadClient({ web: true, fetch: async () => streamingResponse([new TextEncoder().encode(sample.wire)]) });
    assert.equal(await complete({ ...MODEL_AGENT, provider: sample.provider }, QUESTION, sample.keys, undefined, (text) => output.push(text)), "测试");
    assert.deepEqual(output, ["测试"]);
  }
});

/** 功能：验证截断流不会伪装成完整结果；参数：无；返回：异步测试；注意事项：已经交付的片段保留，最终 Promise 必须失败。 */
test("SSE 意外断流保留已生成片段，但不能返回成功", async () => {
  const output = [];
  const { complete } = loadClient({ web: true, fetch: async () => streamingResponse([new TextEncoder().encode('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n')]) });
  await assert.rejects(complete(MODEL_AGENT, QUESTION, {}, undefined, (text) => output.push(text)), /意外中断/);
  assert.deepEqual(output, ["未完成"]);
});

/** 功能：验证持续响应更新空闲计时；参数：无；返回：异步测试；注意事项：总时长超过测试空闲阈值仍成功。 */
test("浏览器持续输出超过空闲超时窗口仍正常完成", async () => {
  const encoder = new TextEncoder();
  const { complete } = loadClient({ web: true, timeoutMs: 50, fetch: async () => ({ status: 200, ok: true, body: new ReadableStream({ async start(controller) {
    for (let index = 0; index < 8; index++) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"字"}}]}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  } }) }) });
  assert.equal(await complete(MODEL_AGENT, QUESTION, {}), "字".repeat(8));
});
