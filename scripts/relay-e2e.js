/** 真实双节点链路验收；只创建随机测试账号，不读取或修改用户账号。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const log = require("../mac-app/electron/log");
const { completeAgentChat } = require("../mac-app/electron/chat-backend");

const live = process.argv.includes("--run-live");
const withCodex = process.argv.includes("--with-codex");
const nodeA = process.env.RELAY_TEST_NODE_A || "";
const nodeB = process.env.RELAY_TEST_NODE_B || "";
const sessions = [];
const sockets = [];
let workspace;
let checks = 0;
/** 记录一组验收结果；参数为检查名称；无返回值；不记录账号或令牌。 */
function passed(name) { checks += 1; log.info(`双节点验收通过：${name}`); }

async function request(base, method, endpoint, token, body, expected = 200) {
  const response = await fetch(base + endpoint, {
    method, headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: "error",
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${endpoint}：预期 HTTP ${expected}，实际 ${response.status}`);
  return data;
}

async function connect(base, session) {
  const { ticket } = await request(base, "POST", "/api/v1/realtime/ticket", session.deviceToken, {});
  const address = new URL(base + "/ws"); address.protocol = address.protocol === "https:" ? "wss:" : "ws:"; address.searchParams.set("ticket", ticket);
  const socket = new WebSocket(address); sockets.push(socket);
  const events = [];
  socket.addEventListener("message", (event) => events.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket 连接失败")); }, { once: true });
  });
  return { socket, events };
}
async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("跨节点事件未在 10 秒内到达");
}

async function main() {
  if (!live) { log.info("运行真实测试：配置 RELAY_TEST_NODE_A/B 后执行 node scripts/relay-e2e.js --run-live [--with-codex]"); return; }
  // ------------ 校验用户显式指定的双节点地址 ---------------
  if (!nodeA || !nodeB) throw new Error("真实验收需要配置 RELAY_TEST_NODE_A 和 RELAY_TEST_NODE_B");
  const suffix = crypto.randomBytes(8).toString("hex");
  const email = `chorus-e2e-${suffix}@example.test`;
  const password = crypto.randomBytes(24).toString("base64url");
  const device = (platform, key) => ({ clientDeviceId: `e2e-${suffix}-${key}`, name: "自动验收临时设备", platform });
  const desktop = await request(nodeA, "POST", "/api/v1/auth/email", null, { email, password, action: "register", name: "链路验收", device: device("mac", "desktop") }); sessions.push([nodeA, desktop]);
  const phone = await request(nodeB, "POST", "/api/v1/auth/email", null, { email, password, action: "login", device: device("android", "phone") }); sessions.push([nodeB, phone]);
  assert.equal(desktop.account.id, phone.account.id); assert.equal(desktop.device.isPrimary, true); assert.equal(phone.device.isPrimary, false);
  await request(nodeB, "POST", "/api/v1/auth/email", null, { email, password: "invalid-password", action: "login", device: device("android", "invalid") }, 401);
  await request(nodeB, "POST", `/api/v1/devices/${phone.device.id}/primary`, phone.deviceToken, {}, 403);
  await request(nodeB, "POST", "/api/v1/dispatches/claim", phone.deviceToken, {}, 403);
  passed("同一账号双节点登录，密码验证与手机执行权限限制");

  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "chorus-relay-e2e-"));
  const agent = { id: "e2e-coder", name: "验收员", backend: "codex", harness: "codex", workspace, provider: "openai", model: "", role: "集成验收", persona: "仅修改用户指定的验收文件。" };
  const history = Array.from({ length: 350 }, (_, index) => ({ id: `h-${index}`, from: "you", text: `历史消息 ${index}`, time: "12:00" }));
  const snapshot = { agents: [{ ...agent, messages: [] }], rooms: [{ id: "e2e-team", name: "验收团队", agentIds: [agent.id], rule: "free", workspace, messages: history }], settings: { localExecution: true, apiKeys: { openai: "synthetic-not-a-secret" } } };
  const remotePhone = await connect(nodeB, phone);
  await request(nodeA, "PUT", "/api/v1/state", desktop.deviceToken, { baseRevision: 0, state: snapshot });
  await waitFor(() => remotePhone.events.some((event) => event.type === "state.updated"));
  const synced = await request(nodeB, "GET", "/api/v1/state", phone.deviceToken);
  assert.equal(synced.state.rooms[0].messages.length, 350); assert.equal(synced.state.rooms[0].messages[0].id, "h-0"); assert.ok(!JSON.stringify(synced.state).includes("synthetic-not-a-secret"));
  await request(nodeB, "PUT", "/api/v1/state", phone.deviceToken, { baseRevision: synced.revision, state: snapshot }, 403);
  passed("跨节点 WebSocket 通知、完整350条历史与密钥过滤；手机不能覆盖配置");

  const outsider = await request(nodeB, "POST", "/api/v1/auth/email", null, { email: `chorus-isolation-${suffix}@example.test`, password, action: "register", device: device("android", "outsider") }); sessions.push([nodeB, outsider]);
  assert.equal(outsider.device.isPrimary, false);
  const isolated = await request(nodeB, "GET", "/api/v1/state", outsider.deviceToken);
  assert.equal(isolated.state.agents.length, 0);
  passed("其他登录账号无法读取历史，手机首登不会成为执行设备");

  const marker = `CHORUS_RELAY_${suffix}`;
  const userText = withCodex ? `在当前指定工作区创建 relay-acceptance.txt，文件内容精确为 ${marker}，验证文件后用中文简短回复。只修改这一个文件。` : "临时验收团队消息";
  const payload = { clientRequestId: `request-${suffix}`, mode: "discuss", roomId: "e2e-team", userText, userMessage: { id: `request-${suffix}`, from: "you", text: userText, attachments: [{ name: "验收.txt", text: marker, size: marker.length }] }, responders: [{ agentId: agent.id }] };
  const created = await request(nodeB, "POST", "/api/v1/dispatches", phone.deviceToken, payload);
  const replay = await request(nodeA, "POST", "/api/v1/dispatches", phone.deviceToken, payload);
  assert.equal(created.dispatch.id, replay.dispatch.id);
  await request(nodeB, "GET", `/api/v1/dispatches/${created.dispatch.id}`, outsider.deviceToken, undefined, 404);
  const claims = await Promise.all([nodeA, nodeB].map((base) => request(base, "POST", "/api/v1/dispatches/claim", desktop.deviceToken, {})));
  const claimed = claims.filter((item) => item.dispatch);
  assert.equal(claimed.length, 1); const job = claimed[0].dispatch;
  assert.equal(job.id, created.dispatch.id); assert.equal(job.roomId, "e2e-team"); assert.equal(job.userMessage.attachments[0].text, marker);
  passed("手机团队消息持久化下发、跨节点幂等去重与原子独占领取");

  // ------------ 最终结果产生前，手机已能收到同一回复的递增正文 ---------------
  let streamingState = await request(nodeA, "GET", "/api/v1/state", desktop.deviceToken);
  const streamingReply = { id: `reply-${suffix}`, from: agent.id, text: "正在逐段输出", requestId: payload.clientRequestId, streaming: true };
  streamingState.state.rooms[0].messages.push(streamingReply);
  for (const text of ["正在逐段输出", "正在逐段输出，第二段已到达"]) {
    streamingReply.text = text;
    const eventStart = remotePhone.events.length;
    const saved = await request(nodeA, "PUT", "/api/v1/state", desktop.deviceToken, { baseRevision: streamingState.revision, state: streamingState.state });
    streamingState.revision = saved.revision;
    await waitFor(() => remotePhone.events.slice(eventStart).some((event) => event.type === "state.updated"));
    const partial = await request(nodeB, "GET", "/api/v1/state", phone.deviceToken);
    const received = partial.state.rooms[0].messages.find((message) => message.id === streamingReply.id);
    assert.equal(received.text, text);
    assert.equal(received.streaming, true);
  }
  passed("任务尚未完成时，两次流式正文和进行中标记实时同步至另一节点手机");

  let resultText = "临时链路验收回复";
  if (withCodex) {
    const heartbeat = setInterval(() => request(nodeA, "POST", `/api/v1/dispatches/${job.id}/result`, desktop.deviceToken, { claimToken: job.claimToken, status: "running" }).catch(() => {}), 20000);
    try {
      const result = await completeAgentChat({ agent, workspace, threadKey: "room:e2e-team", messages: [{ role: "user", content: job.userText }] }, { signal: AbortSignal.timeout(180000), harnessPaths: process.env.RELAY_TEST_CODEX_PATH ? { codex: process.env.RELAY_TEST_CODEX_PATH } : {} });
      resultText = result.text;
    } finally { clearInterval(heartbeat); }
    assert.equal((await fs.readFile(path.join(workspace, "relay-acceptance.txt"), "utf8")).trim(), marker);
    passed("中转下发后真实电脑 Codex CLI 创建并验证指定文件");
  }
  const replies = [{ agentId: agent.id, message: { ...streamingReply, text: resultText, streaming: false } }];
  // 最终快照先落库，再提交任务终态；服务端按消息编号去重，因此不能只提交 done。
  streamingState = await request(nodeA, "GET", "/api/v1/state", desktop.deviceToken);
  const finalIndex = streamingState.state.rooms[0].messages.findIndex((message) => message.id === streamingReply.id);
  streamingState.state.rooms[0].messages[finalIndex] = replies[0].message;
  await request(nodeA, "PUT", "/api/v1/state", desktop.deviceToken, { baseRevision: streamingState.revision, state: streamingState.state });
  const before = remotePhone.events.length;
  const done = await request(nodeA, "POST", `/api/v1/dispatches/${job.id}/result`, desktop.deviceToken, { claimToken: job.claimToken, status: "done", replies });
  await waitFor(() => remotePhone.events.slice(before).some((event) => event.type === "state.updated"));
  await request(nodeB, "POST", `/api/v1/dispatches/${job.id}/result`, desktop.deviceToken, { claimToken: job.claimToken, status: "done", replies });
  const finished = await request(nodeB, "GET", "/api/v1/state", phone.deviceToken);
  assert.equal(finished.revision, done.revision);
  assert.equal(finished.state.rooms[0].messages.filter((message) => message.id === `reply-${suffix}`).length, 1);
  assert.equal(finished.state.rooms[0].messages.find((message) => message.id === streamingReply.id).text, resultText);
  assert.equal(finished.state.rooms[0].messages.find((message) => message.id === streamingReply.id).streaming, false);
  assert.equal(finished.state.agents[0].messages.length, 0);
  remotePhone.socket.close();
  const reconnected = await connect(nodeA, phone);
  await waitFor(() => reconnected.events.some((event) => event.type === "hello"));
  const catchup = await request(nodeA, "GET", "/api/v1/state", phone.deviceToken);
  assert.equal(catchup.revision, finished.revision);
  passed("电脑结果跨节点实时回传、终态幂等、团队私聊隔离与重连补历史");

  const privateRequestId = `private-${suffix}`;
  const privatePayload = { clientRequestId: privateRequestId, mode: "discuss", agentId: agent.id, userText: "临时私聊验收", userMessage: { id: privateRequestId, from: "spoofed", text: "临时私聊验收" }, responders: [{ agentId: agent.id }] };
  const privateCreated = await request(nodeB, "POST", "/api/v1/dispatches", phone.deviceToken, privatePayload);
  const privateClaim = await request(nodeA, "POST", "/api/v1/dispatches/claim", desktop.deviceToken, {});
  assert.equal(privateClaim.dispatch.id, privateCreated.dispatch.id);
  assert.equal(privateClaim.dispatch.agentId, agent.id);
  assert.equal(privateClaim.dispatch.userMessage.from, "you");
  const privateReplyId = `private-reply-${suffix}`;
  await request(nodeA, "POST", `/api/v1/dispatches/${privateClaim.dispatch.id}/result`, desktop.deviceToken, { claimToken: privateClaim.dispatch.claimToken, status: "done", replies: [{ agentId: agent.id, message: { id: privateReplyId, from: agent.id, text: "私聊验收回复" } }] });
  await waitFor(() => reconnected.events.some((event) => event.type === "state.updated"));
  const privateState = await request(nodeB, "GET", "/api/v1/state", phone.deviceToken);
  assert.equal(privateState.state.agents[0].messages.length, 2);
  assert.equal(privateState.state.agents[0].messages[1].id, privateReplyId);
  assert.equal(privateState.state.rooms[0].messages.length, finished.state.rooms[0].messages.length);
  passed("手机私聊独立下发和回传、身份字段规范化、团队历史不受影响");
  log.info(`------------- 双节点验收完成：${checks} 组检查通过 --------------`);
}

main().catch((error) => { log.error(`双节点验收失败：${error.message}`); process.exitCode = 1; }).finally(async () => {
  for (const socket of sockets) socket.close();
  for (const [base, session] of sessions) await request(base, "POST", "/api/v1/auth/logout", session.deviceToken, {}).catch(() => {});
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});
