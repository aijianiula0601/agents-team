const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const R = require("../shared/web/relay-client");
const C = require("../shared/web/conversation");
const source = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
function functions(names, context) {
  vm.runInNewContext(names.map((name) => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, name);
    return `${match[0]}; this.${name} = ${name};`;
  }).join("\n"), context);
  return context;
}
const flush = () => new Promise(setImmediate);

test("中转 URL 保留部署子路径，拒绝查询参数与内嵌凭据", () => {
  assert.equal(R.normalizeBaseUrl("https://relay.example/agents-team/"), "https://relay.example/agents-team");
  assert.equal(R.normalizeBaseUrl("https://relay.example/?ignored=yes#fragment"), "");
  assert.equal(R.normalizeBaseUrl("http://relay.example"), "");
  assert.equal(R.normalizeBaseUrl("http://127.0.0.1:8000/agents-team"), "http://127.0.0.1:8000/agents-team");
  assert.equal(R.normalizeBaseUrl("https://name:secret@relay.example"), "");
  assert.equal(R.normalizeBaseUrl("javascript:alert(1)"), "");
});

test("409 历史合并保留手机新消息、电脑未上传回复与本机工作区", () => {
  const remote = { agents: [{ id: "a", workspace: "/old", messages: [{ id: "phone", from: "you", text: "手机输入" }, { id: "retry", error: true, text: "旧错误" }] }], rooms: [{ id: "r", messages: [{ id: "team-phone", text: "团队手机输入" }] }] };
  const local = { agents: [{ id: "a", workspace: "/current", messages: [{ id: "retry", error: false, text: "重试成功" }, { id: "reply", text: "电脑回复" }] }], rooms: [{ id: "r", messages: [{ id: "team-reply", text: "团队回复" }] }] };
  const result = R.mergeSnapshots(remote, local);
  assert.equal(result.agents[0].workspace, "/current");
  assert.deepEqual(result.agents[0].messages.map((item) => item.id), ["phone", "retry", "reply"]);
  assert.equal(result.agents[0].messages[1].error, false);
  assert.deepEqual(result.rooms[0].messages.map((item) => item.id), ["team-phone", "team-reply"]);
  assert.equal(remote.agents[0].messages[1].error, true);
});

test("远端配置版本更新时采用已提交配置并保留本机回复与执行状态", () => {
  const remote = { configRevision: 3, agents: [{ id: "a", name: "手机新配置", workspaceMode: "auto", harnessModel: "model-new", messages: [{ id: "phone", text: "手机消息" }] }], rooms: [{ id: "r", messages: [{ id: "team-phone", text: "团队消息" }] }], execution: { running: null }, harnessModels: { codex: [{ id: "model-new" }] } };
  const local = { configRevision: 2, agents: [{ id: "a", name: "过期名字", workspace: "/old", messages: [{ id: "reply", replyTo: "phone", text: "电脑回复" }] }], rooms: [{ id: "r", messages: [{ id: "team-local", text: "电脑团队回复" }] }], execution: { running: { agentId: "a" } } };
  const result = R.mergeSnapshots(remote, local);
  assert.equal(result.configRevision, 3);
  assert.equal(result.agents[0].name, "手机新配置");
  assert.equal(result.agents[0].harnessModel, "model-new");
  assert.equal(result.agents[0].workspace, undefined);
  assert.deepEqual(result.agents[0].messages.map((message) => message.id), ["phone", "reply"]);
  assert.equal(result.agents[0].messages[1].replyTo, "phone");
  assert.deepEqual(result.rooms[0].messages.map((message) => message.id), ["team-phone", "team-local"]);
  assert.equal(result.execution.running.agentId, "a");
  assert.equal(remote.agents[0].messages.length, 1);
  assert.equal(local.agents[0].name, "过期名字");
});

test("配置版本相同保留主电脑未上传的本地配置修改", () => {
  const result = R.mergeSnapshots({ configRevision: 4, agents: [{ id: "a", name: "服务器旧名", messages: [] }], rooms: [] }, { configRevision: 4, agents: [{ id: "a", name: "电脑新名", messages: [] }], rooms: [] });
  assert.equal(result.agents[0].name, "电脑新名");
  assert.equal(result.configRevision, 4);
});

test("远端创建与删除同步完整成员和群集合，旧电脑快照不能恢复已删除项", () => {
  const remote = { configRevision: 5, agents: [{ id: "a", name: "远端更新" }, { id: "new", name: "手机新建", workspace: "/main/project" }], rooms: [{ id: "new-room", name: "手机新群", agentIds: ["a", "new"], rule: "mention", workspace: "/main/team" }], settings: { localExecution: true } };
  const local = { configRevision: 4, agents: [{ id: "a", name: "旧名字", messages: [{ id: "reply", text: "未上传回复" }] }, { id: "deleted", name: "已删除成员", messages: [{ id: "old", text: "旧聊天" }] }], rooms: [{ id: "deleted-room", name: "已删除群" }], settings: { localExecution: false }, execution: { running: { agentId: "a" } }, harnessModels: { cursor: { models: ["local-model"] } } };
  const result = R.mergeSnapshots(remote, local);
  assert.deepEqual(result.agents.map((agent) => agent.id), ["a", "new"]);
  assert.equal(result.agents[0].name, "远端更新");
  assert.deepEqual(result.agents[0].messages, [{ id: "reply", text: "未上传回复" }]);
  assert.equal(result.agents[1].workspace, "/main/project");
  assert.deepEqual(result.rooms, [{ ...remote.rooms[0], messages: [] }]);
  assert.equal(result.settings.localExecution, true);
  assert.equal(result.execution.running.agentId, "a");
  assert.deepEqual(result.harnessModels, local.harnessModels);
  assert.equal(local.agents.length, 2);
});

test("远端编辑群成员、规则与主电脑路径时仍保留群里的待上传回复", () => {
  const remote = { configRevision: 8, agents: [{ id: "a" }, { id: "b" }], rooms: [{ id: "r", name: "远端新群名", agentIds: ["b"], rule: "mention", workspace: "/main/shared", messages: [{ id: "phone", text: "手机输入" }] }] };
  const local = { configRevision: 7, agents: [{ id: "a" }], rooms: [{ id: "r", name: "旧群名", agentIds: ["a"], rule: "free", workspace: "/old", messages: [{ id: "reply", text: "电脑回复" }] }] };
  const result = R.mergeSnapshots(remote, local);
  assert.deepEqual(result.rooms[0], { ...remote.rooms[0], messages: [{ id: "phone", text: "手机输入" }, { id: "reply", text: "电脑回复" }] });
  assert.deepEqual(remote.rooms[0].messages, [{ id: "phone", text: "手机输入" }]);
  assert.equal(local.rooms[0].name, "旧群名");
});

test("新配置只同步主电脑执行开关与默认服务商，保留本机密钥和偏好", () => {
  const remote = { configRevision: 3, agents: [], rooms: [], settings: { localExecution: false, defaultProvider: "anthropic", apiKeys: { openai: "remote-secret" }, theme: "remote-theme", notifyApp: false, relayBaseUrl: "https://other.example" } };
  const local = { configRevision: 2, agents: [], rooms: [], settings: { localExecution: true, defaultProvider: "openai", apiKeys: { openai: "local-secret" }, theme: "dark", notifyApp: true, relayBaseUrl: "https://relay.example" } };
  const result = R.mergeSnapshots(remote, local);
  assert.deepEqual(result.settings, { ...local.settings, localExecution: false, defaultProvider: "anthropic" });
  assert.equal(local.settings.localExecution, true);
  assert.equal(local.settings.defaultProvider, "openai");
  const initial = R.mergeSnapshots(remote, {});
  assert.deepEqual(initial.settings, { localExecution: false, defaultProvider: "anthropic" });
});

test("配置同版本或远端缺少新设置字段时保留本机尚未上传值", () => {
  const local = { configRevision: 3, agents: [], rooms: [], settings: { localExecution: false, defaultProvider: "anthropic", notifyApp: true } };
  const remote = { configRevision: 3, agents: [], rooms: [], settings: { localExecution: true, defaultProvider: "openai" } };
  assert.deepEqual(R.mergeSnapshots(remote, local).settings, local.settings);
  assert.deepEqual(R.mergeSnapshots({ ...remote, configRevision: 4, settings: { localExecution: true } }, local).settings, { ...local.settings, localExecution: true });
});

test("同版本显式清空主电脑集合不会复活远端记录，缺少集合仍可首次同步", () => {
  const remote = { configRevision: 2, agents: [{ id: "old-agent" }], rooms: [{ id: "old-room" }] };
  const empty = R.mergeSnapshots(remote, { configRevision: 2, agents: [], rooms: [] });
  assert.deepEqual(empty.agents, []);
  assert.deepEqual(empty.rooms, []);
  const initial = R.mergeSnapshots(remote, {});
  assert.equal(initial.agents[0].id, "old-agent");
  assert.equal(initial.rooms[0].id, "old-room");
});

test("远端更新为全空配置后，重复合并旧电脑快照也不能恢复成员或群", () => {
  const local = { configRevision: 2, agents: [{ id: "deleted-agent", messages: [{ id: "reply" }] }], rooms: [{ id: "deleted-room" }] };
  const remote = { configRevision: 3, agents: [], rooms: [] };
  const merged = R.mergeSnapshots(remote, local);
  assert.equal(merged.configRevision, 3);
  assert.deepEqual(merged.agents, []);
  assert.deepEqual(merged.rooms, []);
  const repeated = R.mergeSnapshots(merged, local);
  assert.deepEqual(repeated.agents, []);
  assert.deepEqual(repeated.rooms, []);
});

test("执行中收到手机消息时保留线程与 Agent 引用，手机只显示电脑配置", () => {
  const thread = [{ id: "local", from: "you", text: "电脑任务" }];
  const agent = { id: "a", name: "工程师", backend: "codex", workspace: "/desktop/current", messages: thread };
  const state = { agents: [agent], rooms: [], activeRoomId: "", selectedAgentId: "a", settings: {}, sending: true };
  const context = functions(["applyRelaySnapshot"], { state, C, ChorusRelayClient: R, isPrimaryDevice: () => true, buildRelaySnapshot: () => ({ agents: state.agents, rooms: state.rooms }), getAgent: (id) => state.agents.find((item) => item.id === id), getRoom: () => null, normalizeStoredMessages: C.normalizeMessages, saveDraft() {}, restoreDraft() {} });
  context.applyRelaySnapshot({ agents: [{ id: "a", name: "旧名字", workspace: "/old", messages: [{ id: "phone", from: "you", text: "手机任务" }] }], rooms: [] });
  assert.equal(state.agents[0], agent);
  assert.equal(state.agents[0].messages, thread);
  assert.equal(agent.workspace, "/desktop/current");
  assert.deepEqual(thread.map((message) => message.id), ["phone", "local"]);
  context.isPrimaryDevice = () => false;
  context.applyRelaySnapshot({ agents: [{ id: "a", name: "电脑配置", workspace: "/desktop/remote", messages: [{ id: "remote", from: "you", text: "远端历史" }] }], rooms: [], settings: { localExecution: false }, execution: { running: { key: "agent:a", agentId: "a", label: "正在执行" } } });
  assert.equal(agent.workspace, "/desktop/remote");
  assert.deepEqual(thread.map((message) => message.id), ["remote"]);
  assert.equal(state.settings.localExecution, false);
  assert.equal(state.running.label, "正在执行");
});

test("账号切换后晚到的旧快照不能写入新账号历史", async () => {
  let finish;
  let applied = false;
  const state = { relaySession: { deviceToken: "old", revision: 1 } };
  const context = functions(["pullRelayState"], { state, relayRequest: () => new Promise((resolve) => { finish = resolve; }), saveRelaySession() {}, applyRelaySnapshot() { applied = true; }, refreshRelayView() {} });
  const pending = context.pullRelayState();
  state.relaySession = { deviceToken: "new", revision: 10 };
  finish({ revision: 2, state: { agents: [] } });
  assert.equal(await pending, false);
  assert.equal(state.relaySession.revision, 10);
  assert.equal(applied, false);
});

test("手机从不上传存量快照，也不会成为执行设备", async () => {
  let uploaded = false;
  const state = { user: { email: "test@example.test" }, relayReady: true, relaySession: { deviceToken: "token", isPrimary: true } };
  const context = functions(["isPrimaryDevice", "pushRelayState"], { state, window: {}, relayRequest: async () => { uploaded = true; } });
  assert.equal(context.isPrimaryDevice(), false);
  await context.pushRelayState();
  assert.equal(uploaded, false);
});

test("手机团队与私聊只下发消息和目标，不发送工作区或模型凭据", async () => {
  const requests = [];
  const state = { relaySession: { deviceToken: "token", revision: 1 } };
  const context = functions(["sendToPrimaryDevice"], { state, relayRequest: async (...args) => { requests.push(args); return { revision: 2 }; }, saveRelaySession() {} });
  const userMessage = { id: "u-1", from: "you", text: "任务", attachments: [{ name: "说明.md", text: "说明" }] };
  const agents = [{ id: "a", workspace: "/private", apiKey: "secret" }];
  await context.sendToPrimaryDevice("任务", agents, "discuss", userMessage, { team: true, owner: { id: "r" } });
  await context.sendToPrimaryDevice("任务", agents, "discuss", userMessage, { team: false, owner: { id: "a" } });
  assert.equal(requests[0][3].roomId, "r");
  assert.equal(requests[0][3].agentId, undefined);
  assert.equal(requests[1][3].agentId, "a");
  assert.equal(requests[1][3].roomId, undefined);
  assert.equal(requests[0][3].clientRequestId, userMessage.id);
  assert.equal(requests[0][3].userMessage.attachments[0].text, "说明");
  assert.doesNotMatch(JSON.stringify(requests), /private|secret|workspace|apiKey/);
});

test("WebSocket 使用一次性 ticket，断线重连重新获取凭据并补历史", async () => {
  const urls = [];
  const calls = [];
  const events = [];
  const timers = [];
  class Socket {
    constructor(url) { urls.push(url); Socket.instances.push(this); }
    close() { this.onclose?.(); }
  }
  Socket.instances = [];
  const client = R.realtime({ baseUrl: "https://relay.example/agents-team", token: "permanent-secret", WebSocketClass: Socket, setTimer: (callback) => { timers.push(callback); return timers.length; }, clearTimer() {}, ticketRequest: async (...args) => { calls.push(args); return { ticket: `once-${calls.length}` }; }, onEvent: (event) => events.push(event) });
  await flush();
  Socket.instances[0].onopen();
  assert.equal(events[0].type, "catchup");
  Socket.instances[0].onmessage({ data: JSON.stringify({ type: "state.updated", revision: 2 }) });
  Socket.instances[0].close();
  timers[0](); await flush();
  assert.equal(calls.length, 2);
  assert.match(urls[0], /^wss:\/\/relay.example\/agents-team\/ws\?ticket=once-1$/);
  assert.match(urls[1], /ticket=once-2/);
  assert.doesNotMatch(urls.join(" "), /permanent-secret/);
  assert.equal(calls[0][3], "permanent-secret");
  client.close();
  const count = events.length;
  Socket.instances[0].onmessage({ data: JSON.stringify({ type: "state.updated" }) });
  assert.equal(events.length, count);
});

test("关闭连接时仍在申请 ticket，晚到结果不能重新连接旧账号", async () => {
  let finish;
  let opened = false;
  class Socket { constructor() { opened = true; } }
  const client = R.realtime({ baseUrl: "https://relay.example", token: "token", WebSocketClass: Socket, ticketRequest: () => new Promise((resolve) => { finish = resolve; }) });
  client.close(); finish({ ticket: "late" }); await flush();
  assert.equal(opened, false);
});

test("旧账号设备列表晚到，不会改变新账号主电脑身份", async () => {
  let finish;
  const state = { relaySession: { deviceToken: "old", deviceId: "old-device", isPrimary: true }, relayDevices: [] };
  const context = functions(["loadRelayDevices"], { state, relayRequest: () => new Promise((resolve) => { finish = resolve; }), syncRelayDeviceList() {} });
  const pending = context.loadRelayDevices();
  state.relaySession = { deviceToken: "new", deviceId: "new-device", isPrimary: false };
  finish({ devices: [{ id: "old-device", isPrimary: true }] });
  await pending;
  assert.equal(state.relaySession.isPrimary, false);
  assert.equal(state.relayDevices.length, 0);
});

test("旧账号 claim 请求晚到，不会启动新账号电脑上的 Agent", async () => {
  let finish;
  let executed = false;
  const state = { relaySession: { deviceToken: "old" }, sending: false };
  const context = functions(["drainPrimaryDispatches"], { state, relayDrainBusy: false, relayJobsInFlight: new Set(), isPrimaryDevice: () => true, relayRequest: () => new Promise((resolve) => { finish = resolve; }), executePrimaryDispatch: async () => { executed = true; } });
  const pending = context.drainPrimaryDispatches();
  state.relaySession = { deviceToken: "new" };
  finish({ dispatch: { id: "old-job" } });
  await pending;
  assert.equal(executed, false);
  assert.equal(context.relayDrainBusy, false);
});

test("旧账号同步请求的 401 不会清除新登录", async () => {
  let finish;
  let cleared = false;
  const state = { relayReady: true, relaySession: { deviceToken: "old" } };
  const context = functions(["runRelayLoop"], { state, relayLoopBusy: false, relayLoopQueued: false, relayBaseUrl: () => undefined, refreshRelayAccount: async () => true, loadRelayDevices: () => new Promise((_, reject) => { finish = reject; }), clearRelaySession() { cleared = true; }, toast() {} });
  const pending = context.runRelayLoop();
  await flush();
  state.relaySession = { deviceToken: "new" };
  const error = new Error("旧令牌失效"); error.status = 401;
  finish(error); await pending;
  assert.equal(cleared, false);
});

test("旧 WebSocket 的延迟 error 不会关闭重连后的连接", async () => {
  const timers = [];
  class Socket {
    constructor() { this.closed = 0; Socket.instances.push(this); }
    close() { this.closed++; this.onclose?.(); }
  }
  Socket.instances = [];
  const client = R.realtime({ baseUrl: "https://relay.example", token: "token", WebSocketClass: Socket, ticketRequest: async () => ({ ticket: "once" }), setTimer: (callback) => { timers.push(callback); return timers.length; }, clearTimer() {} });
  await flush();
  const old = Socket.instances[0]; old.close(); timers[0](); await flush();
  const fresh = Socket.instances[1]; old.onerror();
  assert.equal(fresh.closed, 0);
  client.close();
});

test("超限等永久同步失败明确提示，不标记成已同步", async () => {
  const state = { relayReady: true, relaySession: { deviceToken: "token", revision: 1 }, relayError: "", relayStatus: "online" };
  const notices = [];
  const error = new Error("记录超过限制"); error.status = 413;
  const context = functions(["pushRelayState"], { state, relayPushInFlight: false, relayPushQueued: false, relayPublishedSnapshot: "", isPrimaryDevice: () => true, buildRelaySnapshot: () => ({ agents: [] }), relayRequest: async () => { throw error; }, readableError: (value) => value.message, toast: (message) => notices.push(message), scheduleRelayPush() { throw new Error("永久失败不立即重试"); } });
  await context.pushRelayState();
  assert.equal(state.relayStatus, "error");
  assert.equal(state.relaySession.revision, 1);
  assert.equal(context.relayPublishedSnapshot, "");
  assert.match(notices[0], /同步失败.*记录超过限制/);
});

test("手机登录引导区分共享配置与主电脑执行，空账号可以开始创建", () => {
  const state = { relaySession: null, user: null };
  const context = functions(["relayWelcome"], { state, escapeHtml: (value) => String(value) });
  let html = context.relayWelcome({ team: true, owner: null });
  assert.match(html, /登录账号.*同步电脑聊天/s);
  assert.match(html, /data-setup="auth"/);
  assert.match(html, /data-setup="connection"/);
  assert.doesNotMatch(html, /data-setup="(?:models|harness|agent)"|配置已就绪|本机内核|模型与密钥/);
  state.user = { verified: true }; state.relaySession = { deviceToken: "token" };
  html = context.relayWelcome({ team: true, owner: null });
  assert.match(html, /创建 Agent.*组建协作团队/s);
  assert.match(html, /项目路径填写主电脑上的实际目录/);
  assert.doesNotMatch(html, /data-setup="auth"|配置已就绪/);
  html = context.relayWelcome({ team: false, owner: { id: "a", name: "电脑工程师" } });
  assert.match(html, /data-setup="details"/);
  assert.match(html, /消息交给主电脑执行/);
  assert.doesNotMatch(html, /data-setup="(?:models|harness|agent)"/);
});

test("手机执行配置须经过同步，默认开关不能冒充电脑状态", () => {
  const state = { relaySession: null, relayReady: false, relayConfigSynced: false, relayDevices: [], settings: { localExecution: true } };
  const context = functions(["relayExecutionDescription"], { state });
  assert.match(context.relayExecutionDescription(), /登录同一账号后.*主电脑配置/);
  assert.doesNotMatch(context.relayExecutionDescription(), /已开启|已关闭/);
  state.relaySession = { deviceToken: "token" }; state.relayReady = true;
  assert.match(context.relayExecutionDescription(), /配置 Agent 与团队.*保持主电脑在线/);
  assert.doesNotMatch(context.relayExecutionDescription(), /已开启|已关闭/);
  state.relayConfigSynced = true; state.relayDevices = [{ isPrimary: true, platform: "mac" }];
  assert.match(context.relayExecutionDescription(), /电脑执行开关：已开启/);
  state.settings.localExecution = false;
  assert.match(context.relayExecutionDescription(), /电脑执行开关：已关闭/);
});

function leaseClock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  const intervals = new Map();
  return {
    now: () => time,
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => { const id = ++sequence; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id),
    async beat(at) { time = at; for (const callback of [...intervals.values()]) await callback(); },
    async advance(at) { time = at; for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.callback(); } await flush(); },
  };
}

test("续租 403 或 409 永久拒绝立即取消，并且只取消一次", async () => {
  for (const status of [403, 409]) {
    const clock = leaseClock();
    let cancelled = 0;
    const context = functions(["watchDispatchLease"], { ...clock, Date, Promise });
    const error = new Error("领取失效"); error.status = status;
    const lease = context.watchDispatchLease({ expiresAt: new Date(90000).toISOString(), now: clock.now, current: () => true, renew: async () => { throw error; }, cancel: () => { cancelled++; } });
    await clock.beat(20000);
    assert.equal(cancelled, 1);
    assert.equal(lease.valid(), false);
    await clock.advance(90000);
    assert.equal(cancelled, 1);
    lease.close();
  }
});

test("网络失败或续租挂起均在 90 秒领取到期前取消", async () => {
  for (const hanging of [false, true]) {
    const clock = leaseClock();
    let cancelled = 0;
    const context = functions(["watchDispatchLease"], { ...clock, Date, Promise });
    const lease = context.watchDispatchLease({ expiresAt: new Date(90000).toISOString(), now: clock.now, current: () => true, renew: hanging ? () => new Promise(() => {}) : async () => { throw new Error("网络断开"); }, cancel: () => { cancelled++; } });
    const pending = clock.beat(20000);
    if (!hanging) await pending;
    await clock.advance(74999); assert.equal(cancelled, 0);
    await clock.advance(75000); assert.equal(cancelled, 1);
    assert.equal(lease.valid(), false);
    lease.close();
  }
});

test("续租成功从请求发出时延长期限，网络延迟不延长本机有效期", async () => {
  const clock = leaseClock();
  let finish;
  let cancelled = 0;
  const context = functions(["watchDispatchLease"], { ...clock, Date, Promise });
  const lease = context.watchDispatchLease({ expiresAt: new Date(90000).toISOString(), now: clock.now, current: () => true, renew: () => new Promise((resolve) => { finish = resolve; }), cancel: () => { cancelled++; } });
  const pending = clock.beat(20000);
  await clock.advance(50000); finish(); await pending;
  await clock.advance(94999); assert.equal(cancelled, 0);
  await clock.advance(95000); assert.equal(cancelled, 1);
  lease.close();
});

test("已关闭租约的晚到续租拒绝不能取消后续新任务", async () => {
  const clock = leaseClock();
  let fail;
  let cancelled = 0;
  const context = functions(["watchDispatchLease"], { ...clock, Date, Promise });
  const lease = context.watchDispatchLease({ expiresAt: new Date(90000).toISOString(), now: clock.now, current: () => true, renew: () => new Promise((_, reject) => { fail = reject; }), cancel: () => { cancelled++; } });
  const pending = clock.beat(20000); lease.close();
  const error = new Error("旧领取失效"); error.status = 409;
  fail(error); await pending; await clock.advance(120000);
  assert.equal(cancelled, 0);
});

test("持续续租的任务越过 10 分钟及 35 分钟仍有效，停止续租后按安全期限取消", async () => {
  const clock = leaseClock();
  let renewals = 0;
  let cancelled = 0;
  const context = functions(["watchDispatchLease"], { ...clock, Date, Promise });
  const lease = context.watchDispatchLease({ expiresAt: new Date(90000).toISOString(), now: clock.now, current: () => true, renew: async () => { renewals++; }, cancel: () => { cancelled++; } });
  // ------------ 每 20 秒续租，覆盖原来的总时限和 30 分钟长任务 ---------------
  for (let time = 20000; time <= 35 * 60 * 1000; time += 20000) {
    await clock.advance(time);
    await clock.beat(time);
    assert.equal(lease.valid(), true);
  }
  assert.equal(renewals, 105);
  assert.equal(cancelled, 0);
  await clock.advance(35 * 60 * 1000 + 75000);
  assert.equal(lease.valid(), false);
  assert.equal(cancelled, 1);
  lease.close();
});

test("中转冲突合并保留最新流式内容，并允许同一回复转为最终结果", () => {
  const partial = { id: "stream-reply", from: "a", requestId: "request", text: "第一段", streaming: true };
  const remote = { agents: [], rooms: [{ id: "r", messages: [{ id: "phone", from: "you", text: "手机消息" }, partial] }] };
  const local = { agents: [], rooms: [{ id: "r", messages: [{ ...partial, text: "第一段第二段" }] }] };
  const merged = R.mergeSnapshots(remote, local);
  assert.equal(merged.rooms[0].messages.length, 2);
  assert.equal(merged.rooms[0].messages[1].text, "第一段第二段");
  assert.equal(merged.rooms[0].messages[1].streaming, true);
  const final = R.mergeSnapshots(merged, { agents: [], rooms: [{ id: "r", messages: [{ ...partial, text: "完整最终结果", streaming: false }] }] });
  assert.equal(final.rooms[0].messages.length, 2);
  assert.equal(final.rooms[0].messages[1].streaming, false);
  assert.equal(final.rooms[0].messages[1].text, "完整最终结果");
  assert.equal(remote.rooms[0].messages[1].text, "第一段");
});

test("执行时领取失效取消原生任务，不提交 done 或把停止回复写为完成", async () => {
  const clock = leaseClock();
  const submissions = [];
  let finishExecution;
  let cancelled = 0;
  const agent = { id: "a", messages: [{ id: "u-1", from: "you", text: "任务" }] };
  const state = { relaySession: { deviceToken: "token", baseUrl: "https://relay.example", revision: 1 }, sending: false, activeRunId: "" };
  const context = functions(["watchDispatchLease", "executePrimaryDispatch"], {
    ...clock, Date: class extends Date { static now() { return clock.now(); } }, Promise,
    state, isPrimaryDevice: () => true, pullRelayState: async () => {}, getAgent: () => agent,
    ChorusRelayClient: { request: async (_base, _method, _path, _token, body) => { submissions.push(body.status); const error = new Error("领取失效"); error.status = 409; throw error; } },
    dispatchAgentReplies: async (options) => { state.sending = true; state.activeRunId = "run-1"; options.onRunStart("run-1"); await new Promise((resolve) => { finishExecution = resolve; }); assert.equal(options.canContinue(), false); state.sending = false; state.activeRunId = ""; },
    stopRun: async () => { cancelled++; finishExecution(); }, toast() {},
  });
  const pending = context.executePrimaryDispatch({ id: "job", claimToken: "claim", leaseExpiresAt: new Date(90000).toISOString(), agentId: "a", userMessage: agent.messages[0], responders: [{ agentId: "a" }], userText: "任务" });
  await flush(); await clock.beat(20000); await pending;
  assert.equal(cancelled, 1);
  assert.deepEqual(submissions, ["running"]);
  assert.equal(agent.messages.length, 1);
});

test("切换账号前清编辑器正文、附件与旧选择，旧草稿不会保存到新 scope", async () => {
  const input = { value: "账号A未发送正文" };
  const files = { value: "旧文件选择" };
  const storage = new Map();
  const state = {
    accountScope: "https://relay.example:account-A", user: { email: "a@example.test" },
    relaySession: { deviceToken: "old", accountId: "account-A" },
    agents: [{ id: "a-old" }], rooms: [], drafts: { "agent:a-old": { text: input.value } },
    draftKey: "agent:a-old", pendingAttachments: [{ id: "f-old", name: "a.txt", text: "账号A附件", size: 12 }],
    attachmentLoads: new Set(["agent:a-old"]), activeRoomId: "r-old", selectedAgentId: "a-old", panelMode: "agent",
    desktopAgentIds: ["a-old"], desktopRoomIds: ["r-old"], desktopConnectionInfo: {},
  };
  const persisted = [];
  const context = functions(["resetConversationEditor", "saveDraft", "normalizeRelayAccount", "connectRelaySession"], {
    state, isPrimaryDevice: () => false, conversationEpoch: 0, authAttemptEpoch: 0, closeOverlay() {}, $: (selector) => selector === "#composerInput" ? input : files,
    renderComposerAttachments() {}, relayBaseUrl: () => "https://relay.example",
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    persistApp() { persisted.push(JSON.stringify({ scope: state.accountScope, drafts: state.drafts })); },
    clearRelaySession() { state.relaySession = null; }, saveRelaySession() {},
    pullRelayState: async () => { context.saveDraft(); return false; },
    loadRelayDevices: async () => {}, renderAccount() {}, refreshRelayView() {}, startRelayLoop() {},
  });
  await context.connectRelaySession({ deviceToken: "new", account: { id: "account-B", email: "b@example.test", name: "B", provider: "email" }, device: { id: "phone-B", isPrimary: false } });
  assert.equal(state.accountScope, "https://relay.example:account-B");
  assert.equal(state.draftKey, "");
  assert.equal(input.value, "");
  assert.equal(files.value, "");
  assert.equal(state.pendingAttachments.length, 0);
  assert.equal(state.attachmentLoads.size, 0);
  assert.equal(state.activeRoomId, "");
  assert.equal(state.selectedAgentId, "");
  assert.equal(state.desktopConnectionInfo, null);
  assert.equal(Object.keys(state.drafts).length, 0);
  assert.match(persisted[0], /账号A未发送正文/);
  assert.doesNotMatch(persisted.at(-1), /账号A|a-old|f-old/);
});

test("账号切换时仍在读取的附件晚到，不会加入新账号草稿", async () => {
  let finishFile;
  const input = { value: "旧正文" };
  const state = { draftKey: "agent:old", drafts: { "agent:old": { text: "旧正文", attachments: [] } }, pendingAttachments: [], attachmentLoads: new Set() };
  let persisted = false;
  const context = functions(["resetConversationEditor", "addAttachments"], {
    state, conversationEpoch: 0, $: () => input, renderComposerAttachments() {}, updateComposer() {}, saveDraft() {},
    MAX_ATTACHMENTS: 5, MAX_ATTACHMENT_BYTES: 262144, MAX_ATTACHMENT_TOTAL_BYTES: 524288,
    isTextAttachment: () => true, crypto: { randomUUID: () => "file-id" },
    persistApp() { persisted = true; }, toast() {},
  });
  const pending = context.addAttachments([{ name: "old.txt", size: 16, text: () => new Promise((resolve) => { finishFile = resolve; }) }]);
  context.resetConversationEditor(true);
  state.drafts = {}; state.draftKey = "agent:new";
  finishFile("旧账号附件正文"); await pending;
  assert.equal(Object.keys(state.drafts).length, 0);
  assert.equal(state.pendingAttachments.length, 0);
  assert.equal(persisted, false);
});
