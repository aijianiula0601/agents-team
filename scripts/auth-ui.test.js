const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const C = require("../shared/web/conversation");
const source = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../shared/web/index.html"), "utf8");
const BASE = "https://relay.example.test/agents-team";

/**
 * 加载实际界面函数到隔离上下文。
 * @param {string[]} names 需要验证的真实函数名
 * @param {object} context 测试状态和依赖
 * @returns {object} 带有对应函数的隔离环境
 * 注意事项：不运行页面启动流程，不连接用户账号或外部服务。
 */
function appFunctions(names, context) {
  vm.runInNewContext(names.map((name) => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, name);
    return `${match[0]}; this.${name} = ${name};`;
  }).join("\n"), context);
  return context;
}

/**
 * 创建认证表单、可访问按钮与记录事件的测试环境。
 * @param {object} [overrides] 单个测试需要替换的状态或依赖
 * @returns {object} 可调用真实表单逻辑的测试环境
 * 注意事项：密码与账号均为合成数据；不会写入真实 localStorage 或输出秘密。
 */
function authContext(overrides = {}) {
  const elements = new Map(), storage = new Map(), notices = [], opened = [];
  const state = { authMode: "login", authPending: "", authError: "", authProviders: {}, user: null, relaySession: null, accountScope: "", agents: [], rooms: [], drafts: {}, sending: false, settings: {} };
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: "", textContent: "", type: "password", hidden: false, disabled: false, style: {}, dataset: {}, attributes: {},
      selectionStart: 0, selectionEnd: 0, checkValidity: () => true, focus() {}, setSelectionRange() {},
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    return elements.get(selector);
  };
  const eye = { dataset: { passwordTarget: "regPassword" }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const confirmEye = { ...eye, dataset: { passwordTarget: "regPasswordConfirm" }, attributes: {} };
  const context = {
    state, elements, storage, notices, opened, eye, confirmEye, $: element, $$: () => [eye, confirmEye],
    authAttemptEpoch: 0, conversationEpoch: 0, TextEncoder, AbortController, setTimeout, clearTimeout,
    relayBaseUrl: () => BASE, currentClientPlatform: () => "android", getOrCreateClientDeviceId: () => "synthetic-device", currentDeviceName: () => "测试设备",
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    console: { info() {}, warn() {}, error() {} }, readableError: (error) => error.message,
    toast: (message) => notices.push(message), openOverlay: (name) => opened.push(name), closeOverlay() {},
    persistApp() {}, renderAccount() {}, renderAll() {}, stopRun: async () => {},
    clearRelaySession: () => { state.relaySession = null; },
    resetConversationEditor: () => { state.pendingAttachments = []; state.attachmentLoads = new Set(); element("#composerInput").value = ""; },
    ChorusRelayClient: { request: async () => ({}) }, loadAuthProviders: async () => {},
    ...overrides,
  };
  element("#regEmail").value = "member@example.test";
  element("#regName").value = "测试成员";
  element("#regPassword").value = "synthetic-password";
  element("#regPasswordConfirm").value = "synthetic-password";
  return appFunctions(["syncAuthModal", "setAuthError", "resetAuthPasswords", "setAuthMode", "toggleAuthPassword", "emailLogin", "waitForAuthCompletion"], context);
}

test("默认登录表单先显示邮箱密码，注册有独立确认密码，Google位于最后", () => {
  assert.ok(html.indexOf('id="authEmailForm"') < html.indexOf('id="btnGoogleLogin"'));
  assert.match(html, /id="authNameRow" hidden/);
  assert.match(html, /id="authConfirmRow" hidden/);
  assert.match(html, /id="regPassword"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="regPasswordConfirm"[^>]*autocomplete="new-password"/);
  assert.match(html, /id="btnEmailLogin">登录</);
  assert.match(html, /id="btnSwitchAccount"/);
  assert.match(html, /id="btnHeaderAccount"[^>]*aria-label="登录或注册账号"/);
  assert.match(source, /authEmailForm.*addEventListener\("submit"/);
});

test("未配置中转站时引导设置且不发请求，配置后仍可登录自建站", async () => {
  const sections = [], requests = [];
  const context = authContext({ relayBaseUrl: () => "", openSettings: (section) => sections.push(section), ChorusRelayClient: { request: async (...args) => { requests.push(args); return {}; } } });
  appFunctions(["openAuthModal", "relayRequest"], context);
  context.openAuthModal();
  assert.deepEqual(sections, ["connection"]);
  assert.match(context.notices[0], /填写自己的中转站地址/);
  await assert.rejects(context.relayRequest("GET", "/api/v1/config", null, null), /请先在设置中填写中转站地址/);
  assert.equal(requests.length, 0);
  context.relayBaseUrl = () => BASE;
  await context.relayRequest("GET", "/api/v1/config", null, null);
  assert.equal(requests[0][0], BASE);
  context.openAuthModal();
  assert.equal(context.opened.at(-1), "authOverlay");
});

test("登录和注册模式独立，返回登录不要求姓名或确认密码，切换清除秘密", () => {
  const context = authContext(); context.syncAuthModal();
  assert.equal(context.$("#authNameRow").hidden, true);
  assert.equal(context.$("#regName").required, false);
  context.setAuthMode("register");
  assert.equal(context.$("#authNameRow").hidden, false);
  assert.equal(context.$("#authConfirmRow").hidden, false);
  assert.equal(context.$("#regName").required, true);
  assert.equal(context.$("#regPassword").autocomplete, "new-password");
  assert.equal(context.$("#regPassword").placeholder, "设置密码");
  assert.equal(context.$("#authPasswordHelp").hidden, false);
  assert.equal(context.$("#btnEmailLogin").textContent, "注册并登录");
  context.$("#regPassword").value = "new-secret"; context.setAuthMode("login");
  assert.equal(context.$("#regPassword").value, "");
  assert.equal(context.$("#regPasswordConfirm").disabled, true);
  assert.equal(context.$("#regPassword").autocomplete, "current-password");
  assert.equal(context.$("#authPasswordHelp").hidden, true);
});

test("眼睛按钮显示隐藏密码并更新可访问名称，不改变密码正文", () => {
  const context = authContext(); const password = context.$("#regPassword").value;
  context.toggleAuthPassword(context.eye);
  assert.equal(context.$("#regPassword").type, "text");
  assert.equal(context.eye.attributes["aria-pressed"], "true");
  assert.equal(context.eye.attributes["aria-label"], "隐藏密码");
  context.toggleAuthPassword(context.eye);
  assert.equal(context.$("#regPassword").type, "password");
  assert.equal(context.$("#regPassword").value, password);
});

test("注册确认密码不一致时原地提示，不调用服务器", async () => {
  let requests = 0; const context = authContext({ relayRequest: async () => { requests++; } });
  context.state.authMode = "register"; context.$("#regPasswordConfirm").value = "different";
  assert.equal(await context.emailLogin(), false); assert.equal(requests, 0);
  assert.match(context.state.authError, /不一致/); assert.equal(context.$("#authError").hidden, false);
});

test("注册真实提交服务端action=register，确认密码不会发给严格接口", async () => {
  const requests = []; const context = authContext({ relayRequest: async (...args) => { requests.push(args); return { deviceToken: "synthetic-token" }; }, loginAs: async () => true });
  context.state.authMode = "register";
  assert.equal(await context.emailLogin(), true);
  assert.equal(requests[0][0], "POST"); assert.equal(requests[0][1], "/api/v1/auth/email");
  assert.equal(requests[0][3].action, "register"); assert.equal(requests[0][3].name, "测试成员");
  assert.equal(requests[0][3].device.platform, "android");
  assert.equal(Object.hasOwn(requests[0][3], "confirmPassword"), false);
  assert.equal(Object.hasOwn(requests[0][3], "passwordConfirm"), false);
});

test("邮箱登录忽略注册姓名和确认密码，认证挂起时不能重复提交", async () => {
  let finish, requests = 0;
  const context = authContext({ relayRequest: () => { requests++; return new Promise((resolve) => { finish = resolve; }); }, loginAs: async () => true });
  context.$("#regPasswordConfirm").value = "different";
  const pending = context.emailLogin();
  assert.equal(context.$("#btnEmailLogin").disabled, true);
  assert.equal(await context.emailLogin(), false); assert.equal(requests, 1);
  finish({ deviceToken: "synthetic-token" }); assert.equal(await pending, true);
  assert.equal(context.$("#btnEmailLogin").disabled, false);
});

test("旧认证响应晚到不能开始新账号会话或清除新密码", async () => {
  let finish, loggedIn = 0;
  const context = authContext({ relayRequest: () => new Promise((resolve) => { finish = resolve; }), loginAs: async () => { loggedIn++; } });
  const pending = context.emailLogin(); context.authAttemptEpoch++;
  context.$("#regPassword").value = "new-account-password";
  finish({ deviceToken: "old-token" }); assert.equal(await pending, false);
  assert.equal(loggedIn, 0); assert.equal(context.$("#regPassword").value, "new-account-password");
});

test("服务器注册错误原地显示并解除加载，Unicode密码按服务字节规则提交", async () => {
  const context = authContext({ relayRequest: async () => { throw new Error("该邮箱已注册，请直接登录"); } });
  context.state.authMode = "register";
  context.$("#regPassword").value = "中文密"; context.$("#regPasswordConfirm").value = "中文密";
  assert.equal(await context.emailLogin(), false);
  assert.match(context.state.authError, /已注册/); assert.equal(context.state.authPending, "");
});

test("Google能力由公开配置决定，可关闭也可重新启用", async () => {
  const context = authContext({ relayRequest: async () => ({ googleConfigured: false }) });
  appFunctions(["loadAuthProviders"], context);
  await context.loadAuthProviders(); assert.equal(context.$("#btnGoogleLogin").disabled, true);
  assert.match(context.$("#googleLoginLabel").textContent, /暂未启用/);
  context.relayRequest = async () => ({ googleConfigured: true });
  await context.loadAuthProviders(); assert.equal(context.$("#btnGoogleLogin").disabled, false);
});

test("认证已成功但同步失败时仍登录并后台重试，不会误报注册失败", async () => {
  let retried = false; const context = authContext({ startRelayLoop: () => { retried = true; } });
  context.connectRelaySession = async (session) => { context.state.relaySession = { deviceToken: session.deviceToken }; context.state.user = { name: "测试成员", email: "member@example.test", verified: true }; throw new Error("网络暂时失败"); };
  appFunctions(["loginAs"], context);
  assert.equal(await context.loginAs({ deviceToken: "synthetic-token" }, BASE, 0), true);
  assert.equal(retried, true); assert.equal(context.state.relayReady, true);
  assert.match(context.notices[0], /已登录.*自动重试/);
  assert.equal(context.$("#regPassword").value, "");
});

test("退出先隔离本机再等待服务器，旧同步401先到也不会遗留旧账号聊天", async () => {
  let finish, finishSync; const context = authContext({ relayLoopBusy: false, relayLoopQueued: false, refreshRelayAccount: async () => true,
    loadRelayDevices: () => new Promise((_, reject) => { finishSync = reject; }), pullRelayState: async () => {},
  });
  context.state.user = { verified: true, name: "旧账号", email: "old@example.test" };
  context.state.relaySession = { deviceToken: "old-token", baseUrl: BASE, accountId: "old-account" };
  context.state.accountScope = `${BASE}:old-account`; context.state.agents = [{ messages: ["旧聊天"] }];
  context.state.relayReady = true;
  context.state.drafts = { old: "旧草稿" }; context.state.pendingAttachments = ["旧附件"];
  context.ChorusRelayClient.request = () => new Promise((resolve) => { finish = resolve; });
  appFunctions(["logout", "runRelayLoop"], context);
  const oldSync = context.runRelayLoop(); await new Promise(setImmediate);
  const pending = context.logout(true);
  await new Promise(setImmediate);
  assert.equal(context.state.user, null); assert.equal(context.state.relaySession, null);
  assert.equal(context.state.agents.length, 0); assert.equal(Object.keys(context.state.drafts).length, 0);
  assert.equal(context.state.pendingAttachments.length, 0);
  // 让真实同步函数收到旧401：令牌已隔离，不得跳过注销的本机清理或清除后续身份。
  const unauthorized = new Error("旧会话无效"); unauthorized.status = 401;
  finishSync(unauthorized); await oldSync; finish({}); assert.equal(await pending, true);
  assert.equal(context.state.authMode, "login"); assert.equal(context.state.authPending, "");
  assert.equal(context.opened.at(-1), "authOverlay");
});

test("注销断网也可本机退出，并明确说明服务端注销尚未确认", async () => {
  const context = authContext(); context.state.relaySession = { deviceToken: "old-token", baseUrl: BASE };
  context.state.user = { verified: true, email: "old@example.test" };
  context.ChorusRelayClient.request = async () => { throw new Error("网络失败"); };
  appFunctions(["logout"], context);
  assert.equal(await context.logout(), true);
  assert.equal(context.state.user, null); assert.equal(context.state.relaySession, null);
  assert.match(context.notices[0], /本机退出.*尚未确认/);
});

test("停止旧账号任务后晚到结果不能写聊天或覆盖新账号运行状态", async () => {
  let finish;
  const context = authContext({ crypto: { randomUUID: () => "synthetic-run" }, HARNESS_LABEL: {}, nowTime: () => "12:00", renderRunning() {}, renderAgents() {}, renderMessages() {}, scheduleRelayPush() {}, notifyAgentResult() {} });
  context.state.accountScope = "account-A";
  context.produceReply = () => new Promise((resolve) => { finish = resolve; });
  const thread = [], agent = { id: "a", name: "旧成员", backend: "model" };
  appFunctions(["dispatchAgentReplies"], context);
  const pending = context.dispatchAgentReplies({ userText: "测试任务", responders: [agent], mode: "discuss", context: { thread, key: "agent:a" } });
  context.authAttemptEpoch++; context.conversationEpoch++; context.state.accountScope = "account-B";
  context.state.sending = true; context.state.activeRunId = "new-run";
  finish({ text: "旧回复" }); await pending;
  assert.equal(thread.length, 0); assert.equal(context.state.sending, true); assert.equal(context.state.activeRunId, "new-run");
});

test("退出后再登录A恢复账号缓存草稿，切换无缓存B保持干净", async () => {
  const context = authContext({ isPrimaryDevice: () => false, pullRelayState: async () => false, loadRelayDevices: async () => {}, saveRelaySession() {}, refreshRelayView() {}, startRelayLoop() {} });
  context.storage.set(`chorus-account:${BASE}:account-A`, JSON.stringify({ agents: [{ id: "agent-A", messages: [{ text: "A未上传聊天" }] }], rooms: [], drafts: { "agent:agent-A": { text: "A草稿" } } }));
  context.applyRelaySnapshot = (saved) => { context.state.agents = saved.agents; context.state.rooms = saved.rooms; };
  context.persistApp = () => {
    if (context.state.accountScope) context.storage.set(`chorus-account:${context.state.accountScope}`, JSON.stringify({ agents: context.state.agents, rooms: context.state.rooms, drafts: context.state.drafts }));
  };
  appFunctions(["normalizeRelayAccount", "connectRelaySession", "logout"], context);
  const sessionA = { deviceToken: "token-A", account: { id: "account-A", email: "a@example.test", name: "A", provider: "email" }, device: { id: "device-A", isPrimary: false } };
  assert.equal(await context.connectRelaySession(sessionA), true);
  assert.equal(context.state.agents[0].messages[0].text, "A未上传聊天");
  assert.equal(context.state.drafts["agent:agent-A"].text, "A草稿");
  assert.equal(await context.logout(true), true); assert.equal(context.state.agents.length, 0);
  const sessionB = { deviceToken: "token-B", account: { id: "account-B", email: "b@example.test", name: "B", provider: "email" }, device: { id: "device-B", isPrimary: false } };
  assert.equal(await context.connectRelaySession(sessionB), true);
  assert.equal(context.state.agents.length, 0); assert.equal(Object.keys(context.state.drafts).length, 0);
  assert.match(context.storage.get(`chorus-account:${BASE}:account-A`), /A未上传聊天/);
});

test("旧默认目录准备晚到不能重置新账号的preparingSend", async () => {
  let finish; const context = authContext({ updateComposer() {}, toast() {}, pickResponders: () => [{ id: "a" }], chatContext: () => ({ thread: [] }),
    prepareDesktopWorkspaces: () => new Promise((resolve) => { finish = resolve; }),
  });
  context.state.accountScope = "account-A"; context.state.pendingAttachments = []; context.state.attachmentLoads = new Set();
  context.$("#composerInput").value = "旧任务";
  appFunctions(["sendMessage"], context);
  const pending = context.sendMessage();
  context.authAttemptEpoch++; context.conversationEpoch++; context.state.accountScope = "account-B";
  context.state.preparingSend = true;
  finish(false); await pending;
  assert.equal(context.state.preparingSend, true);
});

test("终端注销挂起期间保存地址被阻止，旧logout完成仍撤销旧令牌且保留新身份", async () => {
  let finishReset;
  const revoked = [];
  const context = authContext({ ChorusTerminalUI: { reset: () => new Promise((resolve) => { finishReset = resolve; }) }, renderSettings() {} });
  context.state.user = { id: "old-account", email: "old@example.test" };
  context.state.accountScope = `${BASE}:old-account`;
  context.state.relaySession = { deviceToken: "synthetic-old", baseUrl: BASE };
  context.ChorusRelayClient.request = async (...args) => { revoked.push(args); return {}; };
  appFunctions(["logout"], context);
  const pending = context.logout(true), attempt = context.authAttemptEpoch;
  const handler = source.split('$("#btnSaveRelayUrl").addEventListener("click", () => {')[1].split("\n        });")[0];
  context.s = context.state.settings; context.normalizeRelayBaseUrl = (value) => value;
  context.$("#relayBaseUrl").value = "https://new.example.test/agents-team";
  vm.runInNewContext(`(function(){${handler}})();`, context);
  assert.equal(context.state.settings.relayBaseUrl, undefined);
  assert.equal(context.authAttemptEpoch, attempt); assert.equal(context.state.authPending, "switch");
  // 即使其他路径已切换认证代际，晚到终端清理也只能撤销捕获的旧令牌。
  context.authAttemptEpoch++; context.state.authPending = "email";
  const newUser = { id: "new-account", email: "new@example.test" }, newAgents = [{ id: "new-agent" }];
  context.state.user = newUser; context.state.agents = newAgents; context.state.accountScope = `${BASE}:new-account`;
  context.state.relaySession = { deviceToken: "synthetic-new", baseUrl: BASE };
  finishReset(); assert.equal(await pending, false);
  assert.equal(context.state.user, newUser); assert.equal(context.state.agents, newAgents);
  assert.equal(context.state.relaySession.deviceToken, "synthetic-new");
  assert.equal(context.state.accountScope, `${BASE}:new-account`); assert.equal(context.state.authPending, "email");
  assert.equal(revoked.length, 1); assert.equal(revoked[0][0], BASE); assert.equal(revoked[0][3], "synthetic-old");
});

test("真实快照恢复先加载账号草稿，编辑器初次显示并在下次快照后保留正文附件", async () => {
  const context = authContext({ C, isPrimaryDevice: () => false, renderComposerAttachments() {}, updateComposer() {},
    pullRelayState: async () => false, loadRelayDevices: async () => {}, saveRelaySession() {}, refreshRelayView() {}, startRelayLoop() {},
  });
  Object.assign(context.state, { panelMode: "agent", draftKey: "", pendingAttachments: [], activeRoomId: "", selectedAgentId: "" });
  const cached = { agents: [{ id: "another-agent", name: "另一成员", messages: [] }, { id: "agent-A", name: "合成成员", messages: [] }], rooms: [], panelMode: "agent", selectedAgentId: "agent-A",
    drafts: { "agent:agent-A": { text: "账号A缓存草稿", attachments: [{ id: "synthetic-file", name: "说明.txt", text: "附件正文" }] } },
  };
  context.storage.set(`chorus-account:${BASE}:account-A`, JSON.stringify(cached));
  appFunctions(["normalizeRelayAccount", "connectRelaySession", "resetConversationEditor", "applyRelaySnapshot", "chatContext", "getAgent", "getRoom", "activeRoom", "activeChatAgent", "saveDraft", "restoreDraft", "normalizeStoredMessages"], context);
  assert.equal(await context.connectRelaySession({ deviceToken: "synthetic-A", account: { id: "account-A", email: "a@example.test", name: "A", provider: "email" }, device: { id: "synthetic-device", isPrimary: false } }), true);
  assert.equal(context.$("#composerInput").value, "账号A缓存草稿");
  assert.equal(context.state.pendingAttachments[0].text, "附件正文");
  context.applyRelaySnapshot(cached);
  assert.equal(context.state.drafts["agent:agent-A"].text, "账号A缓存草稿");
  assert.equal(context.$("#composerInput").value, "账号A缓存草稿");
  assert.equal(context.state.pendingAttachments[0].id, "synthetic-file");
});
