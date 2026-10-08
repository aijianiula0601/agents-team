/* 团队与私聊使用独立线程；这些纯函数同时供界面和回归测试使用。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChorusConversation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function content(message) {
    const files = (message.attachments || []).filter((file) => file.text)
      .map((file) => `\n\n--- 附件：${file.name} ---\n${file.text}`).join("");
    return `${message.text || "请查看附件。"}${files}`;
  }

  /**
   * 选择收到当前消息的候选成员，实际是否发言由各成员模型判断。
   * @param {string} text 当前消息正文
   * @param {object[]} members 群成员
   * @param {string} rule 自由讨论或仅点名
   * @returns {object[]} 被点名的成员，或自由讨论的全部成员
   * 注意事项：这里只解析明确的 @，不通过关键词推断职责相关性。
   */
  function responders(text, members, rule = "free") {
    const mentioned = members.filter((agent) => {
      const name = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`@${name}(?=$|\\s|[，。,.!?！？:：;；])`, "iu").test(text);
    });
    return mentioned.length ? mentioned : rule === "mention" ? [] : members;
  }

  /**
   * 生成真实群聊参与规则，让当前模型自行判断相关性并在工具调用前决定是否参与。
   * @param {object} agent 当前成员
   * @param {object[]} members 群成员及角色
   * @param {string} roomName 群名
   * @param {object|undefined} trigger 触发当前观察的消息
   * @returns {string} 包含沉默约定与成员名单的提示
   * 注意事项：沉默标记仅用于本轮控制，不作为用户可见消息保存。
   */
  function groupInstructions(agent, members, roomName, trigger) {
    const roster = members.map((member) => `@${member.name}：${member.role || "协作者"}`).join("；");
    const author = trigger?.from === "you" ? "用户" : members.find((member) => member.id === trigger?.from)?.name || "群成员";
    return `你是群聊「${roomName || "团队"}」中的 ${agent.name}。成员与职责：${roster}。\n`
      + "这是自然群聊，不要求每位成员轮流回复。先结合上下文、自己的职责、已有回复和本次触发消息判断是否需要参与，再决定是否调用工具或执行任务。只有你有相关职责、能提供新的有用信息或被明确请求协助时才发言；无关、重复、仅表示收到或感谢时保持沉默。\n"
      + "需要沉默时，只返回 [[CHORUS_SILENT]]，不要解释、不要调用工具、不要修改文件。需要回复时直接给出正常正文，不输出该标记，也不要替其他成员发言。需要另一位成员接手、回答或评审时，在正文用名单中的准确名称 @成员 并说明具体请求；仅提到某人时不要使用 @。任务已经解决时停止互相点名。\n"
      + (trigger ? `本次触发消息来自 ${author}：\n${content(trigger)}\n请结合群聊中已出现的后续内容判断当前是否仍需你回应。` : "请关注群聊最近的发言，避免重复执行已经完成的任务。");
  }

  /**
   * 识别成员主动选择的沉默结果。
   * @param {string} text 模型或 CLI 返回的正文
   * @returns {boolean} 是否为完整、独立的控制标记
   * 注意事项：普通正文中引用该标记不会吞掉正常回复；私聊不调用此函数。
   */
  function silentGroupReply(text) {
    return String(text || "").trim() === "[[CHORUS_SILENT]]";
  }

  /**
   * 创建可恢复的群聊观察队列，并将成员之间的有效 @ 转为后续观察。
   * @param {object[]} members 当前群成员
   * @param {object[]} initial 初始候选成员
   * @param {object[]} previous 已保存的本轮回复
   * @param {string} requestId 原始用户消息编号
   * @returns {{next: function, record: function, limited: function}} 队列操作
   * 注意事项：每成员最多观察两次，自动追加最多八次；重复触发、自己 @ 自己和群外成员均忽略。
   */
  function groupTurnQueue(members, initial, previous = [], requestId = "") {
    const roster = new Map(members.map((agent) => [agent.id, agent]));
    const counts = new Map();
    const handled = new Set();
    const queue = [];
    const limit = members.length + 8;
    let turns = previous.length;
    let followups = previous.length - new Set(previous.map((reply) => reply.from)).size;
    let capped = false;
    for (const reply of previous) {
      counts.set(reply.from, (counts.get(reply.from) || 0) + 1);
      handled.add(`${reply.from}:${reply.replyTo || requestId}`);
    }
    for (const agent of initial) {
      if (roster.has(agent.id) && !counts.has(agent.id) && !queue.some((item) => item.agent.id === agent.id)) queue.push({ agent, triggerId: requestId });
    }
    /**
     * 将一条成功回复中的 @ 放到待观察队列前方。
     * @param {object} reply 已保存的成员回复
     * @returns {void} 更新队列
     * 注意事项：已经待观察的同一成员合并为一次，避免重复调用。
     */
    function record(reply) {
      if (reply.error) return;
      const additions = [];
      for (const agent of responders(reply.text || "", members, "mention")) {
        if (agent.id === reply.from || handled.has(`${agent.id}:${reply.id}`)) continue;
        if ((counts.get(agent.id) || 0) >= 2) { capped = true; continue; }
        const pending = queue.findIndex((item) => item.agent.id === agent.id);
        if (pending >= 0) queue.splice(pending, 1);
        additions.push({ agent, triggerId: reply.id });
      }
      queue.unshift(...additions);
    }
    previous.forEach(record);
    return {
      /**
       * 领取下一位观察成员并登记次数。
       * @param 无
       * @returns {object|undefined} 成员与触发消息编号；队列结束时为空
       * 注意事项：沉默同样计入次数，防止重复观察形成无限循环。
       */
      next() {
        if (turns >= limit) { capped ||= queue.length > 0; return undefined; }
        while (queue.length) {
          const item = queue.shift();
          const count = counts.get(item.agent.id) || 0;
          if (count >= 2 || (count > 0 && followups >= 8)) { capped = true; continue; }
          if (count > 0) followups++;
          turns++;
          counts.set(item.agent.id, count + 1);
          handled.add(`${item.agent.id}:${item.triggerId}`);
          return item;
        }
        return undefined;
      },
      record,
      /**
       * 查询是否有自动互动被次数上限截断。
       * @param 无
       * @returns {boolean} 是否达到保护上限
       * 注意事项：供界面日志使用，不额外生成 Agent 消息。
       */
      limited() { return capped; },
    };
  }

  /** 将共享讨论保留为具名上下文，让接力成员看到前序回复。 */
  function modelMessages(thread, agent, agents, userText, team = false, beforeId = "") {
    const end = beforeId ? thread.findIndex((message) => message.id === beforeId) : -1;
    const messages = (end < 0 ? thread : thread.slice(0, end)).filter((item) =>
      item.type !== "day" && !item.error && !item.streaming && item.text && (team || item.from === "you" || item.from === agent.id)
    ).slice(-20).map((item) => {
      const author = agents.find((member) => member.id === item.from);
      const prefix = team && item.from !== "you" && item.from !== agent.id ? `[${author?.name || item.author || "团队成员"}]\n` : "";
      return { role: item.from === agent.id ? "assistant" : "user", content: prefix + content(item) };
    });
    if (!messages.some((item) => item.role === "user" && item.content === userText)) {
      messages.push({ role: "user", content: userText });
    }
    return messages.reduce((result, item) => {
      const previous = result.at(-1);
      if (previous?.role === item.role) previous.content += `\n\n${item.content}`;
      else result.push({ ...item });
      return result;
    }, []);
  }

  function normalizeMessages(messages, allowedIds = null) {
    if (!Array.isArray(messages)) return [];
    return messages.filter((item) => item && typeof item === "object").map((item, index) => ({
      id: String(item.id || `restored-${index}`),
      ...(item.type === "day" ? { type: "day" } : { from: String(item.from || "you") }),
      text: String(item.text || "").slice(0, 200000),
      time: String(item.time || "").slice(0, 40),
      author: String(item.author || "").slice(0, 120),
      error: Boolean(item.error),
      ...(typeof item.streaming === "boolean" ? { streaming: item.streaming } : {}),
      mode: item.mode === "execute" ? "execute" : "discuss",
      requestId: String(item.requestId || ""),
      replyTo: String(item.replyTo || ""),
      chips: Array.isArray(item.chips) ? item.chips.map(String).slice(0, 8) : [],
      attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 5).map((file) => ({
        name: String(file?.name || "附件").slice(0, 240),
        size: Math.min(262144, Math.max(0, Number(file?.size) || 0)),
        text: String(file?.text || "").slice(0, 262144),
      })) : [],
    })).filter((item) => item.type === "day" || !allowedIds || item.from === "you" || allowedIds.includes(item.from));
  }

  function endpoint(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error("请填写有效的模型服务地址"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("模型地址只支持 HTTP / HTTPS，且不能包含用户名或密码");
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  }

  /**
   * 校验名称和后台配置；工作区留空时由电脑创建默认目录。
   * @param {object} draft 待创建或编辑的 Agent 配置
   * @param {object[]} agents 已有 Agent 列表
   * @param {string} [editingId] 编辑时排除当前 Agent 的编号
   * @returns {object} 校验并统一 CLI 执行内核后的原对象
   * 注意事项：这里只校验配置，实际目录创建和可写性检查由可信主进程完成。
   */
  function validateAgent(draft, agents, editingId = "") {
    if (!draft.name.trim()) throw new Error("请为 Agent 填写名称");
    if (draft.name.includes("@") || /\s/.test(draft.name)) throw new Error("名称不能包含空格或 @，以便准确点名");
    if (agents.some((agent) => agent.id !== editingId && agent.name.toLocaleLowerCase() === draft.name.toLocaleLowerCase())) {
      throw new Error("这个 Agent 名称已存在，请换一个名称");
    }
    if (draft.backend === "model" && !draft.model.trim()) throw new Error("请填写模型 ID");
    if (draft.backend === "model" && draft.provider === "custom") draft.endpoint = endpoint(draft.endpoint);
    if (["codex", "claude", "cursor"].includes(draft.backend)) {
      draft.harness = draft.backend;
    }
    return draft;
  }

  /** 网关只共享白名单配置；聊天、草稿和任何凭据始终留在所属设备。 */
  function gatewaySnapshot(agents, rooms, localExecution) {
    const fields = ["id", "name", "initial", "label", "role", "persona", "provider", "model", "backend", "harness", "harnessModel", "workspace", "workspaceMode", "endpoint"];
    return {
      agents: agents.map((agent) => {
        const config = Object.fromEntries(fields.map((field) => [field, typeof agent[field] === "string" ? agent[field] : ""]));
        config.backend = ["codex", "claude", "cursor"].includes(config.backend) ? config.backend : "model";
        if (config.backend !== "model") config.harness = config.backend;
        config.workspaceMode = agent.workspaceMode === "auto" || agent.workspaceMode === "project" ? agent.workspaceMode : config.workspace.trim() ? "project" : "auto";
        return { ...config, temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.7 };
      }),
      rooms: rooms.map((room) => ({ id: String(room.id), name: String(room.name), agentIds: [...new Set(room.agentIds || [])], rule: room.rule === "mention" ? "mention" : "free", workspace: String(room.workspace || "") })),
      settings: { localExecution: localExecution !== false },
    };
  }

  /** 同 ID 配置更新不会替换线程对象；手机自己的其他 Agent 和团队也保留。 */
  function importGatewayConfig(agents, rooms, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.agents) || !snapshot.agents.length || !Array.isArray(snapshot.rooms)) throw new Error("Mac 没有返回有效的 Agent 配置");
    if (snapshot.agents.length > 200 || snapshot.rooms.length > 200) throw new Error("Mac 配置数量过多");
    const clean = gatewaySnapshot(snapshot.agents, snapshot.rooms, snapshot.settings?.localExecution);
    const ids = new Set();
    clean.agents.forEach((agent) => {
      if (!agent.id || ids.has(agent.id) || !agent.name) throw new Error("Mac 的 Agent 配置无效或重复");
      ids.add(agent.id);
    });
    const roomIds = new Set();
    clean.rooms.forEach((room) => {
      if (!room.id || roomIds.has(room.id) || !room.name) throw new Error("Mac 的团队配置无效或重复");
      roomIds.add(room.id);
      room.agentIds = room.agentIds.filter((id) => ids.has(id));
    });
    return {
      agents: clean.agents.map((config) => ({ ...config, desktopManaged: true, messages: agents.find((item) => item.id === config.id)?.messages || [] })).concat(agents.filter((item) => !ids.has(item.id))),
      rooms: clean.rooms.map((config) => ({ ...config, messages: rooms.find((item) => item.id === config.id)?.messages || [] })).concat(rooms.filter((item) => !roomIds.has(item.id))),
      remoteAgentIds: [...ids],
      remoteRoomIds: [...roomIds],
      localExecution: clean.settings.localExecution,
    };
  }

  return { content, responders, groupInstructions, silentGroupReply, groupTurnQueue, modelMessages, normalizeMessages, endpoint, validateAgent, gatewaySnapshot, importGatewayConfig };
});
