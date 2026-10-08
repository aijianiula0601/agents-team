const assert = require("node:assert/strict");
const test = require("node:test");
const auth = require("../shared/web/relay-auth");

const BASE = "https://relay.example.test/agents-team";
const DEVICE = { clientDeviceId: "test-device", name: "测试手机", platform: "android" };
const URL = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=test.apps.googleusercontent.com&redirect_uri=${encodeURIComponent(`${BASE}/api/v1/auth/google/callback`)}&state=random-state&nonce=random-nonce`;
const START = { authId: "login-request", pollToken: "poll-secret", authorizationUrl: URL, expiresIn: 300 };
const SESSION = { deviceToken: "relay-session", account: { id: "google-id", name: "测试", email: "test@example.test", provider: "google" }, device: { id: "device-id" }, revision: 2 };

function options(responses, overrides = {}) {
  const requests = [];
  const opened = [];
  return {
    requests, opened, relayUrl: BASE, device: DEVICE, pollIntervalMs: 0,
    openBrowser: async (url) => opened.push(url),
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request, body: JSON.parse(request.body) });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { status: next.httpStatus || 200, json: async () => next };
    }, ...overrides,
  };
}

test("Google 登录先打开真实授权页，再以请求体轮询领取验证后的中转站会话", async () => {
  const setup = options([START, { status: "pending" }, { status: "done", session: SESSION }]);
  assert.deepEqual(await auth.googleLogin(setup), SESSION);
  assert.deepEqual(setup.opened, [URL]);
  assert.equal(setup.requests[0].url, BASE + "/api/v1/auth/google/start");
  assert.deepEqual(setup.requests[0].body, { device: DEVICE });
  assert.equal(setup.requests[1].url, BASE + "/api/v1/auth/google/poll");
  assert.deepEqual(setup.requests[1].body, { authId: START.authId, pollToken: START.pollToken });
  for (const request of setup.requests) {
    assert.equal(request.url.includes(START.pollToken), false);
    assert.equal(request.url.includes(SESSION.deviceToken), false);
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "no-store");
  }
});

test("Android 使用原生 HTTP，同样禁止 URL 携带凭据和跟随跳转", async () => {
  const calls = [];
  const setup = options([], { nativeHttp: { request: async (request) => {
    calls.push(request);
    return { status: 200, data: JSON.stringify(calls.length === 1 ? START : { status: "done", session: SESSION }) };
  } } });
  assert.deepEqual(await auth.googleLogin(setup), SESSION);
  assert.equal(setup.requests.length, 0);
  assert.equal(calls[1].data.pollToken, START.pollToken);
  assert.equal(calls[1].disableRedirects, true);
  assert.equal(calls[1].url.includes(START.pollToken), false);
});

test("缺失 Google 服务配置明确失败，绝不构造客户端身份或打开假的授权页", async () => {
  const setup = options([{ httpStatus: 503, error: { code: "GOOGLE_NOT_CONFIGURED", message: "中转站尚未配置 Google 登录" } }]);
  await assert.rejects(auth.googleLogin(setup), /尚未配置/);
  assert.deepEqual(setup.opened, []);
  assert.equal(setup.requests.length, 1);
});

test("拒绝含 token 的授权地址、伪 Google 域名和非授权码流程", async () => {
  for (const value of [URL + "&pollToken=secret", URL + "&access_token=secret", URL.replace("accounts.google.com", "accounts.google.com.evil.test"), URL.replace("response_type=code", "response_type=token"), URL.replace("https:", "http:"), URL + "#secret"]) {
    const setup = options([{ ...START, authorizationUrl: value }]);
    await assert.rejects(auth.googleLogin(setup), /授权地址/);
    assert.deepEqual(setup.opened, []);
  }
});

test("拒绝把未验证邮箱资料或缺少中转会话 token 当成成功", async () => {
  for (const session of [{ account: SESSION.account }, { ...SESSION, account: { ...SESSION.account, provider: "local" } }, { ...SESSION, account: { ...SESSION.account, email: "" } }]) {
    await assert.rejects(auth.googleLogin(options([START, { status: "done", session }])), /会话无效/);
  }
});

test("取消登录立即结束原生请求等待，晚到的响应不能登录", async () => {
  const controller = new AbortController();
  let release;
  const setup = options([], { signal: controller.signal, nativeHttp: { request: () => new Promise((resolve) => { release = resolve; }) } });
  const pending = auth.googleLogin(setup);
  controller.abort();
  await assert.rejects(pending, /已取消/);
  release({ status: 200, data: START });
  await Promise.resolve();
  assert.deepEqual(setup.opened, []);
});

test("授权超时或拒绝之后不会生成会话，轮询服务错误遮蔽 poll token", async () => {
  await assert.rejects(auth.googleLogin(options([START], { timeoutMs: 10, openBrowser: () => new Promise(() => {}) })), /登录超时/);
  await assert.rejects(auth.googleLogin(options([START, { status: "failed" }])), /未完成/);
  const setup = options([START, { httpStatus: 400, error: { message: "invalid poll-secret" } }]);
  await assert.rejects(auth.googleLogin(setup), (error) => error.message.includes("已隐藏") && !error.message.includes(START.pollToken));
});

test("中转地址保留路径前缀，禁止网络明文和 URL 凭据", () => {
  assert.equal(auth.normalizeRelayUrl(BASE + "/"), BASE);
  assert.equal(auth.normalizeRelayUrl("http://127.0.0.1:5006/agents-team"), "http://127.0.0.1:5006/agents-team");
  for (const url of ["http://relay.example.test", "https://user:secret@example.test", BASE + "?token=secret", BASE + "#secret"]) {
    assert.throws(() => auth.normalizeRelayUrl(url), /HTTPS|不能包含/);
  }
});
