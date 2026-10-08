const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const BASE = "https://relay.example.test/agents-team";
const ACCOUNT = { id: "account-A", name: "测试管理员", email: "admin@example.test", provider: "google", role: "superadmin", employeeId: "12345678" };

/**
 * 在隔离环境中加载真实界面函数，验证身份边界而不运行完整页面。
 * @param {string[]} names 需要加载的实际函数名称
 * @param {object} context 测试状态及浏览器依赖
 * @returns {object} 包含实际函数的隔离上下文
 * 注意事项：只读取源码，所有账号与令牌均为合成测试数据。
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
 * 创建具有有效设备会话的身份同步环境。
 * @param {Function} request 当前测试的中转站响应实现
 * @returns {object} 状态、资料缓存和真实身份刷新函数
 * 注意事项：不连接外部服务，日志不记录测试账号或设备令牌。
 */
function identityContext(request) {
  const storage = new Map();
  const state = {
    accountScope: `${BASE}:${ACCOUNT.id}`, user: { name: ACCOUNT.name, email: ACCOUNT.email, provider: "google", verified: true, role: "member", employeeId: "" },
    relaySession: { deviceToken: "synthetic-token-A", baseUrl: BASE, accountId: ACCOUNT.id, email: ACCOUNT.email, identityCheckedAt: 0 },
  };
  return appFunctions(["normalizeRelayAccount", "refreshRelayAccount"], {
    state, storage, relayRequest: request, relayBaseUrl: () => BASE,
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    persistApp() {}, renderAccount() {}, syncAuthModal() {}, console: { info() {}, error() {} },
  });
}

test("缓存声明管理员工号无效，只有已认证 Google 响应可以提供员工身份", () => {
  const context = appFunctions(["normalizeRelayAccount"], {});
  const cached = context.normalizeRelayAccount({ ...ACCOUNT, verified: true });
  assert.equal(cached.role, "member"); assert.equal(cached.employeeId, "");
  const google = context.normalizeRelayAccount(ACCOUNT, true);
  assert.equal(google.role, "superadmin"); assert.equal(google.employeeId, "12345678");
  const password = context.normalizeRelayAccount({ ...ACCOUNT, provider: "email" }, true);
  assert.equal(password.role, "member"); assert.equal(password.employeeId, "");
  const malformed = context.normalizeRelayAccount({ ...ACCOUNT, employeeId: "<script>" }, true);
  assert.equal(malformed.role, "member"); assert.equal(malformed.employeeId, "");
});

test("恢复完整本机存档时不会直接恢复超级管理员角色", () => {
  const state = { agents: [], rooms: [], settings: {}, drafts: {}, accountScope: "" };
  const context = appFunctions(["normalizeRelayAccount", "loadPersisted"], {
    state, window: { innerWidth: 600 },
    localStorage: { getItem: () => JSON.stringify({ user: { ...ACCOUNT, verified: true } }) }, console,
  });
  context.loadPersisted();
  assert.equal(state.user.email, ACCOUNT.email); assert.equal(state.user.verified, true);
  assert.equal(state.user.role, "member"); assert.equal(state.user.employeeId, "");
});

test("服务器授权及撤权刷新同一会话，并保存更新后的只读身份", async () => {
  let account = ACCOUNT;
  const requests = [];
  const context = identityContext(async (...args) => { requests.push(args); return { account }; });
  assert.equal(await context.refreshRelayAccount(true), true);
  assert.equal(context.state.user.role, "superadmin");
  assert.equal(JSON.parse(context.storage.get("chorus-user")).employeeId, "12345678");
  account = { ...ACCOUNT, role: "member", employeeId: "" };
  assert.equal(await context.refreshRelayAccount(true), true);
  assert.equal(context.state.user.role, "member"); assert.equal(context.state.user.employeeId, "");
  assert.equal(JSON.parse(context.storage.get("chorus-user")).role, "member");
  assert.equal(requests.length, 2);
  assert.equal(requests[0][0], "GET"); assert.equal(requests[0][1], "/api/v1/auth/session");
});

test("实时消息频繁到达时身份复核保持30秒频率，启动强制复核", async () => {
  let requests = 0;
  const context = identityContext(async () => { requests++; return { account: ACCOUNT }; });
  await context.refreshRelayAccount(); await context.refreshRelayAccount();
  assert.equal(requests, 1);
  await context.refreshRelayAccount(true);
  assert.equal(requests, 2);
});

for (const field of ["token", "base", "accountId", "scope"]) {
  test(`旧身份响应晚到时 ${field} 改变会阻止覆盖当前账号`, async () => {
    let finish;
    const context = identityContext(() => new Promise((resolve) => { finish = resolve; }));
    const pending = context.refreshRelayAccount(true);
    const preserved = { name: "新账号", email: "member@example.test", role: "member", employeeId: "" };
    context.state.user = preserved;
    if (field === "token") context.state.relaySession.deviceToken = "synthetic-token-B";
    if (field === "base") context.state.relaySession.baseUrl = "https://another.example.test";
    if (field === "accountId") context.state.relaySession.accountId = "account-B";
    if (field === "scope") context.state.accountScope = `${BASE}:account-B`;
    finish({ account: ACCOUNT });
    assert.equal(await pending, false);
    assert.equal(context.state.user, preserved); assert.equal(context.storage.size, 0);
    assert.equal(context.state.relaySession.identityCheckedAt, 0);
  });
}

test("服务器会话响应账号不匹配时拒绝身份，不保存或展示管理员", async () => {
  const context = identityContext(async () => ({ account: { ...ACCOUNT, id: "another-account" } }));
  await assert.rejects(context.refreshRelayAccount(true), (error) => error.status === 401);
  assert.equal(context.state.user.role, "member"); assert.equal(context.storage.size, 0);
});

test("恢复同步先确认身份，再拉聊天和连接实时通道", async () => {
  const stages = [];
  const context = identityContext(async () => { stages.push("identity"); return { account: ACCOUNT }; });
  Object.assign(context, {
    window: { chorusDesktop: {} }, loadRelaySession() {}, updateExecutionSettingsVisibility() {},
    pullRelayState: async () => stages.push("state"), loadRelayDevices: async () => stages.push("devices"),
    refreshRelayView() {}, startRelayLoop: () => stages.push("realtime"), scheduleRelayPush() {},
  });
  appFunctions(["bootRelaySync"], context);
  await context.bootRelaySync();
  assert.deepEqual(stages, ["identity", "state", "devices", "realtime"]);
  assert.equal(context.state.user.role, "superadmin");
});

test("账号侧栏和弹窗仅展示服务器身份，退出会话后不显示管理员", () => {
  const elements = new Map();
  const context = appFunctions(["normalizeRelayAccount", "renderAccount", "syncAuthModal"], {
    state: { user: null, relaySession: { deviceToken: "synthetic-token" }, settings: {} }, window: { chorusDesktop: {} },
    relayBaseUrl: () => BASE, $$: () => [],
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, { style: {}, textContent: "", innerHTML: "", hidden: false, setAttribute() {} });
      return elements.get(selector);
    },
  });
  context.state.user = context.normalizeRelayAccount(ACCOUNT, true);
  context.renderAccount(); context.syncAuthModal();
  assert.match(elements.get("#accountSub").textContent, /超级管理员 · 工号 12345678/);
  assert.equal(elements.get("#authDesc").textContent, "超级管理员 · 工号 12345678");
  context.state.user = context.normalizeRelayAccount({ ...ACCOUNT, role: "member", employeeId: "" }, true);
  context.renderAccount(); context.syncAuthModal();
  assert.equal(elements.get("#accountSub").textContent, ACCOUNT.email);
  assert.equal(elements.get("#authDesc").textContent, "管理登录状态");
  context.state.user = context.normalizeRelayAccount(ACCOUNT, true); context.state.relaySession = null;
  context.renderAccount(); context.syncAuthModal();
  assert.doesNotMatch(elements.get("#accountSub").textContent, /超级管理员|12345678/);
  assert.equal(elements.get("#authLoggedIn").hidden, true);
});
