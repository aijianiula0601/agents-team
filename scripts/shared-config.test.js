const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const C = require("../shared/web/conversation");
const R = require("../shared/web/relay-client");

const SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const AGENT = { id: "a", name: "原成员", backend: "cursor", harness: "cursor", provider: "openai", model: "api-model", workspace: "/main/original", workspaceMode: "project", messages: [] };
const ROOM = { id: "r", name: "原团队", agentIds: ["a"], rule: "free", workspace: "/main/team", messages: [] };

/**
 * 加载页面原函数以验证真实权限与异步逻辑。
 * @param {string[]} names 需要加载的函数名
 * @param {object} context 页面依赖与状态
 * @returns {object} 可调用真实函数的隔离环境
 * 注意事项：只替换外部界面和网络，不复制被测实现。
 */
function loadFunctions(names, context) {
  vm.runInNewContext(names.map((name) => {
    const match = SOURCE.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, `找不到函数 ${name}`);
    return `${match[0]}; this.${name} = ${name};`;
  }).join("\n"), context);
  return context;
}

/**
 * 构造主电脑、非主 Mac 或 Android 的共享配置测试环境。
 * @param {string} platform primary、mac 或 android
 * @returns {object} 包含表单、请求与执行调用记录的环境
 * 注意事项：默认模拟已同步账号；原生调用留下记录以检查设备边界。
 */
function configContext(platform = "mac") {
  const controls = new Map();
  const context = {
    C, ChorusRelayClient: R, Error, Promise, Object, console: { info() {}, warn() {}, error() {} },
    authAttemptEpoch: 1, conversationEpoch: 1,
    events: [], notices: [], requests: [], nativeCalls: [], hostCommands: [], checked: ["a"],
    state: {
      accountScope: "relay:account", relayReady: true, relayConfigSynced: true, relayConfigRevision: 2,
      relaySession: { deviceToken: "token", revision: 5, isPrimary: platform === "primary" },
      agents: [{ ...AGENT, messages: [] }], rooms: [{ ...ROOM, agentIds: ["a"], messages: [] }],
      settings: { localExecution: true, defaultProvider: "openai", theme: "dark", apiKeys: { openai: "device-secret" } },
      appInfo: {}, harnessModels: {}, harnessStatus: {}, hostConfigEpoch: 1, sending: false, activeRoomId: "r", selectedAgentId: "a", agentModalEpoch: 1, roomModalEpoch: 1,
      agentModalMode: "create", agentDraft: { id: "a-new", backend: "cursor", harness: "cursor", provider: "openai", harnessModel: "cursor-model", baseRevision: 5, configRevision: 2 },
      roomDraft: { id: "r-new", baseRevision: 5, configRevision: 2 }, roomRule: "mention",
    },
    window: { confirm: () => true },
    readableError: (error) => error.message,
    saveDraft() {}, restoreDraft() {}, normalizeStoredMessages: C.normalizeMessages,
  };
  if (platform !== "android") context.window.chorusDesktop = {
    async normalizeWorkspace(value) { context.nativeCalls.push("normalize"); return value; },
    async prepareAgentWorkspaces(agents) { context.nativeCalls.push("prepare"); return agents.map((agent) => ({ ...agent, workspace: agent.workspace || `/main/auto/${agent.id}` })); },
  };
  context.$ = (selector) => {
    if (!controls.has(selector)) controls.set(selector, { value: "", disabled: false, isConnected: true, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, classList: { contains: () => true } });
    return controls.get(selector);
  };
  context.$$ = (selector) => selector === "#roomAgentPick input:checked" ? context.checked.map((value) => ({ value })) : [];
  context.getAgent = (id) => context.state.agents.find((agent) => agent.id === id);
  context.getRoom = (id) => context.state.rooms.find((room) => room.id === id);
  context.toast = (message) => context.notices.push(message);
  context.saveRelaySession = () => context.events.push("session");
  context.persistApp = () => context.events.push("persist");
  context.renderAll = () => context.events.push("render");
  context.closeOverlay = (id) => context.events.push(`close:${id}`);
  context.openPanel = (mode) => context.events.push(`panel:${mode}`);
  context.relayRequest = async (...args) => { context.requests.push(args); throw new Error("测试必须明确提供中转响应"); };
  context.hostConfigClient = () => ({ command: async (action, body) => { context.hostCommands.push({ action, body }); return { path: body?.path }; } });
  for (const [selector, value] of Object.entries({ "#agentName": "远端工程师", "#agentRole": "开发", "#agentPersona": "处理主电脑项目", "#modelId": "api-model", "#modelEndpoint": "", "#agentWorkspace": "/actual/main/project", "#roomName": "远端新群" })) context.$(selector).value = value;
  return loadFunctions(["isPrimaryDevice", "canEditAgentConfig", "saveRelayConfig", "buildRelaySnapshot", "applyRelaySnapshot", "prepareDesktopWorkspaces", "normalizeAgentWorkspace", "createAgentFromWizard", "createRoomFromModal", "saveRoomConfig", "deleteRoom"], context);
}

/**
 * 创建一次配置保存后的完整中转响应。
 * @param {object} context 当前页面环境
 * @param {object} overrides 覆盖的快照字段
 * @param {number} revision 聊天快照版本
 * @returns {object} 独立快照和版本
 * 注意事项：复制对象，避免测试响应意外共用页面引用。
 */
function response(context, overrides = {}, revision = 6) {
  return { revision, state: JSON.parse(JSON.stringify({ ...context.buildRelaySnapshot(), configRevision: 3, ...overrides })) };
}

/**
 * 构造中转站版本冲突。
 * @param {object} payload 最新快照和版本
 * @returns {Error} 带状态码与负载的冲突异常
 * 注意事项：由真实保存函数决定是否允许重试。
 */
function conflict(payload) {
  return Object.assign(new Error("配置已更新"), { status: 409, payload });
}

/**
 * 为共享配置测试补充主机设置界面及原生调用观测点。
 * @param {string} platform primary、mac 或 android
 * @returns {object} 可读取和保存主电脑设置的页面环境
 * 注意事项：接口仅返回脱敏状态，明文密钥仅由测试模拟表单输入。
 */
function hostContext(platform = "mac") {
  const context = configContext(platform);
  context.state.harnessPaths = { codex: "", claude: "", cursor: "" };
  context.state.harnessStatus = {};
  context.state.desktopModelSettings = { openaiConfigured: false, anthropicConfigured: false, customConfigured: false, ollamaBase: "http://127.0.0.1:11434" };
  context.state.settingsSection = "models";
  context.state.relayDevices = [];
  context.hostConfigTimer = null;
  context.hostConfigPublishedAt = 0;
  context.hostConfigRetryAt = 0;
  context.hostConfigTickBusy = false;
  context.hostConfigActiveCommand = "";
  context.SETTINGS_META = { models: { title: "模型", desc: "主电脑模型配置" } };
  context.escapeHtml = (value) => String(value).replaceAll('"', "&quot;");
  context.updateExecutionSettingsVisibility = () => {};
  context.renderAgents = () => context.events.push("agents");
  context.renderMessages = () => context.events.push("messages");
  context.renderSettings = () => context.events.push("settings");
  context.renderHarnessModelChoice = () => context.events.push("models");
  context.remoteSettings = { modelSettings: { openaiConfigured: true, anthropicConfigured: false, customConfigured: false, ollamaBase: "http://127.0.0.1:18000" }, harnessPaths: { codex: "/main/bin/codex", claude: "", cursor: "/main/bin/agent" }, harnessStatus: { cursor: { available: true, authenticated: true, path: "/main/bin/agent" } } };
  context.hostConfigClient = () => ({ command: async (action, body) => { context.hostCommands.push({ action, body }); return action === "model.save" ? context.remoteSettings.modelSettings : context.remoteSettings; } });
  if (platform !== "android") Object.assign(context.window.chorusDesktop, {
    async getModelSettings() { context.nativeCalls.push("get-model"); return context.remoteSettings.modelSettings; },
    async saveModelSettings() { context.nativeCalls.push("save-model"); },
    async getHarnessSettings() { context.nativeCalls.push("get-harness"); return context.remoteSettings.harnessPaths; },
    async saveHarnessSettings() { context.nativeCalls.push("save-harness"); },
    async probeHarness() { context.nativeCalls.push("probe"); return context.remoteSettings.harnessStatus; },
    async listHarnessModels() { context.nativeCalls.push("models"); return { models: [] }; },
  });
  return loadFunctions(["hasDesktopModelStorage", "normalizeHarnessResult", "loadRemoteHostSettings", "loadDesktopModelSettings", "loadHarnessPaths", "refreshHarnessStatus", "saveHarnessPaths", "loadHarnessModels"], context);
}

for (const platform of ["mac", "android"]) {
  test(`${platform} 新建 Agent 使用主电脑路径，不访问当前设备文件系统`, async () => {
    const context = configContext(platform);
    let finish;
    context.relayRequest = (...args) => { context.requests.push(args); return new Promise((resolve) => { finish = resolve; }); };
    const pending = context.createAgentFromWizard();
    await new Promise(setImmediate);
    assert.equal(context.state.agents.length, 1);
    const [method, url, token, body] = context.requests[0];
    assert.equal(method, "POST"); assert.equal(url, "/api/v1/agents"); assert.equal(token, "token");
    assert.equal(body.id, "a-new"); assert.equal(body.baseRevision, 5);
    assert.equal(body.config.workspace, "/actual/main/project");
    assert.equal(body.config.harnessModel, "cursor-model");
    assert.doesNotMatch(JSON.stringify(body), /device-secret|messages|apiKeys/);
    assert.deepEqual(context.nativeCalls, []);
    assert.equal(context.hostCommands.length, 1);
    assert.equal(context.hostCommands[0].action, "workspace.normalize");
    assert.equal(context.hostCommands[0].body.path, "/actual/main/project");
    finish(response(context, { agents: [AGENT, { id: body.id, ...body.config, messages: [] }] }));
    await pending;
    assert.equal(context.getAgent("a-new").workspace, "/actual/main/project");
    assert.equal(context.isPrimaryDevice(), false);
    assert.ok(context.events.includes("close:agentOverlay"));
  });

  test(`${platform} 新建群等待服务端确认后展示，并使用账号共享成员`, async () => {
    const context = configContext(platform);
    let finish;
    context.relayRequest = (...args) => { context.requests.push(args); return new Promise((resolve) => { finish = resolve; }); };
    const pending = context.createRoomFromModal();
    assert.equal(context.state.rooms.length, 1);
    assert.equal(context.$("#roomCreate").disabled, true);
    const [method, url, , body] = context.requests[0];
    assert.equal(method, "POST"); assert.equal(url, "/api/v1/rooms");
    assert.equal(body.id, "r-new");
    assert.deepEqual(body.config.agentIds, ["a"]);
    assert.equal(body.config.rule, "mention");
    finish(response(context, { rooms: [ROOM, { id: body.id, ...body.config, messages: [] }] }));
    await pending;
    assert.equal(context.getRoom("r-new").name, "远端新群");
    assert.equal(context.state.activeRoomId, "r-new");
    assert.equal(context.$("#roomCreate").disabled, false);
    assert.deepEqual(context.nativeCalls, []);
  });
}

test("主电脑在线新建也通过版本接口，未提前写入待上传快照", async () => {
  const context = configContext("primary");
  context.relayRequest = async (...args) => {
    context.requests.push(args);
    assert.equal(context.state.agents.length, 1);
    const body = args[3];
    return response(context, { agents: [AGENT, { id: body.id, ...body.config, messages: [] }] });
  };
  await context.createAgentFromWizard();
  assert.equal(context.requests[0][0], "POST");
  assert.equal(context.getAgent("a-new").name, "远端工程师");
  assert.deepEqual(context.nativeCalls, ["normalize"]);
});

test("只有聊天版本变化时自动重试一次，创建编号和用户输入保持一致", async () => {
  const context = configContext();
  context.relayRequest = async (...args) => {
    context.requests.push(args);
    if (context.requests.length === 1) throw conflict(response(context, { configRevision: 2, agents: [{ ...AGENT, messages: [{ id: "phone", from: "you", text: "新消息" }] }] }, 6));
    const body = args[3];
    return response(context, { agents: [...context.state.agents, { id: body.id, ...body.config, messages: [] }] }, 7);
  };
  await context.createAgentFromWizard();
  assert.equal(context.requests.length, 2);
  assert.deepEqual(context.requests.map((request) => request[3].baseRevision), [5, 6]);
  assert.deepEqual(context.requests.map((request) => request[3].id), ["a-new", "a-new"]);
  assert.equal(context.getAgent("a").messages[0].text, "新消息");
  assert.equal(context.getAgent("a-new").name, "远端工程师");
});

test("配置冲突保留创建群表单与稳定编号，重新保存使用最新版本", async () => {
  const context = configContext("android");
  context.relayRequest = async (...args) => {
    context.requests.push(args);
    if (context.requests.length === 1) throw conflict(response(context, { agents: [{ ...AGENT, name: "另一端更新" }] }, 9));
    const body = args[3];
    return response(context, { configRevision: 4, rooms: [ROOM, { id: body.id, ...body.config, messages: [] }] }, 10);
  };
  await context.createRoomFromModal();
  assert.equal(context.requests.length, 1);
  assert.equal(context.$("#roomName").value, "远端新群");
  assert.equal(context.state.roomDraft.id, "r-new");
  assert.equal(context.state.roomDraft.baseRevision, 9);
  assert.equal(context.state.roomDraft.configRevision, 3);
  assert.ok(!context.events.includes("close:roomOverlay"));
  assert.match(context.notices[0], /保留你的输入/);
  await context.createRoomFromModal();
  assert.equal(context.requests[1][3].baseRevision, 9);
  assert.equal(context.requests[1][3].id, "r-new");
  assert.equal(context.getRoom("r-new").name, "远端新群");
});

test("群成员修改失败时不先改本地配置或提示保存成功", async () => {
  const context = configContext();
  context.relayRequest = async (...args) => { context.requests.push(args); throw new Error("连接中断"); };
  await context.saveRoomConfig("r", { agentIds: ["other"] }, { baseRevision: 5, configRevision: 2 });
  assert.deepEqual(context.getRoom("r").agentIds, ["a"]);
  assert.equal(context.requests[0][0], "PATCH");
  assert.match(context.notices[0], /连接中断/);
  assert.ok(!context.notices.some((notice) => /已保存/.test(notice)));
});

test("主电脑执行开关和默认服务商先保存共享配置，再改变本机展示", async () => {
  const context = hostContext("android");
  loadFunctions(["saveSharedSettings"], context);
  let finish;
  context.relayRequest = (...args) => { context.requests.push(args); return new Promise((resolve) => { finish = resolve; }); };
  const pending = context.saveSharedSettings({ localExecution: false, defaultProvider: "anthropic" });
  assert.equal(context.state.settings.localExecution, true);
  assert.equal(context.state.settings.defaultProvider, "openai");
  assert.equal(context.requests[0][0], "PATCH");
  assert.equal(context.requests[0][1], "/api/v1/settings");
  assert.doesNotMatch(JSON.stringify(context.requests[0]), /secret|apiKeys|theme/);
  finish(response(context, { settings: { localExecution: false, defaultProvider: "anthropic" } }));
  assert.equal(await pending, true);
  assert.equal(context.state.settings.localExecution, false);
  assert.equal(context.state.settings.defaultProvider, "anthropic");
  assert.equal(context.state.settings.theme, "dark");
  assert.equal(context.state.settings.apiKeys.openai, "device-secret");
});

test("群名保存晚到不能清空之后输入的本群或其他群草稿", async () => {
  for (const nextID of ["r", "other-room"]) {
    const context = configContext();
    const draft = { id: "r", name: "提交的群名", baseRevision: 5, configRevision: 2 };
    context.state.roomNameDraft = draft;
    let finish;
    context.relayRequest = () => new Promise((resolve) => { finish = resolve; });
    const pending = context.saveRoomConfig("r", { name: draft.name }, draft);
    const later = { id: nextID, name: "后来输入不能丢", baseRevision: 5, configRevision: 2 };
    context.state.roomNameDraft = later;
    finish(response(context, { rooms: [{ ...ROOM, name: "提交的群名" }] }));
    await pending;
    assert.equal(context.state.roomNameDraft, later);
  }
});

test("群删除晚到不能清空当前正在编辑的其他群名称", async () => {
  const context = configContext();
  context.state.rooms.push({ ...ROOM, id: "other-room", name: "另一个群" });
  let finish;
  context.relayRequest = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.deleteRoom("r", { baseRevision: 5, configRevision: 2 });
  const later = { id: "other-room", name: "后来输入不能丢", baseRevision: 5, configRevision: 2 };
  context.state.roomNameDraft = later;
  finish(response(context, { rooms: [{ ...ROOM, id: "other-room", name: "另一个群" }] }));
  await pending;
  assert.equal(context.state.roomNameDraft, later);
});

test("创建和删除请求晚到时不能修改切换后的账号或关闭新账号窗口", async () => {
  for (const action of ["createAgentFromWizard", "createRoomFromModal", "deleteRoom"]) {
    const context = configContext();
    let finish;
    context.relayRequest = () => new Promise((resolve) => { finish = resolve; });
    const pending = action === "deleteRoom" ? context.deleteRoom("r", { baseRevision: 5, configRevision: 2 }) : context[action]();
    await new Promise(setImmediate);
    context.state.relaySession = { deviceToken: "other-token", revision: 100 };
    context.state.accountScope = "relay:other-account";
    finish(response(context, { agents: [], rooms: [] }, 6));
    await pending;
    assert.equal(context.state.relaySession.revision, 100);
    assert.equal(context.state.agents.length, 1);
    assert.equal(context.state.rooms.length, 1);
    assert.deepEqual(context.events, []);
    assert.deepEqual(context.notices, []);
  }
});

test("关闭创建表单后返回的成功不能覆盖后来打开的表单", async () => {
  const context = configContext();
  let finish;
  context.relayRequest = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.createRoomFromModal();
  context.state.roomModalEpoch++;
  finish(response(context, { rooms: [] }));
  await pending;
  assert.equal(context.state.rooms.length, 1);
  assert.deepEqual(context.events, []);
});

test("主电脑应用新配置保留在途消息引用，同时删除旧成员并采用共享设置", () => {
  const context = configContext("primary");
  const agent = context.getAgent("a");
  const messages = agent.messages;
  messages.push({ id: "reply", from: "a", text: "电脑待上传回复", streaming: true });
  context.state.agents.push({ ...AGENT, id: "deleted", name: "已删除" });
  context.state.running = { agentId: "a" };
  context.applyRelaySnapshot({ configRevision: 3, agents: [{ ...AGENT, name: "更新成员", messages: [{ id: "phone", from: "you", text: "手机输入" }] }, { ...AGENT, id: "new", name: "手机成员" }], rooms: [], settings: { localExecution: false, defaultProvider: "anthropic", theme: "remote", apiKeys: { openai: "remote" } }, execution: { running: null } });
  assert.equal(context.getAgent("a"), agent);
  assert.equal(context.getAgent("a").messages, messages);
  assert.deepEqual(messages.map((message) => message.id), ["phone", "reply"]);
  assert.equal(context.getAgent("deleted"), undefined);
  assert.equal(context.getAgent("new").name, "手机成员");
  assert.equal(context.state.rooms.length, 0);
  assert.equal(context.state.settings.localExecution, false);
  assert.equal(context.state.settings.defaultProvider, "anthropic");
  assert.equal(context.state.settings.theme, "dark");
  assert.equal(context.state.settings.apiKeys.openai, "device-secret");
  assert.equal(context.state.running.agentId, "a");
});

test("首次恢复旧版本账号缓存显式替换空集合，不能误认为本机删除了全部配置", () => {
  const context = configContext("primary");
  context.state.agents = []; context.state.rooms = []; context.state.relayConfigRevision = 0;
  context.applyRelaySnapshot({ configRevision: 0, agents: [AGENT], rooms: [ROOM], settings: { localExecution: true } }, true);
  assert.equal(context.getAgent("a").name, "原成员");
  assert.equal(context.getRoom("r").name, "原团队");
});

test("默认目录准备晚到时不得覆盖远端改为项目目录的配置", async () => {
  const context = configContext("primary");
  const agent = context.getAgent("a");
  agent.workspaceMode = "auto";
  let finish;
  context.window.chorusDesktop.prepareAgentWorkspaces = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.prepareDesktopWorkspaces();
  agent.workspaceMode = "project";
  finish([{ id: "a", workspace: "/main/auto/a" }]);
  assert.equal(await pending, false);
  assert.equal(agent.workspaceMode, "project");
  assert.equal(agent.workspace, "/main/original");
});

test("登录但未完成同步的设备不能创建或删除配置", async () => {
  for (const platform of ["primary", "mac", "android"]) {
    const context = configContext(platform);
    context.state.relayConfigSynced = false;
    await context.createAgentFromWizard();
    await context.createRoomFromModal();
    await context.deleteRoom("r", { baseRevision: 5, configRevision: 2 });
    assert.deepEqual(context.requests, []);
    assert.deepEqual(context.nativeCalls, []);
    assert.equal(context.state.agents.length, 1);
    assert.equal(context.state.rooms.length, 1);
  }
});

for (const platform of ["mac", "android"]) {
  test(`${platform} 模型和内核配置读取主电脑结果，不读取非主设备原生配置`, async () => {
    const context = hostContext(platform);
    await context.loadDesktopModelSettings();
    assert.equal(context.hostCommands[0].action, "settings.get");
    assert.equal(context.state.desktopModelSettings.ollamaBase, "http://127.0.0.1:18000");
    assert.equal(context.state.harnessPaths.cursor, "/main/bin/agent");
    assert.equal(context.state.harnessStatus.cursor.authenticated, true);
    assert.equal(context.state.hostSettingsLoaded, true);
    assert.deepEqual(context.nativeCalls, []);
  });

  test(`${platform} 保存模型密钥只提交主电脑通道，快照与本地设置不保存新明文`, async () => {
    const context = hostContext(platform);
    context.state.hostSettingsLoaded = true;
    loadFunctions(["renderSettings"], context);
    context.renderSettings();
    context.$("#keyOpenai").value = "submitted-openai-secret";
    context.$("#keyAnthropic").value = "submitted-anthropic-secret";
    context.$("#keyCustom").value = "submitted-custom-secret";
    context.$("#keyOllama").value = "http://127.0.0.1:18000";
    await context.$("#saveKeys").listeners.click({ currentTarget: context.$("#saveKeys") });
    assert.equal(context.hostCommands[0].action, "model.save");
    assert.equal(context.hostCommands[0].body.openai, "submitted-openai-secret");
    assert.doesNotMatch(JSON.stringify(context.state), /submitted-/);
    assert.doesNotMatch(JSON.stringify(context.buildRelaySnapshot()), /secret|apiKeys/);
    assert.doesNotMatch(context.$("#settingsContent").innerHTML, /submitted-|device-secret/);
    assert.equal(context.state.desktopModelSettings.openaiConfigured, true);
    assert.deepEqual(context.nativeCalls, []);
    assert.ok(!context.events.includes("persist"));
  });

  test(`${platform} 保存内核路径提交主电脑并重新读取真实状态`, async () => {
    const context = hostContext(platform);
    context.$$ = (selector) => selector === "[data-harness-path]" ? [{ dataset: { harnessPath: "cursor" }, value: " /main/bin/agent " }] : [];
    await context.saveHarnessPaths();
    assert.deepEqual(context.hostCommands.map((command) => command.action), ["harness.save", "settings.get"]);
    assert.equal(context.hostCommands[0].body.cursor, "/main/bin/agent");
    assert.equal(context.state.harnessPaths.cursor, "/main/bin/agent");
    assert.deepEqual(context.nativeCalls, []);
  });
}

test("强制刷新远端内核模型列表后更新选择器，不能继续显示读取中", async () => {
  const context = hostContext();
  context.hostConfigClient = () => ({ command: async () => ({ models: [{ id: "remote-model" }], source: "主电脑" }) });
  await context.loadHarnessModels("cursor", true);
  assert.equal(context.state.harnessModels.cursor.models[0].id, "remote-model");
  assert.equal(context.state.harnessModels.cursor.loading, undefined);
  assert.deepEqual(context.events, ["models", "models", "persist"]);
  assert.deepEqual(context.nativeCalls, []);
});

test("主电脑切换后的远端设置晚到不会回写上一台路径和配置状态", async () => {
  const context = hostContext();
  let finish;
  context.hostConfigClient = () => ({ command: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = context.loadRemoteHostSettings();
  context.state.hostConfigEpoch++;
  context.state.harnessPaths = { cursor: "/new-main/bin/agent" };
  finish(context.remoteSettings);
  await pending;
  assert.equal(context.state.harnessPaths.cursor, "/new-main/bin/agent");
  assert.equal(context.state.desktopModelSettings.openaiConfigured, false);
});

test("本机主电脑降级后，旧原生路径与模型状态查询不能覆盖新主电脑信息", async () => {
  for (const [loader, native] of [["loadHarnessPaths", "getHarnessSettings"], ["loadDesktopModelSettings", "getModelSettings"]]) {
    const context = hostContext("primary");
    let finish;
    context.window.chorusDesktop[native] = () => new Promise((resolve) => { finish = resolve; });
    const pending = context[loader]();
    context.state.hostConfigEpoch++;
    context.state.relaySession.isPrimary = false;
    context.state.harnessPaths = { cursor: "/new-main/bin/agent" };
    context.state.desktopModelSettings = { openaiConfigured: false, ollamaBase: "http://new-main:11434" };
    finish(native === "getHarnessSettings" ? context.remoteSettings.harnessPaths : context.remoteSettings.modelSettings);
    await pending;
    assert.equal(context.state.harnessPaths.cursor, "/new-main/bin/agent");
    assert.equal(context.state.desktopModelSettings.ollamaBase, "http://new-main:11434");
  }
});

test("主电脑降级后，原生内核检测晚到不覆盖新主电脑状态", async () => {
  const context = hostContext("primary");
  let finish;
  context.window.chorusDesktop.probeHarness = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.refreshHarnessStatus();
  await new Promise(setImmediate);
  context.state.hostConfigEpoch++;
  context.state.relaySession.isPrimary = false;
  context.state.harnessStatus = { cursor: { available: false, path: "/new-main/bin/agent" } };
  finish(context.remoteSettings.harnessStatus);
  await pending;
  assert.equal(context.state.harnessStatus.cursor.path, "/new-main/bin/agent");
  assert.equal(context.state.harnessStatus.cursor.available, false);
});

test("首次确认主电脑设备列表后重新读取实际设置，不能留在未配置状态", async () => {
  const context = hostContext("primary");
  context.state.relaySession.deviceId = "main-device";
  context.clearInterval = () => {};
  context.startHostConfigLoop = () => {};
  context.syncRelayDeviceList = () => {};
  context.renderRunning = () => {};
  context.relayRequest = async () => ({ devices: [{ id: "main-device", isPrimary: true, platform: "mac" }] });
  loadFunctions(["resetHostConfig", "loadRelayDevices"], context);
  await context.loadRelayDevices();
  await new Promise(setImmediate);
  assert.equal(context.state.desktopModelSettings.openaiConfigured, true);
  assert.equal(context.state.harnessPaths.cursor, "/main/bin/agent");
  assert.ok(context.nativeCalls.includes("get-model"));
});

test("主电脑执行聊天期间仍领取配置命令，未结束配置任务不会重复领取", async () => {
  const context = hostContext("primary");
  context.state.sending = true;
  const calls = [];
  let finish;
  context.window.chorusDesktop.setHostConfigContext = async () => ({ publicKey: "public-only" });
  context.hostConfigClient = () => ({ publishKey: async () => calls.push("publish"), claim: async () => { calls.push("claim"); return { id: "command", action: "settings.get" }; } });
  context.executeHostConfigCommand = () => new Promise((resolve) => { calls.push("execute"); finish = resolve; });
  loadFunctions(["runHostConfigLoop"], context);
  await context.runHostConfigLoop();
  assert.deepEqual(calls, ["publish", "claim", "execute"]);
  assert.equal(context.hostConfigActiveCommand, "command");
  await context.runHostConfigLoop();
  assert.deepEqual(calls, ["publish", "claim", "execute"]);
  finish(); await new Promise(setImmediate);
  assert.equal(context.hostConfigActiveCommand, "");
});

test("主电脑密钥准备期间降级后不得发布旧密钥或领取配置命令", async () => {
  const context = hostContext("primary");
  const calls = [];
  let finish;
  context.window.chorusDesktop.setHostConfigContext = () => new Promise((resolve) => { finish = resolve; });
  context.hostConfigClient = () => ({ publishKey: async () => calls.push("publish"), claim: async () => calls.push("claim") });
  loadFunctions(["runHostConfigLoop"], context);
  const pending = context.runHostConfigLoop();
  context.state.hostConfigEpoch++;
  context.state.relaySession.isPrimary = false;
  finish({ publicKey: "old-public-only" });
  await pending;
  assert.deepEqual(calls, []);
  assert.equal(context.hostConfigTickBusy, false);
});

test("非主设备从不启动原生配置领取器", async () => {
  for (const platform of ["mac", "android"]) {
    const context = hostContext(platform);
    context.window.chorusDesktop ||= {};
    context.window.chorusDesktop.setHostConfigContext = async () => context.nativeCalls.push("context");
    context.setInterval = () => { throw new Error("非主设备不应启动领取定时器"); };
    loadFunctions(["startHostConfigLoop", "runHostConfigLoop"], context);
    context.startHostConfigLoop();
    await context.runHostConfigLoop();
    assert.deepEqual(context.nativeCalls, []);
    assert.deepEqual(context.hostCommands, []);
  }
});

test("原生保存成功但结果回执暂时中断，只重试同一成功结果，不重复执行或改报失败", async () => {
  for (const status of [undefined, 503, 429]) {
    const context = hostContext("primary");
    const result = { openaiConfigured: true, ollamaBase: "http://127.0.0.1:11434" };
    const command = { id: "command-result", action: "model.save", payload: {} };
    let executions = 0;
    const deliveries = [];
    context.window.chorusDesktop.executeHostCommand = async () => { executions++; return result; };
    context.setTimeout = (callback) => { callback(); return 1; };
    const client = { complete: async (...args) => {
      deliveries.push(args);
      if (deliveries.length === 1) throw Object.assign(new Error("模拟回执中断"), { status });
      return { command: { status: "done", result } };
    } };
    loadFunctions(["executeHostConfigCommand"], context);
    await context.executeHostConfigCommand(command, client, () => true);
    assert.equal(executions, 1);
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every(([sent, value, error]) => sent === command && value === result && error === ""));
    assert.equal(context.state.desktopModelSettings.openaiConfigured, true);
  }
});

test("回执重试等待期间更换主电脑，停止交付旧配置结果", async () => {
  const context = hostContext("primary");
  const epoch = context.state.hostConfigEpoch;
  let deliveries = 0;
  context.window.chorusDesktop.executeHostCommand = async () => ({ openaiConfigured: true });
  context.setTimeout = (callback) => { context.state.hostConfigEpoch++; callback(); return 1; };
  loadFunctions(["executeHostConfigCommand"], context);
  await context.executeHostConfigCommand({ id: "old-command", action: "model.save" }, { complete: async () => { deliveries++; throw new Error("模拟短暂中断"); } }, () => epoch === context.state.hostConfigEpoch);
  assert.equal(deliveries, 1);
});

test("上一版模型表单保存晚到不能重新渲染或清除后来输入的配置", async () => {
  const context = hostContext();
  context.state.hostSettingsLoaded = true;
  loadFunctions(["renderSettings"], context);
  context.renderSettings();
  context.$("#keyOpenai").value = "earlier-synthetic-secret";
  let finish;
  context.hostConfigClient = () => ({ command: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = context.$("#saveKeys").listeners.click({ currentTarget: context.$("#saveKeys") });
  context.renderSettings();
  const generation = context.state.settingsRenderEpoch;
  context.state.hostSettingsDirty = true;
  context.$("#keyOpenai").value = "new-synthetic-secret";
  finish(context.remoteSettings.modelSettings);
  await pending;
  assert.equal(context.state.settingsRenderEpoch, generation);
  assert.equal(context.state.hostSettingsDirty, true);
  assert.equal(context.$("#keyOpenai").value, "new-synthetic-secret");
  assert.doesNotMatch(JSON.stringify(context.state), /synthetic-secret/);
});

test("上一版内核路径表单保存晚到不能刷新后来打开的配置表单", async () => {
  const context = hostContext();
  context.state.settingsRenderEpoch = 1;
  const input = { dataset: { harnessPath: "cursor" }, value: "/main/previous/agent" };
  context.$$ = () => [input];
  let finish;
  context.hostConfigClient = () => ({ command: (action) => { context.hostCommands.push({ action }); return new Promise((resolve) => { finish = resolve; }); } });
  const pending = context.saveHarnessPaths(1);
  context.state.settingsRenderEpoch = 2;
  context.state.hostSettingsDirty = true;
  input.value = "/main/new-draft/agent";
  finish({ paths: { cursor: "/main/previous/agent" } });
  await pending;
  assert.deepEqual(context.hostCommands.map((command) => command.action), ["harness.save"]);
  assert.equal(context.state.hostSettingsDirty, true);
  assert.equal(context.state.settingsRenderEpoch, 2);
  assert.equal(input.value, "/main/new-draft/agent");
});

test("旧主电脑设置表单不能在换主后继续提交模型密钥", async () => {
  const context = hostContext();
  context.state.hostSettingsLoaded = true;
  loadFunctions(["renderSettings"], context);
  context.renderSettings();
  const save = context.$("#saveKeys").listeners.click;
  context.state.hostConfigEpoch++;
  await save({ currentTarget: context.$("#saveKeys") });
  assert.deepEqual(context.hostCommands, []);
  assert.match(context.notices[0], /主电脑已改变/);
});
