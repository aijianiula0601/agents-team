const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const C = require("../shared/web/conversation");

const SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const MEMBERS = [{ id: "designer", name: "设计师", role: "设计", backend: "model" }, { id: "engineer", name: "工程师", role: "开发", backend: "codex" }, { id: "reviewer", name: "审查员", role: "审查", backend: "model" }];

/**
 * 加载真实页面群聊函数并提供确定性的执行环境。
 * @param {function} produceReply 测试用模型输出
 * @returns {object} 页面函数、状态和执行记录
 * 注意事项：仅替代外部模型、渲染和持久化，不模拟队列或分发逻辑。
 */
function groupContext(produceReply) {
  let nextId = 0;
  const context = {
    C, AbortController, setTimeout, clearTimeout, console: { info() {} }, crypto: { randomUUID: () => `test-${++nextId}` },
    state: { sending: false, accountScope: "account", agents: MEMBERS }, conversationEpoch: 0, authAttemptEpoch: 0,
    HARNESS_LABEL: { codex: "Codex" }, nowTime: () => "12:00", getAgent: (id) => MEMBERS.find((agent) => agent.id === id),
    renderRunning() {}, renderAgents() {}, renderMessages() {}, scheduleRelayPush() {}, persistApp() {}, readableError: (error) => error.message,
    notifications: [], calls: [], window: {}, updateComposer() {}, toast() {},
  };
  context.chat = { key: "room:team", team: true, owner: { id: "team", name: "测试群", agentIds: MEMBERS.map((agent) => agent.id) }, thread: [{ id: "u1", from: "you", text: "请设计方案", mode: "discuss" }] };
  context.chatContext = () => context.chat;
  context.notifyAgentResult = (agent, _chat, text) => context.notifications.push({ id: agent.id, text });
  context.produceReply = (agent, text, options) => { context.calls.push({ id: agent.id, triggerId: options.triggerId }); return produceReply(agent, text, options, context); };
  for (const name of ["buildModelMessages", "dispatchAgentReplies", "stopRun"]) {
    const match = SOURCE.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match);
    vm.runInNewContext(`${match[0]}; this.${name} = ${name};`, context);
  }
  return context;
}

test("群聊先由模型判断相关性，沉默成员不生成消息和完成通知", async () => {
  const context = groupContext(async (agent) => ({ text: agent.id === "engineer" ? "[[CHORUS_SILENT]]" : `${agent.name}的实际观点` }));
  await context.dispatchAgentReplies({ userText: "请设计方案", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1" });
  assert.deepEqual(context.calls.map((item) => item.id), MEMBERS.map((agent) => agent.id));
  assert.deepEqual(context.chat.thread.slice(1).map((reply) => reply.from), ["designer", "reviewer"]);
  assert.deepEqual(context.notifications.map((item) => item.id), ["designer", "reviewer"]);
  assert.equal(context.state.sending, false);
  assert.equal(context.state.running, null);
});

test("被点名成员可再点名其他成员，并把前一条回复作为触发源", async () => {
  const context = groupContext(async (agent) => ({ text: agent.id === "designer" ? "方案已确认，@工程师 请实现" : "实现完成" }));
  await context.dispatchAgentReplies({ userText: "@设计师 请设计方案", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  const replies = context.chat.thread.slice(1);
  assert.deepEqual(context.calls.map((item) => item.id), ["designer", "engineer"]);
  assert.equal(replies[1].replyTo, replies[0].id);
  assert.equal(context.calls[1].triggerId, replies[0].id);
});

test("成员互相点名最多各观察两次，不会产生无限群聊", async () => {
  const context = groupContext(async (agent) => ({ text: agent.id === "designer" ? "@工程师 请继续" : "@设计师 请继续" }));
  await context.dispatchAgentReplies({ userText: "@设计师 开始", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  assert.deepEqual(context.calls.map((item) => item.id), ["designer", "engineer", "designer", "engineer"]);
  assert.equal(context.chat.thread.length, 5);
});

test("群聊失败可见但不会触发错误正文中的成员点名", async () => {
  const context = groupContext(async () => { throw new Error("@工程师 服务调用失败"); });
  await context.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  assert.equal(context.calls.length, 1);
  assert.equal(context.chat.thread[1].error, true);
  assert.match(context.chat.thread[1].text, /服务调用失败/);
});

test("私聊保持原有语义，不解析群聊沉默标记或自动点名", async () => {
  const context = groupContext(async () => ({ text: "[[CHORUS_SILENT]]" }));
  context.chat.team = false;
  context.chat.key = "agent:designer";
  await context.dispatchAgentReplies({ userText: "请解释标记", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  assert.equal(context.chat.thread[1].text, "[[CHORUS_SILENT]]");
  assert.equal(context.notifications.length, 1);
  assert.equal(context.chat.thread[1].replyTo, undefined);
});

test("重试群聊失败后模型选择沉默时移除旧错误，不插入空消息或唤醒其他成员", async () => {
  const context = groupContext(async () => ({ text: "[[CHORUS_SILENT]]" }));
  context.chat.thread.push({ id: "error", from: "designer", requestId: "u1", error: true, text: "旧错误" });
  await context.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1", retryId: "error" });
  assert.equal(context.chat.thread.length, 1);
  assert.equal(context.calls.length, 1);
  assert.equal(context.notifications.length, 0);
});

test("沉默结果收到时租约已经失效，不写消息也不发送通知", async () => {
  let valid = true;
  const context = groupContext(async () => { valid = false; return { text: "晚到结果" }; });
  await context.dispatchAgentReplies({ userText: "任务", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1", canContinue: () => valid });
  assert.equal(context.chat.thread.length, 1);
  assert.equal(context.notifications.length, 0);
  assert.equal(context.calls.length, 1);
});

test("断线恢复依据replyTo续接未完成点名，不重新执行已回复成员", async () => {
  const context = groupContext(async () => ({ text: "完成剩余任务" }));
  context.chat.thread.push({ id: "a1", from: "designer", requestId: "u1", replyTo: "u1", text: "@工程师 请实现" });
  await context.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  assert.deepEqual(context.calls.map((item) => item.id), ["engineer"]);
  assert.equal(context.chat.thread[2].replyTo, "a1");
  const resumed = groupContext(async () => { assert.fail("完成的点名不得重跑"); });
  resumed.chat.thread = C.normalizeMessages(context.chat.thread);
  await resumed.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: resumed.chat, requestId: "u1" });
  assert.equal(resumed.calls.length, 0);
});

test("群聊协议经过模型消息传到远程路径，包含准确名单和触发来源；私聊不受影响", () => {
  const context = groupContext(async () => ({ text: "完成" }));
  context.chat.thread.push({ id: "a1", from: "designer", text: "@工程师 请实现设计" });
  const messages = context.buildModelMessages(MEMBERS[1], "请设计方案", context.chat, "", "a1");
  const prompt = messages.at(-1).content;
  assert.match(prompt, /先结合上下文.*判断是否需要参与/);
  assert.match(prompt, /不要调用工具、不要修改文件/);
  assert.match(prompt, /@审查员：审查/);
  assert.match(prompt, /本次触发消息来自 设计师/);
  assert.match(prompt, /\[\[CHORUS_SILENT\]\]/);
  const privateMessages = context.buildModelMessages(MEMBERS[1], "任务", { ...context.chat, team: false });
  assert.doesNotMatch(JSON.stringify(privateMessages), /CHORUS_SILENT/);
});

test("普通内容中引用沉默标记不会吞掉回复", () => {
  assert.equal(C.silentGroupReply(" \n[[CHORUS_SILENT]]\n"), true);
  assert.equal(C.silentGroupReply("标记为 [[CHORUS_SILENT]]，表示不参与"), false);
  assert.equal(C.silentGroupReply(""), false);
});

test("同一待观察成员被点名只排队一次，自己和群外成员不会触发", () => {
  const queue = C.groupTurnQueue(MEMBERS, MEMBERS, [], "u1");
  assert.equal(queue.next().agent.id, "designer");
  queue.record({ id: "a1", from: "designer", text: "@designer @设计师 @工程师 @工程师" });
  assert.equal(queue.next().agent.id, "engineer");
  assert.equal(queue.next().agent.id, "reviewer");
  assert.equal(queue.next(), undefined);
});

test("群聊自动追加最多八次，同时保留其他成员第一次观察的机会", () => {
  const members = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, name: `成员${index}` }));
  const queue = C.groupTurnQueue(members, members, [], "u1");
  const counts = new Map();
  for (let turn = queue.next(); turn; turn = queue.next()) {
    const id = turn.agent.id;
    counts.set(id, (counts.get(id) || 0) + 1);
    queue.record({ id: `reply-${id}-${counts.get(id)}`, from: id, text: members.filter((member) => member.id !== id).map((member) => `@${member.name}`).join(" ") });
  }
  assert.equal(counts.size, 12);
  assert.ok([...counts.values()].every((count) => count <= 2));
  assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 20);
  assert.equal(queue.limited(), true);
});

/** 功能：用可控完成时机验证真实并行和波次上下文；参数：无；返回：异步测试；注意事项：首轮任何成员未释放前其他成员必须已启动。 */
test("首轮并行使用同一完整上下文，点名必须等本波全部结束再执行", async () => {
  const release = new Map();
  const histories = [];
  const context = groupContext((agent, _text, options) => {
    histories.push({ id: agent.id, messages: options.context.thread.map((item) => item.text) });
    if (histories.length <= 3) return new Promise((resolve) => release.set(agent.id, resolve));
    return Promise.resolve({ text: "已接手" });
  });
  const running = context.dispatchAgentReplies({ userText: "任务", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1" });
  assert.equal(release.size, 3);
  assert.equal(context.state.activeRuns.size, 3);
  assert.equal(new Set([...context.state.activeRuns.keys()]).size, 3);
  release.get("designer")({ text: "设计完成，@工程师 请实现" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(context.calls.length, 3);
  release.get("engineer")({ text: "初步方案" });
  release.get("reviewer")({ text: "审查完成" });
  await running;
  assert.equal(context.calls.length, 4);
  assert.ok(histories.slice(0, 3).every((item) => item.messages.length === 1));
  assert.ok(histories[3].messages.includes("审查完成"));
});

/** 功能：验证工作区互斥不阻塞无关成员；参数：无；返回：异步测试；注意事项：模拟 CLI 共用同一路径和尾斜杠别名。 */
test("相同 CLI 工作区依次启动，不同工作区同时执行", async () => {
  const original = MEMBERS.map((agent) => ({ ...agent }));
  const release = new Map();
  try {
    MEMBERS.forEach((agent, index) => Object.assign(agent, { backend: "codex", workspace: index < 2 ? `/project${index ? "/" : ""}` : "/other" }));
    const context = groupContext((agent) => new Promise((resolve) => release.set(agent.id, resolve)));
    const running = context.dispatchAgentReplies({ userText: "任务", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1" });
    assert.deepEqual(context.calls.map((item) => item.id), ["designer", "reviewer"]);
    release.get("designer")({ text: "第一项完成" });
    for (let count = 0; count < 5; count++) await Promise.resolve();
    assert.equal(context.calls.at(-1).id, "engineer");
    release.get("engineer")({ text: "第二项完成" });
    release.get("reviewer")({ text: "独立任务完成" });
    await running;
  } finally { MEMBERS.forEach((agent, index) => { delete agent.workspace; Object.assign(agent, original[index]); }); }
});

/** 功能：验证未完成回复可见、快照替换后仍持续更新；参数：无；返回：异步测试；注意事项：最终正文沿用一个稳定 ID。 */
test("流式正文提前写入消息，快照替换后继续更新同一条消息且最终清除生成状态", async () => {
  let finish, stream;
  const context = groupContext((_agent, _text, options) => {
    stream = options.onText;
    return new Promise((resolve) => { finish = resolve; });
  });
  const running = context.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  stream("第一段");
  assert.equal(context.chat.thread[1].text, "第一段");
  assert.equal(context.chat.thread[1].streaming, true);
  assert.equal(context.notifications.length, 0);
  const id = context.chat.thread[1].id;
  context.chat.thread.splice(0, context.chat.thread.length, ...C.normalizeMessages(context.chat.thread));
  stream("第一段第二段");
  assert.equal(context.chat.thread[1].text, "第一段第二段");
  finish({ text: "完整正文" });
  await running;
  assert.equal(context.chat.thread.length, 2);
  assert.equal(context.chat.thread[1].id, id);
  assert.equal(context.chat.thread[1].streaming, false);
  stream("晚到分片");
  assert.equal(context.chat.thread[1].text, "完整正文");
  assert.equal(context.notifications.length, 1);
});

/** 功能：验证批量停止及取消后分片隔离；参数：无；返回：异步测试；注意事项：停止所有成员而不是仅最后启动者。 */
test("停止同时取消全部并行成员，保留已输出正文并拒绝取消后的分片", async () => {
  const streams = [];
  const cancelled = [];
  const context = groupContext((_agent, _text, options) => new Promise((_, reject) => {
    streams.push(options.onText);
    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    options.onText("已生成片段");
  }));
  context.window.chorusDesktop = { cancelRun: async (id) => { cancelled.push(id); } };
  const running = context.dispatchAgentReplies({ userText: "任务", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1" });
  await context.stopRun(); await running;
  assert.equal(cancelled.length, 3);
  assert.equal(context.chat.thread.length, 4);
  for (const stream of streams) stream("不应出现");
  for (const reply of context.chat.thread.slice(1)) { assert.match(reply.text, /已生成片段.*\n\n任务已停止/s); assert.equal(reply.streaming, false); }
});

/** 功能：验证账号切换使旧任务失效；参数：无；返回：异步测试；注意事项：晚到正文不污染新账号，也不发送完成通知。 */
test("切换账号后晚到分片和最终结果不会写入消息", async () => {
  let finish, stream;
  const context = groupContext((_agent, _text, options) => { stream = options.onText; return new Promise((resolve) => { finish = resolve; }); });
  const running = context.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  context.state.accountScope = "new-account";
  stream("旧账号片段"); finish({ text: "旧账号结果" });
  await running;
  assert.equal(context.chat.thread.length, 1);
  assert.equal(context.notifications.length, 0);
});

/** 功能：验证协议控制字段与重试恢复；参数：无；返回：异步测试；注意事项：未完成消息不算已执行，恢复时复用原 ID。 */
test("流式沉默标记不展示；恢复未完成回复不会把分片当作完成", async () => {
  const context = groupContext(async (_agent, _text, options) => {
    options.onText("[[CHORUS_");
    assert.equal(context.chat.thread.length, 2);
    options.onText("恢复后的正文");
    return { text: "恢复后的正文" };
  });
  context.chat.thread.push({ id: "partial", from: "designer", requestId: "u1", replyTo: "u1", text: "旧分片", streaming: true });
  await context.dispatchAgentReplies({ userText: "任务", responders: [MEMBERS[0]], mode: "discuss", context: context.chat, requestId: "u1" });
  assert.equal(context.calls.length, 1);
  assert.equal(context.chat.thread.length, 2);
  assert.equal(context.chat.thread[1].id, "partial");
  assert.equal(context.chat.thread[1].streaming, false);
  const normalized = C.normalizeMessages(context.chat.thread);
  assert.equal(normalized[1].streaming, false);
  assert.equal(C.modelMessages([{ from: "you", text: "任务" }, { from: "designer", text: "尚未完成", streaming: true }], MEMBERS[0], MEMBERS, "任务", true).length, 1);
});

/** 功能：验证身份失效同步清理并行运行态；参数：无；返回：异步测试；注意事项：不依赖晚到 dispatch finally 清除状态。 */
test("切换身份立即取消并摘除全部运行状态，新账号不会卡在发送中", async () => {
  const cancelled = [];
  const context = groupContext((_agent, _text, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })));
  context.window.chorusDesktop = { cancelRun: async (id) => { cancelled.push(id); } };
  context.$ = () => ({ value: "" });
  context.renderComposerAttachments = () => {};
  const match = SOURCE.match(/function resetConversationEditor\([\s\S]*?\n    \}/);
  vm.runInNewContext(`${match[0]}; this.resetConversationEditor = resetConversationEditor;`, context);
  const running = context.dispatchAgentReplies({ userText: "任务", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1" });
  context.resetConversationEditor();
  assert.equal(context.state.sending, false);
  assert.equal(context.state.running, null);
  assert.equal(context.state.activeRuns.size, 0);
  assert.equal(cancelled.length, 3);
  await running;
  assert.equal(context.chat.thread.length, 1);
});

/** 功能：验证发布快照不会被分片引用污染；参数：无；返回：异步测试；注意事项：最终 flush 必须确认与当前实际正文一致的 JSON。 */
test("分片推送期间正文变化不会被误认为已同步，final flush 确认最新快照", async () => {
  const snapshot = { rooms: [{ messages: [{ id: "m", text: "第一段", streaming: true }] }] };
  let release;
  const published = [];
  const context = {
    state: { relayReady: true, relaySession: { deviceToken: "token", revision: 0 } },
    relayPushInFlight: false, relayPushQueued: false, relayPublishedSnapshot: "", isPrimaryDevice: () => true,
    buildRelaySnapshot: () => snapshot, saveRelaySession() {}, scheduleRelayPush() {},
    relayRequest: async (_method, _path, _token, body) => { published.push(body.state); if (published.length === 1) await new Promise((resolve) => { release = resolve; }); return { revision: published.length }; },
    setTimeout, console,
  };
  for (const name of ["pushRelayState", "flushRelayState"]) {
    const match = SOURCE.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n    \\}`));
    vm.runInNewContext(`${match[0]}; this.${name} = ${name};`, context);
  }
  const first = context.pushRelayState();
  snapshot.rooms[0].messages[0].text = "最终正文";
  snapshot.rooms[0].messages[0].streaming = false;
  release(); await first;
  assert.equal(JSON.parse(context.relayPublishedSnapshot).rooms[0].messages[0].text, "第一段");
  await context.flushRelayState(() => true);
  assert.equal(published.length, 2);
  assert.equal(published[1].rooms[0].messages[0].text, "最终正文");
  assert.equal(context.relayPublishedSnapshot, JSON.stringify(snapshot));
});

/** 功能：验证大群并行不会超出网关容量；参数：无；返回：异步测试；注意事项：所有成员最终都执行，活跃上限始终为八个。 */
test("超过八个成员时有界并行，排队成员不报错或丢失", async () => {
  const count = MEMBERS.length;
  const release = [];
  let active = 0, maximum = 0;
  try {
    for (let index = count; index < 12; index++) MEMBERS.push({ id: `agent-${index}`, name: `成员${index}`, backend: "model" });
    const context = groupContext(() => new Promise((resolve) => { active++; maximum = Math.max(maximum, active); release.push(() => { active--; resolve({ text: "已完成" }); }); }));
    const running = context.dispatchAgentReplies({ userText: "任务", responders: MEMBERS, mode: "discuss", context: context.chat, requestId: "u1" });
    assert.equal(release.length, 8);
    for (let index = 0; index < 12; index++) { release[index](); for (let turn = 0; turn < 6; turn++) await Promise.resolve(); }
    await running;
    assert.equal(maximum, 8);
    assert.equal(context.calls.length, 12);
    assert.equal(context.chat.thread.length, 13);
  } finally { MEMBERS.splice(count); }
});
