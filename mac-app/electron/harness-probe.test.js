const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { probeHarnessAsync } = require("./harness-probe");

test("真实独立线程检测 CLI 时主进程仍持续处理定时器，并发检测合并", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-probe-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = { codex: path.join(directory, "codex"), claude: path.join(directory, "claude"), cursor: path.join(directory, "cursor-agent") };
  for (const target of Object.values(paths)) fs.writeFileSync(target, '#!/bin/sh\nsleep 0.12\ncase "$1" in status) echo \'{"authenticated":true}\';; login) echo "Logged in";; *) echo "1.0.0";; esac\n', { mode: 0o755 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  t.after(() => clearInterval(timer));
  const first = probeHarnessAsync(paths);
  const second = probeHarnessAsync(paths);
  assert.equal(first, second);
  const result = await first;
  assert.ok(ticks > 20, `主事件循环仅运行 ${ticks} 次`);
  assert.equal(result.codex.available, true);
  assert.equal(result.cursor.authenticated, true);
});

test("检测线程超时、创建失败均返回状态，不误报已保存路径失败", async (t) => {
  const liveTimer = setInterval(() => {}, 100);
  t.after(() => clearInterval(liveTimer));
  let stopped = 0;
  /** 模拟不会自行返回的检测线程；参数忽略；仅统计回收次数，不启动外部程序。 */
  class SilentWorker extends EventEmitter {
    /** 回收测试线程；无参数；返回已完成 Promise；不触发真实进程操作。 */
    async terminate() { stopped += 1; }
  }
  const result = await probeHarnessAsync({ codex: "/test/codex" }, { WorkerClass: SilentWorker, timeoutMs: 10 });
  assert.match(result.codex.error, /超时/);
  assert.equal(result.codex.path, "/test/codex");
  assert.equal(stopped, 1);
  /** 模拟资源不足的线程构造；参数忽略；直接抛错；用于验证保存后的检测不会抛业务失败。 */
  class BrokenWorker { constructor() { throw new Error("test failure"); } }
  const failed = await probeHarnessAsync({ cursor: "/test/cursor-agent" }, { WorkerClass: BrokenWorker });
  assert.match(failed.cursor.error, /无法启动/);
});
