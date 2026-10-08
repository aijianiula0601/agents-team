const { completeChat, normalizeMessages } = require("./llm");
const { runHarness } = require("./harness");
const { resolveAgentWorkspace } = require("./agent-workspaces");

const BACKENDS = new Set(["model", "codex", "claude", "cursor"]);

/** 后台必须由用户明确选择，调用失败时保留原始错误，不更换服务。 */
function normalizeBackend(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw new Error("Agent 配置无效");
  const backend = agent.backend || "model";
  if (!BACKENDS.has(backend)) throw new Error("不支持的讨论后台");
  return backend;
}

/**
 * 根据 Agent 配置进行模型对话或可写的 CLI 工作区会话。
 * @param {{agent: object, messages: object[], workspace?: string, threadKey?: string, conversationId?: string}} payload 页面请求
 * @param {{keys?: object, harnessPaths?: object, sessions?: object, signal?: AbortSignal, onText?: Function, workspaceRoot?: string, workspaceAgents?: object[]}} [context] 主进程环境和累计正文回调，workspaceRoot 仅供隔离测试
 * @returns {Promise<{text: string, via: string}>}
 * 注意事项：每个 Agent 使用自己的目录；已有显式路径无效时直接报错，不替换为其他目录。
 */
async function completeAgentChat(payload, context = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("对话请求格式无效");
  const backend = normalizeBackend(payload.agent);
  if (context.signal?.aborted) throw new Error("任务已停止");
  if (backend === "model") {
    const text = await (context.completeModel || completeChat)(payload.agent, payload.messages, context.keys || {}, { signal: context.signal, onText: context.onText });
    return { text, via: payload.agent.provider || "openai" };
  }

  const messages = normalizeMessages(payload.messages);
  const result = await (context.runCli || runHarness)({
    harness: backend,
    harnessModel: payload.agent.harnessModel || "",
    interaction: "agent",
    cwd: discussDirectory(payload.workspace, payload.agent, context.workspaceRoot, context.workspaceAgents),
    prompt: discussPrompt(payload.agent, messages),
    threadKey: payload.threadKey ?? payload.conversationId,
    agentId: payload.agent.id || "default",
  }, context.harnessPaths || {}, { signal: context.signal, sessions: context.sessions, onText: context.onText });
  if (!result.ok) throw new Error(result.text || `${backend} 执行失败`);
  if (!result.text?.trim()) throw new Error(`${backend} 没有返回内容`);
  return { text: result.text, via: backend };
}

/**
 * 解析 CLI 工作区；未填写时创建该 Agent 的默认目录。
 * @param {string|undefined} workspace 页面显式配置的工作区
 * @param {object} [agent] 成员配置，包含 id、name 和可选 workspace
 * @param {string} [root] 仅供原生隔离测试覆盖默认根目录
 * @param {object[]} [agents] 当前电脑完整成员列表，用于统一处理重名目录
 * @returns {string} 存在且可写的规范目录
 * 注意事项：优先保留显式路径；不使用团队目录，也不回退到临时目录。
 */
function discussDirectory(workspace, agent = {}, root, agents = []) {
  if (workspace !== undefined && typeof workspace !== "string") throw new Error("工作区路径格式无效");
  return resolveAgentWorkspace({ ...agent, workspace: workspace?.trim() ? workspace : agent.workspace }, { root, agents });
}

/**
 * 将具名团队上下文整理为真实 CLI 的任务提示。
 * @param {object} agent 成员角色和人设
 * @param {object[]} messages 已规范化的模型消息
 * @returns {string} 包含独立目录执行说明的任务提示
 * 注意事项：不记录原始提示或聊天内容到日志；明确要求报告实际执行结果。
 */
function discussPrompt(agent, messages) {
  const name = cleanString(agent.name, 120) || "Agent";
  const role = cleanString(agent.role, 240) || "协作者";
  const persona = cleanString(agent.persona, 12000);
  const transcript = messages.map((item) => `${item.role === "assistant" ? name : "对话上下文"}：${item.content}`).join("\n\n");
  return `你是 ${name}，角色：${role}。\n${persona}\n你正在该 Agent 的独立工作区使用真实编码 CLI。请结合以下对话上下文完成用户任务，需要时直接修改文件和运行命令，并用中文报告实际执行结果与验证。遇到失败应说明实际原因，不要把计划或模拟回复当作已完成。\n\n${transcript}`;
}

function cleanString(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

module.exports = { completeAgentChat, discussDirectory, discussPrompt, normalizeBackend };
