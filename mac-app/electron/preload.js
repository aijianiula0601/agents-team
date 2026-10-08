const { contextBridge, ipcRenderer } = require("electron");

const progressHandlers = new Map();
let nextRequestId = 0;

/**
 * 按独立请求编号分发累计文本，避免并行成员或后续任务串流。
 * @param {object} _event Electron 事件，不交给页面
 * @param {object} progress 仅包含 requestId 和累计 text
 * @returns {void}
 * 注意事项：已完成请求没有订阅；界面回调异常不影响其他成员和原生任务。
 */
function receiveProgress(_event, progress) {
  if (typeof progress?.text !== "string") return;
  const handler = progressHandlers.get(progress.requestId);
  if (handler) { try { handler(progress.text); } catch (_) { /* 页面重新渲染不能中断其余成员的输出。 */ } }
}

/**
 * 发起受控 IPC 并为可选正文回调建立独立订阅。
 * @param {string} channel 固定白名单调用通道
 * @param {object} payload 任务参数，runId 仍专门用于取消
 * @param {(text: string) => void} [onText] 累计正文回调
 * @returns {Promise<object>} 原生最终结果
 * 注意事项：成功、失败和取消都清理订阅；所有并发任务共用一个底层监听器。
 */
async function invokeWithProgress(channel, payload, onText) {
  if (onText === undefined) return ipcRenderer.invoke(channel, payload);
  if (typeof onText !== "function") throw new TypeError("onText 必须是函数");
  const requestId = `stream-${Date.now().toString(36)}-${++nextRequestId}`;
  if (!progressHandlers.size) ipcRenderer.on("chorus:run-progress", receiveProgress);
  progressHandlers.set(requestId, onText);
  try {
    return await ipcRenderer.invoke(channel, { ...payload, streamRequestId: requestId });
  } finally {
    progressHandlers.delete(requestId);
    if (!progressHandlers.size) ipcRenderer.removeListener("chorus:run-progress", receiveProgress);
  }
}

/**
 * 向渲染进程暴露受控桌面桥。
 * 功能：声明平台标识，并转发打开设置事件。
 * 参数：无
 * 返回值：无
 * 注意事项：仅暴露白名单 API，禁止直接透传 ipcRenderer。
 */
contextBridge.exposeInMainWorld("chorusDesktop", {
  platform: "mac",
  /**
   * 订阅「打开设置」菜单事件。
   * @param {() => void} handler 回调
   * @returns {() => void} 取消订阅函数
   */
  onOpenSettings(handler) {
    if (typeof handler !== "function") throw new TypeError("handler 必须是函数");
    const listener = () => handler();
    ipcRenderer.on("chorus:open-settings", listener);
    return () => ipcRenderer.removeListener("chorus:open-settings", listener);
  },
  /**
   * 把中转服务返回的 Google 授权码页面交给系统浏览器。
   * @param {string} authorizationUrl 授权地址，不得包含会话或轮询 token
   * @returns {Promise<{opened: boolean}>}
   */
  openGoogleAuthorization(authorizationUrl) {
    return ipcRenderer.invoke("chorus:google-open", authorizationUrl);
  },
  /** 通过原生剪贴板复制，兼容禁止网页剪贴板权限的 file:// 界面。 */
  copyText(text) {
    return ipcRenderer.invoke("chorus:copy-text", text);
  },
  /**
   * 调用 Agent 选择的模型或完整编程 CLI 后台，CLI 可在绑定工作区修改代码。
   * @param {object} payload agent、messages、workspace、runId（可选）
   * @param {(text: string) => void} [onText] 生成中的累计正文，按请求隔离
   * @returns {Promise<{text: string, via: string}>}
   * 注意事项：回调可选；任务结束和取消后自动清理订阅。
   */
  completeChat(payload, onText) {
    return invokeWithProgress("chorus:complete-chat", payload, onText);
  },
  /**
   * 读取应用版本等只读信息。
   * @returns {Promise<{name: string, version: string, platform: string, arch: string, hostname: string}>}
   */
  getAppInfo() {
    return ipcRenderer.invoke("chorus:get-app-info");
  },
  /** 读取原生更新版本；无参数；返回平台、架构、版本及构建号；不暴露文件系统。 */
  getUpdateInfo() {
    return ipcRenderer.invoke("chorus:get-update-info");
  },
  /** 下载并打开可信更新；参数为 relayUrl 和 release；返回安装器状态；主进程重新获取并校验清单。 */
  downloadUpdate(payload) {
    return ipcRenderer.invoke("chorus:download-update", payload);
  },
  /** 订阅更新进度；参数为回调；返回取消订阅函数；仅传递白名单进度事件。 */
  onUpdateProgress(handler) {
    if (typeof handler !== "function") throw new TypeError("handler 必须是函数");
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("chorus:update-progress", listener);
    return () => ipcRenderer.removeListener("chorus:update-progress", listener);
  },
  /**
   * 返回密钥是否已配置，不把明文交给页面。
   * @returns {Promise<{openaiConfigured: boolean, anthropicConfigured: boolean, customConfigured: boolean, ollamaBase: string}>}
   */
  getModelSettings() {
    return ipcRenderer.invoke("chorus:get-model-settings");
  },
  /**
   * 使用系统钥匙串加密保存模型密钥。空字符串保留旧值，null 清除。
   * @param {object} settings 模型设置
   * @returns {Promise<object>}
   */
  saveModelSettings(settings) {
    return ipcRenderer.invoke("chorus:save-model-settings", settings);
  },
  /** 更新主电脑远程配置身份；参数为账号、设备及 primary；返回公开密钥或 null；私钥始终留在主进程。 */
  setHostConfigContext(context) {
    return ipcRenderer.invoke("chorus:host-config-context", context);
  },
  /** 执行已领取的主电脑配置命令；参数为绑定身份的命令；返回脱敏结果；不能执行任意代码。 */
  executeHostCommand(command) {
    return ipcRenderer.invoke("chorus:host-config-command", command);
  },
  /**
   * 在本机工作区运行 Codex / Claude Code / Cursor。
   * @param {object} payload harness、prompt、cwd、runId（可选）
   * @param {(text: string) => void} [onText] CLI 生成中的累计正文
   * @returns {Promise<{ok: boolean, text: string}>}
   * 注意事项：回调可选；只公开正文，不把原始工具或凭据事件交给页面。
   */
  runHarness(payload, onText) {
    return invokeWithProgress("chorus:run-harness", payload, onText);
  },
  /**
   * 终止指定模型请求或 CLI 进程；不存在的任务返回 cancelled: false。
   * @param {string} runId 发起请求时传入的任务编号
   * @returns {Promise<{cancelled: boolean}>}
   */
  cancelRun(runId) {
    return ipcRenderer.invoke("chorus:cancel-run", runId);
  },
  /**
   * 检查本机是否安装了各 Harness 命令。
   * @returns {Promise<{codex: object, claude: object, cursor: object}>}
   */
  probeHarness() {
    return ipcRenderer.invoke("chorus:probe-harness");
  },
  /**
   * 获取本机已安装 CLI 的真实可选模型。
   * @param {"codex"|"claude"|"cursor"} harness 执行内核
   * @returns {Promise<{models: {id: string, label: string}[], source: string, error?: string}>} 模型目录
   * 注意事项：目录来自 CLI，不读取密钥，不产生聊天或推理调用。
   */
  listHarnessModels(harness) {
    return ipcRenderer.invoke("chorus:list-harness-models", harness);
  },
  /**
   * 读取自定义 Harness 可执行路径。
   * @returns {Promise<{codex: string, claude: string, cursor: string}>}
   */
  getHarnessSettings() {
    return ipcRenderer.invoke("chorus:get-harness-settings");
  },
  /**
   * 保存并验证自定义 Harness 可执行路径，空值恢复自动探测。
   * @param {{codex?: string, claude?: string, cursor?: string}} settings 路径设置
   * @returns {Promise<object>}
   */
  saveHarnessSettings(settings) {
    return ipcRenderer.invoke("chorus:save-harness-settings", settings);
  },
  /**
   * 打开 Codex 或 Cursor CLI 的账号登录。
   * @param {"codex"|"cursor"} harness 内核类型
   * @returns {Promise<{ok: boolean, text: string}>}
   */
  loginHarness(harness) {
    return ipcRenderer.invoke("chorus:harness-login", harness);
  },
  /**
   * 把用户填写的工作区路径展开并确认目录可写。空字符串表示清除绑定。
   * @param {string} input 工作区路径
   * @returns {Promise<string>}
   */
  normalizeWorkspace(input) {
    return ipcRenderer.invoke("chorus:normalize-workspace", input);
  },
  /**
   * 自动创建按 Agent 名称隔离的默认工作区，保留已经配置的路径。
   * @param {object[]} agents Agent 编号、名称和工作区列表
   * @returns {Promise<{id: string, workspace: string}[]>} 电脑实际创建的工作区路径
   * 注意事项：根目录由主进程决定；仅电脑提供该能力，不向手机开放目录配置。
   */
  prepareAgentWorkspaces(agents) {
    return ipcRenderer.invoke("chorus:prepare-agent-workspaces", agents);
  },
  /**
   * 打开 macOS 目录选择器并返回规范化后的工作区路径，取消返回空字符串。
   * @returns {Promise<string>}
   */
  chooseWorkspace() {
    return ipcRenderer.invoke("chorus:choose-workspace");
  },
  /** 交互终端保留 CLI 自身的工具、键盘输入和权限审批。 */
  terminalOpen(payload) { return ipcRenderer.invoke("chorus:terminal-open", payload); },
  terminalWrite(id, data) { return ipcRenderer.invoke("chorus:terminal-write", id, data); },
  terminalResize(id, size) { return ipcRenderer.invoke("chorus:terminal-resize", id, size); },
  terminalRead(id, options) { return ipcRenderer.invoke("chorus:terminal-read", id, options); },
  terminalClose(id) { return ipcRenderer.invoke("chorus:terminal-close", id); },
  onTerminalEvent(handler) {
    if (typeof handler !== "function") throw new TypeError("handler 必须是函数");
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("chorus:terminal-event", listener);
    return () => ipcRenderer.removeListener("chorus:terminal-event", listener);
  },
  /** 手机连接默认关闭，显式开启后才监听本地网络。 */
  getGatewayStatus() { return ipcRenderer.invoke("chorus:gateway-status"); },
  startGateway(payload) { return ipcRenderer.invoke("chorus:gateway-start", payload); },
  stopGateway() { return ipcRenderer.invoke("chorus:gateway-stop"); },
  updateGatewayConfig(snapshot) { return ipcRenderer.invoke("chorus:gateway-config", snapshot); },
});
