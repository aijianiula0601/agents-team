const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const C = require("../shared/web/conversation");
const { createDesktopGateway } = require("../mac-app/electron/desktop-gateway");

const SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/gateway-client.js"), "utf8");
const CONFIG = { baseUrl: "http://192.168.1.10:47631", token: "ab".repeat(32) };
const CHAT = { agentId: "coder", threadKey: "agent:coder", runId: "phone-test", messages: [{ role: "user", content: "仅用于本地测试" }] };

function loadClient(options = {}) {
  const calls = [];
  const context = {
    ChorusConversation: C, URL, TextEncoder, AbortController, clearTimeout,
    setTimeout: options.timeoutMs ? (callback) => setTimeout(callback, options.timeoutMs) : setTimeout,
    fetch: options.fetch || (() => { throw new Error("原生 HTTP 不应调用浏览器 fetch"); }),
    Capacitor: options.web ? undefined : {
      getPlatform: () => "android",
      Plugins: { CapacitorHttp: { request: (payload) => {
        calls.push(payload);
        return Promise.resolve().then(() => options.native ? options.native(payload) : { status: 200, data: { name: "Chorus", protocolVersion: 1 } });
      } } },
    },
  };
  vm.runInNewContext(SOURCE, context, { filename: "gateway-client.js" });
  return { ...context.ChorusGatewayClient, calls };
}

test("HTTP只接受真实局域网/本机地址，域名前缀不能伪装LAN，令牌格式严格", () => {
  const { connection } = loadClient();
  for (const url of ["http://localhost.evil.test", "http://10.evil.test", "http://172.20.evil.test", "http://192.168.evil.test", "http://8.8.8.8", "http://172.32.1.1"]) {
    assert.throws(() => connection({ ...CONFIG, baseUrl: url }), /局域网/);
  }
  for (const url of ["http://127.0.0.1:47631", "http://10.0.0.2", "http://172.31.1.2", "http://192.168.1.2", "http://169.254.1.2", "http://Mac.local", "http://[::1]", "http://[fd00::1]"]) {
    assert.equal(connection({ ...CONFIG, baseUrl: url }).token, CONFIG.token);
  }
  assert.equal(connection({ ...CONFIG, baseUrl: "https://gateway.example.test" }).baseUrl, "https://gateway.example.test");
  assert.equal(connection({ ...CONFIG, token: CONFIG.token.toUpperCase() }).token, CONFIG.token);
  assert.throws(() => connection({ ...CONFIG, token: "not-a-real-token" }), /64/);
  assert.throws(() => connection({ ...CONFIG, baseUrl: "https://user:secret@gateway.example.test" }), /用户名|密码/);
});

test("Android按CapacitorHttp传JSON对象，兼容原生自动解析JSON响应", async () => {
  const { request, calls } = loadClient({ native: async () => ({ status: 200, data: { text: "原生完成", via: "codex" } }) });
  assert.equal((await request(CONFIG, "POST", "/chat", CHAT)).text, "原生完成");
  assert.equal(calls[0].data.agentId, "coder");
  assert.equal(calls[0].headers.Authorization, `Bearer ${CONFIG.token}`);
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].disableRedirects, true);
  assert.equal(calls[0].responseType, "text");
  assert.equal(calls[0].connectTimeout, 15000);
  assert.equal(calls[0].readTimeout, 0);
  assert.equal(calls[0].url.includes(CONFIG.token), false);
});

test("原生HTTP错误保留状态，自动JSON和文本JSON均可解析，令牌大小写均脱敏", async () => {
  for (const text of [false, true]) {
    const data = { error: { message: `invalid ${CONFIG.token.toUpperCase()}` } };
    const { request } = loadClient({ native: async () => ({ status: 401, data: text ? JSON.stringify(data) : data }) });
    await assert.rejects(request(CONFIG, "GET", "/info"), (error) => {
      assert.match(error.message, /HTTP 401.*已隐藏/);
      assert.doesNotMatch(error.message.toLowerCase(), new RegExp(CONFIG.token));
      return true;
    });
  }
});

test("取消原生聊天立即结束等待并独立取消Mac任务，晚到响应不能成功", async () => {
  let release;
  const { request, calls } = loadClient({ native: (payload) => payload.url.endsWith("/cancel")
    ? { status: 200, data: { cancelled: true } }
    : new Promise((resolve) => { release = resolve; }) });
  const controller = new AbortController();
  const payload = { ...CHAT };
  const pending = request(CONFIG, "POST", "/chat", payload, controller.signal);
  const stopped = assert.rejects(pending, /任务已停止/);
  await Promise.resolve();
  payload.runId = "another-run";
  controller.abort();
  await stopped;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, CONFIG.baseUrl + "/cancel");
  assert.equal(calls[1].data.runId, CHAT.runId);
  assert.equal(calls[0].data.runId, CHAT.runId);
  release({ status: 200, data: { text: "晚到成功" } });
  await assert.rejects(pending, /任务已停止/);
});

test("预先取消不发送任何原生请求；独立请求不受另一段聊天取消影响", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const empty = loadClient();
  await assert.rejects(empty.request(CONFIG, "POST", "/chat", CHAT, aborted.signal), /任务已停止/);
  assert.equal(empty.calls.length, 0);
  const pendingCalls = new Map();
  const value = loadClient({ native: (payload) => payload.url.endsWith("/cancel") ? { status: 200, data: { cancelled: true } } : new Promise((resolve) => pendingCalls.set(payload.data.runId, resolve)) });
  const controller = new AbortController();
  const first = value.request(CONFIG, "POST", "/chat", CHAT, controller.signal);
  const stopped = assert.rejects(first, /任务已停止/);
  const second = value.request(CONFIG, "POST", "/chat", { ...CHAT, runId: "other-chat" });
  await Promise.resolve();
  controller.abort();
  pendingCalls.get("other-chat")({ status: 200, data: { text: "第二段回复" } });
  assert.equal((await second).text, "第二段回复");
  await stopped;
  pendingCalls.get(CHAT.runId)({ status: 200, data: { text: "晚到第一段" } });
});

test("原生聊天没有固定总超时，显式取消仍终止 Mac 任务", async () => {
  const { request, calls } = loadClient({ timeoutMs: 1, native: (payload) => payload.url.endsWith("/cancel") ? { status: 200, data: { cancelled: true } } : new Promise(() => {}) });
  const controller = new AbortController();
  let settled = false;
  const operation = request(CONFIG, "POST", "/chat", CHAT, controller.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(operation, /任务已停止/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  controller.abort();
  await rejected;
  assert.equal(calls[1].data.runId, CHAT.runId);
});

test("Java网络异常有中文错误，原生SocketTimeout会尝试取消后台且不泄漏令牌", async () => {
  for (const code of ["ConnectException", "UnknownHostException", "SSLHandshakeException", "SocketTimeoutException"]) {
    const { request } = loadClient({ native: (payload) => {
      if (payload.url.endsWith("/cancel")) return { status: 200, data: { cancelled: false } };
      throw { code, message: `native transport ${CONFIG.token}` };
    } });
    await assert.rejects(request(CONFIG, "POST", "/chat", CHAT), (error) => {
      assert.match(error.message, /连接不到 Mac|Mac 连接超时/);
      assert.doesNotMatch(error.message, new RegExp(CONFIG.token));
      return true;
    });
  }
});

test("错误响应格式与UTF8体积检查明确，超限请求在调用插件前被拒绝", async () => {
  const value = loadClient();
  await assert.rejects(value.request(CONFIG, "POST", "/chat", { ...CHAT, messages: [{ role: "user", content: "中".repeat(400000) }] }), /不能超过 1 MB/);
  assert.equal(value.calls.length, 0);
  for (const data of [null, undefined, "null", "<html>wrong endpoint</html>", ["invalid"]]) {
    const { request } = loadClient({ native: async () => ({ status: 200, data }) });
    await assert.rejects(request(CONFIG, "GET", "/info"), /返回格式无效/);
  }
});

test("浏览器传输使用JSON、Bearer、禁止重定向且不发送Cookie", async () => {
  let payload;
  const { request } = loadClient({ web: true, fetch: async (url, options) => {
    payload = { url, ...options };
    return { status: 200, text: async () => JSON.stringify({ text: "浏览器完成" }) };
  } });
  assert.equal((await request(CONFIG, "POST", "/chat", CHAT)).text, "浏览器完成");
  assert.equal(JSON.parse(payload.body).runId, CHAT.runId);
  assert.equal(payload.redirect, "error");
  assert.equal(payload.credentials, "omit");
  assert.equal(payload.url.includes(CONFIG.token), false);
});

test("原生形状的HTTP请求与真实回环网关契约一致，取消信号到达Mac后台", async (t) => {
  let ready;
  let aborted;
  const running = new Promise((resolve) => { ready = resolve; });
  const stopped = new Promise((resolve) => { aborted = resolve; });
  const gateway = createDesktopGateway({
    getSnapshot: () => ({ agents: [{ id: "coder", backend: "model" }], rooms: [], settings: { localExecution: false } }),
    completeChat: (_, { signal }) => { signal.addEventListener("abort", aborted, { once: true }); ready(signal); return new Promise(() => {}); },
  });
  const state = await gateway.start({ port: 0 });
  t.after(() => gateway.stop());
  const config = { baseUrl: state.url, token: state.token };
  const { request } = loadClient({ native: async (payload) => {
    const response = await fetch(payload.url, { method: payload.method, headers: payload.headers, ...(payload.data ? { body: JSON.stringify(payload.data) } : {}) });
    return { status: response.status, data: await response.json() };
  } });
  assert.equal((await request(config, "GET", "/info")).protocolVersion, 1);
  assert.equal((await request(config, "GET", "/config")).settings.localExecution, false);
  const controller = new AbortController();
  const pending = request(config, "POST", "/chat", CHAT, controller.signal);
  const rejection = assert.rejects(pending, /任务已停止/);
  const signal = await running;
  controller.abort();
  await rejection;
  await stopped;
  assert.equal(signal.aborted, true);
});

/** 功能：验证 Android 轮询流式增量与结束结果；参数：无；返回：异步测试；注意事项：真实网关保持短响应，客户端不得等完整内容才回调。 */
test("Android 网关流式轮询在任务完成前展示正文，并返回最终结果", async (t) => {
  let finish;
  let emit;
  const gateway = createDesktopGateway({
    getSnapshot: () => ({ agents: [{ id: "coder", backend: "model" }], rooms: [], settings: { localExecution: false } }),
    completeChat: (_, { onText }) => { emit = onText; onText("第一段"); return new Promise((resolve) => { finish = resolve; }); },
  });
  const state = await gateway.start({ port: 0 });
  t.after(() => gateway.stop());
  const { request, calls } = loadClient({ native: async (payload) => {
    const response = await fetch(payload.url, { method: payload.method, headers: payload.headers, ...(payload.data ? { body: JSON.stringify(payload.data) } : {}) });
    return { status: response.status, data: await response.json() };
  } });
  const output = [];
  const result = await request({ baseUrl: state.url, token: state.token }, "POST", "/chat", CHAT, undefined, (text) => {
    output.push(text);
    if (text === "第一段") { emit("第一段第二段"); finish({ text: "第一段第二段", via: "model" }); }
  });
  assert.deepEqual(output, ["第一段", "第一段第二段"]);
  assert.equal(result.text, "第一段第二段");
  assert.equal(result.status, "complete");
  assert.equal(calls[0].data.stream, true);
  assert.ok(calls.some((call) => call.url.endsWith(`/chat/${CHAT.runId}`)));
});

/** 功能：验证流式轮询取消及晚到状态隔离；参数：无；返回：异步测试；注意事项：取消后不能再推送新正文。 */
test("流式轮询取消会停止 Mac 任务并拒绝后续分片", async () => {
  const controller = new AbortController();
  const output = [];
  const { request, calls } = loadClient({ native: async (payload) => payload.url.endsWith("/cancel") ? { status: 200, data: { cancelled: true } } : { status: 202, data: { runId: CHAT.runId, status: "running", text: "已有正文" } } });
  await assert.rejects(request(CONFIG, "POST", "/chat", CHAT, controller.signal, (text) => { output.push(text); controller.abort(); }), /任务已停止/);
  assert.deepEqual(output, ["已有正文"]);
  assert.equal(calls.filter((call) => call.url.endsWith("/cancel")).length, 1);
  assert.equal(calls.length, 2);
});
