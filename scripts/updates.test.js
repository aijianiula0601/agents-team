const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, validateRelease, createController } = require("../shared/web/updates");

const BASE = "https://relay.example.test/agents-team";
const INFO = { platform: "mac", arch: "arm64", version: "0.5.5", buildNumber: 0 };
const RELEASE = { id: "release-1", platform: "mac", arch: "arm64", version: "0.5.6", buildNumber: 0, notes: "更新说明", fileName: "Chorus.dmg", size: 100, sha256: "a".repeat(64), downloadUrl: `${BASE}/api/v1/releases/release-1/download` };

/** 建立更新测试上下文；参数 overrides 替换原生或请求；返回控制器；注意使用合成域名不联网。 */
function setup(overrides = {}) {
  return createController({ adapter: { getUpdateInfo: async () => INFO, subscribe: async () => () => {}, downloadUpdate: async () => ({ status: "installing" }) }, getBaseUrl: () => BASE, request: async () => ({ release: RELEASE }), ...overrides });
}

test("稳定版本采用数值比较，拒绝预发布和非法版本", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.5.5", "0.5.5"), 0);
  for (const version of ["0.5.6-beta", "01.0.0", "1.2", "1.2.NaN"]) assert.throws(() => compareVersions(version, INFO.version));
});

test("清单拒绝跨平台、跨架构、跨源、无摘要与非法文件长度", () => {
  for (const patch of [{ platform: "android" }, { arch: "x64" }, { sha256: "" }, { size: -1 }, { size: 3 * 1024 ** 3 }, { downloadUrl: "https://evil.example.test/file.dmg" }, { downloadUrl: `${BASE}/other/file.dmg` }, { downloadUrl: `${BASE}/api/v1/releases/a#unsafe` }]) {
    assert.throws(() => validateRelease({ ...RELEASE, ...patch }, INFO, BASE));
  }
  assert.equal(validateRelease({ ...RELEASE, arch: "universal" }, INFO, BASE).id, RELEASE.id);
  assert.equal(validateRelease({ ...RELEASE, version: "0.5.4" }, INFO, BASE), null);
});

test("Android必须提高构建号，不能只提高显示版本号，也不允许版本名回退", () => {
  const info = { ...INFO, platform: "android", arch: "universal", buildNumber: 10 };
  const release = { ...RELEASE, platform: "android", arch: "universal", buildNumber: 11 };
  assert.ok(validateRelease(release, info, BASE));
  assert.equal(validateRelease({ ...release, buildNumber: 10 }, info, BASE), null);
  assert.equal(validateRelease({ ...release, version: "0.5.4" }, info, BASE), null);
  assert.ok(validateRelease({ ...release, version: "0.5.5" }, info, BASE));
});

test("更新检查无需账号凭据，传递原生真实版本并合并重复检查", async () => {
  const requests = []; let finish;
  const controller = setup({ request: (...args) => { requests.push(args); return new Promise((resolve) => { finish = resolve; }); } });
  const first = controller.check(), second = controller.check();
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][3], "");
  assert.match(requests[0][2], /currentVersion=0.5.5/);
  finish({ release: RELEASE });
  assert.equal((await first).status, "available");
  assert.equal((await second).release.id, RELEASE.id);
  await controller.check();
  assert.equal(requests.length, 1);
});

test("切换中转站后旧请求晚到不能恢复旧站点更新", async () => {
  let base = BASE, finish;
  const controller = setup({ getBaseUrl: () => base, request: () => new Promise((resolve) => { finish = resolve; }) });
  const first = controller.check(); await new Promise(setImmediate);
  base = "https://another.example.test/agents-team"; controller.invalidate();
  finish({ release: RELEASE }); await first;
  assert.equal(controller.snapshot().release, null);
  assert.equal(controller.snapshot().status, "idle");
});

test("旧中转站与损坏响应明确报告检查失败，不误报已是最新版本", async () => {
  const unavailable = setup({ request: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  assert.match((await unavailable.check()).message, /尚未启用/);
  const malformed = setup({ request: async () => ({}) });
  assert.equal((await malformed.check()).status, "error");
  const current = setup({ request: async () => ({ release: null }) });
  assert.equal((await current.check()).status, "current");
});

test("下载重复点击只执行一次，进度与校验状态同步，安装完成解除监听", async () => {
  let progress, finish, downloads = 0, removed = false;
  const controller = setup({ adapter: { getUpdateInfo: async () => INFO, subscribe: async (listener) => { progress = listener; return () => { removed = true; }; }, downloadUpdate: async (options) => { assert.equal(options.relayUrl, BASE); downloads++; return new Promise((resolve) => { finish = resolve; }); } } });
  await controller.check(); const first = controller.download(), second = controller.download();
  await new Promise(setImmediate);
  assert.equal(downloads, 1); assert.equal(controller.isBusy(), true);
  progress({ status: "downloading", percent: 42 }); assert.equal(controller.snapshot().percent, 42);
  progress({ status: "verifying", percent: 100 }); assert.equal(controller.snapshot().status, "verifying");
  await controller.check(true); assert.equal(controller.snapshot().status, "verifying");
  finish({ status: "installing" }); await Promise.all([first, second]);
  assert.equal(controller.snapshot().status, "installing"); assert.equal(controller.isBusy(), false); assert.equal(removed, true);
});

test("下载失败保留重试清单，Android权限提示不伪称安装成功", async () => {
  let fail = true;
  const controller = setup({ adapter: { getUpdateInfo: async () => INFO, subscribe: async () => () => {}, downloadUpdate: async () => { if (fail) throw new Error("摘要不匹配"); return { status: "ready", permissionRequired: true }; } } });
  await controller.check(); await controller.download();
  assert.equal(controller.snapshot().status, "error"); assert.match(controller.snapshot().message, /摘要不匹配/);
  assert.equal(controller.snapshot().release.id, RELEASE.id);
  fail = false; await controller.download(); assert.equal(controller.snapshot().status, "ready"); assert.match(controller.snapshot().message, /允许安装/);
});

test("Android等待授权保留事件监听，回到前台不重置安装状态，拒绝后可重试", async () => {
  let progress, removed = false, requests = 0;
  const controller = setup({ request: async () => { requests++; return { release: RELEASE }; }, adapter: { getUpdateInfo: async () => INFO, subscribe: async (listener) => { progress = listener; return () => { removed = true; }; }, downloadUpdate: async () => ({ status: "ready", permissionRequired: true }) } });
  await controller.check(); await controller.download();
  assert.equal(removed, false); assert.equal(controller.isBusy(), true);
  await controller.check(true); assert.equal(requests, 1); assert.equal(controller.snapshot().status, "ready");
  progress({ status: "error", message: "未允许安装应用" });
  assert.equal(controller.snapshot().status, "error"); assert.equal(controller.isBusy(), false); assert.equal(removed, true);
});
