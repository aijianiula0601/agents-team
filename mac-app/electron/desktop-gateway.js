const http = require("node:http");
const os = require("node:os");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const log = require("./log");

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_RESULTS = 64;
const MAX_STREAM_TEXT_BYTES = 2 * 1024 * 1024;
const CLI_BACKENDS = new Set(["codex", "claude", "cursor"]);
const WORKSPACE_BUSY = "这个工作区已有 Harness 正在执行，请等待它结束或关闭终端";
const AGENT_STRINGS = ["id", "name", "initial", "label", "role", "persona", "provider", "model", "harnessModel", "backend", "harness", "workspace", "workspaceMode"];

class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 可选手机网关。构造时不监听；只有桌面显式 start 后才允许携带本次随机令牌的请求。
 * @param {object} options 本机配置、执行函数、终端接口与可选超时配置
 * @returns {{start: Function, stop: Function, status: Function}} 受控网关生命周期接口
 * 注意事项：completeChat/runHarness 的第二参数接收 signal/onText；后台与路径始终取自电脑配置。
 * requestTimeoutMs 默认 0 表示不限制总执行时间；流式轮询连续失联后仍会取消任务。
 */
function createDesktopGateway({ getSnapshot, completeChat, runHarness, terminals, requestTimeoutMs = 0, bodyTimeoutMs = 15000, streamLeaseMs = 60000, version = "0.4.0" } = {}) {
  if (typeof getSnapshot !== "function") throw new Error("手机网关需要本机 Agent 配置");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 0 || !Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs < 1 || !Number.isFinite(streamLeaseMs) || streamLeaseMs < 1) {
    throw new Error("手机网关超时配置无效");
  }
  let current = null;
  let starting = null;
  let stopping = null;

  function status() {
    if (!current || current.stopping) return { enabled: false, host: "", port: 0, token: "", url: "", urls: [] };
    const urls = connectionUrls(current.host, current.port);
    return { enabled: true, host: current.host, port: current.port, token: current.token, url: urls[0], urls };
  }

  async function start({ host = "127.0.0.1", port = 47631 } = {}) {
    if (stopping) await stopping;
    if (starting) return starting;
    if (current) return status();
    if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("手机网关监听地址或端口无效");
    }
    starting = (async () => {
      const state = { token: randomBytes(32).toString("hex"), epoch: randomUUID(), host, port, runs: new Map(), streams: new Map(), cancelledRuns: new Map(), sessions: new Map(), terminalKeys: new Map(), stopping: false };
      state.server = http.createServer((req, res) => {
        handleRequest(state, req, res).catch((error) => {
          if (error?.message === WORKSPACE_BUSY) error = new GatewayError(409, WORKSPACE_BUSY);
          const known = error instanceof GatewayError;
          sendJson(res, known ? error.status : 503, { error: known ? error.message : "主设备处理失败，请检查 CLI 登录、额度和工作区后重试" });
        });
      });
      state.server.requestTimeout = bodyTimeoutMs;
      state.server.headersTimeout = bodyTimeoutMs;
      state.server.keepAliveTimeout = 5000;
      state.server.maxHeadersCount = 50;
      await new Promise((resolve, reject) => {
        const failed = (error) => { state.server.removeListener("listening", ready); reject(error); };
        const ready = () => { state.server.removeListener("error", failed); resolve(); };
        state.server.once("error", failed);
        state.server.once("listening", ready);
        state.server.listen(port, host);
      });
      state.port = state.server.address().port;
      state.server.on("error", () => log.error("手机连接网关发生网络错误"));
      current = state;
      log.info(`手机连接网关已启动，端口 ${state.port}`);
      return status();
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function stop() {
    if (starting) { try { await starting; } catch (_) { return status(); } }
    if (stopping) return stopping;
    const state = current;
    if (!state) return status();
    state.stopping = true;
    stopping = (async () => {
      for (const controller of state.runs.values()) controller.abort(new GatewayError(409, "任务已停止"));
      await Promise.allSettled([...state.sessions.keys()].map((id) => terminals.close(id)));
      state.sessions.clear();
      state.terminalKeys.clear();
      state.cancelledRuns.clear();
      for (const record of state.streams.values()) clearTimeout(record.timer);
      state.streams.clear();
      await new Promise((resolve) => {
        state.server.close(resolve);
        state.server.closeAllConnections();
      });
      if (current === state) current = null;
      log.info("手机连接网关已关闭");
      return status();
    })();
    try { return await stopping; } finally { stopping = null; }
  }

  async function handleRequest(state, req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // 浏览器预检不携带 Bearer；只返回方法信息，所有实际路由仍必须校验令牌。
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204);
      res.end();
      return;
    }
    if (state.stopping) throw new GatewayError(503, "手机连接已关闭");
    if (!authenticated(req.headers.authorization, state.token)) throw new GatewayError(401, "连接令牌无效，请在主设备重新获取");
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch (_) { throw new GatewayError(400, "请求地址无效"); }
    if (req.method === "GET" && url.pathname === "/info") {
      return sendJson(res, 200, { name: "Chorus", version, protocolVersion: 1, capabilities: { chat: typeof completeChat === "function", execution: typeof runHarness === "function", terminal: Boolean(terminals), chatStreaming: true } });
    }
    if (req.method === "GET" && url.pathname === "/config") {
      return sendJson(res, 200, publicSnapshot(await snapshot()));
    }
    if (req.method === "GET" && /^\/chat\/[^/]+$/.test(url.pathname)) {
      const runId = decodeId(url.pathname.slice("/chat/".length));
      const record = state.streams.get(runId);
      if (!record) throw new GatewayError(404, "流式任务不存在或已过期");
      if (record.reply.status === "running") record.timer.refresh();
      return sendJson(res, 200, record.reply);
    }
    if (req.method === "GET" && /^\/terminal\/[^/]+$/.test(url.pathname)) {
      const id = decodeId(url.pathname.slice("/terminal/".length));
      ownSession(state, id);
      const raw = url.searchParams.get("after") || "0";
      if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new GatewayError(400, "终端读取位置无效");
      return sendJson(res, 200, terminalResult(state, await terminals.read(id, { after: Number(raw) })));
    }
    if (req.method !== "POST") throw new GatewayError(404, "接口不存在");
    if (!["/chat", "/cancel", "/terminal/open", "/terminal/write", "/terminal/resize", "/terminal/close"].includes(url.pathname)) {
      throw new GatewayError(404, "接口不存在");
    }
    const body = await readBody(req, bodyTimeoutMs);
    if (state.stopping) throw new GatewayError(503, "手机连接已关闭");
    if (url.pathname === "/chat") return chat(state, body, res);
    if (url.pathname === "/cancel") {
      onlyFields(body, ["runId"]);
      const runId = identifier(body.runId, "任务编号");
      const controller = state.runs.get(runId);
      const cancelled = Boolean(controller && !controller.signal.aborted);
      if (cancelled) controller.abort(new GatewayError(409, "任务已停止"));
      else {
        // 原生 HTTP 无法直接中断；取消可能先于聊天上传到达，短期记住编号避免迟到请求再启动 CLI。
        const now = Date.now();
        for (const [id, expiry] of state.cancelledRuns) if (expiry <= now) state.cancelledRuns.delete(id);
        if (state.cancelledRuns.size >= 128) state.cancelledRuns.delete(state.cancelledRuns.keys().next().value);
        state.cancelledRuns.set(runId, now + 60000);
      }
      return sendJson(res, 200, { cancelled });
    }
    if (!terminals) throw new GatewayError(503, "主设备尚未启用终端");
    if (url.pathname === "/terminal/open") {
      onlyFields(body, ["agentId", "threadKey", "resumeSessionId", "cols", "rows"]);
      const local = await snapshot();
      const agent = allowedAgent(local, body.agentId);
      if (!local.settings?.localExecution) throw new GatewayError(403, "请在主设备开启本机执行");
      const threadKey = body.threadKey === undefined ? `agent:${agent.id}` : identifier(body.threadKey, "对话编号");
      allowedThread(local, agent.id, threadKey);
      const resumeSessionId = body.resumeSessionId || "";
      if (typeof resumeSessionId !== "string" || (resumeSessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(resumeSessionId))) {
        throw new GatewayError(400, "CLI 历史会话编号无效");
      }
      const harness = CLI_BACKENDS.has(agent.backend) ? agent.backend : agent.harness;
      if (!CLI_BACKENDS.has(harness)) throw new GatewayError(400, "请在主设备为这个 Agent 选择编程后台");
      const dims = dimensions(body);
      const terminalKey = JSON.stringify([agent.id, threadKey]);
      if (state.terminalKeys.size >= 8 && !state.terminalKeys.has(terminalKey)) {
        throw new GatewayError(429, "手机终端会话过多，请先关闭不用的终端");
      }
      // 保持键长固定，旧存档中的长 Agent 编号也不会超过终端管理器的长度限制。
      const terminalAgentId = state.terminalKeys.get(terminalKey) || `gateway-${state.epoch}-${randomUUID()}`;
      state.terminalKeys.set(terminalKey, terminalAgentId);
      let session;
      try { session = await terminals.open({ harness, harnessModel: agent.harnessModel, cwd: agent.workspace, workspaceMode: agent.workspaceMode, agentName: agent.name, agentId: terminalAgentId, sessionAgentId: agent.id, threadKey, resumeSessionId, ...dims }); }
      catch (error) {
        if (![...state.sessions.values()].some((item) => item.terminalKey === terminalKey)) state.terminalKeys.delete(terminalKey);
        throw error;
      }
      if (!session || typeof session.sessionId !== "string") throw new Error("终端返回无效");
      if (state.stopping) {
        await terminals.close(session.sessionId);
        throw new GatewayError(503, "手机连接已关闭");
      }
      for (const [id, record] of state.sessions) {
        if (record.terminalKey === terminalKey && id !== session.sessionId) state.sessions.delete(id);
      }
      state.sessions.set(session.sessionId, { agentId: agent.id, threadKey, terminalKey });
      return sendJson(res, 200, terminalResult(state, session));
    }
    onlyFields(body, url.pathname === "/terminal/write" ? ["sessionId", "data"] : url.pathname === "/terminal/resize" ? ["sessionId", "cols", "rows"] : ["sessionId"]);
    const id = identifier(body.sessionId, "终端编号");
    ownSession(state, id);
    const record = state.sessions.get(id);
    if (url.pathname === "/terminal/write") {
      if (typeof body.data !== "string" || Buffer.byteLength(body.data, "utf8") > 65536) throw new GatewayError(400, "终端输入不能超过 64 KB");
      await terminals.write(id, body.data);
      return sendJson(res, 200, { written: true });
    }
    if (url.pathname === "/terminal/resize") {
      const dims = dimensions(body, true);
      await terminals.resize(id, dims);
      return sendJson(res, 200, dims);
    }
    const result = await terminals.close(id);
    state.terminalKeys.delete(record.terminalKey);
    state.sessions.delete(id);
    return sendJson(res, 200, { closed: Boolean(result?.closed) });
  }

  async function chat(state, body, res) {
    onlyFields(body, ["agentId", "messages", "threadKey", "runId", "mode", "stream"]);
    if (body.stream !== undefined && typeof body.stream !== "boolean") throw new GatewayError(400, "流式配置无效");
    const local = await snapshot();
    const agent = allowedAgent(local, body.agentId);
    const messages = chatMessages(body.messages);
    const threadKey = body.threadKey === undefined ? `agent:${agent.id}` : identifier(body.threadKey, "对话编号");
    const room = allowedThread(local, agent.id, threadKey);
    const runId = body.runId === undefined ? randomUUID() : identifier(body.runId, "任务编号");
    const mode = body.mode || "discuss";
    if (!["discuss", "execute"].includes(mode)) throw new GatewayError(400, "对话模式无效");
    const cancelledUntil = state.cancelledRuns.get(runId);
    state.cancelledRuns.delete(runId);
    if (cancelledUntil > Date.now()) throw new GatewayError(409, "任务已停止");
    if ((mode === "execute" || CLI_BACKENDS.has(agent.backend)) && !local.settings?.localExecution) {
      throw new GatewayError(403, "请在主设备开启本机执行");
    }
    if (state.runs.has(runId) || state.streams.has(runId)) throw new GatewayError(409, "这个任务编号正在运行或保留结果，请使用新编号");
    if (state.runs.size >= 8) throw new GatewayError(429, "主设备正在处理过多手机请求，请稍后重试");
    const controller = new AbortController();
    state.runs.set(runId, controller);
    // ------------ 执行不设总时限，流式手机连接通过轮询续期并保留取消能力 ---------------
    const timeout = requestTimeoutMs > 0 ? setTimeout(() => controller.abort(new GatewayError(504, "主设备处理超时，任务已停止")), requestTimeoutMs) : null;
    let record;
    if (body.stream) {
      if (state.streams.size >= MAX_STREAM_RESULTS) {
        const expired = [...state.streams].find(([, entry]) => entry.reply.status !== "running");
        if (expired) { clearTimeout(expired[1].timer); state.streams.delete(expired[0]); }
      }
      record = { reply: { runId, status: "running", text: "" }, timer: setTimeout(() => controller.abort(new GatewayError(409, "手机连接已断开，任务已停止")), streamLeaseMs) };
      record.timer.unref?.();
      state.streams.set(runId, record);
      sendJson(res, 202, record.reply);
      log.info(`------------- 手机流式任务开始 active=${state.runs.size} --------------`);
    }
    const disconnected = () => { if (!res.writableEnded) controller.abort(new GatewayError(409, "手机连接已断开，任务已停止")); };
    if (!record) res.once("close", disconnected);
    let aborted;
    const cancelled = new Promise((_, reject) => {
      aborted = () => reject(controller.signal.reason || new GatewayError(409, "任务已停止"));
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      const internalId = `gateway-${state.epoch}-${randomUUID()}`;
      const context = {
        signal: controller.signal,
        /** 更新累计正文；参数为生成中的文字；无返回值；取消后忽略迟到回调并限制缓存大小。 */
        onText(text) {
          if (!record || controller.signal.aborted || record.reply.status !== "running" || typeof text !== "string") return;
          if (Buffer.byteLength(text, "utf8") > MAX_STREAM_TEXT_BYTES) { controller.abort(new GatewayError(503, "主设备回复内容过大")); return; }
          record.reply.text = text;
        },
      };
      let action;
      if (mode === "execute") {
        const harness = CLI_BACKENDS.has(agent.harness) ? agent.harness : agent.backend;
        if (!CLI_BACKENDS.has(harness)) throw new GatewayError(400, "请在主设备配置执行内核");
        if (typeof runHarness !== "function") throw new GatewayError(503, "主设备尚未启用执行后台");
        const transcript = messages.map((item) => `${item.role === "assistant" ? agent.name : "对话上下文"}：${item.content}`).join("\n\n");
        const prompt = `你是 ${agent.name}（${agent.role}）。${agent.persona}\n${room ? `你正在参与团队「${room.name}」，请结合前序成员的意见执行本轮任务。` : "请处理当前私聊任务。"}\n\n${transcript}`;
        action = Promise.resolve().then(() => runHarness({ harness, harnessModel: agent.harnessModel, cwd: agent.workspace, workspaceMode: agent.workspaceMode, agentName: agent.name, interaction: "agent", prompt, runId: internalId, agentId: agent.id, threadKey }, context));
      } else {
        if (typeof completeChat !== "function") throw new GatewayError(503, "主设备尚未启用对话后台");
        const contextual = room ? { ...agent, persona: `${agent.persona}\n你正在团队「${room.name}」中协作，请结合其他成员已给出的意见继续推进。` } : agent;
        action = Promise.resolve().then(() => completeChat({ agent: contextual, messages, workspace: agent.workspace || "", runId: internalId, threadKey }, context));
      }
      const result = await Promise.race([action, cancelled]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (result?.ok === false) throw new Error("后台执行失败");
      const text = typeof result === "string" ? result : result?.text;
      if (typeof text !== "string" || !text.trim()) throw new Error("后台返回无效");
      if (Buffer.byteLength(text, "utf8") > MAX_STREAM_TEXT_BYTES) throw new GatewayError(503, "主设备回复内容过大");
      const reply = { runId, text, via: mode === "execute" ? "execute" : typeof result?.via === "string" ? result.via : agent.backend || "model", ...(mode === "execute" ? { ok: true } : {}) };
      if (record) record.reply = { ...reply, status: "complete" };
      else return sendJson(res, 200, reply);
    } catch (error) {
      if (!record) throw error;
      const message = error?.message === WORKSPACE_BUSY ? WORKSPACE_BUSY : error instanceof GatewayError ? error.message : "主设备处理失败，请检查 CLI 登录、额度和工作区后重试";
      record.reply = { ...record.reply, status: "error", error: message };
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", disconnected);
      controller.signal.removeEventListener("abort", aborted);
      state.runs.delete(runId);
      if (record) {
        clearTimeout(record.timer);
        if (!state.stopping) {
          record.timer = setTimeout(() => state.streams.delete(runId), streamLeaseMs);
          record.timer.unref?.();
        }
        log.info(`------------- 手机流式任务结束 status=${record.reply.status} active=${state.runs.size} --------------`);
      }
    }
  }

  async function snapshot() {
    const value = await getSnapshot();
    if (!value || !Array.isArray(value.agents)) throw new GatewayError(503, "请在主设备配置 Agent 后重新连接");
    return value;
  }

  return { start, stop, status };
}

function authenticated(header, token) {
  if (typeof header !== "string" || !/^Bearer [0-9a-f]{64}$/.test(header)) return false;
  return timingSafeEqual(Buffer.from(header.slice(7)), Buffer.from(token));
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function onlyFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new GatewayError(400, "请求包含不允许的配置；后台和工作区只能在主设备设置");
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new GatewayError(400, `${label}格式无效`);
  return value;
}

function decodeId(value) {
  try { return identifier(decodeURIComponent(value), "终端编号"); }
  catch (_) { throw new GatewayError(400, "终端编号格式无效"); }
}

function allowedAgent(snapshot, id) {
  identifier(id, "Agent 编号");
  const source = snapshot.agents.find((agent) => agent && agent.id === id);
  if (!source) throw new GatewayError(403, "这个 Agent 不在主设备的允许列表中");
  const agent = agentFields(source);
  agent.endpoint = typeof source.endpoint === "string" ? source.endpoint : "";
  return agent;
}

function allowedThread(snapshot, agentId, threadKey) {
  if (threadKey === `agent:${agentId}`) return null;
  const room = (snapshot.rooms || []).find((item) => item && threadKey === `room:${item.id}` && Array.isArray(item.agentIds) && item.agentIds.includes(agentId));
  if (!room) throw new GatewayError(403, "这个 Agent 不属于请求的对话或团队");
  return { id: room.id, name: typeof room.name === "string" ? room.name : "团队" };
}

function agentFields(agent) {
  return { ...Object.fromEntries(AGENT_STRINGS.map((key) => [key, typeof agent[key] === "string" ? agent[key] : ""])), temperature: typeof agent.temperature === "number" ? agent.temperature : 0.7, notify: Boolean(agent.notify) };
}

/** 配置按字段白名单导出，历史、API Key、令牌和服务地址均不出现在手机同步中。 */
function publicSnapshot(snapshot) {
  const agents = snapshot.agents.filter((item) => item && typeof item.id === "string").map(agentFields);
  const ids = new Set(agents.map((item) => item.id));
  const rooms = (Array.isArray(snapshot.rooms) ? snapshot.rooms : []).filter((item) => item && typeof item.id === "string").map((item) => ({
    id: item.id, name: typeof item.name === "string" ? item.name : "团队", agentIds: Array.isArray(item.agentIds) ? item.agentIds.filter((id) => ids.has(id)) : [], rule: item.rule === "mention" ? "mention" : "free", workspace: typeof item.workspace === "string" ? item.workspace : "",
  }));
  return { agents, rooms, settings: { localExecution: Boolean(snapshot.settings?.localExecution) } };
}

function chatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 60) throw new GatewayError(400, "对话记录为空或过长");
  return messages.map((item) => {
    if (!item || typeof item !== "object" || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || !item.content.trim()) {
      throw new GatewayError(400, "对话格式无效");
    }
    return { role: item.role, content: item.content };
  });
}

function dimensions(body, required = false) {
  const result = {};
  for (const key of ["cols", "rows"]) {
    if (body[key] === undefined && !required) continue;
    if (!Number.isInteger(body[key]) || body[key] < 2 || body[key] > (key === "rows" ? 300 : 500)) throw new GatewayError(400, "终端尺寸无效");
    result[key] = body[key];
  }
  return result;
}

function ownSession(state, id) {
  if (!state.sessions.has(id)) throw new GatewayError(404, "终端不属于这次手机连接，请重新打开");
}

function terminalResult(state, result) {
  if (!result || typeof result.sessionId !== "string") throw new Error("终端返回无效");
  ownSession(state, result.sessionId);
  const record = state.sessions.get(result.sessionId);
  return { sessionId: result.sessionId, agentId: record.agentId, threadKey: record.threadKey, resumeSessionId: result.resumeSessionId || "", harness: result.harness, cwd: result.cwd, status: result.status, cols: result.cols, rows: result.rows, createdAt: result.createdAt, output: typeof result.output === "string" ? result.output : "", startOffset: result.startOffset, nextOffset: result.nextOffset, reset: Boolean(result.reset), exitCode: result.exitCode ?? null, signal: result.signal ?? null };
}

function readBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", failed);
      req.removeListener("aborted", failed);
      chunks = [];
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const failed = () => finish(new GatewayError(400, "请求内容未完整接收"));
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return finish(new GatewayError(413, "请求不能超过 1 MB，请缩短历史或附件"));
      chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (_) { finish(new GatewayError(400, "请求必须是有效 JSON")); }
    };
    const timer = setTimeout(() => finish(new GatewayError(408, "请求上传超时")), timeoutMs);
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    req.once("aborted", failed);
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) finish(new GatewayError(413, "请求不能超过 1 MB，请缩短历史或附件"));
  });
}

function connectionUrls(host, port) {
  if (host === "::1") return [`http://[::1]:${port}`];
  if (host !== "0.0.0.0") return [`http://${host}:${port}`];
  const addresses = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && !entry.internal && (entry.family === "IPv4" || entry.family === 4)).map((entry) => entry.address);
  return [...new Set([...addresses, "127.0.0.1"])].map((address) => `http://${address}:${port}`);
}

module.exports = { createDesktopGateway };
