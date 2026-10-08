const assert = require("node:assert/strict");
const test = require("node:test");
const { RunRegistry } = require("./run-registry");

test("停止仅影响对应任务，而且取消后的晚到结果不能返回成功", async () => {
  const runs = new RunRegistry();
  let release;
  let signal;
  const pending = runs.run("run-1", async (value) => {
    signal = value;
    await new Promise((resolve) => { release = resolve; });
    return "late-result";
  });
  assert.deepEqual(runs.cancel("not-running"), { cancelled: false });
  assert.deepEqual(runs.cancel("run-1"), { cancelled: true });
  assert.equal(signal.aborted, true);
  release();
  await assert.rejects(pending, /任务已停止/);
  assert.deepEqual(runs.cancel("run-1"), { cancelled: false });
  assert.equal(await runs.run("run-1", async () => "retry"), "retry");
});

test("重复任务编号被拒绝，退出应用可取消全部任务", async () => {
  const runs = new RunRegistry();
  const waitForAbort = (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  const first = runs.run("same", waitForAbort);
  const unnamed = runs.run(undefined, waitForAbort);
  await assert.rejects(runs.run("same", async () => "duplicate"), /正在运行/);
  runs.cancelAll();
  await Promise.all([assert.rejects(first, /任务已停止/), assert.rejects(unnamed, /任务已停止/)]);
});

test("取消和执行都校验任务编号", async () => {
  const runs = new RunRegistry();
  assert.throws(() => runs.cancel({ id: "invalid" }), /编号格式/);
  await assert.rejects(runs.run("x".repeat(129), async () => "invalid"), /编号格式/);
});
