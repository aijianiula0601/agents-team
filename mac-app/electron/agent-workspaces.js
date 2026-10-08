const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./log");
const { validateWorkspace } = require("./workspace-paths");

const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), "Documents/chorus/agent-teams/workspace");

/**
 * 主动创建公共根目录，并按 Agent 名称创建独立默认工作区。
 * @param {object[]} agents 电脑端 Agent 配置，包含唯一 id、name 和可选 workspace
 * @param {{root?: string}} [options] 仅原生测试可覆盖默认根目录
 * @returns {{id: string, workspace: string}[]} 每个 Agent 对应的绝对工作区路径
 * 注意事项：即使没有成员或全部已有显式路径，也准备公共根目录；不迁移、删除或创建显式目录，不允许子目录越过根目录。
 */
function prepareAgentWorkspaces(agents, options = {}) {
  if (!Array.isArray(agents) || agents.length > 200) throw new Error("Agent 工作区配置格式无效");
  const ids = new Set();
  agents = agents.map((agent) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw new Error("Agent 工作区配置格式无效");
    if (agent.workspaceMode && !["auto", "project"].includes(agent.workspaceMode)) throw new Error("工作区管理方式无效");
    return agent.workspaceMode === "auto" ? { ...agent, workspace: "" } : agent;
  });
  const names = agents.map((agent) => {
    if (!agent || typeof agent.id !== "string" || !agent.id.trim() || agent.id.length > 240 || ids.has(agent.id)) throw new Error("Agent 编号无效或重复");
    if (typeof agent.name !== "string" || agent.name.length > 4096 || (agent.workspace !== undefined && typeof agent.workspace !== "string")) throw new Error("Agent 工作区配置格式无效");
    ids.add(agent.id);
    return workspaceName(agent.name, agent.id);
  });
  // ------------ 创建默认根目录并校验独立子目录 ---------------
  const pendingCount = agents.filter((agent) => !agent.workspace?.trim()).length;
  log.info(`------------- 准备公共工作区根目录：${pendingCount} 个成员待补目录 --------------`);
  const root = path.resolve(options.root || DEFAULT_WORKSPACE_ROOT);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const realRoot = validateWorkspace(root);
  if (!pendingCount) {
    log.info("------------- 公共工作区根目录已就绪，已有成员路径保持原样 --------------");
    return agents.map((agent) => ({ id: agent.id, workspace: agent.workspace }));
  }
  const collisions = new Map();
  names.forEach((name) => collisions.set(name.toLocaleLowerCase("en-US"), (collisions.get(name.toLocaleLowerCase("en-US")) || 0) + 1));
  const directories = names.map((name, index) => collisions.get(name.toLocaleLowerCase("en-US")) > 1 ? `${name}-${workspaceSuffix(agents[index].id)}` : name);
  const used = new Set();
  agents.filter((agent) => agent.workspace?.trim()).forEach((agent) => {
    const expanded = agent.workspace.trim().replace(/^~(?=\/|$)/, os.homedir());
    const explicit = path.resolve(expanded);
    // 保留显式路径，但不让新成员默认落入另一个成员已配置的目录。
    if (path.dirname(explicit) === realRoot) used.add(path.basename(explicit).normalize("NFC").toLocaleLowerCase("en-US"));
    if (fs.existsSync(explicit)) {
      const real = fs.realpathSync(explicit);
      if (path.dirname(real) === realRoot) used.add(path.basename(real).normalize("NFC").toLocaleLowerCase("en-US"));
    }
  });
  agents.map((agent, index) => ({ id: agent.id, index })).sort((left, right) => left.id.localeCompare(right.id)).forEach(({ index }) => {
    let directory = directories[index];
    let count = 0;
    // 原始名字也可能刚好等于另一个成员的摘要目录；再次消除这种派生名称冲突。
    while (used.has(directory.toLocaleLowerCase("en-US"))) directory = `${directories[index]}-${workspaceSuffix(agents[index].id)}-${++count}`;
    directories[index] = directory;
    used.add(directory.toLocaleLowerCase("en-US"));
  });
  const result = agents.map((agent, index) => {
    if (agent.workspace?.trim()) return { id: agent.id, workspace: agent.workspace };
    const target = path.join(realRoot, directories[index]);
    try {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o755 });
      // 默认目录不能通过符号链接与其他成员共用目录，即使链接目标仍在根目录内。
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("默认 Agent 工作区不能使用符号链接，请检查同名目录");
      const workspace = validateWorkspace(target);
      const relative = path.relative(realRoot, workspace);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("默认工作区不能链接到根目录外");
      return { id: agent.id, workspace };
    } catch (error) {
      log.error("默认 Agent 工作区准备失败", error);
      throw error;
    }
  });
  log.info(`------------- Agent 默认工作区已准备：${result.length} 个配置 --------------`);
  return result;
}

/**
 * 在实际执行电脑解析成员目录，自动模式不信任其他设备同步的绝对路径。
 * @param {{id?: string, name?: string, workspace?: string, workspaceMode?: string}} agent 成员目录配置
 * @param {{root?: string, agents?: object[]}} options 执行电脑成员列表和测试根目录
 * @returns {string} 存在且可写的本机目录
 * 注意事项：旧版非空路径按显式项目保留；显式项目无效时报错，不创建同名空目录。
 */
function resolveAgentWorkspace(agent, options = {}) {
  if (agent.workspace !== undefined && typeof agent.workspace !== "string") throw new Error("工作区路径格式无效");
  if (agent.workspaceMode && !["auto", "project"].includes(agent.workspaceMode)) throw new Error("工作区管理方式无效");
  if (agent.workspaceMode === "project" || (agent.workspaceMode !== "auto" && agent.workspace?.trim())) return validateWorkspace(agent.workspace || "");
  const member = { ...agent, id: agent.id || "default", name: agent.name || agent.id || "Agent", workspace: "", workspaceMode: "auto" };
  const roster = (options.agents || []).filter((entry) => entry.id !== member.id && (["codex", "claude", "cursor"].includes(entry.backend) || ["codex", "claude", "cursor"].includes(entry.harness))).concat(member);
  return prepareAgentWorkspaces(roster, { root: options.root }).find((entry) => entry.id === member.id).workspace;
}

/**
 * 将名称转换为中文友好的单层目录名，危险或空名称附加编号摘要。
 * @param {string} name Agent 名称
 * @param {string} id 稳定 Agent 编号
 * @returns {string} 不含路径分隔符、控制字符或相对路径段的目录名
 * 注意事项：保留中文；截断按 UTF-8 字节，避免超过文件系统的文件名长度限制。
 */
function workspaceName(name, id) {
  const normalized = name.normalize("NFC").trim();
  let safe = normalized.replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "-").replace(/^\.+|[. ]+$/g, "");
  let limited = "";
  for (const character of safe) {
    if (Buffer.byteLength(limited + character, "utf8") > 160) break;
    limited += character;
  }
  safe = limited || "Agent";
  if (safe !== normalized || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe)) safe += `-${workspaceSuffix(id)}`;
  return safe;
}

/**
 * 生成稳定目录后缀，区分清洗后重名或空名称。
 * @param {string} id Agent 编号
 * @returns {string} 12 位 SHA-256 摘要
 * 注意事项：仅使用编号，不把原始名称或聊天内容写入日志。
 */
function workspaceSuffix(id) {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
}

module.exports = { DEFAULT_WORKSPACE_ROOT, prepareAgentWorkspaces, resolveAgentWorkspace };
