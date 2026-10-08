const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAppUpdater, newerVersion, relayAddress } = require("./app-updates");

/** 创建隔离更新站；参数为测试上下文和响应钩子；返回发布清单与下载器；不触碰真实安装目录。 */
async function fixture(t, handler) {
  const content = Buffer.from("test-dmg-content");
  const release = { id: "release-1", platform: "mac", arch: process.arch, version: "9.0.0", buildNumber: 0, fileName: "Chorus.dmg", size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex"), downloadUrl: "/download" };
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/api/v1/releases/latest?")) {
      const url = new URL(request.url, "http://localhost");
      assert.equal(url.searchParams.get("currentVersion"), "0.5.5");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ release }));
    } else if (handler) handler(request, response, content);
    else { response.setHeader("Content-Length", content.length); response.end(content); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-updater-"));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const opened = [];
  const events = [];
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const updater = createAppUpdater({ app: { isPackaged: false, getVersion: () => "0.5.5", getPath: () => directory }, shell: { openPath: async (file) => { opened.push(file); return ""; } }, onProgress: (event) => events.push(event), trustedRelay: relayUrl });
  return { updater, content, release, relayUrl, directory, opened, events };
}

test("主进程重新获取清单，忽略页面篡改的文件地址和摘要，完整下载后打开 DMG", async (t) => {
  const state = await fixture(t);
  const result = await state.updater.downloadUpdate({ relayUrl: state.relayUrl, release: { ...state.release, downloadUrl: "https://evil.invalid/payload", sha256: "0".repeat(64) } });
  assert.equal(result.status, "installing");
  assert.equal(state.opened.length, 1);
  assert.deepEqual(fs.readFileSync(state.opened[0]), state.content);
  assert.equal(state.events.at(-1).percent, 100);
  assert.deepEqual([...new Set(state.events.map((event) => event.status))], ["downloading", "verifying", "ready", "installing"]);
  assert.deepEqual(fs.readdirSync(path.join(state.directory, "updates")), ["Chorus-update.dmg"]);
});

test("哈希错误拒绝安装，清除临时文件，后续任务可重试", async (t) => {
  const state = await fixture(t);
  const hash = state.release.sha256;
  state.release.sha256 = "0".repeat(64);
  await assert.rejects(state.updater.downloadUpdate(state), /完整性校验失败/);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(state.directory, "updates")), []);
  assert.equal(state.events.at(-1).status, "error");
  state.release.sha256 = hash;
  assert.equal((await state.updater.downloadUpdate(state)).status, "installing");
});

test("拒绝跨源下载重定向", async (t) => {
  const state = await fixture(t, (_request, response) => { response.writeHead(302, { Location: "http://127.0.0.1:1/payload" }); response.end(); });
  await assert.rejects(state.updater.downloadUpdate(state), /重定向不可信/);
  assert.equal(state.opened.length, 0);
});

test("过期清单、错误架构和降级版本不能安装", async (t) => {
  const state = await fixture(t);
  await assert.rejects(state.updater.downloadUpdate({ ...state, release: { id: "stale" } }), /版本已变化/);
  state.release.arch = "wrong-arch";
  await assert.rejects(state.updater.downloadUpdate(state), /不适用于本机/);
  state.release.arch = process.arch;
  state.release.version = "0.5.4";
  await assert.rejects(state.updater.downloadUpdate(state), /不适用于本机/);
});

test("单任务限制和超出声明大小保护", async (t) => {
  let deliver;
  const state = await fixture(t, (_request, response, content) => { deliver = () => response.end(Buffer.concat([content, Buffer.from("oversized")])); response.writeHead(200); response.flushHeaders(); });
  const first = state.updater.downloadUpdate(state);
  await assert.rejects(state.updater.downloadUpdate(state), /已有更新/);
  while (!deliver) await new Promise((resolve) => setTimeout(resolve, 5));
  deliver();
  await assert.rejects(first, /超过声明大小/);
  assert.equal(state.opened.length, 0);
});

test("生产包拒绝未授权源和明文源，正式版本比较防止回退", async () => {
  assert.throws(() => relayAddress("http://relay.example.com", true), /HTTPS/);
  assert.throws(() => relayAddress("http://127.0.0.1", false), /HTTPS/);
  assert.throws(() => relayAddress("https://name:secret@relay.example.com", false), /HTTPS/);
  assert.equal(newerVersion("0.10.0", "0.9.9"), true);
  assert.equal(newerVersion("0.5.5", "0.5.5"), false);
  const updater = createAppUpdater({ app: { isPackaged: true, getVersion: () => "0.5.5" }, shell: {} });
  await assert.rejects(updater.downloadUpdate({ relayUrl: "https://evil.invalid", release: { id: "1" } }), /可信更新源/);
});
