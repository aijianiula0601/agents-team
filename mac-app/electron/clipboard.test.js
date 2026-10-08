const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const handlerSource = source.match(/ipcMain\.handle\("chorus:copy-text",[\s\S]*?\n\}\);/)[0];
function handler(clipboard, trust = () => {}) {
  let callback;
  vm.runInNewContext(handlerSource, { Buffer, clipboard, trust, ipcMain: { handle: (_channel, value) => { callback = value; } } });
  return callback;
}

test("Electron 44 复制等待原生异步写入和读回，中文多行不会误报失败", async () => {
  let copied = "";
  const events = [];
  const callback = handler({
    async writeText(value) { events.push("writing"); await Promise.resolve(); copied = value; events.push("written"); },
    async readText() { events.push("read"); await Promise.resolve(); return copied; },
  });
  assert.equal(await callback({}, "第一行中文\n第二行 🙂\n复制验收"), true);
  assert.deepEqual(events, ["writing", "written", "read"]);
});

test("异步剪贴板读回不一致或写入失败，不会误报成功", async () => {
  assert.equal(await handler({ writeText: async () => {}, readText: async () => "其他内容" })({}, "复制内容"), false);
  await assert.rejects(handler({ writeText: async () => { throw new Error("原生复制失败"); }, readText: async () => "" })({}, "复制内容"), /原生复制失败/);
});

test("未知页面、非文本或过大复制请求不能写入系统剪贴板", async () => {
  const clipboard = { writeText: async () => { throw new Error("不能写入"); }, readText: async () => "" };
  const callback = handler(clipboard);
  await assert.rejects(callback({}, { text: "内容" }), /无效/);
  await assert.rejects(callback({}, "界".repeat(3 * 1024 * 1024)), /过大/);
  await assert.rejects(handler(clipboard, () => { throw new Error("拒绝未知页面"); })({}, "内容"), /拒绝未知页面/);
});
