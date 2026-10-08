const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./log");
const { HarnessSessions, harnessSessionKey, normalizeSessionId } = require("./harness-sessions");
const { expandHome, validateWorkspace } = require("./workspace-paths");
const { resolveAgentWorkspace } = require("./agent-workspaces");

const BINARY_NAMES = {
  codex: ["codex"],
  claude: ["claude"],
  cursor: ["cursor-agent", "agent"],
};
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_STDOUT_LENGTH = 40000;
const MAX_STDERR_LENGTH = 12000;
const MAX_RESULT_LENGTH = 5 * 1024 * 1024;
const LOGIN_ARGS = {
  codex: ["login"],
  cursor: ["login"],
};
const activeWorkspaces = new Map();
const memorySessions = new HarnessSessions();
let activeLogin = null;

/**
 * 判断路径文件名是否属于指定 Harness，避免把 Cursor 编辑器本体当成 agent。
 * @param {"codex"|"claude"|"cursor"} harness 内核类型
 * @param {string} filePath 待检查路径
 * @returns {boolean} 文件名匹配时返回 true
 */
function matchesBinaryName(harness, filePath) {
  const base = path.basename(filePath).toLowerCase();
  return BINARY_NAMES[harness].some((name) => base === name || base.startsWith(`${name}-`));
}

/**
 * 校验用户配置的 CLI 路径，并解析符号链接到真实的普通可执行文件。
 * @param {string} input 可执行文件路径，空值表示自动探测
 * @param {string} label UI 名称
 * @param {"codex"|"claude"|"cursor"} [harness] 传入时校验文件名
 * @returns {string} 规范化后的绝对路径
 * 注意事项：空字符串表示继续自动探测，不会当成错误。
 */
function validateExecutablePath(input, label, harness) {
  const expanded = expandHome(input);
  if (!expanded) return "";
  if (!path.isAbsolute(expanded)) throw new Error(`${label} 可执行路径必须是绝对路径`);
  let resolved;
  try {
    resolved = fs.realpathSync(expanded);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error("not-file");
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch (_error) {
    throw new Error(`${label} 可执行路径不存在或不可执行：${expanded}`);
  }
  if (harness && !matchesBinaryName(harness, expanded) && !matchesBinaryName(harness, resolved)) {
    throw new Error(`${label} 路径必须指向 ${BINARY_NAMES[harness].join(" 或 ")}`);
  }
  return resolved;
}

/**
 * 严格校验三种 Harness 的自定义路径。
 * @param {object} paths 用户设置
 * @returns {{codex: string, claude: string, cursor: string}}
 */
function validateHarnessPaths(paths) {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new Error("Harness 设置格式无效");
  }
  return {
    codex: validateExecutablePath(paths.codex, "Codex", "codex"),
    claude: validateExecutablePath(paths.claude, "Claude Code", "claude"),
    cursor: validateExecutablePath(paths.cursor, "Cursor", "cursor"),
  };
}

/**
 * 探测本机已安装的编程 Harness，并返回真实路径和登录状态。
 * @param {{codex?: string, claude?: string, cursor?: string}} [configuredPaths] 自定义 CLI 路径
 * @returns {{codex: object, claude: object, cursor: object}}
 */
function probeHarness(configuredPaths = {}) {
  return {
    codex: probeOne("codex", configuredPaths.codex),
    claude: probeOne("claude", configuredPaths.claude),
    cursor: probeOne("cursor", configuredPaths.cursor),
  };
}

/** 只解析指定内核，供编码任务和交互终端复用，不触发其他 CLI 的登录探测。 */
function resolveHarnessExecutable(harness, configuredPaths = {}) {
  if (!Object.hasOwn(BINARY_NAMES, harness)) throw new Error("未知的 Harness");
  const bin = configuredPaths[harness]
    ? validateExecutablePath(configuredPaths[harness], harnessLabel(harness), harness)
    : findBinary(BINARY_NAMES[harness]);
  if (!bin) throw new Error(`本机没有找到 ${BINARY_NAMES[harness][0]}，请先安装并登录，或在设置中指定路径`);
  return bin;
}

function probeOne(harness, configuredPath) {
  let bin = "";
  let configurationError = "";
  try {
    bin = configuredPath
      ? validateExecutablePath(configuredPath, harnessLabel(harness), harness)
      : findBinary(BINARY_NAMES[harness]);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : "可执行路径无效";
  }
  if (!bin) {
    return {
      available: false,
      path: "",
      version: "",
      authenticated: harness === "claude" ? null : false,
      error: configurationError,
    };
  }
  return {
    available: true,
    path: bin,
    version: readVersion(bin),
    authenticated: harness === "codex" ? codexIsAuthenticated(bin) : harness === "cursor" ? cursorIsAuthenticated(bin) : null,
    error: "",
  };
}

/**
 * 按当前 PATH、常见版本管理器目录、最后登录 shell 的顺序查找固定命令名。
 * @param {string[]} names 受信任的命令名列表
 * @returns {string} 可执行文件真实路径
 */
function findBinary(names) {
  const dirs = candidateBinDirectories();
  for (const name of names) {
    for (const dir of dirs) {
      const found = executableFile(path.join(dir, name));
      if (found) return found;
    }
  }
  for (const name of names) {
    const found = findViaLoginShell(name);
    if (found) return found;
  }
  return "";
}

function candidateBinDirectories() {
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".cursor", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  dirs.push(...versionedBinDirectories(path.join(home, ".nvm", "versions", "node"), "bin"));
  dirs.push(...versionedBinDirectories(path.join(home, ".workbuddy", "binaries", "node", "versions"), "bin"));
  dirs.push(...versionedBinDirectories(path.join(home, ".fnm", "node-versions"), path.join("installation", "bin")));
  return [...new Set(dirs.filter(Boolean))];
}

function versionedBinDirectories(root, suffix) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, suffix))
      .reverse();
  } catch (_error) {
    return [];
  }
}

function executableFile(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isFile()) return "";
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch (_error) {
    return "";
  }
}

function findViaLoginShell(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return "";
  const shell = executableFile(process.env.SHELL || "") || executableFile("/bin/zsh");
  if (!shell) return "";
  const result = spawnSync(shell, ["-lic", `command -v -- ${name}`], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 16 * 1024,
    env: process.env,
  });
  if (result.status !== 0) return "";
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line));
  for (const line of lines.reverse()) {
    const found = executableFile(line);
    if (found) return found;
  }
  return "";
}

function readVersion(bin) {
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 32 * 1024,
    env: buildChildEnv(bin),
  });
  const line = `${result.stdout || ""}\n${result.stderr || ""}`
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return String(line || "").slice(0, 200);
}

function codexIsAuthenticated(bin) {
  const result = spawnSync(bin, ["login", "status"], {
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 32 * 1024,
    env: buildChildEnv(bin),
  });
  return result.status === 0 && /logged in/i.test(`${result.stdout || ""}\n${result.stderr || ""}`);
}

/**
 * 读取 Cursor CLI 的登录状态。
 * @param {string} bin agent 或 cursor-agent 的绝对路径
 * @returns {boolean} 已登录返回 true
 * 注意事项：status 命令失败或输出无法识别时按未登录处理，避免把未连上的内核显示成可用。
 */
function cursorIsAuthenticated(bin) {
  const result = spawnSync(bin, ["status", "--format", "json"], {
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 64 * 1024,
    env: buildChildEnv(bin),
  });
  const stdout = String(result.stdout || "").trim();
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.authenticated === "boolean") return parsed.authenticated;
    if (typeof parsed.isAuthenticated === "boolean") return parsed.isAuthenticated;
    if (parsed.email || parsed.user || parsed.account) return result.status === 0;
  } catch (_error) {
    // 老版本可能只输出纯文本。
  }
  const text = `${stdout}\n${result.stderr || ""}`;
  if (/not (logged in|authenticated)|login required|please (log|sign) in/i.test(text)) return false;
  return result.status === 0 && /logged in|authenticated|@/i.test(text);
}

/**
 * 组装非交互命令。Codex 的 --approve-for-me 已自带 workspace-write，不能再与 -s 同传。
 * Cursor 必须带 --trust，否则无界面时会停在信任工作区的提示上。
 * @param {"codex"|"claude"|"cursor"} harness 内核类型
 * @param {string} bin 可执行文件绝对路径
 * @param {string} prompt 任务说明
 * @param {string} cwd 工作目录
 * @param {{outputFile?: string, interaction?: string, sessionId?: string, harnessModel?: string}} [extras] 原生会话、模型与输出配置
 * @returns {{cmd: string, args: string[], cwd: string, stdin: string, outputFile: string}}
 */
function buildCommand(harness, bin, prompt, cwd, extras = {}) {
  const ask = extras.interaction === "ask";
  const model = validateHarnessModel(extras.harnessModel);
  const sessionId = extras.sessionId ? normalizeSessionId(extras.sessionId) : "";
  if (harness === "codex") {
    const args = ["exec", "--skip-git-repo-check", "--color", "never", "--json"];
    if (model) args.push("--model", model);
    if (ask) args.push("-s", "read-only");
    else args.push("--approve-for-me");
    args.push("-C", cwd);
    if (extras.outputFile) args.push("--output-last-message", extras.outputFile);
    if (sessionId) args.push("resume", sessionId);
    args.push("-");
    return { cmd: bin, args, cwd, stdin: prompt, outputFile: extras.outputFile || "" };
  }
  if (harness === "claude") {
    const args = ["-p", "--permission-mode", ask ? "plan" : "acceptEdits", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    return {
      cmd: bin,
      args,
      cwd,
      stdin: prompt,
      outputFile: "",
    };
  }
  const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"];
  if (model) args.push("--model", model);
  if (ask) args.push("--mode", "ask");
  else args.push("--force", "--sandbox", "enabled");
  args.push("--workspace", cwd);
  if (sessionId) args.push("--resume", sessionId);
  // 讨论历史及附件可能大于系统 argv 上限，所有 CLI 从 stdin 完整读取。
  return { cmd: bin, args, cwd, stdin: prompt, outputFile: "" };
}

/**
 * 校验 CLI 模型标识，空值沿用内核默认模型。
 * @param {string|undefined} value 页面选择的模型编号
 * @returns {string} 已校验模型编号
 * 注意事项：参数独立传入 spawn，不拼接 shell；保留提供商模型路径与参数化模型语法。
 */
function validateHarnessModel(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 300 || /[\u0000-\u0020\u007f]/.test(value) || value.startsWith("-")) throw new Error("执行模型编号无效");
  return value;
}

/**
 * 在指定工作区运行 Codex / Claude Code / Cursor Agent。
 * @param {{harness: string, prompt: string, cwd?: string, workspaceMode?: string, agentName?: string, harnessModel?: string, interaction?: string, threadKey?: string, conversationId?: string, agentId?: string}} options 执行参数
 * @param {{codex?: string, claude?: string, cursor?: string}} [configuredPaths] 自定义 CLI 路径
 * @param {{signal?: AbortSignal, onText?: (text: string) => void, sessions?: HarnessSessions, workspaceRoot?: string, workspaceAgents?: object[]}} [context] 取消信号、累计回复回调、会话索引与执行电脑成员列表
 * @returns {Promise<{ok: boolean, text: string, sessionId?: string, resumed?: boolean}>} 执行结果
 * 注意事项：任务没有默认时间上限；onText 为当前完整可见文本，结束时以返回结果为准，回调异常不影响执行。
 */
function runHarness(options, configuredPaths = {}, context = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return Promise.reject(new Error("Harness 请求格式无效"));
  }
  const harness = String(options.harness || "");
  if (!Object.hasOwn(BINARY_NAMES, harness)) return Promise.reject(new Error("未知的 Harness"));
  if (context.signal?.aborted) return Promise.reject(new Error("任务已停止"));
  if (options.interaction !== undefined && options.interaction !== "ask" && options.interaction !== "agent") {
    return Promise.reject(new Error("Harness 交互模式无效"));
  }

  let bin;
  try {
    bin = resolveHarnessExecutable(harness, configuredPaths);
  } catch (error) {
    return Promise.reject(error);
  }
  let cwd;
  let sessionKey;
  let sessionId;
  let harnessModel;
  const sessions = context.sessions || memorySessions;
  try {
    harnessModel = validateHarnessModel(options.harnessModel);
    cwd = resolveAgentWorkspace({ id: options.agentId || "default", name: options.agentName || options.agentId || "Agent", workspace: options.cwd || "", workspaceMode: options.workspaceMode }, { root: context.workspaceRoot, agents: context.workspaceAgents });
    sessionKey = harnessSessionKey(options, harness, cwd);
    sessionId = sessionKey ? sessions.get(sessionKey) : "";
    if (sessionId) normalizeSessionId(sessionId);
  } catch (error) {
    return Promise.reject(error);
  }
  const prompt = typeof options.prompt === "string" ? options.prompt.trim() : "";
  if (!prompt) return Promise.reject(new Error("任务内容为空"));
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    return Promise.reject(new Error("任务内容和附件合计不能超过 1 MB，请缩短历史或附件"));
  }
  const interaction = options.interaction === "ask" ? "ask" : "agent";
  let releaseWorkspace;
  try {
    releaseWorkspace = acquireHarnessWorkspace(cwd, interaction);
  } catch (error) {
    return Promise.reject(error);
  }
  const outputFile = harness === "codex"
    ? path.join(os.tmpdir(), `chorus-codex-${crypto.randomBytes(8).toString("hex")}.txt`)
    : "";
  const command = buildCommand(harness, bin, prompt, cwd, { outputFile, interaction, sessionId, harnessModel });
  log.info(`------------- Harness 执行开始 harness=${harness} model=${harnessModel || "default"} interaction=${interaction} cwd=${cwd} promptBytes=${Buffer.byteLength(prompt, "utf8")} deadline=none --------------`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command.cmd, command.args, {
        cwd: command.cwd,
        env: buildChildEnv(command.cmd),
        stdio: [command.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      releaseWorkspace();
      readOutputFile(outputFile);
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let stopped = "";
    const output = createOutputCollector(harness, sessionId, (text) => {
      if (!stopped && !context.signal?.aborted) context.onText?.(text);
    });
    let settled = false;
    let killTimer = null;
    /** 停止整个进程组；参数为停止原因，无返回值，等待 close 后才释放工作区租约。 */
    const stop = (reason) => {
      if (settled || stopped) return;
      stopped = reason;
      log.info(`Harness 请求停止 harness=${harness} reason=${reason} pid=${child.pid || "none"}`);
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 3000);
      killTimer.unref?.();
    };
    const abort = () => stop("cancelled");
    context.signal?.addEventListener("abort", abort, { once: true });
    // ------------ 长任务持续运行，仅由调用方取消或 CLI 自行退出 ---------------
    if (context.signal?.aborted) abort();
    /** 清理取消监听与终止定时器；无参数或返回值，释放函数可重复调用。 */
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      context.signal?.removeEventListener("abort", abort);
      releaseWorkspace();
    };

    if (command.stdin) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") log.error("Harness 输入失败", error);
      });
      child.stdin.end(command.stdin);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output.push(chunk);
      stdout = appendLimited(stdout, chunk, MAX_STDOUT_LENGTH);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, MAX_STDERR_LENGTH);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      readOutputFile(command.outputFile);
      log.error(`Harness 进程异常 harness=${harness}`, error);
      reject(stopped === "cancelled" ? new Error("任务已停止") : error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.finish();
      if (sessionKey && output.sessionId) {
        try {
          sessions.set(sessionKey, output.sessionId);
        } catch (error) {
          readOutputFile(command.outputFile);
          reject(new Error(`保存 CLI 会话失败：${error.message}`));
          return;
        }
      }
      if (stopped) {
        readOutputFile(command.outputFile);
        log.info(`------------- Harness 已停止 harness=${harness} code=${code} signal=${signal || "none"} --------------`);
        reject(new Error("任务已停止"));
        return;
      }
      let ok = code === 0 && !output.error && !hasStructuredError(stdout);
      let fileText;
      try {
        fileText = readOutputFile(command.outputFile, true);
      } catch (error) {
        resolve({ ok: false, text: error.message, ...(output.sessionId ? { sessionId: output.sessionId, resumed: Boolean(sessionId) } : {}) });
        return;
      }
      let text = (ok ? fileText || output.text : output.error) || extractOutput(harness, stdout, stderr, ok);
      if (!fileText && !output.text && stdout.length === MAX_STDOUT_LENGTH && text !== "没有输出") {
        text = `[CLI 日志较长，以下保留最后 ${MAX_STDOUT_LENGTH} 个字符]\n${text}`;
      }
      if (ok && text === "没有输出") ok = false;
      log.info(`------------- Harness 执行结束 code=${code} signal=${signal || "none"} harness=${harness} ok=${ok} outputChars=${text.length} --------------`);
      resolve({ ok, text, ...(output.sessionId ? { sessionId: output.sessionId, resumed: Boolean(sessionId) } : {}) });
    });
  });
}

/** 可写终端与后台编码共用工作区租约；release 可重复调用，关闭后才能再次执行。 */
function acquireHarnessWorkspace(workspace, interaction = "agent") {
  const cwd = validateWorkspace(workspace);
  const writer = interaction !== "ask";
  const active = activeWorkspaces.get(cwd);
  if (active && (active.writer || writer)) throw new Error("这个工作区已有 Harness 正在执行，请等待它结束或关闭终端");
  activeWorkspaces.set(cwd, { writer, count: (active?.count || 0) + 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeWorkspaces.get(cwd);
    if (current?.count > 1) current.count -= 1;
    else activeWorkspaces.delete(cwd);
  };
}

/**
 * 增量解析 CLI 的 JSONL，保留原生会话、累计可见文本和最终回复。
 * @param {string} harness 内核类型
 * @param {string} initialSessionId 恢复中的会话编号
 * @param {(text: string) => void} [onText] 当前完整可见文本发生变化时同步调用
 * @returns {{sessionId: string, text: string, error: string, push: Function, finish: Function}} 有界输出收集器
 * 注意事项：按换行组装碎片，忽略工具与思考内容；最终 result 覆盖累计内容，不能重复追加。
 */
function createOutputCollector(harness, initialSessionId = "", onText) {
  const output = { sessionId: initialSessionId, text: "", error: "" };
  let pending = "";
  let discarded = false;
  let oversizedLine = false;
  let visibleText = "";
  let messageId = "";
  let messagePrefix = "";
  let messageText = "";

  /** 发布累计文本；参数为完整文本，无返回值，尺寸超限或回调异常均不会抛出未捕获异常。 */
  const publish = (text) => {
    if (text.length > MAX_RESULT_LENGTH) {
      output.error = "CLI 返回内容超过 5 MB，无法完整读取，请缩小单次输出";
      return;
    }
    output.text = text;
    if (text === visibleText) return;
    if (!visibleText && text) log.info(`Harness 收到首段流式回复 harness=${harness} chars=${text.length}`);
    visibleText = text;
    try {
      onText?.(text);
    } catch (error) {
      log.error(`Harness 流式回调失败 harness=${harness}`, error);
    }
  };

  /** 切换当前助手消息；参数为消息编号，无返回值，同一编号的完整快照只替换当前片段。 */
  const startMessage = (id) => {
    if (id && id === messageId) return;
    messageId = id;
    messagePrefix = visibleText ? `${visibleText}\n\n` : "";
    messageText = "";
  };

  /** 消费一行完整 JSON；参数为未截断行，无返回值，不能将系统状态或工具输出当作回复。 */
  const consume = (line) => {
    const event = parseJson(line);
    if (!event) return;
    const id = event.session_id || (event.type === "thread.started" ? event.thread_id : "");
    if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) output.sessionId = id;
    if (event.parent_tool_use_id) return;
    if (hasStructuredError(line)) {
      output.error = friendlyHarnessError(harness, jsonErrorText(event.error || event.errors || event.result || event.message) || "CLI 返回失败状态");
      return;
    }
    if (output.error) return;

    // ------------ 原生文本事件实时发布，汇总事件仅覆盖已有内容 ---------------
    if (harness === "codex" && /^item\.(started|updated|completed)$/.test(event.type) && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      startMessage(event.item.id || "codex-message");
      messageText = event.item.text;
      publish(messagePrefix + messageText);
      // Codex 原有结果契约只返回最后一条助手消息，工具前的说明仅用于实时展示。
      output.text = messageText.trim();
    } else if (harness === "cursor" && event.type === "assistant") {
      // Cursor 的工具前 flush 和最终 flush 都重复已有 deltas，官方以这两个字段区分。
      if (event.timestamp_ms !== undefined && !event.model_call_id) publish(visibleText + assistantText(event.message));
    } else if (harness === "claude" && event.type === "stream_event") {
      const partial = event.event;
      if (partial?.type === "message_start") startMessage(partial.message?.id || "");
      const fragment = partial?.type === "content_block_delta" && partial.delta?.type === "text_delta"
        ? partial.delta.text
        : partial?.type === "content_block_start" && partial.content_block?.type === "text" ? partial.content_block.text : "";
      if (typeof fragment === "string" && fragment) {
        messageText += fragment;
        publish(messagePrefix + messageText);
      }
    } else if (harness === "claude" && event.type === "assistant") {
      const text = assistantText(event.message);
      if (text) {
        if (event.message?.id && event.message.id !== messageId) startMessage(event.message.id);
        messageText = text;
        publish(messagePrefix + messageText);
      }
    } else if ((!event.type || event.type === "result") && (typeof event.result === "string" || typeof event.message === "string")) {
      publish(extractOutput(harness, line, "", true));
    }
  };

  /** 接收任意 stdout 碎片；参数为 UTF-8 字符串，无返回值，单行超限时丢弃到下个换行。 */
  output.push = (chunk) => {
    const lines = chunk.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!discarded) {
        pending += lines[index];
        if (pending.length > MAX_RESULT_LENGTH) {
          pending = "";
          discarded = true;
          oversizedLine = true;
        }
      }
      if (index < lines.length - 1) {
        if (!discarded) consume(pending);
        pending = "";
        discarded = false;
      }
    }
  };
  /** 收尾最后一行；无参数或返回值，兼容 CLI 未输出末尾换行的情况。 */
  output.finish = () => {
    if (!discarded && pending) consume(pending);
    if (oversizedLine && !output.text && !output.error) output.error = "CLI 返回内容超过 5 MB，无法完整读取，请缩小单次输出";
  };
  return output;
}

/**
 * 提取助手消息中的纯文本块。
 * @param {object} message 原生消息对象
 * @returns {string} 按顺序拼接的文本
 * 注意事项：工具参数、思考块与图片不能进入面向用户的回复。
 */
function assistantText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

function buildChildEnv(bin) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathParts = [path.dirname(bin), ...candidateBinDirectories()];
  env.PATH = [...new Set(pathParts)].join(path.delimiter);
  return env;
}

function terminateProcessTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (_error) {
    try {
      child.kill(signal);
    } catch (inner) {
      if (!inner || inner.code !== "ESRCH") log.error("停止 Harness 失败", inner);
    }
  }
}

function appendLimited(current, chunk, limit) {
  const next = current + chunk.toString("utf8");
  return next.length > limit ? next.slice(-limit) : next;
}

function extractOutput(harness, stdout, stderr, ok) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const errors = uniqueErrorLines(combined);
  if (!ok && errors) return friendlyHarnessError(harness, errors);
  const primary = ok ? stdout : stderr || stdout;
  if (harness === "codex" && stdout.trim()) {
    const messages = stdout.split(/\r?\n/).map(parseJson).filter(Boolean);
    if (!ok) {
      const error = messages.find((item) => item.type === "error" || item.type === "turn.failed");
      if (error) return friendlyHarnessError(harness, jsonErrorText(error.error || error.message));
    }
    const final = messages.filter((item) => item.type === "item.completed" && item.item?.type === "agent_message").at(-1);
    if (ok && typeof final?.item?.text === "string") return final.item.text.trim();
    if (ok && messages.length) return "没有输出";
  }
  if ((harness === "claude" || harness === "cursor") && stdout.trim()) {
    const parsed = parseJson(stdout);
    if (parsed) {
      if (!ok) {
        const error = jsonErrorText(parsed.error || parsed.errors || parsed.result || parsed.message);
        if (error) return friendlyHarnessError(harness, error);
      }
      if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result.trim();
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (parsed.type === "result" || Object.prototype.hasOwnProperty.call(parsed, "result")) return "没有输出";
    }
  }
  const text = (primary || errors || "没有输出").trim();
  return ok ? text : friendlyHarnessError(harness, text);
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch (_error) {
    return null;
  }
}

/** 有些 CLI 在退出码为 0 时仍把 API 失败写进 JSON，需要按结果状态判定。 */
function hasStructuredError(stdout) {
  const parsed = parseJson(stdout);
  if (parsed) return parsed.is_error === true || parsed.type === "error" || parsed.type === "turn.failed" || ((!parsed.type || parsed.type === "result") && (/^error/.test(parsed.subtype || "") || Boolean(parsed.error)));
  return stdout.split(/\r?\n/).some((line) => {
    const event = parseJson(line);
    return event?.type === "turn.failed" || event?.type === "error";
  });
}

function jsonErrorText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jsonErrorText).filter(Boolean).join("\n");
  return value && typeof value === "object" ? jsonErrorText(value.message || value.error || value.type) : "";
}

/**
 * 抽出 CLI 明确写出的 ERROR 行，去掉启动横幅。
 * @param {string} text 标准输出和错误输出
 * @returns {string} 去重后的错误行
 */
function uniqueErrorLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ERROR:"));
  return [...new Set(lines)].join("\n");
}

/**
 * 把常见的内核失败说明换成可直接操作的中文。
 * @param {string} harness 内核类型
 * @param {string} text 原始错误
 * @returns {string} 展示给用户的说明
 */
function friendlyHarnessError(harness, text) {
  const raw = String(text || "").trim();
  if (/out of credits/i.test(raw)) {
    return `${harnessLabel(harness)} 已连上，但当前账号额度已用完。请到对应账号里补充额度后再执行。`;
  }
  if (/not logged in|not authenticated|authentication required|please (log|sign) in|agent login/i.test(raw)) {
    return `${harnessLabel(harness)} 尚未登录。请到设置 → 本机与内核里使用账号登录。`;
  }
  return raw || "没有输出";
}

function harnessLabel(harness) {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude Code" : "Cursor";
}

/**
 * 读取 Codex 写入的最终回复并删除临时文件。
 * @param {string} file 结果文件路径，空字符串表示没有
 * @returns {string} 去空白后的正文
 */
function readOutputFile(file, strict = false) {
  if (!file) return "";
  let text = "";
  let failure;
  try {
    if (fs.statSync(file).size > MAX_RESULT_LENGTH) failure = new Error("CLI 最终回复超过 5 MB，无法完整读取，请缩小单次输出");
    else text = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (!error || error.code !== "ENOENT") log.error("读取 Harness 结果文件失败", error);
  }
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== "ENOENT") log.error("清理 Harness 结果文件失败", error);
  }
  if (strict && failure) throw failure;
  return text;
}

/**
 * 打开 Codex 或 Cursor CLI 的浏览器登录，并等待该进程结束。
 * @param {"codex"|"claude"|"cursor"} harness 内核类型
 * @param {{codex?: string, claude?: string, cursor?: string}} [configuredPaths] 自定义 CLI 路径
 * @returns {Promise<{ok: boolean, text: string}>} 登录进程的退出结果
 * 注意事项：同一时间只允许一个登录流程。Claude Code 没有稳定的浏览器登录参数，不在这里启动。
 */
function startHarnessLogin(harness, configuredPaths = {}) {
  const args = Object.hasOwn(LOGIN_ARGS, harness) ? LOGIN_ARGS[harness] : null;
  if (!args) return Promise.reject(new Error("这个内核请在它自己的终端里完成登录"));
  if (activeLogin) return Promise.reject(new Error("已有登录流程在进行，请先在浏览器完成"));

  let bin = "";
  try {
    bin = configuredPaths[harness]
      ? validateExecutablePath(configuredPaths[harness], harnessLabel(harness), harness)
      : findBinary(BINARY_NAMES[harness]);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!bin) return Promise.reject(new Error(`本机没有找到 ${BINARY_NAMES[harness][0]}，请先安装后再登录`));

  log.info(`打开 Harness 登录 harness=${harness}`);
  activeLogin = harness;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        env: buildChildEnv(bin),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      activeLogin = null;
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeLogin = null;
      terminateProcessTree(child, "SIGTERM");
      reject(new Error("登录等待超过 3 分钟，已停止。可以稍后重试"));
    }, 180000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, 4000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, 4000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeLogin = null;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeLogin = null;
      const text = (stdout || stderr || (code === 0 ? "登录流程已结束" : "登录未完成")).trim();
      log.info(`Harness 登录结束 harness=${harness} code=${code}`);
      resolve({ ok: code === 0, text });
    });
  });
}

module.exports = {
  acquireHarnessWorkspace,
  buildChildEnv,
  buildCommand,
  probeHarness,
  resolveHarnessExecutable,
  runHarness,
  startHarnessLogin,
  extractOutput,
  validateExecutablePath,
  validateHarnessPaths,
  validateHarnessModel,
  validateWorkspace,
};
