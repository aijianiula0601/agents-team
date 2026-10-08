const assert = require("node:assert/strict");
const test = require("node:test");
const createPlatform = require("../shared/web/platform");

function documentFor(success) {
  const calls = [];
  const input = { value: "", style: {}, setAttribute() {}, select() { calls.push("select"); }, setSelectionRange() {}, remove() { calls.push("remove"); } };
  return { calls, input, document: {
    body: { appendChild() {} }, createElement: () => input,
    activeElement: { focus() { calls.push("focus"); } },
    execCommand: (name) => { calls.push(name); return success; },
  } };
}

test("Electron 原生复制成功时不请求已禁用的网页剪贴板权限", async () => {
  let copied;
  const api = createPlatform({ chorusDesktop: { copyText: async (text) => { copied = text; return true; } }, navigator: { clipboard: { writeText() { throw new Error("不应该调用"); } } } });
  assert.equal(await api.copyText("消息\n内容"), true);
  assert.equal(copied, "消息\n内容");
});

test("Android 原生插件正确复制消息并返回真实结果", async () => {
  let payload;
  const api = createPlatform({ Capacitor: { getPlatform: () => "android", Plugins: { ChorusClipboard: { writeText: async (value) => { payload = value; return { copied: true }; } } } } });
  assert.equal(await api.copyText("手机消息"), true);
  assert.deepEqual(payload, { text: "手机消息" });
});

test("网页权限被拒绝时使用 checked execCommand 回退并恢复焦点", async () => {
  const setup = documentFor(true);
  const api = createPlatform({ document: setup.document, navigator: { clipboard: { writeText: async () => { throw new Error("permission denied"); } } } });
  assert.equal(await api.copyText("可复制消息"), true);
  assert.equal(setup.input.value, "可复制消息");
  assert.deepEqual(setup.calls, ["select", "copy", "remove", "focus"]);
});

test("复制全部失败时返回 false，避免把 execCommand false 误报为已复制", async () => {
  const setup = documentFor(false);
  const api = createPlatform({ document: setup.document, chorusDesktop: { copyText: async () => { throw new Error("native failure"); } } });
  assert.equal(await api.copyText("消息"), false);
  assert.equal(await api.copyText({ text: "无效值" }), false);
});

test("Google 登录使用 Electron 受控系统浏览器，传设备信息并阻止并发登录", async () => {
  let received;
  let opened;
  let release;
  const api = createPlatform({
    chorusDesktop: { openGoogleAuthorization: async (url) => { opened = url; } },
    ChorusRelayAuth: { googleLogin: async (options) => { received = options; await options.openBrowser("https://accounts.google.com"); return new Promise((resolve) => { release = resolve; }); } },
  });
  const device = { clientDeviceId: "test-device", platform: "mac" };
  const pending = api.googleLogin("https://relay.example.test", { device });
  await Promise.resolve();
  assert.equal(opened, "https://accounts.google.com");
  assert.deepEqual(received.device, device);
  await assert.rejects(api.googleLogin("https://relay.example.test", { device }), /正在进行/);
  release({ deviceToken: "real-session" });
  assert.deepEqual(await pending, { deviceToken: "real-session" });
});

test("Android Google 登录打开系统 Browser 并使用原生 HTTP", async () => {
  let opened;
  const http = { request() {} };
  const api = createPlatform({
    Capacitor: { getPlatform: () => "android", Plugins: { Browser: { open: async (options) => { opened = options; } }, CapacitorHttp: http } },
    ChorusRelayAuth: { googleLogin: async (options) => { assert.equal(options.nativeHttp, http); await options.openBrowser("https://accounts.google.com"); return { deviceToken: "session" }; } },
  });
  assert.deepEqual(await api.googleLogin("https://relay.example.test", { device: { platform: "android" } }), { deviceToken: "session" });
  assert.deepEqual(opened, { url: "https://accounts.google.com" });
});

test("网页预建授权窗口，异步请求失败时关闭并允许再次登录", async () => {
  const opened = [];
  let closed = 0;
  const api = createPlatform({
    open: () => ({ location: { replace: (url) => opened.push(url) }, close: () => closed++, closed: false }),
    ChorusRelayAuth: { googleLogin: async (options) => { await options.openBrowser("https://accounts.google.com"); throw new Error("未配置 Google"); } },
  });
  await assert.rejects(api.googleLogin("https://relay.example.test"), /未配置/);
  await assert.rejects(api.googleLogin("https://relay.example.test"), /未配置/);
  assert.equal(closed, 2);
  assert.deepEqual(opened, ["https://accounts.google.com", "https://accounts.google.com"]);
});
