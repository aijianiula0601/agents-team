const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** 仅保存 CLI 原生会话编号；对话和工具执行记录仍由各 CLI 自己管理。 */
class HarnessSessions {
  constructor(file = "") {
    this.file = file;
    this.entries = null;
  }

  get(key) {
    if (!key) return "";
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("CLI 会话索引编号无效");
    return this.read()[key] || "";
  }

  set(key, sessionId) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("CLI 会话索引编号无效");
    const id = normalizeSessionId(sessionId);
    const entries = this.read();
    if (entries[key] === id) return;
    const next = { ...entries, [key]: id };
    if (this.file) {
      const payload = JSON.stringify({ version: 1, sessions: next }, null, 2);
      if (Buffer.byteLength(payload, "utf8") > 1024 * 1024) throw new Error("CLI 会话索引过大");
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, payload, { mode: 0o600 });
        fs.renameSync(temporary, this.file);
        fs.chmodSync(this.file, 0o600);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    this.entries = next;
  }

  read() {
    if (this.entries) return this.entries;
    if (!this.file) return (this.entries = {});
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("CLI 会话索引无效");
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
        throw new Error("CLI 会话索引格式无效");
      }
      const entries = {};
      for (const [key, id] of Object.entries(parsed.sessions)) {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("CLI 会话索引格式无效");
        entries[key] = normalizeSessionId(id);
      }
      return (this.entries = entries);
    } catch (error) {
      if (error.code === "ENOENT") return (this.entries = {});
      if (error instanceof SyntaxError) throw new Error("CLI 会话索引已损坏，请检查 harness-sessions.json");
      throw error;
    }
  }
}

/** 同一聊天、成员和工作区才续接会话，避免私聊或群聊串线。 */
function harnessSessionKey(options, harness, cwd) {
  const thread = options.threadKey ?? options.conversationId;
  if (thread === undefined || thread === null || thread === "") return "";
  if (typeof thread !== "string" || !thread.trim() || thread.length > 256 || /[\u0000-\u001f\u007f]/.test(thread)) {
    throw new Error("对话编号格式无效");
  }
  const agentId = options.agentId ?? "default";
  if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 256 || /[\u0000-\u001f\u007f]/.test(agentId)) {
    throw new Error("Agent 编号格式无效");
  }
  return crypto.createHash("sha256").update(JSON.stringify([harness, cwd, thread, agentId])).digest("hex");
}

function normalizeSessionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error("CLI 会话编号格式无效");
  return value;
}

module.exports = { HarnessSessions, harnessSessionKey, normalizeSessionId };
