const crypto = require("crypto");
const { resolveHarnessExecutable, buildChildEnv, validateWorkspace, validateHarnessModel, acquireHarnessWorkspace } = require("./harness");
const { resolveAgentWorkspace } = require("./agent-workspaces");
const log = require("./log");

const MAX_SESSIONS = 8;
const MAX_BUFFER_LENGTH = 512 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

/**
 * 构造原生交互命令，按 Agent 选择传入模型。
 * @param {string} harness 内核类型
 * @param {string} executable 可执行文件
 * @param {string} cwd 已解析本机目录
 * @param {string} resumeSessionId 可选历史会话
 * @param {string} harnessModel 可选模型编号
 * @returns {{cmd: string, args: string[]}} 无 shell 拼接的命令
 * 注意事项：模型为空时保留 CLI 默认值，权限和审批继续使用原生配置。
 */
function buildInteractiveCommand(harness, executable, cwd, resumeSessionId = "", harnessModel = "") {
  const resume = validateResumeSessionId(resumeSessionId);
  const model = validateHarnessModel(harnessModel);
  const modelArgs = model ? ["--model", model] : [];
  if (harness === "codex") return { cmd: executable, args: [...(resume ? ["resume", resume] : []), "-C", cwd, ...modelArgs] };
  if (harness === "cursor") return { cmd: executable, args: [...(resume ? ["--resume", resume] : []), "--workspace", cwd, ...modelArgs] };
  if (harness === "claude") return { cmd: executable, args: [...(resume ? ["--resume", resume] : []), ...modelArgs] };
  throw new Error("未知的终端内核");
}

/**
 * 管理持续运行的 CLI 伪终端，关闭面板不会结束进程，关闭会话才会结束进程树。
 * 输出原样传给 xterm，不记录终端内容或凭据。事件与 read 的 offset 均按 JS 字符串长度累计。
 * 支持注入 pty 和路径解析器，方便在没有原生扩展的环境验证会话生命周期。
 */
class TerminalSessionManager {
  constructor(options = {}) {
    this.pty = options.pty || null;
    this.onEvent = options.onEvent || (() => {});
    this.resolveExecutable = options.resolveExecutable || resolveHarnessExecutable;
    this.validateWorkspace = options.validateWorkspace || validateWorkspace;
    this.resolveWorkspace = options.resolveWorkspace || resolveAgentWorkspace;
    this.childEnv = options.childEnv || buildChildEnv;
    this.acquireWorkspace = options.acquireWorkspace || acquireHarnessWorkspace;
    this.killProcessTree = options.killProcessTree || terminateProcessTree;
    this.maxSessions = options.maxSessions || MAX_SESSIONS;
    this.maxBufferLength = options.maxBufferLength || MAX_BUFFER_LENGTH;
    this.sessions = new Map();
  }

  /** 打开指定 Agent 的交互终端；同一 Agent 的活动会话可重新连接。 */
  open(options, configuredPaths = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("终端参数格式无效");
    const harness = options.harness;
    if (!["codex", "claude", "cursor"].includes(harness)) throw new Error("未知的终端内核");
    const agentId = validateAgentId(options.agentId);
    const threadKey = validateThreadKey(options.threadKey);
    const resumeSessionId = validateResumeSessionId(options.resumeSessionId);
    const harnessModel = validateHarnessModel(options.harnessModel);
    const cwd = options.workspaceMode === "auto" || !options.cwd ? this.resolveWorkspace({ id: options.sessionAgentId || agentId || "default", name: options.agentName || options.sessionAgentId || agentId || "Agent", workspace: options.cwd || "", workspaceMode: options.workspaceMode }) : this.validateWorkspace(options.cwd);
    const size = validateSize(options.cols ?? 100, options.rows ?? 30);
    if (agentId) {
      const existing = [...this.sessions.values()].find((session) => session.agentId === agentId && session.threadKey === threadKey);
      if (existing?.status === "running") {
        if (existing.cwd !== cwd || existing.harness !== harness || existing.harnessModel !== harnessModel) {
          throw new Error("这个 Agent 的终端仍在运行，请先关闭再更换项目、内核或模型");
        }
        return { ...this.read(existing.sessionId), reused: true };
      }
      if (existing) this.close(existing.sessionId);
    }
    if (this.sessions.size >= this.maxSessions) throw new Error(`最多同时保留 ${this.maxSessions} 个终端，请先关闭不用的会话`);
    const executable = this.resolveExecutable(harness, configuredPaths);
    const command = buildInteractiveCommand(harness, executable, cwd, resumeSessionId, harnessModel);
    if (!this.pty) {
      try {
        this.pty = require("node-pty");
      } catch (_error) {
        throw new Error("终端组件无法加载，请重新安装完整的 Chorus 应用");
      }
    }
    const env = { ...this.childEnv(executable), TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Chorus" };
    delete env.CI;
    const releaseWorkspace = this.acquireWorkspace(cwd, "agent");
    let process;
    try {
      process = this.pty.spawn(command.cmd, command.args, {
        name: "xterm-256color", cwd, env, ...size, encoding: "utf8",
      });
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
    const session = {
      sessionId: crypto.randomUUID(), harness, harnessModel, cwd, agentId, threadKey, resumeSessionId, ...size,
      status: "running", exitCode: null, signal: null,
      createdAt: Date.now(), output: "", startOffset: 0, nextOffset: 0,
      process, releaseWorkspace, subscriptions: [],
    };
    log.info(`------------- 打开内核终端 harness=${harness} model=${harnessModel || "default"} agent=${agentId || "default"} --------------`);
    this.sessions.set(session.sessionId, session);
    session.subscriptions.push(process.onData((data) => {
      if (session.status !== "running" || typeof data !== "string") return;
      const startOffset = session.nextOffset;
      session.nextOffset += data.length;
      session.output += data;
      if (session.output.length > this.maxBufferLength) {
        let start = session.output.length - this.maxBufferLength;
        if (/^[\uDC00-\uDFFF]$/.test(session.output[start])) start += 1;
        session.output = session.output.slice(start);
      }
      session.startOffset = session.nextOffset - session.output.length;
      this.onEvent({ sessionId: session.sessionId, type: "data", data, startOffset, nextOffset: session.nextOffset });
    }));
    session.subscriptions.push(process.onExit(({ exitCode, signal }) => {
      if (session.status !== "running") return;
      session.status = "exited";
      session.exitCode = Number.isInteger(exitCode) ? exitCode : null;
      session.signal = Number.isInteger(signal) ? signal : null;
      session.releaseWorkspace();
      this.disposeSubscriptions(session);
      this.onEvent({ sessionId: session.sessionId, type: "exit", status: session.status, exitCode: session.exitCode, signal: session.signal });
    }));
    return { ...this.read(session.sessionId), reused: false };
  }

  create(options, configuredPaths) {
    return this.open(options, configuredPaths);
  }

  /** 发送原始键盘数据，包含换行、方向键和 Ctrl+C；不拼接 shell 命令。 */
  write(sessionId, data) {
    const session = this.requireSession(sessionId);
    if (session.status !== "running") throw new Error("终端已经退出，请重新打开");
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) throw new Error("终端单次输入不能超过 64 KB");
    session.process.write(data);
    return { written: true };
  }

  resize(sessionId, size) {
    const session = this.requireSession(sessionId);
    if (!size || typeof size !== "object" || Array.isArray(size)) throw new Error("终端尺寸格式无效");
    const normalized = validateSize(size.cols, size.rows);
    if (session.status === "running") session.process.resize(normalized.cols, normalized.rows);
    Object.assign(session, normalized);
    return normalized;
  }

  /** 按 offset 读取输出；历史已滚动淘汰时 reset 为 true，客户端应清屏后重放返回内容。 */
  read(sessionId, options = {}) {
    const session = this.requireSession(sessionId);
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("终端读取参数格式无效");
    const after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0 || after > session.nextOffset) throw new Error("终端读取位置无效");
    const reset = after < session.startOffset;
    return {
      ...metadata(session),
      output: session.output.slice(Math.max(after, session.startOffset) - session.startOffset),
      startOffset: Math.max(after, session.startOffset), nextOffset: session.nextOffset, reset,
    };
  }

  list() {
    return [...this.sessions.values()].map(metadata);
  }

  close(sessionId) {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return { closed: false };
    this.sessions.delete(sessionId);
    const wasRunning = session.status === "running";
    session.status = "closed";
    this.disposeSubscriptions(session);
    if (wasRunning) {
      const timer = setTimeout(() => this.killProcessTree(session.process, "SIGKILL"), 3000);
      timer.unref?.();
      // 原生进程退出后无需再发送信号，避免 PID 被重用时误伤其他进程。
      const exitSubscription = session.process.onExit(() => {
        clearTimeout(timer);
        exitSubscription.dispose();
      });
      this.killProcessTree(session.process, "SIGTERM");
    }
    session.releaseWorkspace();
    this.onEvent({ sessionId: session.sessionId, type: "exit", status: "closed", exitCode: session.exitCode, signal: session.signal });
    return { closed: true };
  }

  closeAll() {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId);
  }

  requireSession(sessionId) {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("终端会话不存在，请重新打开");
    return session;
  }

  disposeSubscriptions(session) {
    for (const subscription of session.subscriptions.splice(0)) subscription.dispose();
  }
}

function validateAgentId(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Agent 编号格式无效");
  return value;
}

function validateSessionId(value) {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("终端会话编号无效");
}

function validateThreadKey(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("聊天编号格式无效");
  return value;
}

function validateResumeSessionId(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("CLI 历史会话编号无效");
  return value;
}

function validateSize(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 2 || rows > 300) {
    throw new Error("终端尺寸必须在 2–500 列、2–300 行之间");
  }
  return { cols, rows };
}

function metadata(session) {
  const { sessionId, harness, harnessModel, cwd, agentId, threadKey, resumeSessionId, status, cols, rows, createdAt, exitCode, signal } = session;
  return { sessionId, harness, harnessModel, cwd, agentId, threadKey, resumeSessionId, status, cols, rows, createdAt, exitCode, signal };
}

function terminateProcessTree(ptyProcess, signal) {
  try {
    if (process.platform === "win32") ptyProcess.kill(signal);
    else process.kill(-ptyProcess.pid, signal);
  } catch (_error) {
    try { ptyProcess.kill(signal); } catch (_ignored) { /* 进程可能已经退出。 */ }
  }
}

module.exports = { TerminalSessionManager, buildInteractiveCommand };
