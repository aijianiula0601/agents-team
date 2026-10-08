const { app, BrowserWindow, Menu, clipboard, dialog, shell, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./log");
const { openGoogleAuthorization } = require("./google-auth");
const { normalizeBaseUrl } = require("./llm");
const { completeAgentChat, normalizeBackend } = require("./chat-backend");
const { prepareAgentWorkspaces, resolveAgentWorkspace } = require("./agent-workspaces");
const { probeHarness, runHarness, startHarnessLogin, validateHarnessPaths, validateWorkspace } = require("./harness");
const { listHarnessModels } = require("./harness-models");
const { RunRegistry } = require("./run-registry");
const { HarnessSessions, harnessSessionKey } = require("./harness-sessions");
const { TerminalSessionManager } = require("./terminal-session");
const { createDesktopGateway } = require("./desktop-gateway");
const { createAppUpdater } = require("./app-updates");
const { createHostConfig } = require("./host-config");
const { probeHarnessAsync } = require("./harness-probe");
const { assertTrustedIpc, isSafeExternalUrl, isTrustedRendererUrl } = require("./ipc-security");
const {
  getHarnessSettings,
  getModelSecrets,
  getModelSettings,
  saveHarnessSettings,
  saveModelSettings,
} = require("./settings-store");

const RENDERER_FILE = path.join(__dirname, "..", "renderer", "index.html");
const runs = new RunRegistry();
let sessions;
let gatewaySnapshot = { agents: [], rooms: [], settings: { localExecution: true } };
const terminals = new TerminalSessionManager({
  onEvent(event) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("chorus:terminal-event", event);
  },
});
const gateway = createDesktopGateway({
  getSnapshot: () => gatewaySnapshot,
  completeChat: completeRequest,
  runHarness: harnessRequest,
  terminals: {
    open: openTerminal,
    write: (id, data) => terminals.write(id, data),
    resize: (id, size) => terminals.resize(id, size),
    read: (id, options) => terminals.read(id, options),
    close: (id) => terminals.close(id),
  },
});
const hostConfig = createHostConfig({
  /** 读取可展示的主电脑配置；无业务参数；返回密钥存在状态和实际路径；不含密钥正文。 */
  "settings.get": async () => { const modelSettings = getModelSettings(), harnessPaths = getHarnessSettings(); return { modelSettings, harnessPaths, harnessStatus: await probeHarnessAsync(harnessPaths) }; },
  /** 读取模型配置；无业务参数；返回存在状态；不解密密钥。 */
  "model.get": () => getModelSettings(),
  /** 保存解密后的模型配置；参数为模型设置；返回脱敏设置；沿用系统钥匙串。 */
  "model.save": (payload, assertCurrent) => { assertCurrent(); return saveValidatedModelSettings(payload); },
  /** 读取内核路径；无业务参数；返回主电脑实际路径；不读取另一台设备。 */
  "harness.get": () => getHarnessSettings(),
  /** 保存并验证主电脑内核路径；参数为路径对象；返回路径和检测结果；不存在的路径不保存。 */
  "harness.save": async (payload, assertCurrent) => { const paths = validateHarnessPaths(payload); assertCurrent(); saveHarnessSettings(paths); return { paths, probe: await probeHarnessAsync(paths) }; },
  /** 检测主电脑内核；无业务参数；返回安装和登录状态；不启动登录浏览器。 */
  "harness.probe": () => probeHarnessAsync(getHarnessSettings()),
  /** 查询主电脑模型列表；参数为内核名；返回真实模型目录；不执行推理。 */
  "harness.models": (payload) => listHarnessModels(payload.harness, getHarnessSettings()),
  /** 校验主电脑项目路径；参数为 path；返回规范路径；不会创建指定目录。 */
  "workspace.normalize": (payload) => typeof payload.path === "string" && payload.path.trim() ? validateWorkspace(payload.path) : "",
});

/** @type {BrowserWindow | null} */
let mainWindow = null;
const updater = createAppUpdater({
  app,
  shell,
  /** 转发原生更新进度；参数为安全进度事件；无返回值；窗口关闭后不再发送。 */
  onProgress(event) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("chorus:update-progress", event);
  },
});

/**
 * 创建 Chorus 主窗口。
 * 功能：加载 renderer UI，使用 macOS hiddenInset 标题栏以贴合原生体验。
 * 参数：无
 * 返回值：BrowserWindow 实例
 * 注意事项：开发态打开 DevTools 需手动；生产包禁用 nodeIntegration。
 */
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Chorus",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#23262a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(RENDERER_FILE, { query: { platform: "mac" } }).catch((error) => {
    log.error("加载界面失败", error);
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((error) => log.error("打开外部链接失败", error));
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, RENDERER_FILE)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((error) => log.error("打开外部链接失败", error));
    }
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.on("closed", () => {
    runs.cancelAll();
    terminals.closeAll();
    gateway.stop().catch(() => log.error("关闭手机连接失败"));
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

/**
 * 安装应用菜单（中文）。
 * 功能：提供标准 macOS 菜单，含设置快捷键发送到渲染进程。
 * 参数：无
 * 返回值：无
 */
function installAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: "关于 Chorus" },
              { type: "separator" },
              {
                label: "设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => mainWindow?.webContents.send("chorus:open-settings"),
              },
              { type: "separator" },
              { role: "hide", label: "隐藏 Chorus" },
              { role: "hideOthers", label: "隐藏其他" },
              { role: "unhide", label: "显示全部" },
              { type: "separator" },
              { role: "quit", label: "退出 Chorus" },
            ],
          },
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 应用就绪后启动主窗口。
 * 参数：无
 * 返回值：Promise<void>
 * 注意事项：启动时主动准备公共工作区根；目录权限异常只记录错误，仍打开窗口供用户修复配置。
 */
async function bootstrap() {
  // ------------ 单实例锁，避免重复打开多个主窗口 ---------------
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  await app.whenReady();
  // ------------ 主动准备公共工作区根，保留所有成员已有路径 ---------------
  try { prepareAgentWorkspaces([]); }
  catch (error) { log.error("公共工作区根目录准备失败，请检查目录权限", error); }
  installAppMenu();
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
}

function trust(event) {
  assertTrustedIpc(event, mainWindow?.webContents, RENDERER_FILE);
}

function sessionStore() {
  if (!sessions) sessions = new HarnessSessions(path.join(app.getPath("userData"), "harness-sessions.json"));
  return sessions;
}

/**
 * 执行桌面或已授权手机下发的成员对话，复用电脑配置和取消信号。
 * @param {object} payload 成员、上下文和运行编号
 * @param {{signal?: AbortSignal, onText?: Function}} [options] 网关取消信号或桌面累计正文回调
 * @returns {Promise<object>} 模型或原生 CLI 的实际回复
 * 注意事项：手机只能使用电脑允许的后台；默认目录按完整成员列表隔离，不记录聊天或凭据。
 */
async function completeRequest(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("模型请求格式无效");
  const backend = normalizeBackend(payload.agent);
  if (backend !== "model" && !gatewaySnapshot.settings.localExecution) throw new Error("请在设置中开启本机执行");
  const stored = backend === "model" ? getModelSecrets(payload.agent.provider || "openai") : {};
  const legacy = payload.keys && typeof payload.keys === "object" && !Array.isArray(payload.keys) ? payload.keys : {};
  const keys = {
    openai: stored.openai || legacy.openai || "",
    anthropic: stored.anthropic || legacy.anthropic || "",
    custom: stored.custom || legacy.custom || "",
    ollamaBase: stored.ollamaBase || legacy.ollamaBase,
  };
  return runs.run(payload.runId, (signal) => completeAgentChat(payload, {
    keys, harnessPaths: backend === "model" ? {} : getHarnessSettings(), sessions: sessionStore(), workspaceAgents: gatewaySnapshot.agents,
    signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, onText: options.onText,
  }));
}

/**
 * 执行主电脑 CLI 任务并补全成员的目录与模型配置。
 * @param {object} payload 页面或网关提交的执行任务
 * @param {{signal?: AbortSignal, onText?: Function}} options 外部取消信号和累计正文回调
 * @returns {Promise<object>} CLI 的真实执行结果
 * 注意事项：缺省配置来自本机已同步快照，最终目录仍在执行电脑重新解析。
 */
async function harnessRequest(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("后台请求格式无效");
  if (!gatewaySnapshot.settings.localExecution) throw new Error("请在设置中开启本机执行");
  const agent = gatewaySnapshot.agents.find((entry) => entry.id === payload.agentId);
  const request = { ...payload, agentName: payload.agentName ?? agent?.name, cwd: payload.cwd ?? agent?.workspace, workspaceMode: payload.workspaceMode ?? agent?.workspaceMode, harnessModel: payload.harnessModel ?? agent?.harnessModel };
  return runs.run(payload.runId, (signal) => runHarness(request, getHarnessSettings(), {
    sessions: sessionStore(), workspaceAgents: gatewaySnapshot.agents, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, onText: options.onText,
  }));
}

/**
 * 打开主电脑成员终端并恢复该聊天的原生会话。
 * @param {object} payload 成员、内核、模型和可选项目目录
 * @returns {object} 终端状态与增量输出
 * 注意事项：自动目录忽略其他设备路径，解析完成后再建立会话索引和工作区租约。
 */
function openTerminal(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("终端参数格式无效");
  if (!gatewaySnapshot.settings.localExecution) throw new Error("请在设置中开启本机执行");
  const agent = gatewaySnapshot.agents.find((entry) => entry.id === (payload.sessionAgentId || payload.agentId));
  const cwd = resolveAgentWorkspace({ ...agent, id: agent?.id || payload.agentId || "default", name: agent?.name || payload.agentName || payload.agentId || "Agent", workspace: payload.cwd ?? agent?.workspace, workspaceMode: payload.workspaceMode ?? agent?.workspaceMode }, { agents: gatewaySnapshot.agents });
  const key = harnessSessionKey({ threadKey: payload.threadKey, agentId: payload.sessionAgentId || payload.agentId }, payload.harness, cwd);
  const resumeSessionId = payload.resumeSessionId || sessionStore().get(key);
  return terminals.open({ ...payload, cwd, workspaceMode: "project", harnessModel: payload.harnessModel ?? agent?.harnessModel ?? "", resumeSessionId }, getHarnessSettings());
}

/** 网关仅保留执行所需配置，不复制聊天记录或页面中的密钥。 */
function updateGatewayConfig(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.rooms) || snapshot.agents.length > 200 || snapshot.rooms.length > 200) {
    throw new Error("主设备配置格式无效");
  }
  const fields = ["id", "name", "initial", "label", "role", "persona", "provider", "model", "harnessModel", "backend", "harness", "workspace", "workspaceMode", "endpoint"];
  const agents = snapshot.agents.map((agent) => {
    if (!agent || typeof agent !== "object") throw new Error("Agent 配置格式无效");
    return { ...Object.fromEntries(fields.map((field) => [field, typeof agent[field] === "string" ? agent[field] : ""])), temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.7, notify: Boolean(agent.notify) };
  });
  const rooms = snapshot.rooms.map((room) => {
    if (!room || typeof room !== "object") throw new Error("团队配置格式无效");
    return { id: room.id, name: room.name, agentIds: Array.isArray(room.agentIds) ? room.agentIds.filter((id) => typeof id === "string") : [], rule: room.rule, workspace: room.workspace };
  });
  const next = { agents, rooms, settings: { localExecution: snapshot.settings?.localExecution !== false } };
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > 2 * 1024 * 1024) throw new Error("主设备配置过大");
  const stopExecution = gatewaySnapshot.settings.localExecution && !next.settings.localExecution;
  gatewaySnapshot = next;
  if (stopExecution) {
    // ------------ 失去主电脑执行资格时统一停止桌面与远端任务 ---------------
    log.info("------------- 本机执行已关闭，停止全部任务与交互终端 --------------");
    runs.cancelAll();
    terminals.closeAll();
  }
  return { updated: true };
}

ipcMain.handle("chorus:get-platform", async (event) => {
  trust(event);
  return "mac";
});

ipcMain.handle("chorus:get-app-info", async (event) => {
  trust(event);
  return { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch, hostname: os.hostname() };
});

// ------------ 在线更新只允许可信主窗口调用，安装清单由主进程独立校验 ---------------
ipcMain.handle("chorus:get-update-info", (event) => { trust(event); return updater.getUpdateInfo(); });
ipcMain.handle("chorus:download-update", (event, payload) => { trust(event); return updater.downloadUpdate(payload); });

ipcMain.handle("chorus:google-open", async (event, authorizationUrl) => {
  trust(event);
  return openGoogleAuthorization(authorizationUrl, (url) => shell.openExternal(url));
});

ipcMain.handle("chorus:copy-text", async (event, value) => {
  trust(event);
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8 * 1024 * 1024) {
    throw new Error("复制内容无效或过大");
  }
  await clipboard.writeText(value);
  return (await clipboard.readText()) === value;
});

/**
 * 执行桌面对话并向原始可信页面合并推送进度。
 * @param {object} event 已通过可信 IPC 验证的事件
 * @param {object} payload 包含可选 streamRequestId 的任务参数
 * @param {Function} action 已实现鉴权和取消的对话或 CLI 执行函数
 * @returns {Promise<object>} 原生最终结果
 * 注意事项：每 50ms 最多推送一次累计正文，结束刷新并清理；每次发送重新验证原始 frame。
 */
async function runWithProgress(event, payload, action) {
  const requestId = payload?.streamRequestId;
  if (requestId === undefined) return action(payload);
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error("流式请求编号格式无效");
  let pending = null;
  let timer = null;
  let finished = false;
  let lastSent = 0;
  /** 发送最新累计正文；无参数及返回值；原始页面变化后忽略推送，不输出正文日志。 */
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    lastSent = Date.now();
    try {
      trust(event);
      event.sender.send("chorus:run-progress", { requestId, text });
    } catch (_) { /* 原始页面已关闭或导航，禁止把正文发送到新页面。 */ }
  }
  try {
    return await action(payload, {
      /** 接收累计正文；参数为回复文本；无返回值；只保留最新内容，避免每个 token 复制全文。 */
      onText(text) {
        if (finished || typeof text !== "string") return;
        pending = text;
        if (Date.now() - lastSent >= 50) flush();
        else if (!timer) timer = setTimeout(flush, 50);
      },
    });
  } finally {
    finished = true;
    flush();
  }
}

ipcMain.handle("chorus:complete-chat", async (event, payload) => {
  trust(event);
  return runWithProgress(event, payload, completeRequest);
});

ipcMain.handle("chorus:get-model-settings", async (event) => {
  trust(event);
  return getModelSettings();
});

ipcMain.handle("chorus:save-model-settings", async (event, payload) => {
  trust(event);
  return saveValidatedModelSettings(payload);
});

/** 保存本机或远端模型设置；参数为设置对象；返回脱敏状态；统一执行地址及密钥校验。 */
function saveValidatedModelSettings(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("模型设置格式无效");
  const normalized = { ...payload };
  if (Object.prototype.hasOwnProperty.call(normalized, "ollamaBase")) {
    normalized.ollamaBase = normalizeBaseUrl(normalized.ollamaBase || "http://127.0.0.1:11434", {
      label: "Ollama Base URL",
      localOnly: true,
    });
  }
  return saveModelSettings(normalized);
}

/** 更新已认证主设备的配置身份；参数为账号及设备角色；返回公开密钥；主角色失效立即清理私钥。 */
ipcMain.handle("chorus:host-config-context", (event, context) => { trust(event); return hostConfig.setContext(context); });
/** 执行已领取的配置命令；参数为绑定身份的命令；返回脱敏结果；操作固定于白名单。 */
ipcMain.handle("chorus:host-config-command", (event, command) => { trust(event); return hostConfig.execute(command); });

ipcMain.handle("chorus:run-harness", async (event, payload) => {
  trust(event);
  return runWithProgress(event, payload, harnessRequest);
});

ipcMain.handle("chorus:terminal-open", (event, payload) => { trust(event); return openTerminal(payload); });
ipcMain.handle("chorus:terminal-write", (event, id, data) => { trust(event); return terminals.write(id, data); });
ipcMain.handle("chorus:terminal-resize", (event, id, size) => { trust(event); return terminals.resize(id, size); });
ipcMain.handle("chorus:terminal-read", (event, id, options) => { trust(event); return terminals.read(id, options); });
ipcMain.handle("chorus:terminal-close", (event, id) => { trust(event); return terminals.close(id); });
ipcMain.handle("chorus:gateway-status", (event) => { trust(event); return gateway.status(); });
ipcMain.handle("chorus:gateway-config", (event, snapshot) => { trust(event); return updateGatewayConfig(snapshot); });
ipcMain.handle("chorus:gateway-start", async (event, payload = {}) => {
  trust(event);
  if (payload.snapshot) updateGatewayConfig(payload.snapshot);
  return gateway.start({ host: "0.0.0.0", port: payload.port ?? 47631 });
});
ipcMain.handle("chorus:gateway-stop", (event) => { trust(event); return gateway.stop(); });

ipcMain.handle("chorus:cancel-run", async (event, runId) => {
  trust(event);
  return runs.cancel(runId);
});

ipcMain.handle("chorus:probe-harness", async (event) => {
  trust(event);
  return probeHarness(getHarnessSettings());
});

/** 获取所选本机内核的实际模型目录；参数为可信 IPC 与内核；返回目录 Promise；不会执行推理任务。 */
ipcMain.handle("chorus:list-harness-models", async (event, harness) => {
  trust(event);
  return listHarnessModels(harness, getHarnessSettings());
});

ipcMain.handle("chorus:get-harness-settings", async (event) => {
  trust(event);
  return getHarnessSettings();
});

ipcMain.handle("chorus:save-harness-settings", async (event, payload) => {
  trust(event);
  const paths = validateHarnessPaths(payload);
  saveHarnessSettings(paths);
  return { paths, probe: probeHarness(paths) };
});

ipcMain.handle("chorus:choose-workspace", async (event) => {
  trust(event);
  if (!mainWindow) return "";
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Chorus 工作区",
    buttonLabel: "选择工作区",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length !== 1) return "";
  const selected = result.filePaths[0];
  if (!path.isAbsolute(selected) || !fs.existsSync(selected)) throw new Error("选择的工作区无效");
  return validateWorkspace(selected);
});

ipcMain.handle("chorus:normalize-workspace", async (event, input) => {
  trust(event);
  if (typeof input !== "string") throw new Error("工作区路径格式无效");
  if (!input.trim()) return "";
  return validateWorkspace(input);
});

/**
 * 为可信桌面配置准备 Agent 默认工作区。
 * @param {Electron.IpcMainInvokeEvent} event 当前 renderer 的调用事件
 * @param {object[]} agents Agent 编号、名称及已有工作区
 * @returns {Promise<object[]>} 创建完成的 Agent 工作区配置
 * 注意事项：手机不可调用；默认根目录固定于主进程，页面不能指定任意创建位置。
 */
ipcMain.handle("chorus:prepare-agent-workspaces", async (event, agents) => {
  trust(event);
  return prepareAgentWorkspaces(agents);
});

ipcMain.handle("chorus:harness-login", async (event, harness) => {
  trust(event);
  if (typeof harness !== "string") throw new Error("Harness 类型无效");
  return startHarnessLogin(harness, getHarnessSettings());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  runs.cancelAll();
  terminals.closeAll();
  gateway.stop().catch(() => log.error("关闭手机连接失败"));
});

bootstrap().catch((err) => {
  log.error("启动失败", err);
  app.quit();
});
