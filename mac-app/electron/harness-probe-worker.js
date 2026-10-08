const { parentPort, workerData } = require("worker_threads");
const { probeHarness } = require("./harness");

// ------------ 隔离可能等待 CLI 的同步检测，保持主进程流式消息和心跳继续运行 ---------------
try { parentPort.postMessage({ result: probeHarness(workerData) }); }
catch (_) { parentPort.postMessage({ error: "内核检测失败，请检查主电脑路径" }); }
