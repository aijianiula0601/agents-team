const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/terminal-ui.js"), "utf8");
const AGENTS = [
  { id: "a", name: "架构师", backend: "codex", workspace: "/tmp/a" },
  { id: "b", name: "工程师", backend: "cursor", workspace: "/tmp/b" },
];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const snapshot = (id, text = "", after = 0, extra = {}) => ({
  sessionId: id, output: text.slice(after), startOffset: after, nextOffset: text.length,
  status: "running", exitCode: null, reused: false, ...extra,
});
const drain = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

/**
 * 在隔离 VM 中加载真实终端模块，提供可控时钟、DOM 与解析队列。
 * @param {{asyncParsing?: boolean}} [options] 是否模拟异步 xterm 解析
 * @returns {object} 模块 API、节点、计时器和观测结果
 * 注意事项：所有输出与会话均为合成内容，不连接真实 CLI 或读取用户终端。
 */
function load(options = {}) {
  const nodes = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const frames = new Map();
  const globalListeners = new Map();
  const logs = [];
  const parsed = [];
  let now = 10000, timer = 0, terminal;
  function node(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const element = {
      value: "", disabled: false, textContent: "", listeners: {}, open: true, children: [],
      classList: { contains: () => element.open },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      dispatch(type, event = {}) {
        return this.listeners[type]?.({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
      },
      click() { if (!this.disabled) return this.dispatch("click"); },
      replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return this.children; },
      getBoundingClientRect() { return { width: 900, height: 400 }; },
    };
    nodes.set(selector, element);
    return element;
  }
  node("#terminalKeys").children = [node("#keyUp"), node("#keyEnter")];
  /**
   * 仿真 xterm 的异步解析、销毁与输入事件，检查跨账号旧帧隔离。
   * 参数：构造时接收终端显示配置；实例方法接收输入、写入回调或无参数。
   * 返回值：写入和销毁操作不返回数据。
   * 注意事项：销毁后不解析旧队列，旧输入回调仍可被测试刻意触发。
   */
  class Terminal {
    constructor(options) { terminal = this; this.options = options; this.cols = 100; this.rows = 30; this.output = ""; this.focuses = 0; this.resets = 0; }
    loadAddon() {} open() {} onData(handler) { this.send = handler; }
    reset() { this.output = ""; this.resets += 1; }
    dispose() { this.disposed = true; this.output = ""; }
    write(data, callback) {
      const apply = () => { if (!this.disposed) this.output += data; callback?.(); };
      if (options.asyncParsing) parsed.push(apply); else apply();
    }
    paste(data) { this.send(`\u001b[200~${data}\u001b[201~`); }
    focus() { this.focuses += 1; }
  }
  const context = {
    document: { querySelector: node, createElement: () => node(`option-${Math.random()}`) },
    Terminal, FitAddon: { FitAddon: class { fit() {} } },
    ResizeObserver: class { observe() {} }, addEventListener(type, handler) { globalListeners.set(type, handler); },
    requestAnimationFrame(callback) { const id = ++timer; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setInterval(callback) { const id = ++timer; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timer; timeouts.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console: { info: (text) => logs.push(text), warn: (text) => logs.push(text) },
    Date: { now: () => now },
  };
  vm.runInNewContext(SOURCE, context, { filename: "terminal-ui.js" });
  return { ui: context.ChorusTerminalUI, node, get term() { return terminal; }, intervals, timeouts, frames, logs, resize: () => globalListeners.get("resize")?.(),
    parse: () => { for (const apply of parsed.splice(0)) apply(); }, advance: (ms) => {
    now += ms;
    for (const [id, timeout] of timeouts) if (timeout.at <= now) { timeouts.delete(id); timeout.callback(); }
  } };
}

/**
 * 仿真终端后台及可控订阅，用于观察账号边界的读写和关闭请求。
 * @param {string} id 合成会话编号
 * @param {string} [text] 合成输出
 * @returns {object} 后台 adapter、调用记录与推送入口
 * 注意事项：保留旧订阅回调供竞态测试主动触发，正常退订会停止推送。
 */
function adapter(id, text = "") {
  const calls = { opened: [], written: [], closed: [], resized: [], unsubscribed: 0 };
  let listener;
  return {
    calls,
    async open(options) { calls.opened.push(options); return snapshot(id, text); },
    async read(_id, { after }) { return snapshot(id, text, after); },
    async write(sessionId, data) { calls.written.push({ sessionId, data }); },
    async close(sessionId) { calls.closed.push(sessionId); },
    async resize(sessionId, size) { calls.resized.push({ sessionId, size }); },
    subscribe(callback) { listener = callback; calls.lastListener = callback; return () => { listener = undefined; calls.unsubscribed++; }; },
    emit(event) { listener?.(event); },
  };
}

function config(backends, extra = {}) {
  return { agents: AGENTS, threadKey: "room:test", adapter: (agent) => backends[agent.id], ...extra };
}

test("快速切换 Agent 时，晚返回的 open 不能改写当前终端，并清理放弃的新会话", async () => {
  const h = load(), a = adapter("A", "旧内容"), b = adapter("B", "当前内容"), pending = deferred();
  a.open = () => pending.promise;
  const original = h.ui.open(config({ a, b }));
  await drain();
  await h.node("#terminalAgent").dispatch("change", { target: { value: "b" } });
  pending.resolve(snapshot("A", "旧内容"));
  await original;
  assert.equal(h.term.output, "当前内容");
  assert.deepEqual(a.calls.closed, ["A"]);
  h.term.send("新指令\r"); await drain();
  assert.deepEqual(b.calls.written, [{ sessionId: "B", data: "新指令\r" }]);
});

test("切换 Agent 后，既有复用会话保持运行", async () => {
  const h = load(), a = adapter("A"), b = adapter("B"), pending = deferred();
  a.open = () => pending.promise;
  const original = h.ui.open(config({ a, b }));
  await drain();
  await h.node("#terminalAgent").dispatch("change", { target: { value: "b" } });
  pending.resolve(snapshot("A", "", 0, { reused: true }));
  await original;
  assert.deepEqual(a.calls.closed, []);
  await h.ui.reset();
  assert.deepEqual(a.calls.closed, ["A"]);
  assert.deepEqual(b.calls.closed, ["B"]);
});

test("旧会话的 read、close 和 write 失败不能覆盖新会话状态", async () => {
  const h = load(), a = adapter("A", "A"), b = adapter("B", "B");
  await h.ui.open(config({ a, b }));
  const reading = deferred(), closing = deferred(), writing = deferred();
  a.read = () => reading.promise;
  a.write = () => writing.promise;
  a.close = () => closing.promise;
  h.term.send("old"); await drain();
  const oldRead = [...h.intervals.values()][0]();
  const oldClose = h.node("#terminalCloseSession").click();
  await h.node("#terminalAgent").dispatch("change", { target: { value: "b" } });
  reading.reject(new Error("old read failed"));
  writing.reject(new Error("old write failed"));
  closing.resolve();
  await Promise.all([oldRead, oldClose]); await drain();
  assert.equal(h.term.output, "B");
  assert.match(h.node("#terminalStatus").textContent, /正在运行/);
  assert.equal(h.node("#terminalLine").disabled, false);
});

test("推送与读取响应重叠时，增量输出只追加一次", async () => {
  const h = load(), a = adapter("A", "abc");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  const pending = deferred(); a.read = () => pending.promise;
  const reading = [...h.intervals.values()][0]();
  a.emit({ type: "data", sessionId: "A", data: "def", startOffset: 3, nextOffset: 6 });
  pending.resolve(snapshot("A", "abcdef", 3)); await reading;
  assert.equal(h.term.output, "abcdef");
  a.emit({ type: "data", sessionId: "A", data: "def", startOffset: 3, nextOffset: 6 });
  assert.equal(h.term.output, "abcdef");
});

test("丢失历史滚动缓冲时按 reset 重放，过期 running 响应不能重启已退出会话", async () => {
  const h = load(), a = adapter("A", "abc");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  a.read = async () => ({ ...snapshot("A", "fgh"), startOffset: 5, nextOffset: 8, reset: true });
  await [...h.intervals.values()][0]();
  assert.equal(h.term.output, "fgh");
  const pending = deferred(); a.read = () => pending.promise;
  const reading = [...h.intervals.values()][0]();
  a.emit({ type: "exit", sessionId: "A", status: "exited", exitCode: 2 });
  pending.resolve(snapshot("A", "abcdefgh", 8)); await reading;
  assert.equal(h.node("#terminalLine").disabled, true);
  assert.match(h.node("#terminalStatus").textContent, /退出码 2/);
});

test("隐藏期间启动完成不抢焦点、不关闭 CLI，重新打开保留用户选中的 Agent", async () => {
  const h = load(), a = adapter("A"), b = adapter("B"), pending = deferred();
  b.open = () => pending.promise;
  const opening = h.ui.open(config({ a, b }, { selectedAgentId: "b" }));
  h.node("#terminalOverlay").open = false;
  pending.resolve(snapshot("B")); await opening;
  assert.equal(h.term.focuses, 0);
  assert.deepEqual(b.calls.closed, []);
  h.node("#terminalOverlay").open = true;
  b.open = async (options) => { b.calls.opened.push(options); return snapshot("B", "", 0, { reused: true }); };
  await h.ui.open(config({ a, b }));
  assert.equal(h.node("#terminalAgent").value, "b");
  await h.ui.open(config({ a, b }, { selectedAgentId: "a" }));
  assert.equal(h.node("#terminalAgent").value, "a");
});

test("短暂失联暂停输入，按退避重读恢复现有会话，不重复 open", async () => {
  const h = load(), a = adapter("A", "abc");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  a.read = async () => { throw new Error("offline"); };
  const poll = [...h.intervals.values()][0]; await poll();
  assert.equal(h.node("#terminalLine").disabled, true);
  assert.match(h.node("#terminalStatus").textContent, /重连/);
  a.read = async () => snapshot("A", "abcdef", 3);
  h.advance(5000); await poll();
  assert.equal(h.term.output, "abcdef");
  assert.equal(h.node("#terminalLine").disabled, false);
  assert.equal(a.calls.opened.length, 1);
});

test("过期身份或不存在的会话停止重试，明确提示重新打开", async () => {
  const h = load(), a = adapter("A");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  a.read = async () => { throw new Error("HTTP 401：连接令牌已失效"); };
  await [...h.intervals.values()][0]();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.node("#terminalLine").disabled, true);
  assert.match(h.node("#terminalStatus").textContent, /重新打开/);
});

test("中文输入法 Enter 不提前发送，长粘贴按 Unicode 边界有序分块", async () => {
  const h = load(), a = adapter("A");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  const line = h.node("#terminalLine"); line.value = "你好";
  line.dispatch("keydown", { key: "Enter", isComposing: true });
  line.dispatch("keydown", { key: "Enter", keyCode: 229 }); await drain();
  assert.equal(a.calls.written.length, 0);
  line.dispatch("keydown", { key: "Enter", isComposing: false }); await drain();
  assert.equal(a.calls.written[0].data, "\u001b[200~你好\u001b[201~");
  assert.equal(a.calls.written.length, 1);
  h.advance(150); await drain();
  assert.equal(a.calls.written[1].data, "\r");
  const paste = "a".repeat(15999) + "😀" + "中".repeat(20000);
  h.term.send(paste); await drain();
  const chunks = a.calls.written.slice(2).map((item) => item.data);
  assert.equal(chunks.join(""), paste);
  assert.equal(chunks[0].length, 15999);
  assert.equal(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 65536), true);
});

test("写入失败后不自动重放或继续发送粘贴余块", async () => {
  const h = load(), a = adapter("A");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  let attempts = 0; a.write = async () => { attempts++; throw new Error("offline"); };
  h.term.send("a".repeat(40000)); await drain();
  assert.equal(attempts, 1);
  assert.equal(h.node("#terminalLine").disabled, true);
  assert.match(h.node("#terminalStatus").textContent, /检查终端/);
});

test("同一 Agent 切换另一 Mac 后，旧连接的晚返回 open 不得混入新终端", async () => {
  const h = load(), a = adapter("MacA"), b = adapter("MacB", "来自 MacB"), pending = deferred();
  a.open = () => pending.promise;
  const original = h.ui.open(config({ a }, { agents: [AGENTS[0]], connectionKey: "MacA" })); await drain();
  await h.ui.open(config({ a: b }, { agents: [AGENTS[0]], connectionKey: "MacB" }));
  pending.resolve(snapshot("MacA", "来自 MacA")); await original;
  assert.equal(h.term.output, "来自 MacB");
  assert.deepEqual(a.calls.closed, ["MacA"]);
});

test("xterm 旧帧异步解析完之后再 reset，不会把旧内容画进新终端", async () => {
  const h = load({ asyncParsing: true }), a = adapter("A", "旧帧"), b = adapter("B", "新帧");
  const opening = h.ui.open(config({ a, b }));
  h.parse(); await opening;
  const switching = h.node("#terminalAgent").dispatch("change", { target: { value: "b" } });
  h.parse(); await switching;
  h.parse();
  assert.equal(h.term.output, "新帧");
});

test("发送 Line 后切换、关闭或 Ctrl+C 都不会把延迟回车送到错的会话", async () => {
  for (const action of ["switch", "close", "ctrlc"]) {
    const h = load(), a = adapter("A"), b = adapter("B");
    await h.ui.open(config({ a, b }));
    h.node("#terminalLine").value = "synthetic command";
    const sending = h.node("#terminalSendLine").click(); await drain();
    if (action === "switch") await h.node("#terminalAgent").dispatch("change", { target: { value: "b" } });
    if (action === "close") await h.node("#terminalCloseSession").click();
    if (action === "ctrlc") { h.term.send("\x03"); await drain(); }
    h.advance(150); await sending;
    assert.equal(a.calls.written.some((item) => item.data === "\r"), false, action);
    assert.equal(b.calls.written.length, 0, action);
  }
});

test("Line 粘贴写入失败不会补回车，并保留内容供用户核对", async () => {
  const h = load(), a = adapter("A");
  await h.ui.open(config({ a }, { agents: [AGENTS[0]] }));
  let calls = 0; a.write = async () => { calls++; throw new Error("offline"); };
  h.node("#terminalLine").value = "synthetic command";
  await h.node("#terminalSendLine").click();
  h.advance(1000); await drain();
  assert.equal(calls, 1);
  assert.equal(h.node("#terminalLine").value, "synthetic command");
});

test("账号重置同步清空所有旧视图和订阅，关闭失败也不保留终端内容", async () => {
  const h = load(), a = adapter("A", "旧账号输出"), b = adapter("B", "旧账号另一输出");
  await h.ui.open(config({ a, b }));
  await h.node("#terminalAgent").dispatch("change", { target: { value: "b" } });
  const oldTerm = h.term;
  h.node("#terminalLine").value = "尚未发送的旧命令";
  b.close = async (id) => { b.calls.closed.push(id); throw new Error("SYNTHETIC_PRIVATE_TERMINAL_OUTPUT"); };
  const resetting = h.ui.reset();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.node("#terminalAgent").children.length, 0);
  assert.equal(h.node("#terminalAgent").value, "");
  assert.equal(h.node("#terminalStatus").textContent, "");
  assert.equal(h.node("#terminalLine").value, "");
  assert.equal(h.node("#terminalLine").disabled, true);
  assert.equal(oldTerm.disposed, true);
  assert.equal(oldTerm.output, "");
  await resetting;
  assert.deepEqual(a.calls.closed, ["A"]);
  assert.deepEqual(b.calls.closed, ["B"]);
  assert.equal(a.calls.unsubscribed, 1);
  assert.equal(b.calls.unsubscribed, 1);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.logs.join("\n").includes("SYNTHETIC_PRIVATE_TERMINAL_OUTPUT"), false);
  a.calls.lastListener({ type: "data", sessionId: "A", data: "晚到旧帧", startOffset: 0, nextOffset: 99 });
  assert.equal(oldTerm.output, "");
});

test("重置后晚到的复用 open 使用旧 adapter 关闭，相同键等待它结束", async () => {
  const h = load(), old = adapter("Old"), fresh = adapter("Fresh", "新账号内容"), pending = deferred();
  old.open = () => pending.promise;
  const opening = h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  await drain();
  await h.ui.reset();
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  assert.equal(fresh.calls.opened.length, 0);
  assert.match(h.node("#terminalStatus").textContent, /旧账号终端尚在关闭/);
  pending.resolve(snapshot("Old", "不得显示的旧账号内容", 0, { reused: true }));
  await opening;
  assert.deepEqual(old.calls.closed, ["Old"]);
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  assert.equal(h.term.output, "新账号内容");
  assert.equal(fresh.calls.opened.length, 1);
  assert.deepEqual(fresh.calls.closed, []);
});

test("旧 open 在新账号其他成员打开后返回，不关闭或污染新会话", async () => {
  const h = load(), old = adapter("Old"), fresh = adapter("Fresh", "新账号输出"), pending = deferred();
  old.open = () => pending.promise;
  const opening = h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  await drain(); await h.ui.reset();
  await h.ui.open(config({ b: fresh }, { agents: [AGENTS[1]] }));
  pending.resolve(snapshot("Old", "旧输出", 0, { reused: true })); await opening;
  assert.equal(h.term.output, "新账号输出");
  assert.deepEqual(old.calls.closed, ["Old"]);
  assert.deepEqual(fresh.calls.closed, []);
  assert.equal(h.node("#terminalAgent").value, "b");
  assert.equal(h.node("#terminalLine").disabled, false);
});

test("销毁旧 xterm 隔离异步解析队列和晚到输入，重开不重复绑定事件", async () => {
  const h = load({ asyncParsing: true }), old = adapter("Old", "旧帧"), fresh = adapter("Fresh", "新帧");
  const opening = h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  h.parse(); await opening;
  const oldTerm = h.term;
  const previousChange = h.node("#terminalAgent").listeners.change;
  await h.ui.reset();
  const next = h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  h.parse(); await next; h.parse();
  assert.notEqual(h.term, oldTerm);
  assert.equal(oldTerm.disposed, true);
  assert.equal(h.term.output, "新帧");
  assert.equal(h.node("#terminalAgent").listeners.change, previousChange);
  oldTerm.send("旧输入"); await drain();
  assert.deepEqual(fresh.calls.written, []);
  h.term.send("新输入"); await drain();
  assert.deepEqual(fresh.calls.written, [{ sessionId: "Fresh", data: "新输入" }]);
});

test("重置会结束仍等待旧解析器的 open，不再启动旧后台", async () => {
  const h = load({ asyncParsing: true }), old = adapter("Old");
  const opening = h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  await h.ui.reset(); await opening;
  assert.equal(old.calls.opened.length, 0);
  assert.equal(h.intervals.size, 0);
  h.parse();
  assert.equal(h.node("#terminalAgent").value, "");
  assert.equal(h.node("#terminalStatus").textContent, "");
});

test("旧会话关闭挂起最多等待三秒，不会晚到清空新账号视图", async () => {
  const h = load(), old = adapter("Old", "旧输出"), fresh = adapter("Fresh", "新输出"), closing = deferred();
  await h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  old.close = (id) => { old.calls.closed.push(id); return closing.promise; };
  let resetDone = false;
  const resetting = h.ui.reset().then(() => { resetDone = true; });
  const opening = h.ui.open(config({ b: fresh }, { agents: [AGENTS[1]] }));
  await drain(); h.advance(2999); await drain();
  assert.equal(resetDone, false);
  assert.equal(fresh.calls.opened.length, 0);
  h.advance(1); await resetting; await opening;
  assert.equal(h.term.output, "新输出");
  closing.resolve(); await drain();
  assert.equal(h.term.output, "新输出");
  assert.equal(h.node("#terminalAgent").value, "b");
  assert.equal(h.node("#terminalLine").disabled, false);
  assert.deepEqual(fresh.calls.closed, []);
});

test("三秒后相同键的旧 close 仍挂起时阻止复用，失败后的旧编号也不重放", async () => {
  const h = load(), old = adapter("Old", "旧输出"), fresh = adapter("Fresh", "新输出"), closing = deferred();
  await h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  old.close = () => closing.promise;
  const resetting = h.ui.reset(); await drain(); h.advance(3000); await resetting;
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  assert.equal(fresh.calls.opened.length, 0);
  closing.reject(new Error("offline")); await drain();
  fresh.open = async () => snapshot("Old", "不得重放的旧输出", 0, { reused: true });
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  assert.equal(h.term.output, "");
  assert.match(h.node("#terminalStatus").textContent, /前一账号的终端尚未关闭/);
  assert.equal(h.node("#terminalLine").disabled, true);
  fresh.open = async () => snapshot("Fresh", "新输出");
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  assert.equal(h.term.output, "新输出");
});

test("旧账号未完成的读取、粘贴和延迟回车不能影响新账号", async () => {
  const h = load(), old = adapter("Old", "旧输出"), fresh = adapter("Fresh", "新输出"), reading = deferred(), writing = deferred();
  await h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  old.read = () => reading.promise;
  const oldRead = [...h.intervals.values()][0]();
  old.write = (sessionId, data) => { old.calls.written.push({ sessionId, data }); return writing.promise; };
  h.node("#terminalLine").value = "a".repeat(40000);
  const sending = h.node("#terminalSendLine").click(); await drain();
  await h.ui.reset();
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  reading.resolve(snapshot("Old", "晚到旧输出")); writing.resolve();
  await oldRead; h.advance(150); await sending; await drain();
  assert.equal(h.term.output, "新输出");
  assert.equal(h.node("#terminalLine").value, "");
  assert.equal(old.calls.written.length, 1);
  assert.equal(old.calls.written.some((item) => item.data === "\r"), false);
  assert.deepEqual(fresh.calls.written, []);
});

test("重复账号重置不能使已失效的open覆盖新账号", async () => {
  const h = load(), old = adapter("Old"), abandoned = adapter("Abandoned"), fresh = adapter("Fresh", "新输出"), closing = deferred();
  await h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  old.close = () => closing.promise;
  const first = h.ui.reset();
  const staleOpen = h.ui.open(config({ b: abandoned }, { agents: [AGENTS[1]] }));
  const second = h.ui.reset();
  await drain(); h.advance(3000); await Promise.all([first, second, staleOpen]);
  assert.equal(abandoned.calls.opened.length, 0);
  await h.ui.open(config({ b: fresh }, { agents: [AGENTS[1]] }));
  closing.resolve(); await drain();
  assert.equal(h.term.output, "新输出");
  assert.equal(h.node("#terminalStatus").textContent.includes("正在运行"), true);
});

test("账号重置前排队的resize帧不调整新会话，也不清掉新帧调度", async () => {
  const h = load(), old = adapter("Old"), fresh = adapter("Fresh");
  await h.ui.open(config({ a: old }, { agents: [AGENTS[0]] }));
  h.resize();
  const previousFrame = [...h.frames.values()][0];
  await h.ui.reset();
  assert.equal(h.frames.size, 0);
  await h.ui.open(config({ a: fresh }, { agents: [AGENTS[0]] }));
  const initialResizes = fresh.calls.resized.length;
  h.term.cols = 120;
  h.resize();
  previousFrame(); await drain();
  assert.equal(fresh.calls.resized.length, initialResizes);
  h.resize();
  assert.equal(h.frames.size, 1);
  const [id, currentFrame] = [...h.frames][0];
  h.frames.delete(id); currentFrame(); await drain();
  assert.equal(fresh.calls.resized.length, initialResizes + 1);
  assert.equal(fresh.calls.resized.at(-1).size.cols, 120);
  assert.deepEqual(fresh.calls.closed, []);
});
