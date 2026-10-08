const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { assertTrustedIpc } = require("./ipc-security");

const RENDERER = path.resolve(__dirname, "../renderer/index.html");

test("复制与授权浏览器 IPC 允许主窗口本地顶层页面及平台查询参数", () => {
  const mainFrame = { url: pathToFileURL(RENDERER).href + "?platform=mac" };
  const sender = { mainFrame };
  assert.doesNotThrow(() => assertTrustedIpc({ sender, senderFrame: mainFrame }, sender, RENDERER));
});

test("复制与授权浏览器 IPC 拒绝远端导航、其他文件、iframe和其他窗口", () => {
  const mainFrame = { url: pathToFileURL(RENDERER).href };
  const sender = { mainFrame };
  assert.throws(() => assertTrustedIpc({ sender: { mainFrame }, senderFrame: mainFrame }, sender, RENDERER), /未知窗口/);
  assert.throws(() => assertTrustedIpc({ sender, senderFrame: { url: mainFrame.url } }, sender, RENDERER), /子页面/);
  for (const url of ["https://evil.example.test", pathToFileURL(path.join(__dirname, "other.html")).href]) {
    mainFrame.url = url;
    assert.throws(() => assertTrustedIpc({ sender, senderFrame: mainFrame }, sender, RENDERER), /未知页面/);
  }
});
