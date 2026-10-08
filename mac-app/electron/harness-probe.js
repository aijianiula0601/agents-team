const path = require("path");
const { Worker } = require("worker_threads");
const log = require("./log");

const pending = new Map();

/**
 * 在独立线程复用内核检测，避免阻塞主进程的流式输出和配置续期。
 * @param {object} paths 主电脑已保存的内核路径
 * @param {object} options 测试可注入 Worker 实现和超时
 * @returns {Promise<object>} 三种内核的安装、登录状态或明确检测错误
 * 注意事项：相同路径合并并发查询；不会触发登录授权，最长 35 秒回收检测线程。
 */
function probeHarnessAsync(paths, { WorkerClass = Worker, timeoutMs = 35000 } = {}) {
  const key = JSON.stringify(paths);
  if (pending.has(key)) return pending.get(key);
  const operation = new Promise((resolve) => {
    let finished = false;
    let worker, timer;
    /** 只完成一次检测；参数为结果或安全错误；无返回值；异常也返回状态，不能把已保存路径误报为未保存。 */
    function finish(result, error = "") {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker?.terminate().catch(() => {});
      if (error) log.info("主电脑异步内核检测未完成");
      resolve(result || Object.fromEntries(["codex", "claude", "cursor"].map((name) => [name, { available: false, path: paths[name] || "", version: "", authenticated: null, error }])));
    }
    try { worker = new WorkerClass(path.join(__dirname, "harness-probe-worker.js"), { workerData: paths }); }
    catch (_) { finish(null, "无法启动内核检测，请重试"); return; }
    timer = setTimeout(() => finish(null, "内核检测超时，请检查主电脑 CLI"), timeoutMs);
    timer.unref?.();
    worker.once("message", (message) => finish(message.result, message.error));
    worker.once("error", () => finish(null, "无法启动内核检测，请重试"));
    worker.once("exit", () => finish(null, "内核检测已退出，请重试"));
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

module.exports = { probeHarnessAsync };
