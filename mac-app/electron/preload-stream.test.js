const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

/** 加载隔离桌面桥；无参数；返回桥、事件总线与待完成调用；不启动 Electron。 */
function bridgeFixture() {
  const ipc = new EventEmitter();
  const requests = [];
  ipc.invoke = (channel, payload) => new Promise((resolve, reject) => requests.push({ channel, payload, resolve, reject }));
  let bridge;
  const contextBridge = { exposeInMainWorld: (_name, value) => { bridge = value; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "preload.js"), "utf8"), { require: () => ({ ipcRenderer: ipc, contextBridge }) });
  return { bridge, ipc, requests };
}

test("桌面并行成员按内部请求编号隔离进度，同runId也不会串流，成功失败均解除订阅", async () => {
  const { bridge, ipc, requests } = bridgeFixture();
  const updates = [[], []];
  const one = bridge.completeChat({ runId: "same" }, (text) => updates[0].push(text));
  const two = bridge.runHarness({ runId: "same" }, (text) => updates[1].push(text));
  assert.equal(ipc.listenerCount("chorus:run-progress"), 1);
  const firstId = requests[0].payload.streamRequestId;
  const secondId = requests[1].payload.streamRequestId;
  assert.notEqual(firstId, secondId);
  ipc.emit("chorus:run-progress", {}, { requestId: secondId, text: "第二成员" });
  ipc.emit("chorus:run-progress", {}, { requestId: firstId, text: "第一成员" });
  ipc.emit("chorus:run-progress", {}, { requestId: "unknown", text: "不属于请求" });
  assert.deepEqual(updates, [["第一成员"], ["第二成员"]]);
  requests[0].resolve({ text: "完成" });
  await one;
  assert.equal(ipc.listenerCount("chorus:run-progress"), 1);
  ipc.emit("chorus:run-progress", {}, { requestId: firstId, text: "迟到事件" });
  requests[1].reject(new Error("任务已停止"));
  await assert.rejects(two, /任务已停止/);
  assert.equal(ipc.listenerCount("chorus:run-progress"), 0);
  assert.deepEqual(updates, [["第一成员"], ["第二成员"]]);
});

test("旧版无回调仍只调用原IPC，展示异常不终止其他成员", async () => {
  const { bridge, ipc, requests } = bridgeFixture();
  const old = bridge.completeChat({ runId: "legacy" });
  assert.equal(ipc.listenerCount("chorus:run-progress"), 0);
  assert.equal(requests[0].payload.streamRequestId, undefined);
  requests[0].resolve({ text: "兼容" });
  await old;
  const next = bridge.completeChat({}, () => { throw new Error("页面已销毁"); });
  assert.doesNotThrow(() => ipc.emit("chorus:run-progress", {}, { requestId: requests[1].payload.streamRequestId, text: "片段" }));
  requests[1].resolve({ text: "完成" });
  await next;
  assert.equal(ipc.listenerCount("chorus:run-progress"), 0);
});

test("主进程合并高频输出且结束刷新最后片段，导航后禁发，迟到回调被清理", async () => {
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const fn = source.match(/async function runWithProgress\([^]*?\n\}/)?.[0];
  assert.ok(fn);
  let trusted = true;
  const context = { setTimeout, clearTimeout, trust: () => { if (!trusted) throw new Error("页面已导航"); } };
  vm.runInNewContext(`this.runWithProgress = ${fn}`, context);
  const sent = [];
  const event = { sender: { send: (_channel, value) => sent.push(value.text) } };
  let callback;
  let finish;
  const pending = context.runWithProgress(event, { streamRequestId: "stream-one" }, (_payload, { onText }) => {
    callback = onText;
    for (let index = 1; index <= 1000; index += 1) onText(`片段${index}`);
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.deepEqual(sent, ["片段1"]);
  finish({ text: "片段1000" });
  await pending;
  assert.deepEqual(sent, ["片段1", "片段1000"]);
  callback("迟到消息");
  assert.equal(sent.length, 2);
  trusted = false;
  await context.runWithProgress(event, { streamRequestId: "stream-two" }, async (_payload, { onText }) => { onText("不能泄露到新页面"); return { text: "完成" }; });
  assert.equal(sent.length, 2);
  await assert.rejects(context.runWithProgress(event, { streamRequestId: "bad\n" }, async () => ({})), /编号格式无效/);
});
