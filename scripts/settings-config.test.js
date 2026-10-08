const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const C = require("../shared/web/conversation");
const R = require("../shared/web/relay-client");

const SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const AGENT = { id: "a", name: "工程师", role: "开发", persona: "完成实际任务", provider: "openai", backend: "codex", harness: "codex", harnessModel: "model-selected", model: "model-api", workspace: "/main/project", workspaceMode: "project", messages: [] };

/**
 * 加载页面真实函数，隔离模型、网络和原生窗口副作用。
 * @param {string[]} names 需要验证的函数名
 * @param {object} context 页面测试环境
 * @returns {object} 带真实页面函数的环境
 * 注意事项：不替代被测函数内的权限、冲突和异步版本判断。
 */
function loadFunctions(names, context) {
  if (names.includes("saveRelayAgentConfig") && !names.includes("saveRelayConfig")) names = ["saveRelayConfig", ...names];
  if (names.includes("saveEditedAgent") && !names.includes("normalizeAgentWorkspace")) names = ["normalizeAgentWorkspace", ...names];
  const source = names.map((name) => {
    const match = SOURCE.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, `找不到函数 ${name}`);
    return `${match[0]}; this.${name} = ${name};`;
  }).join("\n");
  vm.runInNewContext(source, context);
  return context;
}

/**
 * 构造设置页与编辑表单的最小环境。
 * @param {boolean} primary 是否为主电脑
 * @returns {object} 包含状态、控件和副作用记录的环境
 * 注意事项：默认存在已同步账号和一个可编辑成员，网络调用需各测试显式定义。
 */
function settingsContext(primary = false) {
  const elements = new Map();
  const context = {
    C, ChorusRelayClient: R, Error, Promise, console: { info() {}, warn() {}, error() {} },
    authAttemptEpoch: 1, conversationEpoch: 1, relayPrimaryBusy: false, relayDeviceListSignature: "", relayApplying: false, hostConfigTimer: null,
    state: { accountScope: "relay:account-a", user: { verified: true }, relayReady: true, relayConfigSynced: true, relayConfigRevision: 1, relaySession: { deviceToken: "token-a", accountId: "account-a", deviceId: "this-device", isPrimary: primary, revision: 3 }, relayDevices: [], harnessModels: {}, settings: { localExecution: true, notifyApp: true, notifySound: true }, agents: [{ ...AGENT, messages: [] }], rooms: [], editingAgentId: AGENT.id, agentModalEpoch: 1, agentModalMode: "edit", editDraft: { backend: "codex", harness: "codex", provider: "openai", harnessModel: "model-selected", baseRevision: 3 }, agentDraft: { backend: "model", harness: "none" }, settingsSection: "general" },
    window: { chorusDesktop: {}, confirm: () => true }, document: { hasFocus: () => false, activeElement: null },
    events: [], notices: [], requests: [],
    HARNESS_LABEL: { codex: "Codex", claude: "Claude Code", cursor: "Cursor" },
    renderRunning() {}, renderPanel() {}, updateExecutionSettingsVisibility() {}, syncRelayDeviceList() {}, saveDraft() {}, restoreDraft() {},
    readableError: (error) => error.message,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    normalizeStoredMessages: (messages) => C.normalizeMessages(messages),
    buildRelaySnapshot: () => ({ agents: context.state.agents, rooms: [], configRevision: context.state.relayConfigRevision }),
  };
  context.$ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: "", hidden: false, disabled: false, innerHTML: "", textContent: "", classList: { contains: () => selector === "#agentOverlay", toggle() {} }, querySelectorAll: () => [], addEventListener() {} });
    return elements.get(selector);
  };
  context.$$ = () => [];
  context.getAgent = (id) => context.state.agents.find((agent) => agent.id === id);
  context.getRoom = () => null;
  context.toast = (message) => context.notices.push(message);
  context.persistApp = () => context.events.push("persist");
  context.saveRelaySession = () => context.events.push("save-session");
  context.renderAll = () => context.events.push("render-all");
  context.renderSettings = () => context.events.push("render-settings");
  context.renderRelayDeviceList = () => context.events.push("render-devices");
  context.closeOverlay = (id) => context.events.push(`close:${id}`);
  context.prepareDesktopWorkspaces = async () => false;
  context.loadRelayDevices = async () => context.events.push("load-devices");
  context.pullRelayState = async () => context.events.push("pull-state");
  context.logout = async () => { context.events.push("logout"); context.state.relaySession = null; };
  context.stopRun = async () => context.events.push("stop-run");
  context.publishGatewayConfig = async () => context.events.push("publish-gateway");
  context.refreshHarnessStatus = async () => context.events.push("refresh-harness");
  context.loadDesktopModelSettings = async () => context.events.push("load-model-settings");
  context.resetHostConfig = () => context.events.push("reset-host");
  context.startHostConfigLoop = () => context.events.push("start-host");
  context.hostConfigClient = () => ({ command: async (_action, body) => ({ path: body?.path }) });
  context.ChorusTerminalUI = { reset: async () => context.events.push("reset-terminal") };
  context.relayRequest = async (...args) => { context.requests.push(args); return { revision: 4, state: { agents: [{ ...AGENT }], rooms: [], settings: { localExecution: true } } }; };
  context.applyRelaySnapshot = (snapshot) => { context.events.push("apply-snapshot"); context.snapshot = snapshot; };
  context.refreshRelayView = () => context.events.push("refresh-relay");
  context.renderHarnessModelChoice = () => context.events.push("render-models");
  for (const [selector, value] of Object.entries({ "#editAgentName": "新的工程师", "#editAgentRole": "开发", "#editAgentPersona": "修改后的人设", "#editAgentLabel": "标签", "#editModelId": "model-api", "#editModelEndpoint": "", "#editTemperature": "0.7", "#editAgentWorkspace": "/main/project" })) context.$(selector).value = value;
  return loadFunctions(["isPrimaryDevice", "canEditAgentConfig"], context);
}

test("其他已同步账号设备可以编辑 Agent，但不获得主电脑执行权限", () => {
  const context = settingsContext();
  assert.equal(context.canEditAgentConfig(), true);
  assert.equal(context.isPrimaryDevice(), false);
  context.state.relayConfigSynced = false;
  assert.equal(context.canEditAgentConfig(), false);
  context.state.relaySession = null;
  assert.equal(context.canEditAgentConfig(), true);
  context.window.chorusDesktop = undefined;
  assert.equal(context.canEditAgentConfig(), false);
});

test("版本化 PATCH 只带配置白名单，ID 只在路径，不带聊天和凭据", async () => {
  const context = loadFunctions(["saveRelayAgentConfig"], settingsContext());
  const result = await context.saveRelayAgentConfig({ ...AGENT, notify: false, apiKey: "secret", messages: [{ text: "private-content" }] });
  assert.equal(result, true);
  const [method, url, token, body] = context.requests[0];
  assert.equal(method, "PATCH"); assert.equal(url, "/api/v1/agents/a"); assert.equal(token, "token-a");
  assert.equal(body.baseRevision, 3);
  assert.equal(body.config.id, undefined);
  assert.equal(body.config.harnessModel, "model-selected");
  assert.equal(body.config.workspaceMode, "project");
  assert.equal(body.config.notify, undefined);
  assert.doesNotMatch(JSON.stringify(body), /secret|private-content|messages|apiKey/);
});

test("409 应用最新共享状态并更新基准版本，保留未提交的表单和模型选择", async () => {
  const context = loadFunctions(["saveRelayAgentConfig", "applyRelaySnapshot", "refreshRelayView"], settingsContext());
  const inputs = ["#editAgentName", "#editAgentPersona", "#editAgentWorkspace"].map((selector) => context.$(selector).value);
  const error = new Error("conflict");
  error.status = 409;
  error.payload = { revision: 9, state: { configRevision: 5, agents: [{ ...AGENT, name: "其他设备已保存" }], rooms: [], settings: { localExecution: true } } };
  context.relayRequest = async () => { throw error; };
  assert.equal(await context.saveRelayAgentConfig(AGENT), false);
  assert.equal(context.state.agents[0].name, "其他设备已保存");
  assert.equal(context.state.editDraft.baseRevision, 9);
  assert.equal(context.state.editDraft.harnessModel, "model-selected");
  assert.deepEqual(["#editAgentName", "#editAgentPersona", "#editAgentWorkspace"].map((selector) => context.$(selector).value), inputs);
  assert.match(context.notices[0], /保留你的输入/);
  assert.ok(!context.events.includes("close:agentOverlay"));
});

test("PATCH 晚到成功或冲突不能覆盖切换后的账号", async () => {
  for (const conflict of [false, true]) {
    const context = loadFunctions(["saveRelayAgentConfig"], settingsContext());
    let finish;
    context.relayRequest = () => new Promise((resolve, reject) => { finish = conflict ? reject : resolve; });
    const pending = context.saveRelayAgentConfig(AGENT);
    context.state.relaySession = { deviceToken: "token-b", revision: 40 };
    const payload = { revision: 5, state: { agents: [AGENT] } };
    finish(conflict ? Object.assign(new Error("conflict"), { status: 409, payload }) : payload);
    assert.equal(await pending, false);
    assert.equal(context.state.relaySession.revision, 40);
    assert.equal(context.snapshot, undefined);
    assert.equal(context.notices.length, 0);
  }
});

test("PATCH 成功响应晚于实时同步时，不用旧快照回退当前配置和版本", async () => {
  const context = loadFunctions(["saveRelayAgentConfig"], settingsContext());
  let finish;
  context.relayRequest = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.saveRelayAgentConfig(AGENT);
  context.state.relaySession.revision = 12;
  context.state.agents[0].name = "实时同步的新配置";
  finish({ revision: 8, state: { agents: [{ ...AGENT, name: "保存时的旧快照" }] } });
  assert.equal(await pending, true);
  assert.equal(context.state.relaySession.revision, 12);
  assert.equal(context.state.agents[0].name, "实时同步的新配置");
  assert.equal(context.snapshot, undefined);
});

test("409 响应晚于实时同步时，保留当前快照并以最新版本准备再次保存", async () => {
  const context = loadFunctions(["saveRelayAgentConfig"], settingsContext());
  let finish;
  context.relayRequest = () => new Promise((resolve, reject) => { finish = reject; });
  const pending = context.saveRelayAgentConfig(AGENT);
  context.state.relaySession.revision = 12;
  context.state.agents[0].name = "实时同步的新配置";
  const error = Object.assign(new Error("conflict"), { status: 409, payload: { revision: 8, state: { agents: [{ ...AGENT, name: "冲突时的旧快照" }] } } });
  finish(error);
  assert.equal(await pending, false);
  assert.equal(context.state.relaySession.revision, 12);
  assert.equal(context.state.editDraft.baseRevision, 12);
  assert.equal(context.state.agents[0].name, "实时同步的新配置");
  assert.equal(context.$("#editAgentName").value, "新的工程师");
  assert.equal(context.snapshot, undefined);
});

test("工作区异步校验期间切换账号，不得使用新账号令牌保存旧表单", async () => {
  const context = loadFunctions(["saveEditedAgent", "saveRelayAgentConfig"], settingsContext(true));
  let finish;
  context.window.chorusDesktop.normalizeWorkspace = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.saveEditedAgent();
  context.authAttemptEpoch++; context.conversationEpoch++;
  context.state.accountScope = "relay:account-b";
  context.state.relaySession = { deviceToken: "token-b", accountId: "account-b", isPrimary: true, revision: 20 };
  context.state.agents = [{ ...AGENT, name: "新账号成员" }];
  finish("/old-account/project");
  await pending;
  assert.equal(context.requests.length, 0);
  assert.equal(context.state.agents[0].name, "新账号成员");
  assert.equal(context.notices.length, 0);
});

test("非主电脑在编辑过程中失去同步连接，不得伪装成本地保存成功", async () => {
  const context = loadFunctions(["saveEditedAgent", "saveRelayAgentConfig"], settingsContext());
  context.state.relayReady = false;
  await context.saveEditedAgent();
  assert.equal(context.state.agents[0].name, AGENT.name);
  assert.equal(context.requests.length, 0);
  assert.ok(!context.events.includes("close:agentOverlay"));
});

test("非主电脑与手机只读取共享模型目录，不调用本机 CLI", async () => {
  const context = loadFunctions(["loadHarnessModels"], settingsContext());
  let calls = 0;
  context.window.chorusDesktop.listHarnessModels = async () => { calls++; return { models: [] }; };
  await context.loadHarnessModels("codex", true);
  assert.equal(calls, 0);
  context.window.chorusDesktop = undefined;
  await context.loadHarnessModels("claude", true);
  assert.equal(calls, 0);
});

test("主电脑模型目录请求去重，完成后保留模型ID和来源", async () => {
  const context = loadFunctions(["loadHarnessModels"], settingsContext(true));
  let finish, calls = 0;
  context.window.chorusDesktop.listHarnessModels = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const pending = context.loadHarnessModels("codex");
  await context.loadHarnessModels("codex", true);
  assert.equal(calls, 1);
  finish({ models: [{ id: "real-model", label: "真实模型" }], source: "cli" }); await pending;
  assert.equal(context.state.harnessModels.codex.models[0].id, "real-model");
  assert.equal(context.state.harnessModels.codex.source, "cli");
  assert.ok(!context.state.harnessModels.codex.loading);
});

test("切换账号后晚到的模型目录不进入新账号缓存", async () => {
  const context = loadFunctions(["loadHarnessModels"], settingsContext(true));
  let finish;
  context.window.chorusDesktop.listHarnessModels = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.loadHarnessModels("codex");
  context.state.accountScope = "relay:account-b";
  context.state.harnessModels = {};
  finish({ models: [{ id: "account-a-model" }] }); await pending;
  assert.equal(context.state.harnessModels.codex, undefined);
});

test("同账号退出再登录后，旧模型目录也不能覆盖新会话结果", async () => {
  const context = loadFunctions(["loadHarnessModels"], settingsContext(true));
  let finish;
  context.window.chorusDesktop.listHarnessModels = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.loadHarnessModels("codex");
  context.authAttemptEpoch++; context.conversationEpoch++;
  context.state.relaySession.deviceToken = "token-a-new";
  context.state.harnessModels = { codex: { models: [{ id: "new-session-model" }] } };
  finish({ models: [{ id: "old-session-model" }] }); await pending;
  assert.equal(context.state.harnessModels.codex.models[0].id, "new-session-model");
});

test("模型目录失败仍保留已选模型，并提示失败原因", () => {
  const context = loadFunctions(["renderHarnessModelChoice"], settingsContext());
  context.state.harnessModels.codex = { models: [], error: "主电脑 CLI 暂不可用" };
  context.renderHarnessModelChoice("edit");
  assert.equal(context.$("#editHarnessModel").value, "model-selected");
  assert.match(context.$("#editHarnessModel").innerHTML, /model-selected（已配置）/);
  assert.equal(context.$("#editHarnessModelHint").textContent, "主电脑 CLI 暂不可用");
});

test("通知总开关覆盖所有 Agent，忽略已废弃的单 Agent notify字段", () => {
  const context = loadFunctions(["notifyAgentResult"], settingsContext());
  const notifications = [];
  context.Notification = function (title, options) { notifications.push({ title, options }); this.addEventListener = () => {}; };
  context.Notification.permission = "granted";
  context.window.Notification = context.Notification;
  context.playNotificationTone = () => context.events.push("sound");
  context.notifyAgentResult({ ...AGENT, notify: false }, {}, "完成", false);
  assert.equal(notifications.length, 1);
  assert.equal(context.events.filter((event) => event === "sound").length, 1);
  context.state.settings.notifyApp = false;
  context.notifyAgentResult({ ...AGENT, notify: true }, {}, "完成", false);
  assert.equal(notifications.length, 1);
  assert.equal(context.events.filter((event) => event === "sound").length, 1);
  context.state.settings.notifyApp = true;
  context.document.hasFocus = () => true;
  context.notifyAgentResult(AGENT, {}, "完成", false);
  assert.equal(notifications.length, 1);
});

test("离线电脑的列表操作禁用并显示离线不可设置，当前主电脑明显标记", () => {
  const context = loadFunctions(["renderRelayDeviceList", "relayDevicesSignature", "devicePlatformLabel", "formatDeviceLastSeen"], settingsContext());
  context.state.relayDevices = [{ id: "primary", name: "执行电脑", platform: "mac", online: true, isPrimary: true }, { id: "offline", name: "离线电脑", platform: "windows", online: false, isPrimary: false }];
  context.renderRelayDeviceList();
  const html = context.$("#relayDeviceList").innerHTML;
  assert.match(html, /device-row is-primary/);
  assert.match(html, /value="offline" disabled/);
  assert.match(html, /离线不可设置/);
  assert.match(html, /data-remove-device="offline"/);
});

test("离线电脑不能通过设置函数发起主电脑变更请求", async () => {
  const context = loadFunctions(["setRelayPrimary"], settingsContext());
  context.state.relayDevices = [{ id: "offline", platform: "mac", online: false }];
  await context.setRelayPrimary("offline");
  assert.equal(context.requests.length, 0);
  assert.equal(context.notices[0], "离线不可设置");
});

test("取消删除不发送请求，确认后删除目标设备并刷新共享状态", async () => {
  const context = loadFunctions(["removeRelayDevice"], settingsContext());
  context.state.relayDevices = [{ id: "another-device", name: "旧电脑", isPrimary: true }];
  let prompt;
  context.window.confirm = (message) => { prompt = message; return false; };
  await context.removeRelayDevice("another-device");
  assert.equal(context.requests.length, 0);
  assert.match(prompt, /重新选择在线主电脑/);
  context.window.confirm = () => true;
  await context.removeRelayDevice("another-device");
  assert.equal(context.requests[0][0], "DELETE");
  assert.equal(context.requests[0][1], "/api/v1/devices/another-device");
  assert.deepEqual(context.events.filter((event) => ["load-devices", "pull-state"].includes(event)), ["load-devices", "pull-state"]);
  assert.equal(context.relayPrimaryBusy, false);
});

test("删除本机设备会退出本机登录，重复删除被进行中状态阻止", async () => {
  const context = loadFunctions(["removeRelayDevice"], settingsContext());
  context.state.relayDevices = [{ id: "this-device", name: "本机" }];
  let finish;
  context.relayRequest = (...args) => { context.requests.push(args); return new Promise((resolve) => { finish = resolve; }); };
  const pending = context.removeRelayDevice("this-device");
  await context.removeRelayDevice("this-device");
  assert.equal(context.requests.length, 1);
  finish({}); await pending;
  assert.equal(context.state.relaySession, null);
  assert.equal(context.events.filter((event) => event === "logout").length, 1);
});

test("删除设备期间切换账号，旧响应不能退出新账号或拉取新账号状态", async () => {
  const context = loadFunctions(["removeRelayDevice"], settingsContext());
  context.state.relayDevices = [{ id: "this-device", name: "本机" }];
  let finish;
  context.relayRequest = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.removeRelayDevice("this-device");
  context.state.relaySession = { deviceToken: "new-account", revision: 1 };
  finish({}); await pending;
  assert.equal(context.state.relaySession.deviceToken, "new-account");
  assert.ok(!context.events.includes("logout"));
  assert.ok(!context.events.includes("pull-state"));
});

test("主电脑身份被撤销后停止当前聊天任务并更新执行入口", async () => {
  const context = loadFunctions(["loadRelayDevices"], settingsContext(true));
  context.state.sending = true;
  context.state.harnessModels.codex = { loading: true };
  context.relayRequest = async () => ({ devices: [{ id: "this-device", name: "旧主电脑", platform: "mac", online: true, isPrimary: false }] });
  await context.loadRelayDevices();
  assert.equal(context.isPrimaryDevice(), false);
  assert.equal(context.events.filter((event) => event === "stop-run").length, 1);
  assert.ok(context.events.includes("reset-terminal"));
  assert.ok(context.events.includes("publish-gateway"));
  assert.equal(Object.keys(context.state.harnessModels).length, 0);
});

test("非主电脑发布的本地网关不能沿用主电脑允许执行的开关", () => {
  const context = loadFunctions(["gatewayConfig"], settingsContext());
  context.state.settings.localExecution = true;
  assert.equal(context.gatewayConfig().settings.localExecution, false);
  context.state.relaySession.isPrimary = true;
  assert.equal(context.gatewayConfig().settings.localExecution, true);
});

test("成为新主电脑后丢弃旧主电脑模型缓存并检测本机内核", async () => {
  const context = loadFunctions(["loadRelayDevices"], settingsContext());
  context.state.harnessModels.codex = { models: [{ id: "old-host-model" }] };
  context.relayRequest = async () => ({ devices: [{ id: "this-device", platform: "mac", online: true, isPrimary: true }] });
  await context.loadRelayDevices();
  assert.equal(context.isPrimaryDevice(), true);
  assert.equal(Object.keys(context.state.harnessModels).length, 0);
  assert.ok(context.events.includes("refresh-harness"));
});

test("主电脑降级再升级后，旧模型目录请求不能覆盖新设备角色的目录", async () => {
  const context = loadFunctions(["loadRelayDevices", "loadHarnessModels"], settingsContext(true));
  let finish;
  context.window.chorusDesktop.listHarnessModels = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.loadHarnessModels("codex");
  context.relayRequest = async () => ({ devices: [{ id: "this-device", platform: "mac", online: true, isPrimary: false }] });
  await context.loadRelayDevices();
  context.relayRequest = async () => ({ devices: [{ id: "this-device", platform: "mac", online: true, isPrimary: true }] });
  await context.loadRelayDevices();
  context.state.harnessModels.codex = { models: [{ id: "new-role-model" }] };
  finish({ models: [{ id: "old-role-model" }] }); await pending;
  assert.equal(context.state.harnessModels.codex.models[0].id, "new-role-model");
});

test("切换主电脑请求刷新列表期间换账号，不得在新账号显示旧操作成功", async () => {
  const context = loadFunctions(["setRelayPrimary"], settingsContext());
  context.state.relayDevices = [{ id: "target", name: "目标电脑", platform: "mac", online: true }];
  let finish;
  context.loadRelayDevices = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.setRelayPrimary("target");
  await new Promise(setImmediate);
  context.state.relaySession = { deviceToken: "token-b", revision: 1 };
  finish(); await pending;
  assert.equal(context.notices.length, 0);
});

test("删除其他设备刷新列表期间换账号，不再执行旧操作后续状态拉取", async () => {
  const context = loadFunctions(["removeRelayDevice"], settingsContext());
  context.state.relayDevices = [{ id: "target", name: "目标电脑", platform: "mac", online: false }];
  let finish;
  context.loadRelayDevices = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.removeRelayDevice("target");
  await new Promise(setImmediate);
  context.state.relaySession = { deviceToken: "token-b", revision: 1 };
  finish(); await pending;
  assert.ok(!context.events.includes("pull-state"));
  assert.equal(context.notices.length, 0);
});
