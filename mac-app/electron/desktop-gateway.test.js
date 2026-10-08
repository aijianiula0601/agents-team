const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDesktopGateway } = require("./desktop-gateway");
const { TerminalSessionManager } = require("./terminal-session");
const { acquireHarnessWorkspace } = require("./harness");

function fixture(options = {}) {
  const snapshot = {
    agents: [{ id: "coder", name: "编码员", role: "实现", persona: "帮助实现产品", backend: "codex", harness: "claude", workspace: "/trusted/project", apiKey: "DO-NOT-EXPORT", endpoint: "https://private.example/api?key=DO-NOT-EXPORT", messages: [{ text: "PRIVATE-HISTORY" }] }],
    rooms: [{ id: "team", name: "产品团队", agentIds: ["coder", "deleted"], messages: [{ text: "PRIVATE-HISTORY" }] }],
    settings: { localExecution: true, apiKeys: { openai: "DO-NOT-EXPORT" }, gatewayToken: "DO-NOT-EXPORT" },
  };
  const calls = [];
  const sessions = new Map();
  const terminals = {
    open(payload) {
      calls.push(["open", payload]);
      const existing = [...sessions.values()].find((item) => item.agentId === payload.agentId);
      if (existing) return existing;
      const value = { ...payload, sessionId: `terminal-${sessions.size + 1}`, status: "running", output: "CLI prompt> ", startOffset: 0, nextOffset: 12, cols: payload.cols || 80, rows: payload.rows || 24 };
      sessions.set(value.sessionId, value);
      return value;
    },
    write(id, data) { calls.push(["write", id, data]); return { written: true }; },
    resize(id, dims) { calls.push(["resize", id, dims]); return dims; },
    read(id, params) { calls.push(["read", id, params]); return { ...sessions.get(id), output: "new output", nextOffset: 22 }; },
    close(id) { calls.push(["close", id]); return { closed: sessions.delete(id) }; },
  };
  const gateway = createDesktopGateway({
    getSnapshot: () => snapshot,
    completeChat: (payload, context) => { calls.push(["chat", payload, context]); return { text: "完成", via: "codex" }; },
    runHarness: (payload, context) => { calls.push(["execute", payload, context]); return { ok: true, text: "已编码" }; },
    terminals,
    ...options,
  });
  return { gateway, snapshot, calls, terminals, sessions };
}

async function connect(t, options) {
  const value = fixture(options);
  value.status = await value.gateway.start({ port: 0 });
  t.after(() => value.gateway.stop());
  value.request = async (path, body, extra = {}) => {
    const response = await fetch(value.status.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${value.status.token}`, "Content-Type": "application/json", ...extra.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...extra,
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
  };
  return value;
}

const chat = { agentId: "coder", threadKey: "agent:coder", runId: "phone-1", messages: [{ role: "user", content: "完成项目" }] };

test("构造默认关闭；所有实际路由鉴权，预检不返回任何配置", async (t) => {
  const { gateway } = fixture();
  assert.equal(gateway.status().enabled, false);
  assert.equal(gateway.status().token, "");
  const state = await gateway.start({ port: 0 });
  t.after(() => gateway.stop());
  assert.equal(state.host, "127.0.0.1");
  assert.match(state.token, /^[a-f0-9]{64}$/);
  const second = await gateway.start({ port: 0 });
  assert.deepEqual(second, state);
  for (const path of ["/info", "/config", "/terminal/local", "/missing"]) {
    const response = await fetch(state.url + path);
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(state.token), false);
  }
  const invalid = await fetch(state.url + "/info", { headers: { Authorization: "Bearer " + "0".repeat(64) } });
  assert.equal(invalid.status, 401);
  const options = await fetch(state.url + "/chat", { method: "OPTIONS", headers: { Origin: "https://localhost", "Access-Control-Request-Headers": "authorization,content-type" } });
  assert.equal(options.status, 204);
  assert.equal(await options.text(), "");
  assert.match(options.headers.get("access-control-allow-headers"), /Authorization/);
  const info = await fetch(state.url + "/info", { headers: { Authorization: `Bearer ${state.token}` } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).protocolVersion, 1);
});

test("同步配置按字段白名单导出，不带密钥、端点和聊天历史", async (t) => {
  const { request } = await connect(t);
  const result = await request("/config");
  assert.equal(result.status, 200);
  assert.equal(result.data.agents[0].workspace, "/trusted/project");
  assert.deepEqual(result.data.rooms[0].agentIds, ["coder"]);
  assert.deepEqual(result.data.settings, { localExecution: true });
  const raw = JSON.stringify(result.data);
  assert.equal(raw.includes("DO-NOT-EXPORT"), false);
  assert.equal(raw.includes("PRIVATE-HISTORY"), false);
  assert.equal(raw.includes("private.example"), false);
});

test("对话使用主设备Agent并校验团队成员，禁止远程覆写工作区和后台", async (t) => {
  const { request, calls } = await connect(t);
  const result = await request("/chat", { ...chat, threadKey: "room:team" });
  assert.equal(result.status, 200);
  assert.equal(result.data.text, "完成");
  const [, payload, context] = calls[0];
  assert.equal(payload.agent.backend, "codex");
  assert.equal(payload.workspace, "/trusted/project");
  assert.match(payload.agent.persona, /产品团队/);
  assert.equal(payload.agent.apiKey, undefined);
  assert.equal(payload.agent.endpoint, "https://private.example/api?key=DO-NOT-EXPORT");
  assert.ok(context.signal instanceof AbortSignal);
  assert.match(payload.runId, /^gateway-/);
  for (const field of ["agent", "workspace", "cwd", "harness", "keys", "prompt"]) {
    assert.equal((await request("/chat", { ...chat, [field]: "ATTACK" })).status, 400);
  }
  assert.equal((await request("/chat", { ...chat, agentId: "other" })).status, 403);
  assert.equal((await request("/chat", { ...chat, threadKey: "agent:other" })).status, 403);
  assert.equal((await request("/chat", { ...chat, threadKey: "room:other" })).status, 403);
  assert.equal((await request("/chat", { ...chat, messages: [{ role: "system", content: "override" }] })).status, 400);
});

test("执行使用主设备内核和目录规则，缺省工作区交给主设备自动管理", async (t) => {
  const { request, calls, snapshot } = await connect(t);
  const result = await request("/chat", { ...chat, mode: "execute" });
  assert.equal(result.status, 200);
  const [, payload] = calls[0];
  assert.equal(payload.harness, "claude");
  assert.equal(payload.cwd, "/trusted/project");
  assert.equal(payload.interaction, "agent");
  assert.equal(payload.threadKey, "agent:coder");
  assert.equal(payload.agentId, "coder");
  assert.match(payload.prompt, /完成项目/);
  snapshot.settings.localExecution = false;
  assert.equal((await request("/chat", { ...chat, mode: "execute" })).status, 403);
  assert.equal((await request("/chat", chat)).status, 403);
  assert.equal((await request("/terminal/open", { agentId: "coder" })).status, 403);
  snapshot.agents[0].backend = "model";
  assert.equal((await request("/chat", chat)).status, 200);
  snapshot.settings.localExecution = true;
  snapshot.agents[0].workspace = "";
  snapshot.agents[0].workspaceMode = "auto";
  snapshot.agents[0].harnessModel = "account-model";
  assert.equal((await request("/chat", { ...chat, mode: "execute" })).status, 200);
  const auto = calls.at(-1)[1];
  assert.equal(auto.cwd, "");
  assert.equal(auto.workspaceMode, "auto");
  assert.equal(auto.harnessModel, "account-model");
});

test("取消只影响网关自身任务，取消后的晚到结果不能返回成功", async (t) => {
  let release;
  let received;
  const began = new Promise((resolve) => { received = resolve; });
  const { request } = await connect(t, { completeChat: (payload, { signal }) => {
    received(signal);
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = request("/chat", chat);
  const signal = await began;
  assert.equal((await request("/chat", chat)).status, 409);
  assert.deepEqual((await request("/cancel", { runId: "desktop-local" })).data, { cancelled: false });
  assert.deepEqual((await request("/cancel", { runId: "phone-1" })).data, { cancelled: true });
  assert.equal(signal.aborted, true);
  const result = await pending;
  assert.equal(result.status, 409);
  release({ text: "late-result" });
  assert.deepEqual((await request("/cancel", { runId: "phone-1" })).data, { cancelled: false });
});

test("长请求超时会终止后台；错误内容不暴露注入后台的异常或密钥", async (t) => {
  let signal;
  const { request } = await connect(t, { requestTimeoutMs: 30, completeChat: (_, context) => { signal = context.signal; return new Promise(() => {}); } });
  const timed = await request("/chat", chat);
  assert.equal(timed.status, 504);
  assert.equal(signal.aborted, true);
  const failing = await connect(t, { completeChat: () => { throw new Error("secret-key=DO-NOT-EXPORT Authorization: PRIVATE-TOKEN"); } });
  const error = await failing.request("/chat", chat);
  assert.equal(error.status, 503);
  assert.equal(JSON.stringify(error.data).includes("DO-NOT-EXPORT"), false);
  assert.equal(JSON.stringify(error.data).includes("PRIVATE-TOKEN"), false);
});

test("终端在本机配置下创建，增量读取与写入/缩放只允许当前连接会话", async (t) => {
  const { request, calls } = await connect(t);
  const opened = await request("/terminal/open", { agentId: "coder", cols: 100, rows: 30 });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.agentId, "coder");
  assert.equal(opened.data.harness, "codex");
  assert.equal(calls[0][1].cwd, "/trusted/project");
  assert.equal(calls[0][1].sessionAgentId, "coder");
  assert.match(calls[0][1].agentId, /^gateway-/);
  assert.equal((await request("/terminal/open", { agentId: "coder", cwd: "/evil" })).status, 400);
  const sessionId = opened.data.sessionId;
  assert.equal((await request("/terminal/write", { sessionId, data: "帮助我编码\r" })).status, 200);
  assert.equal((await request("/terminal/resize", { sessionId, cols: 120, rows: 40 })).status, 200);
  const output = await request(`/terminal/${sessionId}?after=12`);
  assert.equal(output.status, 200);
  assert.equal(output.data.output, "new output");
  assert.deepEqual(calls.find((item) => item[0] === "read")[2], { after: 12 });
  assert.equal((await request(`/terminal/${sessionId}?after=-1`)).status, 400);
  assert.equal((await request("/terminal/local-existing")).status, 404);
  assert.equal((await request("/terminal/write", { sessionId: "local-existing", data: "\r" })).status, 404);
  assert.equal((await request("/terminal/close", { sessionId })).status, 200);
  assert.equal((await request(`/terminal/${sessionId}`)).status, 404);
});

test("停止关闭网关终端并取消请求，重启旋转令牌且不接受上一轮会话", async (t) => {
  const value = await connect(t);
  const sessionId = (await value.request("/terminal/open", { agentId: "coder" })).data.sessionId;
  await value.gateway.stop();
  assert.equal(value.gateway.status().enabled, false);
  assert.ok(value.calls.some((item) => item[0] === "close" && item[1] === sessionId));
  const next = await value.gateway.start({ port: 0 });
  assert.notEqual(next.token, value.status.token);
  assert.equal((await fetch(next.url + "/info", { headers: { Authorization: `Bearer ${value.status.token}` } })).status, 401);
  const lost = await fetch(next.url + `/terminal/${sessionId}`, { headers: { Authorization: `Bearer ${next.token}` } });
  assert.equal(lost.status, 404);
});

test("关闭网关会取消尚未结束的聊天；连接断开也会传递取消信号", async (t) => {
  let began;
  const waiting = new Promise((resolve) => { began = resolve; });
  const first = await connect(t, { completeChat: (_, { signal }) => { began(signal); return new Promise(() => {}); } });
  const pending = first.request("/chat", chat).then((value) => value, () => null);
  const signal = await waiting;
  await first.gateway.stop();
  await pending;
  assert.equal(signal.aborted, true);

  let running;
  let cancelled;
  const received = new Promise((resolve) => { running = resolve; });
  const aborted = new Promise((resolve) => { cancelled = resolve; });
  const second = await connect(t, { completeChat: (_, context) => {
    context.signal.addEventListener("abort", cancelled, { once: true });
    running(context.signal);
    return new Promise(() => {});
  } });
  const req = http.request(second.status.url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${second.status.token}`, "Content-Type": "application/json" } });
  req.on("error", () => {});
  req.end(JSON.stringify(chat));
  const disconnected = await received;
  req.destroy();
  await aborted;
  assert.equal(disconnected.aborted, true);
});

test("关闭期间晚到的终端也会清理；长Agent编号使用固定长度内部键", async (t) => {
  let ready;
  let release;
  let cleaned;
  let internal;
  const began = new Promise((resolve) => { ready = resolve; });
  const closed = new Promise((resolve) => { cleaned = resolve; });
  const terminal = {
    open(payload) { internal = payload.agentId; ready(); return new Promise((resolve) => { release = resolve; }); },
    close(sessionId) { cleaned(sessionId); return { closed: true }; },
  };
  const { request, gateway, snapshot } = await connect(t, { terminals: terminal });
  snapshot.agents[0].id = "x".repeat(128);
  const pending = request("/terminal/open", { agentId: snapshot.agents[0].id }).then((value) => value, () => null);
  await began;
  assert.ok(internal.length <= 128);
  await gateway.stop();
  release({ sessionId: "late-session", agentId: internal });
  assert.equal(await closed, "late-session");
  await pending;
});

test("终端按已授权聊天隔离并支持原生恢复，不能伪造其他团队或CLI选项", async (t) => {
  const { request, calls } = await connect(t);
  const privateSession = await request("/terminal/open", { agentId: "coder" });
  const resumed = await request("/terminal/open", { agentId: "coder", threadKey: "room:team", resumeSessionId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.threadKey, "room:team");
  assert.notEqual(privateSession.data.sessionId, resumed.data.sessionId);
  const repeated = await request("/terminal/open", { agentId: "coder", threadKey: "room:team" });
  assert.equal(repeated.data.sessionId, resumed.data.sessionId);
  const opens = calls.filter((item) => item[0] === "open");
  assert.equal(opens[1][1].resumeSessionId, "00000000-0000-4000-8000-000000000000");
  assert.equal(opens[2][1].agentId, opens[1][1].agentId);
  assert.equal((await request("/terminal/open", { agentId: "coder", threadKey: "room:other" })).status, 403);
  assert.equal((await request("/terminal/open", { agentId: "coder", resumeSessionId: "--dangerously-bypass-approvals-and-sandbox" })).status, 400);
  assert.equal((await request("/terminal/resize", { sessionId: resumed.data.sessionId, cols: 80, rows: 301 })).status, 400);
});

test("原生取消先于聊天上传到达时，迟到请求不能再启动编程后台", async (t) => {
  const { request, calls } = await connect(t);
  assert.deepEqual((await request("/cancel", { runId: chat.runId })).data, { cancelled: false });
  assert.equal((await request("/chat", chat)).status, 409);
  assert.equal(calls.length, 0);
  assert.equal((await request("/chat", { ...chat, runId: "new-run" })).status, 200);
});

test("真实HTTP终端持有工作区写锁时聊天显示409操作提示，关闭终端后可重试", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-gateway-lock-"));
  const terminals = new TerminalSessionManager({
    pty: { spawn: () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }) },
    resolveExecutable: () => "/synthetic/codex", childEnv: () => ({ PATH: "/bin" }), killProcessTree() {},
  });
  const value = await connect(t, { terminals, completeChat: (payload) => {
    const release = acquireHarnessWorkspace(payload.workspace, "agent");
    try { return { text: "重试完成", via: "codex" }; } finally { release(); }
  } });
  t.after(() => { terminals.closeAll(); fs.rmSync(workspace, { recursive: true, force: true }); });
  value.snapshot.agents[0].workspace = workspace;
  const session = await value.request("/terminal/open", { agentId: "coder" });
  assert.equal(session.status, 200);
  const conflict = await value.request("/chat", chat);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "这个工作区已有 Harness 正在执行，请等待它结束或关闭终端");
  assert.equal((await value.request("/terminal/close", { sessionId: session.data.sessionId })).status, 200);
  assert.equal((await value.request("/chat", chat)).data.text, "重试完成");
  const unsafe = await connect(t, { completeChat: () => { throw new Error(conflict.data.error + " SECRET-KEY"); } });
  const rejected = await unsafe.request("/chat", chat);
  assert.equal(rejected.status, 503);
  assert.doesNotMatch(rejected.data.error, /SECRET-KEY/);
});

test("请求体限制覆盖 Content-Length 和分块传输；慢上传有明确超时", async (t) => {
  const { request, status } = await connect(t, { bodyTimeoutMs: 80 });
  assert.equal((await request("/chat", { ...chat, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] })).status, 413);
  async function raw(chunks, finish = true) {
    return new Promise((resolve, reject) => {
      const req = http.request(status.url + "/chat", { method: "POST", headers: { Authorization: `Bearer ${status.token}`, "Content-Type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => { req.destroy(); resolve(res.statusCode); });
      });
      req.on("error", reject);
      for (const chunk of chunks) req.write(chunk);
      if (finish) req.end();
    });
  }
  assert.equal(await raw(["x".repeat(600000), "x".repeat(600000)]), 413);
  assert.equal(await raw(["{\"agentId\":\"coder\""], false), 408);
});

test("手机流式请求立即响应并在结束前轮询累计正文，完成和取消相互隔离", async (t) => {
  const active = new Map();
  const { request, status } = await connect(t, {
    completeChat: (payload, context) => new Promise((resolve) => { active.set(payload.messages[0].content, { context, resolve }); }),
  });
  const first = await request("/chat", { ...chat, runId: "stream-one", stream: true });
  const second = await request("/chat", { ...chat, runId: "stream-two", stream: true, messages: [{ role: "user", content: "第二任务" }] });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(first.data.status, "running");
  const one = active.get("完成项目");
  const two = active.get("第二任务");
  one.context.onText("第一段");
  two.context.onText("另一个成员");
  assert.equal((await request("/chat/stream-one")).data.text, "第一段");
  assert.equal((await request("/chat/stream-two")).data.text, "另一个成员");
  const denied = await fetch(`${status.url}/chat/stream-one`);
  assert.equal(denied.status, 401);
  assert.equal((await request("/chat", { ...chat, runId: "stream-one", stream: true })).status, 409);
  assert.equal((await request("/cancel", { runId: "stream-one" })).data.cancelled, true);
  one.context.onText("迟到片段不能覆盖");
  one.resolve({ text: "迟到成功", via: "codex" });
  const cancelled = await request("/chat/stream-one");
  assert.equal(cancelled.data.status, "error");
  assert.equal(cancelled.data.text, "第一段");
  assert.match(cancelled.data.error, /任务已停止/);
  assert.equal(two.context.signal.aborted, false);
  two.resolve({ text: "另一个成员完成", via: "codex" });
  const completed = await request("/chat/stream-two");
  assert.equal(completed.data.status, "complete");
  assert.equal(completed.data.text, "另一个成员完成");
  assert.equal(completed.data.via, "codex");
});

test("流式轮询续期长任务，失联取消且结果自动过期，不暴露后台异常", async (t) => {
  let context;
  const { request } = await connect(t, { streamLeaseMs: 150, completeChat: (_payload, options) => { context = options; return new Promise(() => {}); } });
  await request("/chat", { ...chat, stream: true });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await request(`/chat/${chat.runId}`)).data.status, "running");
  }
  assert.equal(context.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(context.signal.aborted, true);
  const stopped = await request(`/chat/${chat.runId}`);
  assert.equal(stopped.data.status, "error");
  assert.match(stopped.data.error, /连接已断开/);
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal((await request(`/chat/${chat.runId}`)).status, 404);
  const failed = await connect(t, { completeChat: async () => { throw new Error("PRIVATE-API-KEY"); } });
  await failed.request("/chat", { ...chat, stream: true });
  const error = await failed.request(`/chat/${chat.runId}`);
  assert.equal(error.data.status, "error");
  assert.equal(JSON.stringify(error.data).includes("PRIVATE-API-KEY"), false);
});

test("网关默认总时长超过三十分钟不终止CLI，显式取消仍生效", async (t) => {
  let started;
  let context;
  const ready = new Promise((resolve) => { started = resolve; });
  const { request } = await connect(t, { completeChat: (_payload, options) => { context = options; started(); return new Promise(() => {}); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = request("/chat", chat);
  await ready;
  t.mock.timers.tick(31 * 60 * 1000);
  assert.equal(context.signal.aborted, false);
  const stop = await request("/cancel", { runId: chat.runId });
  assert.equal(stop.data.cancelled, true);
  assert.equal((await pending).status, 409);
  t.mock.timers.reset();
});

test("流式完成缓存有界，旧结果淘汰，运行中缓存不能覆盖或被手机注入配置", async (t) => {
  const { request } = await connect(t);
  for (let index = 0; index < 65; index += 1) {
    const response = await request("/chat", { ...chat, runId: `stream-${index}`, stream: true });
    assert.equal(response.status, 202);
  }
  assert.equal((await request("/chat/stream-0")).status, 404);
  assert.equal((await request("/chat/stream-64")).data.status, "complete");
  assert.equal((await request("/chat", { ...chat, stream: "true" })).status, 400);
  assert.equal((await request("/chat", { ...chat, stream: true, cwd: "/untrusted" })).status, 400);
});
