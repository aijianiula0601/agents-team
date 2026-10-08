const { spawn } = require("child_process");
const os = require("os");
const log = require("./log");
const { buildChildEnv, resolveHarnessExecutable, validateHarnessModel } = require("./harness");

const MODEL_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const pending = new Map();

/**
 * 从已安装 CLI 获取真实模型目录，合并同一内核并发查询。
 * @param {"codex"|"claude"|"cursor"} harness 执行内核
 * @param {object} configuredPaths 本机 CLI 路径设置
 * @param {{timeoutMs?: number}} options 测试可覆盖超时
 * @returns {Promise<{models: object[], source: string, error?: string}>} 可用目录或可操作错误
 * 注意事项：只做目录发现，不发送用户提示，不执行模型推理；不硬编码模型清单。
 */
async function listHarnessModels(harness, configuredPaths = {}, options = {}) {
  let executable;
  try { executable = resolveHarnessExecutable(harness, configuredPaths); }
  catch (error) { return { models: [], source: "", error: error.message }; }
  const key = `${harness}:${executable}`;
  if (pending.has(key)) return pending.get(key);
  const request = discoverModels(harness, executable, options).then((models) => {
    if (!models.length) throw new Error("内核没有返回可选模型，请在对应 CLI 登录后刷新");
    log.info(`------------- 内核模型目录就绪 harness=${harness} count=${models.length} --------------`);
    return { models, source: harness === "codex" ? "codex-app-server" : harness === "cursor" ? "cursor-list-models" : "claude-sdk-initialize" };
  }).catch((error) => {
    log.error(`读取内核模型目录失败 harness=${harness}`, error);
    return { models: [], source: "", error: error.message };
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/**
 * 启动只读目录查询并处理 CLI 的文本或 JSONL 协议。
 * @param {string} harness 执行内核
 * @param {string} executable 本机已校验可执行路径
 * @param {{timeoutMs?: number}} options 查询时限
 * @returns {Promise<object[]>} 规范模型列表
 * 注意事项：Codex 使用 initialize → model/list 分页；Claude 只发送 SDK initialize；进程最终强制回收。
 */
function discoverModels(harness, executable, options) {
  const args = harness === "codex" ? ["app-server"] : harness === "cursor" ? ["--list-models"] : ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}'];
  log.info(`------------- 读取内核模型目录 harness=${harness} --------------`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: os.tmpdir(), env: buildChildEnv(executable), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let settled = false;
    let output = "";
    let buffered = "";
    let outputBytes = 0;
    let requestId = 1;
    let killTimer;
    const catalog = [];
    const cursors = new Set();
    const timer = setTimeout(() => finish(new Error("读取模型列表超时，请确认 CLI 已登录且网络正常后重试")), options.timeoutMs || MODEL_TIMEOUT_MS);
    timer.unref?.();

    /** 发送单条目录协议；参数为消息对象；无返回值；不含用户任务或凭据。 */
    function send(message) { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); }

    /** 结束查询并回收进程树；参数为错误或目录；无返回值；只允许完成一次。 */
    function finish(error, models) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        terminateDiscovery(child, "SIGTERM");
        killTimer = setTimeout(() => terminateDiscovery(child, "SIGKILL"), 1000);
        killTimer.unref?.();
      }
      if (error) reject(error);
      else resolve(normalizeModels(models));
    }

    /** 处理一条 CLI JSONL 响应；参数为协议对象；无返回值；忽略无关通知，校验分页上限。 */
    function receive(message) {
      if (harness === "claude") {
        if (message.type !== "control_response" || message.response?.request_id !== "chorus-models") return;
        if (message.response.subtype !== "success") return finish(new Error("Claude Code 无法读取模型目录，请检查登录和 CLI 版本"));
        return finish(null, message.response.response?.models);
      }
      if (message.id !== requestId) return;
      if (message.error) return finish(new Error("Codex 无法读取模型目录，请检查登录和 CLI 版本"));
      if (requestId === 1) {
        send({ method: "initialized", params: {} });
        requestId += 1;
        send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false } });
        return;
      }
      if (!Array.isArray(message.result?.data)) return finish(new Error("Codex 返回的模型目录格式无效"));
      catalog.push(...message.result.data);
      const cursor = message.result.nextCursor;
      if (!cursor) return finish(null, catalog);
      if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 20) return finish(new Error("Codex 模型目录分页无效"));
      cursors.add(cursor);
      requestId += 1;
      send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false, cursor } });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES) return finish(new Error("CLI 模型目录输出过大"));
      if (harness === "cursor") { output += chunk; return; }
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop();
      for (const line of lines) {
        if (settled) break;
        try { receive(JSON.parse(line)); } catch (_error) { /* 启动横幅不是协议消息。 */ }
      }
    });
    // 错误输出可能包含账户信息，仅记录状态，不把原始内容传给页面或日志。
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => { if (!settled) finish(new Error(`模型目录通信失败：${error.code || "stdin"}`)); });
    child.on("error", (error) => finish(new Error(`无法启动模型目录查询：${error.code || "spawn"}`)));
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (settled) return;
      if (harness === "cursor" && code === 0) return finish(null, parseCursorModels(output));
      finish(new Error(`CLI 未返回模型目录（退出码 ${code ?? "未知"}），请检查登录和 CLI 版本`));
    });
    if (harness === "codex") send({ id: requestId, method: "initialize", params: { clientInfo: { name: "chorus", title: "Chorus", version: "1.0.0" } } });
    else if (harness === "claude") send({ type: "control_request", request_id: "chorus-models", request: { subtype: "initialize" } });
    else child.stdin.end();
  });
}

/**
 * 解析 Cursor 官方 --list-models 输出，兼容文本与 JSON 列表。
 * @param {string} output CLI 标准输出
 * @returns {object[]} 原始模型项
 * 注意事项：只接受明确的 id - 名称行，不将标题、提示或 ANSI 颜色当作模型。
 */
function parseCursorModels(output) {
  const clean = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  try {
    const data = JSON.parse(clean);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.models)) return data.models;
  } catch (_error) { /* 官方 CLI 常规输出为文本列表。 */ }
  return clean.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([A-Za-z0-9][^\s]*)\s+-\s+(.+)$/);
    return match ? [{ id: match[1], label: match[2].replace(/\s+\((?:current|default)(?:,\s*(?:current|default))*\)$/i, "") }] : [];
  });
}

/**
 * 将不同 CLI 的目录合并为页面只读列表。
 * @param {object[]} entries CLI 原始模型项
 * @returns {{id: string, label: string, description?: string}[]} 去重模型目录
 * 注意事项：剔除隐藏项和不合法编号；目录表示 CLI 可选项，不代表额度或推理调用一定成功。
 */
function normalizeModels(entries) {
  const models = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item || item.hidden === true) continue;
    let id;
    try { id = validateHarnessModel(item.model || item.id || item.value || item.slug); } catch (_error) { continue; }
    if (!id) continue;
    const name = item.label || item.displayName || item.display_name || id;
    const label = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : id;
    models.set(id, { id, label, ...(typeof item.description === "string" ? { description: item.description.slice(0, 500) } : {}) });
  }
  return [...models.values()];
}

/** 终止本次目录查询进程树；参数为子进程和信号；无返回值；进程已退出时忽略。 */
function terminateDiscovery(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (_error) { try { child.kill(signal); } catch (_ignored) { /* 进程可能已结束。 */ } }
}

module.exports = { listHarnessModels, normalizeModels, parseCursorModels };
