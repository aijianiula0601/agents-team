// Chorus 工作台：团队共享讨论与 Agent 私聊分开保存。

    const AVATAR_COLORS = {
      Architect: { bg: "#3d4f66", fg: "#b8d0f0" },
      Coder: { bg: "#2f4f44", fg: "#9ee0c8" },
      Reviewer: { bg: "#5a4332", fg: "#f0c9a0" },
      PM: { bg: "#4a3d5c", fg: "#d4c0f0" },
      default: { bg: "#3a4048", fg: "#d0d5db" },
    };

    const HARNESS_LABEL = {
      none: "仅对话",
      codex: "Codex",
      claude: "Claude Code",
      cursor: "Cursor",
    };

    const state = {
      version: "0.4.0",
      agents: [
        {
          id: "a1",
          name: "Architect",
          role: "系统架构师",
          persona: "从边界、扩展性和失败模式出发，先画清楚再动手。",
          provider: "openai",
          model: "gpt-4.1",
          harness: "none",
          initial: "A",
          label: "",
          endpoint: "",
          temperature: 0.7,
        },
        {
          id: "a2",
          name: "Coder",
          role: "实现工程师",
          persona: "把方案落成可运行的最小改动，偏好清晰模块边界。",
          provider: "openai",
          model: "gpt-4.1",
          harness: "codex",
          initial: "C",
          label: "主力实现",
          endpoint: "",
          temperature: 0.4,
        },
        {
          id: "a3",
          name: "Reviewer",
          role: "代码审查官",
          persona: "专找回归风险、权限漏洞和不可测代码。",
          provider: "openai",
          model: "gpt-4.1",
          harness: "claude",
          initial: "R",
          label: "代码审查",
          endpoint: "",
          temperature: 0.3,
        },
        {
          id: "a4",
          name: "PM",
          role: "产品经理",
          persona: "盯住用户价值和验收标准，阻止过度设计。",
          provider: "openai",
          model: "gpt-4.1",
          harness: "none",
          initial: "P",
          label: "",
          endpoint: "",
          temperature: 0.7,
        },
      ],
      rooms: [
        {
          id: "r1",
          name: "产品研发团队",
          agentIds: ["a1", "a2", "a3"],
          rule: "free",
          workspace: "",
        },
        {
          id: "r2",
          name: "需求工作室",
          agentIds: ["a1", "a4"],
          rule: "mention",
          workspace: "",
        },
      ],
      activeRoomId: "r1",
      selectedAgentId: "a1",
      panelMode: "room", // room 为共享团队对话，agent 为独立私聊
      panelCollapsed: window.innerWidth <= 900,
      drafts: {},
      draftKey: "",
      running: null,
      activeRunId: "",
      activeRuns: new Map(),
      stopRequested: false,
      requestController: null,
      activeRunConnection: null,
      desktopConnectionInfo: null,
      desktopConnectionDraft: null,
      desktopAgentIds: [],
      desktopRoomIds: [],
      gatewayStatus: null,
      connectionBusy: false,
      agentModalMode: "create", // create | edit
      editingAgentId: null,
      agentWizardStep: 1,
      agentModalEpoch: 0,
      agentDraft: {
        provider: "openai",
        harness: "none",
      },
      editDraft: {
        provider: "openai",
        harness: "none",
      },
      settingsSection: "general",
      user: null, // { name, email, provider: 'google'|'email' }
      relaySession: null, // { deviceToken, baseUrl, revision, accountId, deviceId, isPrimary }
      relayDevices: [],
      accountScope: "",
      relayStatus: "offline",
      relayError: "",
      relayReady: false,
      relayConfigSynced: false,
      relayConfigRevision: 0,
      harnessModels: {},
      hostConfigEpoch: 0,
      hostSettingsLoaded: false,
      hostSettingsLoading: false,
      hostSettingsError: "",
      hostSettingsDirty: false,
      settings: {
        theme: localStorage.getItem("chorus-theme") || "system",
        localExecution: true,
        notifyApp: true,
        notifySound: false,
        defaultProvider: "openai",
        googleClientId: "",
        relayBaseUrl: "",
        relayEnabled: true,
        desktopConnection: { baseUrl: "", token: "" },
        apiKeys: {
          openai: "",
          anthropic: "",
          custom: "",
          ollamaBase: "http://127.0.0.1:11434",
        },
      },
      composerMode: "discuss",
      authMode: "login",
      authPending: "",
      authError: "",
      authProviders: { baseUrl: "", googleConfigured: null },
      roomRule: "free",
      roomDraft: null,
      roomNameDraft: null,
      roomModalEpoch: 0,
      sending: false,
      preparingSend: false,
      pendingAttachments: [],
      attachmentLoads: new Set(),
      desktopModelSettings: {
        openaiConfigured: false,
        anthropicConfigured: false,
        customConfigured: false,
        ollamaBase: "http://127.0.0.1:11434",
      },
      legacyDesktopKeys: null,
      harnessPaths: { codex: "", claude: "", cursor: "" },
      harnessStatus: {
        codex: { available: false, path: "", version: "", authenticated: null, checking: true, error: "" },
        claude: { available: false, path: "", version: "", authenticated: null, checking: true, error: "" },
        cursor: { available: false, path: "", version: "", authenticated: null, checking: true, error: "" },
      },
      appInfo: { name: "Chorus", version: "0.5.8" },
    };

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const C = ChorusConversation;
    const messageViews = new WeakMap();
    const MAX_ATTACHMENT_BYTES = 256 * 1024;
    const MAX_ATTACHMENT_TOTAL_BYTES = 512 * 1024;
    const MAX_ATTACHMENTS = 5;
    // ------------ 首次使用由用户选择中转站，避免连接未授权的公共服务 ---------------
    const DEFAULT_RELAY_BASE_URL = "";
    const RELAY_SESSION_KEY = "chorus-relay-session";
    const CLIENT_DEVICE_KEY = "chorus-client-device-id";
    let draftTimer = null;
    let gatewayConfigSignature = "";
    let gatewayConfigQueue = Promise.resolve();
    let desktopConnectionEpoch = 0;
    let relayPushTimer = null;
    let relayPushInFlight = false;
    let relayPushQueued = false;
    let relayLoopTimer = null;
    let relayLoopBusy = false;
    let relayLoopQueued = false;
    let relayDrainBusy = false;
    let relayPrimaryBusy = false;
    let relayDeviceListSignature = "";
    let relayRealtime = null;
    let relayApplying = false;
    let authAttemptEpoch = 0;
    let conversationEpoch = 0;
    let relayPublishedSnapshot = "";
    const relayJobsInFlight = new Set();
    let hostConfigTimer = null, hostConfigPublishedAt = 0, hostConfigRetryAt = 0, hostConfigTickBusy = false, hostConfigActiveCommand = "";

    /**
     * 规范化中转站根地址，去掉末尾斜线并只允许 http(s)。
     * @param {unknown} value 用户输入
     * @returns {string} 合法地址；不合法时返回空字符串
     */
    function normalizeRelayBaseUrl(value) {
      return ChorusRelayClient.normalizeBaseUrl(value);
    }

    /**
     * 返回当前生效的中转站根地址。
     * @returns {string}
     */
    function relayBaseUrl() {
      return normalizeRelayBaseUrl(state.settings.relayBaseUrl) || DEFAULT_RELAY_BASE_URL;
    }

    /**
     * 当前这台是不是主设备。未登录中转站的桌面按主设备处理，单机仍可本地执行。
     * @returns {boolean}
     */
    function isPrimaryDevice() {
      if (!window.chorusDesktop) return false;
      if (!state.relaySession?.deviceToken) return true;
      return state.relaySession.isPrimary === true;
    }

    /**
     * 判断当前设备是否可以编辑账号共享的 Agent 配置。
     * @param 无
     * @returns {boolean} 主电脑或已同步账号设备可以编辑
     * 注意事项：允许编辑不代表允许本机执行；密钥与 CLI 仍由主电脑管理。
     */
    function canEditAgentConfig() {
      return state.relaySession?.deviceToken ? Boolean(state.relayReady && state.relayConfigSynced) : isPrimaryDevice();
    }

    /**
     * 保存账号共享配置，并仅对聊天引起的版本变化自动重试。
     * @param {string} method HTTP 方法
     * @param {string} path 受控配置接口路径
     * @param {object} body 配置白名单，不含聊天与密钥
     * @param {object} draft 保存表单打开时的 baseRevision、configRevision
     * @param {function} current 编辑对象及窗口是否仍有效
     * @returns {Promise<boolean>} 服务端是否确认保存
     * 注意事项：配置冲突保留输入；账号切换后不应用晚到结果。
     */
    async function saveRelayConfig(method, path, body, draft, current = () => true) {
      const token = state.relaySession?.deviceToken, scope = state.accountScope, attempt = authAttemptEpoch;
      const valid = () => token && state.relaySession?.deviceToken === token && state.accountScope === scope && authAttemptEpoch === attempt && current();
      if (!valid() || !canEditAgentConfig()) return false;
      console.info(`[chorus] ------------- 保存共享配置 method=${method} path=${path} --------------`);
      for (let retry = 0; retry < 2 && valid(); retry++) {
        try {
          const payload = await relayRequest(method, path, token, { ...body, baseRevision: draft.baseRevision });
          if (!valid()) return false;
          if (Number(payload.revision) >= Number(state.relaySession.revision || 0)) {
            state.relaySession.revision = Number(payload.revision) || 0;
            applyRelaySnapshot(payload.state);
          }
          saveRelaySession(); persistApp();
          console.info(`[chorus] 共享配置已保存 revision=${state.relaySession.revision}`);
          return true;
        } catch (error) {
          if (!valid()) return false;
          if (error.status === 409 && error.payload?.state) {
            const previousConfig = draft.configRevision;
            if (Number(error.payload.revision) >= Number(state.relaySession.revision || 0)) {
              applyRelaySnapshot(error.payload.state);
              state.relaySession.revision = Number(error.payload.revision) || 0;
            }
            draft.baseRevision = state.relaySession.revision;
            draft.configRevision = state.relayConfigRevision;
            saveRelaySession(); persistApp();
            // 聊天分片也会递增快照版本，但没有修改配置时可以安全重试同一草稿。
            if (retry === 0 && previousConfig !== undefined && previousConfig === state.relayConfigRevision) continue;
            toast("共享配置已有更新。已保留你的输入，请核对后再次保存。");
            return false;
          }
          console.warn(`[chorus] 共享配置保存失败 status=${error.status || "network"}`);
          throw error;
        }
      }
      return false;
    }

    /**
     * 提交正在编辑的 Agent 白名单配置。
     * @param {object} draft 已校验的完整成员草稿
     * @returns {Promise<boolean>} 保存是否成功
     * 注意事项：不提交消息、身份或密钥；关闭或切换表单会作废响应。
     */
    async function saveRelayAgentConfig(draft) {
      const epoch = state.agentModalEpoch;
      const config = C.gatewaySnapshot([draft], [], true).agents[0];
      delete config.id;
      return saveRelayConfig("PATCH", `/api/v1/agents/${encodeURIComponent(draft.id)}`, { config }, state.editDraft, () => epoch === state.agentModalEpoch && $("#agentOverlay").classList.contains("open"));
    }

    /**
     * 创建绑定当前账号、主电脑身份及服务地址的配置客户端。
     * @param 无
     * @returns {object} 不缓存明文配置的远程客户端
     * 注意事项：账号或主电脑切换会终止旧请求的轮询和回写。
     */
    function hostConfigClient() {
      const token = state.relaySession?.deviceToken, base = state.relaySession?.baseUrl, scope = state.accountScope, epoch = state.hostConfigEpoch;
      if (!token || !state.relayReady || typeof ChorusHostConfig === "undefined") throw new Error("请先登录并连接中转站");
      const expectedTargetDeviceId = isPrimaryDevice() ? state.relaySession.deviceId : state.relayDevices.find((device) => device.isPrimary)?.id;
      if (!expectedTargetDeviceId) throw new Error("请先连接并选择主电脑");
      return ChorusHostConfig.createClient({
        expectedTargetDeviceId,
        current: () => state.relaySession?.deviceToken === token && state.relaySession?.baseUrl === base && state.accountScope === scope && state.hostConfigEpoch === epoch,
        request: (method, path, body) => ChorusRelayClient.request(base, method, path, token, body),
      });
    }

    /**
     * 清理上一台主电脑的配置状态与原生私钥。
     * @param 无
     * @returns {void}
     * 注意事项：不把另一台电脑的路径、密钥状态展示为新主电脑配置。
     */
    function resetHostConfig() {
      state.hostConfigEpoch = (state.hostConfigEpoch || 0) + 1;
      state.hostSettingsLoaded = false; state.hostSettingsLoading = false; state.hostSettingsError = ""; state.hostSettingsDirty = false;
      state.harnessPaths = { codex: "", claude: "", cursor: "" };
      state.harnessModels = {};
      state.harnessStatus = Object.fromEntries(["codex", "claude", "cursor"].map((key) => [key, { available: false, path: "", version: "", authenticated: null, checking: false, error: "" }]));
      state.desktopModelSettings = { openaiConfigured: false, anthropicConfigured: false, customConfigured: false, ollamaBase: "http://127.0.0.1:11434" };
      hostConfigPublishedAt = 0; hostConfigRetryAt = 0;
      if (hostConfigTimer) clearInterval(hostConfigTimer);
      hostConfigTimer = null;
      window.chorusDesktop?.setHostConfigContext?.({ primary: false }).catch(() => {});
      if (["models", "harness"].includes(state.settingsSection) && $("#settingsOverlay").classList.contains("open")) renderSettings();
    }

    /**
     * 主电脑独立接收配置命令，同时定时续期公开配置密钥。
     * @param 无
     * @returns {Promise<void>} 本轮领取完成，长检测在独立任务中执行
     * 注意事项：配置轮询不被聊天占用；日志不记录配置正文或密钥。
     */
    async function runHostConfigLoop() {
      if (hostConfigTickBusy || Date.now() < hostConfigRetryAt || !isPrimaryDevice() || !state.relayReady || !state.relaySession?.deviceToken || !window.chorusDesktop?.setHostConfigContext) return;
      hostConfigTickBusy = true;
      const epoch = state.hostConfigEpoch, token = state.relaySession.deviceToken;
      const current = () => state.hostConfigEpoch === epoch && state.relaySession?.deviceToken === token && isPrimaryDevice();
      try {
        const client = hostConfigClient();
        if (!hostConfigPublishedAt || Date.now() - hostConfigPublishedAt >= 30000) {
          const key = await window.chorusDesktop.setHostConfigContext({ accountId: state.relaySession.accountId, deviceId: state.relaySession.deviceId, primary: true });
          if (!current()) return;
          await client.publishKey(key);
          if (!current()) return;
          hostConfigPublishedAt = Date.now();
        }
        if (hostConfigActiveCommand) return;
        const command = await client.claim();
        if (!command || !current()) return;
        hostConfigActiveCommand = command.id;
        executeHostConfigCommand(command, client, current).finally(() => { if (hostConfigActiveCommand === command.id) hostConfigActiveCommand = ""; });
      } catch (error) {
        if (current()) {
          hostConfigRetryAt = Date.now() + 15000;
          console.warn(`[chorus] 主电脑配置通道暂不可用 status=${error.status || "network"}`);
          if (error.status === 401 || error.status === 403) { resetHostConfig(); loadRelayDevices().catch(() => {}); }
        }
      } finally { hostConfigTickBusy = false; }
    }

    /**
     * 调用原生白名单处理器并向请求设备交付脱敏结果。
     * @param {object} command 已领取且绑定身份的短期命令
     * @param {object} client 当前通道
     * @param {function} current 主设备资格是否仍有效
     * @returns {Promise<void>} 回写完成或已记录失败
     * 注意事项：主设备或账号变更后不交付旧结果，也不把密钥写入快照。
     */
    async function executeHostConfigCommand(command, client, current) {
      let result = null, errorMessage = "";
      try { result = await window.chorusDesktop.executeHostCommand(command); }
      catch (error) { errorMessage = readableError(error); }
      if (!current()) return;
      if (!errorMessage) {
        if (command.action === "model.save") state.desktopModelSettings = result;
        if (command.action === "harness.models") {
          state.harnessModels[command.payload.harness] = { models: result.models || [], source: result.source || "", error: result.error || "" };
          persistApp();
        }
        if (command.action === "harness.save") {
          state.harnessPaths = result.paths;
          state.harnessModels = {};
          for (const harness of ["codex", "claude", "cursor"]) loadHarnessModels(harness, true).catch(() => {});
        }
        const probe = command.action === "harness.save" ? result.probe : command.action === "harness.probe" ? result : null;
        if (probe) for (const key of ["codex", "claude", "cursor"]) state.harnessStatus[key] = normalizeHarnessResult(probe[key]);
        if (!state.hostSettingsDirty && ["models", "harness"].includes(state.settingsSection) && $("#settingsOverlay").classList.contains("open")) renderSettings();
      }
      // ------------ 执行结果固定后只重试交付，不把已保存配置误报成执行失败 ---------------
      for (let attempt = 0; attempt < 4 && current(); attempt++) {
        try { await client.complete(command, result, errorMessage); return; }
        catch (error) {
          if (!current()) return;
          if (attempt === 3 || error.status && error.status < 500 && error.status !== 429) {
            console.warn(`[chorus] 主电脑配置结果尚未确认 action=${command.action} status=${error.status || "network"}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        }
      }
    }

    /**
     * 启动当前主电脑的配置领取和密钥续期。
     * @param 无
     * @returns {void}
     * 注意事项：非主设备不启动原生处理器，定时器在退出账号时清理。
     */
    function startHostConfigLoop() {
      if (hostConfigTimer) clearInterval(hostConfigTimer);
      hostConfigTimer = null;
      if (!isPrimaryDevice() || !state.relayReady || !state.relaySession?.deviceToken || !window.chorusDesktop?.setHostConfigContext) return;
      hostConfigTimer = setInterval(runHostConfigLoop, 1000);
      runHostConfigLoop();
    }

    /**
     * 读取主电脑实际模型状态、内核路径与检测结果。
     * @param 无
     * @returns {Promise<void>} 脱敏配置已填入界面状态
     * 注意事项：加载期间不接受编辑，避免晚到读取覆盖正在输入的路径。
     */
    async function loadRemoteHostSettings() {
      if (isPrimaryDevice() || state.hostSettingsLoading) return;
      const epoch = state.hostConfigEpoch;
      state.hostSettingsLoading = true; state.hostSettingsLoaded = false; state.hostSettingsError = "";
      renderSettings();
      try {
        const result = await hostConfigClient().command("settings.get");
        if (state.hostConfigEpoch !== epoch || isPrimaryDevice()) return;
        state.desktopModelSettings = result.modelSettings;
        state.harnessPaths = result.harnessPaths;
        for (const key of ["codex", "claude", "cursor"]) state.harnessStatus[key] = normalizeHarnessResult(result.harnessStatus?.[key]);
        state.hostSettingsLoaded = true;
      } catch (error) { if (state.hostConfigEpoch === epoch) state.hostSettingsError = readableError(error); }
      finally {
        if (state.hostConfigEpoch === epoch) {
          state.hostSettingsLoading = false;
          if (["models", "harness"].includes(state.settingsSection) && $("#settingsOverlay").classList.contains("open")) renderSettings();
        }
      }
    }

    /**
     * 校验 Agent 项目路径，始终在实际执行的主电脑上解析。
     * @param {object} draft 成员配置草稿
     * @returns {Promise<void>} 已填入规范路径
     * 注意事项：自动目录不在非主设备创建；显式路径校验失败保留表单。
     */
    async function normalizeAgentWorkspace(draft) {
      if (!draft.workspace) return;
      if (isPrimaryDevice()) {
        if (window.chorusDesktop?.normalizeWorkspace) draft.workspace = await window.chorusDesktop.normalizeWorkspace(draft.workspace);
      } else {
        const result = await hostConfigClient().command("workspace.normalize", { path: draft.workspace });
        draft.workspace = typeof result === "string" ? result : result.path;
      }
    }

    /**
     * 更新主电脑共享的执行开关或 Agent 默认值。
     * @param {object} config localExecution/defaultProvider 的变更
     * @returns {Promise<boolean>} 是否成功保存
     * 注意事项：外观、通知、中转站地址仍为各设备独立偏好。
     */
    async function saveSharedSettings(config) {
      if (!canEditAgentConfig()) { toast("请先登录并同步账号配置"); return false; }
      try {
        if (state.relaySession?.deviceToken) {
          const draft = { baseRevision: state.relaySession.revision, configRevision: state.relayConfigRevision };
          if (!await saveRelayConfig("PATCH", "/api/v1/settings", { config }, draft)) return false;
        } else Object.assign(state.settings, config);
        persistApp(); renderSettings(); toast("主电脑配置已更新");
        return true;
      } catch (error) { toast(readableError(error)); return false; }
    }

    /**
     * 读取主电脑 CLI 的真实可选模型并同步目录。
     * @param {string} harness 执行内核标识
     * @param {boolean} force 是否刷新已有目录
     * @returns {Promise<void>} 读取结束，失败信息显示在模型选择旁
     * 注意事项：其他设备只读取主电脑发布的目录；不使用本机 CLI 冒充主电脑。
     */
    async function loadHarnessModels(harness, force = false) {
      if ((!isPrimaryDevice() && !force) || (!force && state.harnessModels[harness])) return;
      const scope = state.accountScope, token = state.relaySession?.deviceToken, attempt = authAttemptEpoch, hostEpoch = state.hostConfigEpoch;
      if (state.harnessModels[harness]?.loading) return;
      const pending = { ...state.harnessModels[harness], loading: true };
      state.harnessModels[harness] = pending;
      try {
        const result = isPrimaryDevice() ? await window.chorusDesktop.listHarnessModels(harness) : await hostConfigClient().command("harness.models", { harness });
        if (scope !== state.accountScope || token !== state.relaySession?.deviceToken || attempt !== authAttemptEpoch || state.harnessModels[harness] !== pending || hostEpoch !== state.hostConfigEpoch) return;
        state.harnessModels[harness] = { models: result.models || [], source: result.source || "", error: result.error || "" };
        console.info(`[chorus] 内核模型目录已更新 harness=${harness} count=${state.harnessModels[harness].models.length}`);
      } catch (error) {
        if (scope !== state.accountScope || token !== state.relaySession?.deviceToken || attempt !== authAttemptEpoch || state.harnessModels[harness] !== pending || hostEpoch !== state.hostConfigEpoch) return;
        state.harnessModels[harness] = { models: [], error: readableError(error) };
      }
      if (scope !== state.accountScope || token !== state.relaySession?.deviceToken || attempt !== authAttemptEpoch || hostEpoch !== state.hostConfigEpoch) return;
      renderHarnessModelChoice("create"); renderHarnessModelChoice("edit"); persistApp();
    }

    /**
     * 渲染执行内核模型选择，空值表示沿用 CLI 默认。
     * @param {string} prefix create 或 edit，对应创建与编辑表单
     * @returns {void}
     * 注意事项：保留已配置但当前目录不可用的模型，避免静默切换用户选择。
     */
    function renderHarnessModelChoice(prefix) {
      const draft = prefix === "create" ? state.agentDraft : state.editDraft;
      const harness = (draft.backend || "model") === "model" ? draft.harness : draft.backend;
      const row = $(`#${prefix}HarnessModelRow`), select = $(`#${prefix}HarnessModel`), hint = $(`#${prefix}HarnessModelHint`);
      row.hidden = !harness || harness === "none";
      if (row.hidden) return;
      const catalog = state.harnessModels[harness];
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      select.innerHTML = '<option value="">使用 CLI 默认模型</option>' + models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`).join("") + (draft.harnessModel && !models.some((model) => model.id === draft.harnessModel) ? `<option value="${escapeHtml(draft.harnessModel)}">${escapeHtml(draft.harnessModel)}（已配置）</option>` : "");
      select.value = draft.harnessModel || "";
      hint.textContent = catalog?.loading ? "正在读取主电脑 CLI 的模型列表…" : catalog?.error || (models.length ? `来自主电脑 ${HARNESS_LABEL[harness]} · ${models.length} 个可选模型` : "暂未取得模型列表，可使用 CLI 默认模型；主电脑在线后刷新。");
      $(`#refresh${prefix === "create" ? "Create" : "Edit"}Models`).disabled = Boolean(catalog?.loading);
      if (!catalog) loadHarnessModels(harness);
    }

    function usingDesktopAgent(agent) {
      return desktopManagedAgent(agent) && Boolean(state.desktopConnectionInfo && state.desktopAgentIds.includes(agent.id));
    }

    function desktopManagedAgent(agent) {
      return !window.chorusDesktop && Boolean(agent.desktopManaged || state.desktopAgentIds.includes(agent.id));
    }

    function gatewayConfig() {
      return C.gatewaySnapshot(state.agents, state.rooms, state.settings.localExecution && isPrimaryDevice());
    }

    /**
     * 让主电脑为未设置路径的 Agent 创建独立默认工作区。
     * @param {object[]} [agents] 当前成员或待保存的草稿，默认使用全部成员
     * @returns {Promise<boolean>} 是否补充了至少一个工作区
     * 注意事项：保留项目路径；自动目录在当前主电脑解析；异步期间切换账号或修改成员时不回写旧配置。
     */
    async function prepareDesktopWorkspaces(agents = state.agents) {
      if (!isPrimaryDevice() || !window.chorusDesktop?.prepareAgentWorkspaces) return false;
      const pending = agents.filter((agent) => (agent.backend && agent.backend !== "model" || agent.harness && agent.harness !== "none") && (agent.workspaceMode === "auto" || !agent.workspace?.trim())).map((agent) => ({ agent, name: agent.name, workspace: agent.workspace, workspaceMode: agent.workspaceMode }));
      if (!pending.length) return false;
      const scope = state.accountScope;
      const epoch = conversationEpoch, configRevision = state.relayConfigRevision;
      const ids = new Set(agents.map((agent) => agent.id));
      const roster = state.agents.filter((agent) => !ids.has(agent.id)).concat(agents).filter((agent) => agent.backend && agent.backend !== "model" || agent.harness && agent.harness !== "none");
      const prepared = await window.chorusDesktop.prepareAgentWorkspaces(roster.map((agent) => ({ id: agent.id, name: agent.name, workspace: agent.workspace || "", workspaceMode: agent.workspaceMode || (agent.workspace ? "project" : "auto") })));
      if (!isPrimaryDevice() || state.accountScope !== scope || conversationEpoch !== epoch || state.relayConfigRevision !== configRevision) return false;
      if (!Array.isArray(prepared)) throw new Error("电脑未返回有效的默认工作区");
      let changed = false;
      for (const item of pending) {
        // 已有路径可能在目录创建期间被用户修改，不能被晚到的默认值覆盖。
        if (item.agent.name !== item.name || item.agent.workspace !== item.workspace || item.agent.workspaceMode !== item.workspaceMode) continue;
        const workspace = prepared.find((result) => result.id === item.agent.id)?.workspace;
        if (typeof workspace !== "string" || !workspace.trim()) throw new Error("电脑未返回有效的默认工作区");
        if (item.agent.workspace === workspace && item.agent.workspaceMode === "auto") continue;
        item.agent.workspace = workspace;
        item.agent.workspaceMode = "auto";
        changed = true;
      }
      return changed;
    }

    /** 顺序发布配置，避免异步 IPC 把较旧的工作区或执行开关覆盖到新版本。 */
    function publishGatewayConfig() {
      if (!window.chorusDesktop?.updateGatewayConfig) return Promise.resolve();
      const snapshot = gatewayConfig();
      const signature = JSON.stringify(snapshot);
      if (signature === gatewayConfigSignature) return gatewayConfigQueue;
      gatewayConfigSignature = signature;
      gatewayConfigQueue = gatewayConfigQueue.catch(() => {}).then(() => window.chorusDesktop.updateGatewayConfig(snapshot));
      gatewayConfigQueue.catch(() => { if (gatewayConfigSignature === signature) gatewayConfigSignature = ""; });
      return gatewayConfigQueue;
    }

    async function refreshGatewayStatus() {
      if (!window.chorusDesktop?.getGatewayStatus) return;
      try { state.gatewayStatus = await window.chorusDesktop.getGatewayStatus(); }
      catch (error) { toast(readableError(error)); }
      if (state.settingsSection === "connection" && $("#settingsOverlay").classList.contains("open")) renderSettings();
    }

    /** 只导入配置，保留本机线程、草稿、当前浏览位置和独立模型密钥。 */
    async function connectDesktop(config = state.settings.desktopConnection, announce = true) {
      if (state.sending || state.connectionBusy) return toast("请等待当前任务或连接完成");
      const epoch = ++desktopConnectionEpoch;
      state.connectionBusy = true;
      try {
        const connection = ChorusGatewayClient.connection(config);
        const info = await ChorusGatewayClient.request(connection, "GET", "/info");
        if (info.protocolVersion !== 1 || !info.capabilities?.chat) throw new Error("这台 Mac 的连接协议不兼容，请升级 Chorus");
        const snapshot = await ChorusGatewayClient.request(connection, "GET", "/config");
        if (state.sending || epoch !== desktopConnectionEpoch) throw new Error("当前任务已开始，请结束后重新连接 Mac");
        const imported = C.importGatewayConfig(state.agents, state.rooms, snapshot);
        saveDraft();
        state.agents = imported.agents;
        state.rooms = imported.rooms;
        state.desktopAgentIds = imported.remoteAgentIds;
        state.desktopRoomIds = imported.remoteRoomIds;
        state.settings.localExecution = imported.localExecution;
        state.settings.desktopConnection = connection;
        state.desktopConnectionDraft = null;
        state.desktopConnectionInfo = { name: String(info.name || "Chorus"), version: String(info.version || ""), capabilities: { ...info.capabilities } };
        if (!state.agents.some((agent) => agent.id === state.selectedAgentId)) state.selectedAgentId = state.agents[0].id;
        if (!state.rooms.some((room) => room.id === state.activeRoomId)) state.activeRoomId = state.rooms[0]?.id || "";
        if (!state.rooms.length) state.panelMode = "agent";
        renderAll(); restoreDraft();
        if (announce) toast(`已连接 Mac · ${imported.remoteAgentIds.length} 个 Agent，可直接聊天与编程`);
      } catch (error) {
        if (announce) toast(readableError(error));
      } finally {
        state.connectionBusy = false;
        updateComposer();
        if (state.settingsSection === "connection" && $("#settingsOverlay").classList.contains("open")) renderSettings();
      }
    }

    function terminalAdapter(agent) {
      if (usingDesktopAgent(agent)) {
        const connection = { ...state.settings.desktopConnection };
        return {
          open: (options) => ChorusGatewayClient.request(connection, "POST", "/terminal/open", { agentId: agent.id, threadKey: options.threadKey, cols: options.cols, rows: options.rows }),
          write: (sessionId, data) => ChorusGatewayClient.request(connection, "POST", "/terminal/write", { sessionId, data }),
          resize: (sessionId, size) => ChorusGatewayClient.request(connection, "POST", "/terminal/resize", { sessionId, ...size }),
          read: (sessionId, options) => ChorusGatewayClient.request(connection, "GET", `/terminal/${encodeURIComponent(sessionId)}?after=${options.after || 0}`),
          close: (sessionId) => ChorusGatewayClient.request(connection, "POST", "/terminal/close", { sessionId }),
        };
      }
      const desktop = window.chorusDesktop;
      if (!desktop?.terminalOpen) throw new Error("请在设置 → 桌面连接中连接 Mac，再使用完整 CLI 终端");
      return {
        open: (options) => publishGatewayConfig().then(() => desktop.terminalOpen(options)),
        write: (sessionId, data) => desktop.terminalWrite(sessionId, data),
        resize: (sessionId, size) => desktop.terminalResize(sessionId, size),
        read: (sessionId, options) => desktop.terminalRead(sessionId, options),
        close: (sessionId) => desktop.terminalClose(sessionId),
        subscribe: (callback) => desktop.onTerminalEvent(callback),
      };
    }

    /**
     * 打开当前聊天成员的真实 CLI 终端，并自动准备默认工作区。
     * @param 无
     * @returns {Promise<void>} 终端已打开或已显示校验错误
     * 注意事项：每个成员使用自己的目录，终端与聊天继续共用写锁。
     */
    async function openTerminal() {
      if (window.chorusDesktop && !isPrimaryDevice()) return toast("终端在主电脑运行，请在主电脑打开");
      const context = chatContext();
      const agents = (context.team ? (context.owner?.agentIds || []).map(getAgent).filter(Boolean) : [context.owner].filter(Boolean))
        .filter((agent) => (agent.backend || "model") !== "model" || (agent.harness && agent.harness !== "none"));
      if (!agents.length) return toast("请编辑 Agent，选择 Codex、Claude Code 或 Cursor 后台");
      if (state.sending) return toast("请先停止聊天任务，再打开同一工作区的终端");
      try { await prepareDesktopWorkspaces(agents); }
      catch (error) { return toast(readableError(error)); }
      const invalid = validateSend("discuss", agents.filter((agent) => (agent.backend || "model") !== "model"));
      if (!state.settings.localExecution) return toast("Mac 本机执行已关闭，请在 Mac 设置 → 通用开启");
      if (agents.some((agent) => !agent.workspace?.trim())) return toast("请为每个终端 Agent 指定工作区");
      if (invalid && agents.some((agent) => (agent.backend || "model") !== "model")) return toast(invalid);
      if (!window.chorusDesktop?.terminalOpen && agents.some((agent) => !usingDesktopAgent(agent))) return openSettings("connection");
      if (!window.chorusDesktop && !state.desktopConnectionInfo?.capabilities.terminal) return toast("这台 Mac 没有提供终端能力，请升级桌面版");
      openOverlay("terminalOverlay");
      try { await ChorusTerminalUI.open({ agents, threadKey: context.key, connectionKey: window.chorusDesktop ? "native" : `${state.settings.desktopConnection.baseUrl}:${desktopConnectionEpoch}`, adapter: terminalAdapter }); }
      catch (error) { toast(readableError(error)); }
    }

    /**
     * 当前客户端平台，用来在设备列表里区分 Mac 和手机。
     * @returns {"mac"|"android"|"web"}
     */
    function currentClientPlatform() {
      const marked = document.documentElement.getAttribute("data-platform");
      if (marked === "android" || marked === "web" || marked === "mac") return marked;
      if (window.chorusDesktop?.platform === "mac") return "mac";
      return window.Capacitor?.getPlatform?.() === "android" ? "android" : "web";
    }

    /**
     * 登录时登记到中转站的设备名称。Mac 会带上电脑名，方便在列表里分辨多台电脑。
     * @param {{name?: string}} user 当前登录用户
     * @returns {string}
     */
    function currentDeviceName(user) {
      const owner = String(user?.name || "Chorus").trim().slice(0, 24) || "Chorus";
      const host = String(state.appInfo?.hostname || "").replace(/\.local$/i, "").trim();
      const name = host ? `${owner} · ${host}` : `${owner} ${devicePlatformLabel(currentClientPlatform())}`;
      return name.slice(0, 120);
    }

    /**
     * 生成本机稳定设备编号，供中转站识别同一台 Mac。
     * @returns {string}
     */
    function getOrCreateClientDeviceId() {
      try {
        const saved = String(localStorage.getItem(CLIENT_DEVICE_KEY) || "").trim();
        if (/^[A-Za-z0-9._:-]{4,128}$/.test(saved)) return saved;
      } catch (_error) {
        /* ignore */
      }
      const next = `${currentClientPlatform()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        localStorage.setItem(CLIENT_DEVICE_KEY, next);
      } catch (_error) {
        /* ignore */
      }
      return next;
    }

    /**
     * 从本机恢复中转站会话（含设备令牌）。
     * @returns {void}
     */
    function loadRelaySession() {
      try {
        const data = JSON.parse(localStorage.getItem(RELAY_SESSION_KEY) || "null");
        if (!data?.deviceToken || data.authVersion !== 2 || !data.accountId || !data.email
          || data.email.toLowerCase() !== String(state.user?.email || "").toLowerCase()
          || normalizeRelayBaseUrl(data.baseUrl) !== relayBaseUrl()) return;
        state.relaySession = { ...data, revision: Number(data.revision) || 0, isPrimary: Boolean(data.isPrimary) };
      } catch (_) { state.relaySession = null; }
    }

    /**
     * 把中转站会话写到本机。
     * @returns {void}
     */
    function saveRelaySession() {
      try {
        if (!state.relaySession?.deviceToken) {
          localStorage.removeItem(RELAY_SESSION_KEY);
          return;
        }
        localStorage.setItem(RELAY_SESSION_KEY, JSON.stringify({
          authVersion: 2,
          email: state.relaySession.email,
          deviceToken: state.relaySession.deviceToken,
          baseUrl: state.relaySession.baseUrl || relayBaseUrl(),
          revision: Number(state.relaySession.revision) || 0,
          accountId: state.relaySession.accountId || "",
          deviceId: state.relaySession.deviceId || "",
          isPrimary: state.relaySession.isPrimary !== false,
        }));
      } catch (error) {
        console.error("[chorus] 保存中转站会话失败", error);
      }
    }

    /**
     * 清除中转站会话。
     * @returns {void}
     */
    /** 切换身份时先清编辑器，阻止旧线程草稿和异步附件写进新账号。 */
    function resetConversationEditor(clearSelection = false) {
      if (state.sending) stopRun().catch(() => {});
      ++conversationEpoch;
      state.sending = false; state.preparingSend = false; state.running = null; state.activeRunId = ""; state.activeRuns = new Map(); state.requestController = null; state.activeRunConnection = null; state.stopRequested = false;
      state.draftKey = "";
      state.pendingAttachments = [];
      state.attachmentLoads = new Set();
      $("#composerInput").value = "";
      $("#composerFiles").value = "";
      if (clearSelection) {
        state.activeRoomId = ""; state.selectedAgentId = ""; state.panelMode = "room";
        state.desktopAgentIds = []; state.desktopRoomIds = [];
        state.desktopConnectionInfo = null; state.desktopConnectionDraft = null;
      }
      renderComposerAttachments();
    }

    function clearRelaySession() {
      resetHostConfig();
      ++state.agentModalEpoch; ++state.roomModalEpoch;
      state.roomDraft = null; state.roomNameDraft = null;
      closeOverlay("agentOverlay"); closeOverlay("roomOverlay");
      if (state.sending) stopRun().catch(() => {});
      resetConversationEditor();
      relayRealtime?.close(); relayRealtime = null;
      if (relayLoopTimer) clearInterval(relayLoopTimer);
      if (relayPushTimer) clearTimeout(relayPushTimer);
      relayLoopTimer = null; relayPushTimer = null; relayPushQueued = false;
      state.relayReady = false; state.relayConfigSynced = false; state.relayStatus = "offline"; state.relayError = "";
      state.relaySession = null; state.relayDevices = [];
      state.relayConfigRevision = 0; state.harnessModels = {};
      relayPublishedSnapshot = "";
      try { localStorage.removeItem(RELAY_SESSION_KEY); } catch (_) { /* ignore */ }
    }

    /**
     * 组装提交给中转站的聊天快照（不含密钥）。
     * @returns {object}
     */
    function buildRelaySnapshot() {
      const config = C.gatewaySnapshot(state.agents, state.rooms, state.settings.localExecution);
      return {
        ...config,
        settings: { ...config.settings, defaultProvider: state.settings.defaultProvider },
        configRevision: state.relayConfigRevision || 0,
        harnessModels: state.harnessModels,
        agents: config.agents.map((agent) => ({ ...agent, messages: getAgent(agent.id)?.messages || [] })),
        rooms: config.rooms.map((room) => ({ ...room, messages: getRoom(room.id)?.messages || [] })),
        execution: { running: state.running ? { ...state.running } : null, desktopName: state.appInfo.hostname || state.appInfo.name || "电脑" },
      };
    }

    /**
     * 调用中转站 HTTP 接口。
     * @param {string} method 方法
     * @param {string} path 相对路径，以 / 开头
     * @param {string|null} token 设备令牌
     * @param {object|null} body JSON 体
     * @returns {Promise<object>}
     * 注意事项：未配置服务地址时立即拒绝请求，不尝试访问默认站点。
     */
    async function relayRequest(method, path, token, body) {
      const base = token && state.relaySession?.deviceToken === token ? state.relaySession.baseUrl : relayBaseUrl();
      if (!base) throw new Error("请先在设置中填写中转站地址");
      return ChorusRelayClient.request(base, method, path, token, body);
    }

    /**
     * 规范账号展示资料，只有服务器认证响应可以提供员工身份。
     * @param {object} account 登录、会话接口或本机缓存中的账号资料
     * @param {boolean} [serverVerified] 是否直接来自当前服务器认证响应，缓存必须为 false
     * @returns {object} 包含姓名、邮箱、登录方式和只读员工身份的用户资料
     * 注意事项：管理员身份仅用于展示；服务端独立授权，缓存或密码账号不能提升角色。
     */
    function normalizeRelayAccount(account, serverVerified = false) {
      const provider = account.provider === "google" ? "google" : account.provider === "email" ? "email" : "local";
      const employeeId = String(account.employeeId || "");
      const superadmin = serverVerified && provider === "google" && account.role === "superadmin" && /^\d{1,32}$/.test(employeeId);
      return {
        name: String(account.name || account.email).slice(0, 100),
        email: String(account.email || "").slice(0, 320),
        picture: String(account.picture || "").slice(0, 2000),
        provider, verified: serverVerified || account.verified === true,
        role: superadmin ? "superadmin" : "member", employeeId: superadmin ? employeeId : "",
      };
    }

    /**
     * 查询当前服务器有效身份，刷新管理员撤权和账号展示资料。
     * @param {boolean} [force] 是否跳过 30 秒缓存期限，启动恢复时使用
     * @returns {Promise<boolean>} 当前会话身份是否已经完成有效刷新
     * 注意事项：捕获令牌、服务地址、账号与 scope；旧请求晚到不能影响切换后的账号。
     */
    async function refreshRelayAccount(force = false) {
      const token = state.relaySession?.deviceToken;
      const base = state.relaySession?.baseUrl;
      const accountId = state.relaySession?.accountId;
      const scope = state.accountScope;
      if (!token || !accountId || base !== relayBaseUrl() || scope !== `${base}:${accountId}`) return false;
      if (!force && Date.now() - Number(state.relaySession.identityCheckedAt || 0) < 30000) return false;
      const payload = await relayRequest("GET", "/api/v1/auth/session", token, null);
      if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
        || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return false;
      if (String(payload.account?.id || "") !== accountId
        || String(payload.account?.email || "").toLowerCase() !== String(state.relaySession.email || "").toLowerCase()) {
        const error = new Error("中转站返回的账号身份与当前会话不一致，请重新登录");
        error.status = 401;
        throw error;
      }
      const user = normalizeRelayAccount(payload.account, true);
      state.relaySession.identityCheckedAt = Date.now();
      if (JSON.stringify(user) !== JSON.stringify(state.user)) {
        // 身份只从当前已认证会话刷新，持久缓存重启后仍须重新确认角色。
        state.user = user;
        try { localStorage.setItem("chorus-user", JSON.stringify(user)); }
        catch (_) { console.error("[chorus] 账号资料缓存写入失败"); }
        persistApp(); renderAccount(); syncAuthModal();
        console.info("[chorus] 服务端账号身份已更新");
      }
      return true;
    }

    /**
     * 使用服务端验证过的登录结果建立可协同配置的账号会话。
     * @param {object} session 当前登录接口返回的账号、设备和设备令牌
     * @returns {Promise<boolean>} 是否为当前账号成功建立同步会话
     * 注意事项：员工身份只接受认证响应；异步同步期间切换账号后停止回写。
     */
    async function connectRelaySession(session) {
      if (!session?.deviceToken || !session.account?.id || !session.account?.email) throw new Error("中转站未返回有效登录会话");
      const account = session.account;
      const base = relayBaseUrl(), accountId = String(account.id), attempt = authAttemptEpoch;
      const scope = `${base}:${accountId}`;
      persistApp();
      if (!state.accountScope) localStorage.setItem("chorus-app-local", localStorage.getItem("chorus-app") || "{}");
      const changingAccount = state.accountScope && state.accountScope !== scope;
      let saved = null;
      if (state.accountScope !== scope) {
        try { saved = JSON.parse(localStorage.getItem(`chorus-account:${scope}`) || "null"); }
        catch (_) { console.warn("[chorus] 本机账号缓存不可读，将从中转站恢复"); }
      }
      clearRelaySession();
      if (changingAccount || saved) {
        closeOverlay("terminalOverlay");
        if (typeof ChorusTerminalUI !== "undefined") await ChorusTerminalUI.reset?.();
        if (authAttemptEpoch !== attempt || relayBaseUrl() !== base) return false;
        resetConversationEditor(true);
        state.agents = []; state.rooms = []; state.drafts = {}; state.activeRoomId = ""; state.selectedAgentId = "";
        if (saved) {
          // 先恢复目标账号的线程选择和草稿，再应用快照，避免空编辑器覆盖已保存的草稿。
          state.drafts = saved.drafts || {};
          state.panelMode = saved.panelMode === "agent" || (!saved.panelMode && !saved.rooms?.length) ? "agent" : "room";
          state.activeRoomId = String(saved.activeRoomId || "");
          state.selectedAgentId = String(saved.selectedAgentId || "");
          applyRelaySnapshot(saved, true);
        }
      }
      state.accountScope = scope;
      state.user = normalizeRelayAccount(account, true);
      state.relaySession = { deviceToken: session.deviceToken, baseUrl: base, revision: 0, accountId, email: String(account.email), deviceId: String(session.device?.id || ""), isPrimary: Boolean(session.device?.isPrimary), authVersion: 2, identityCheckedAt: Date.now() };
      saveRelaySession();
      const token = state.relaySession.deviceToken;
      await pullRelayState();
      if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
        || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return false;
      state.relayReady = true;
      await loadRelayDevices();
      if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
        || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return false;
      renderAccount(); refreshRelayView();
      if (isPrimaryDevice() && window.chorusDesktop?.listHarnessModels) ["codex", "claude", "cursor"].forEach((harness) => loadHarnessModels(harness));
      persistApp(); startRelayLoop();
      return true;
    }

    /**
     * 拉取最新历史；主电脑合并未上传内容，并保持执行中的线程引用。
     * @param 无
     * @returns {Promise<boolean>} 是否拉到了非空快照
     * 注意事项：仅主电脑补充默认工作区；目录准备期间切换账号后不继续同步旧状态。
     */
    async function pullRelayState() {
      if (state.connectionBusy || state.desktopConnectionInfo || !state.relaySession?.deviceToken) return false;
      const token = state.relaySession.deviceToken;
      const payload = await relayRequest("GET", "/api/v1/state", token, null);
      if (state.connectionBusy || state.desktopConnectionInfo || state.relaySession?.deviceToken !== token) return false;
      const revision = Number(payload.revision) || 0;
      if (revision < Number(state.relaySession.revision || 0)) return false;
      state.relaySession.revision = revision;
      saveRelaySession();
      if (!payload.state || !Array.isArray(payload.state.agents)) {
        if (!isPrimaryDevice()) { state.agents = []; state.rooms = []; state.running = null; refreshRelayView(); }
        state.relayConfigSynced = true;
        return false;
      }
      applyRelaySnapshot(payload.state, !state.relayConfigSynced && (Number(payload.state.configRevision) > 0 || payload.state.agents.length > 0 || payload.state.rooms?.length > 0));
      state.relayConfigSynced = true;
      const prepared = await prepareDesktopWorkspaces();
      if (state.relaySession?.deviceToken !== token) return false;
      if (prepared) { persistApp(); scheduleRelayPush(0); }
      refreshRelayView();
      return true;
    }

    /**
     * 把中转站快照应用到本机状态（不回写密钥）。
     * @param {object} data 快照
     * @param {boolean} replace 首次恢复账号时直接采用远端集合
     * @returns {void}
     * 注意事项：只应用共享设置白名单，不把本机密钥或偏好改成远端值。
     */
    function applyRelaySnapshot(data, replace = false) {
      saveDraft();
      const snapshot = isPrimaryDevice() && !replace ? ChorusRelayClient.mergeSnapshots(data, buildRelaySnapshot()) : data;
      state.relayConfigRevision = Number(snapshot.configRevision) || 0;
      if (!isPrimaryDevice()) state.harnessModels = Object.fromEntries(Object.entries(snapshot.harnessModels || {}).map(([key, catalog]) => [key, { ...catalog, loading: false }]));
      const config = C.gatewaySnapshot(snapshot.agents || [], snapshot.rooms || [], snapshot.settings?.localExecution);
      const applyOwners = (existing, clean, owners, privateChat) => clean.map((item) => {
        const prior = existing.find((owner) => owner.id === item.id);
        const source = owners.find((owner) => owner.id === item.id);
        const messages = privateChat ? normalizeStoredMessages(source?.messages, item.id) : C.normalizeMessages(source?.messages);
        if (prior) {
          Object.assign(prior, item);
          prior.messages ||= [];
          prior.messages.splice(0, prior.messages.length, ...messages);
          return prior;
        }
        return { ...item, initial: item.initial || item.name.slice(0, 1).toUpperCase(), messages };
      });
      state.agents = applyOwners(state.agents, config.agents, snapshot.agents || [], true);
      state.rooms = applyOwners(state.rooms, config.rooms, snapshot.rooms || [], false);
      if (!getRoom(state.activeRoomId)) state.activeRoomId = state.rooms[0]?.id || "";
      if (!getAgent(state.selectedAgentId)) state.selectedAgentId = state.agents[0]?.id || "";
      if (typeof snapshot.settings?.localExecution === "boolean") state.settings.localExecution = snapshot.settings.localExecution;
      if (["openai", "anthropic", "local", "custom"].includes(snapshot.settings?.defaultProvider)) state.settings.defaultProvider = snapshot.settings.defaultProvider;
      if (!isPrimaryDevice()) {
        state.relayConfigSynced = typeof data.settings?.localExecution === "boolean";
        state.running = data.execution?.running || null;
      }
      state.composerMode = "discuss";
      restoreDraft();
    }

    /** 远端刷新只落本地缓存，避免刷新页面再次上传形成循环。 */
    function refreshRelayView() {
      relayApplying = true;
      try { renderAll(); renderRunning(); updateExecutionSettingsVisibility(); }
      finally { relayApplying = false; }
    }

    /**
     * 把本机聊天快照推到中转站。
     * @returns {Promise<void>}
     */
    async function pushRelayState() {
      if (!state.relayReady || !state.relaySession?.deviceToken || !isPrimaryDevice()) return;
      if (relayPushInFlight) { relayPushQueued = true; return; }
      const token = state.relaySession.deviceToken;
      const serialized = JSON.stringify(buildRelaySnapshot());
      const snapshot = JSON.parse(serialized);
      if (serialized === relayPublishedSnapshot) return;
      relayPushInFlight = true;
      try {
        const payload = await relayRequest("PUT", "/api/v1/state", token, { baseRevision: state.relaySession.revision, state: snapshot });
        if (state.relaySession?.deviceToken !== token) return;
        state.relaySession.revision = Math.max(Number(payload.revision) || 0, state.relaySession.revision);
        relayPublishedSnapshot = serialized;
        state.relayError = "";
        saveRelaySession();
      } catch (error) {
        if (state.relaySession?.deviceToken !== token) return;
        if (error.status === 409) {
          // 手机可以在 PUT 期间提交消息。先合并最新历史，再以新版本重发。
          const latest = error.payload?.state ? error.payload : await relayRequest("GET", "/api/v1/state", token, null);
          if (state.relaySession?.deviceToken !== token) return;
          applyRelaySnapshot(latest.state || {});
          state.relaySession.revision = Number(latest.revision) || 0;
          saveRelaySession(); refreshRelayView(); relayPushQueued = true;
        } else if (error.status === 401) { clearRelaySession(); toast("登录已过期，请重新登录中转站"); }
        else {
          const message = readableError(error);
          if (state.relayError !== message) toast(`聊天同步失败：${message}`);
          state.relayError = message; state.relayStatus = "error";
          if (!error.status || error.status >= 500 || error.status === 429) scheduleRelayPush(5000);
        }
      } finally {
        relayPushInFlight = false;
        if (relayPushQueued && state.relaySession?.deviceToken === token) { relayPushQueued = false; scheduleRelayPush(500); }
      }
    }

    /**
     * 等待当前主设备最终快照得到服务端确认。
     * @param {function} current 租约和账号有效性检查
     * @returns {Promise<void>} 最终正文已保存
     * 注意事项：分片沿用消息 ID；先保存最终正文再提交 done，避免服务端去重保留旧分片。
     */
    async function flushRelayState(current) {
      for (let attempt = 0; attempt < 20 && current(); attempt++) {
        if (!relayPushInFlight) await pushRelayState();
        if (!current()) return;
        if (!relayPushInFlight && JSON.stringify(buildRelaySnapshot()) === relayPublishedSnapshot) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (current()) throw new Error("最终回复尚未完成同步，请检查中转站连接后重试");
    }

    /**
     * 防抖推送，避免每次按键都打中转站。
     * @param {number} [delayMs]
     * @returns {void}
     */
    /**
     * 设备平台的展示名称。
     * @param {string} platform 中转站返回的平台
     * @returns {string}
     */
    function devicePlatformLabel(platform) {
      return { mac: "Mac", android: "Android", web: "Web", windows: "Windows", linux: "Linux" }[platform] || platform || "设备";
    }

    /**
     * 离线设备的最近在线时间，用来在列表里区分很久没上线的设备。
     * @param {string|undefined} value 中转站返回的 lastSeenAt
     * @returns {string} 空字符串表示没有记录
     */
    function formatDeviceLastSeen(value) {
      if (!value) return "";
      const time = new Date(value);
      if (Number.isNaN(time.getTime())) return "";
      const delta = Date.now() - time.getTime();
      if (delta < 60_000) return "刚刚";
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
      return time.toLocaleDateString();
    }

    /**
     * 设备列表的比较串。内容没变时不重画，避免轮询把正在点的单选按钮刷掉。
     * @returns {string}
     */
    function relayDevicesSignature() {
      return state.relayDevices.map((device) => [
        device.id,
        device.name,
        device.platform,
        device.online,
        device.isPrimary,
        device.online ? "" : formatDeviceLastSeen(device.lastSeenAt),
      ].join("\t")).join("\n");
    }

    /**
     * 设置页开着时，把最新设备列表画出来。本机主设备身份变了就整页刷新，执行开关会跟着变。
     * @param {boolean} primaryRoleChanged 本机是否刚被换成或取消主设备
     * @returns {void}
     */
    function syncRelayDeviceList(primaryRoleChanged) {
      const settingsOpen = $("#settingsOverlay")?.classList.contains("open") && ["general", "connection"].includes(state.settingsSection);
      if (!settingsOpen || !$("#relayDeviceList") || relayPrimaryBusy) return;
      if (primaryRoleChanged && document.activeElement?.id !== "relayBaseUrl") {
        renderSettings();
        return;
      }
      if (relayDevicesSignature() !== relayDeviceListSignature) renderRelayDeviceList();
    }

    /**
     * 读取同账号下全部已登录设备，并记住本机是不是主设备。
     * @returns {Promise<void>}
     */
    async function loadRelayDevices() {
      if (!state.relaySession?.deviceToken) {
        state.relayDevices = [];
        syncRelayDeviceList(false);
        return;
      }
      const token = state.relaySession.deviceToken;
      const payload = await relayRequest("GET", "/api/v1/devices", token, null);
      if (state.relaySession?.deviceToken !== token) return;
      const previousHost = state.relayDevices.find((device) => device.isPrimary)?.id;
      state.relayDevices = Array.isArray(payload.devices) ? payload.devices : [];
      const hostChanged = previousHost !== state.relayDevices.find((device) => device.isPrimary)?.id;
      const wasPrimary = state.relaySession.isPrimary !== false;
      const mine = state.relayDevices.find((device) => device.id === state.relaySession.deviceId);
      if (mine) {
        state.relaySession.isPrimary = Boolean(mine.isPrimary);
        if (hostChanged || wasPrimary !== state.relaySession.isPrimary) resetHostConfig();
        if (wasPrimary !== state.relaySession.isPrimary) {
          saveRelaySession();
          if (wasPrimary && !state.relaySession.isPrimary) {
            if (state.sending) stopRun().catch(() => {});
            if (typeof ChorusTerminalUI !== "undefined") ChorusTerminalUI.reset?.().catch(() => {});
            closeOverlay("terminalOverlay");
            state.harnessModels = {};
          }
          publishGatewayConfig().catch(() => {});
          renderPanel();
          updateExecutionSettingsVisibility();
          if (state.relaySession.isPrimary) {
            if (!state.sending) state.running = null;
            state.harnessModels = {};
          }
          console.info(`[chorus] 本机主设备状态已更新 primary=${state.relaySession.isPrimary}`);
        }
      }
      if (!state.relayDevices.some((device) => device.isPrimary) && !state.sending) { state.running = null; renderRunning(); }
      syncRelayDeviceList(Boolean(mine) && wasPrimary !== state.relaySession.isPrimary);
      if (hostChanged || Boolean(mine) && wasPrimary !== state.relaySession.isPrimary) {
        if (isPrimaryDevice()) { loadDesktopModelSettings().catch(() => {}); refreshHarnessStatus().catch(() => {}); }
        else if (["models", "harness"].includes(state.settingsSection) && $("#settingsOverlay").classList.contains("open")) { renderSettings(); loadRemoteHostSettings(); }
      }
      if (isPrimaryDevice() && !hostConfigTimer) startHostConfigLoop();
    }

    /**
     * 按账号同步状态开放配置入口，终端只在主电脑显示。
     * @param 无
     * @returns {void}
     * 注意事项：配置权限与本机执行资格独立，非主设备不能执行本机 CLI。
     */
    function updateExecutionSettingsVisibility() {
      const editable = canEditAgentConfig();
      ["#btnNewAgent", "#btnNewAgentSide", "#btnNewRoom", "#btnNewRoomSide"].forEach((selector) => { const element = $(selector); if (element) element.hidden = !editable; });
      if ($("#btnTerminal")) $("#btnTerminal").hidden = !isPrimaryDevice();
      $$("#settingsNav button").forEach((button) => {
        if (["models", "harness", "agent", "approvals"].includes(button.dataset.settings)) button.hidden = !editable;
      });
    }

    /**
     * 把已登录设备画进通用设置。点另一台的单选即可更换主设备。
     * @returns {void}
     */
    function renderRelayDeviceList() {
      const box = $("#relayDeviceList");
      if (!box) return;
      if (!state.user?.verified) {
        relayDeviceListSignature = "";
        box.innerHTML = `<p style="margin:0;color:var(--text-faint);font-size:12px;">登录后会显示这个账号下的电脑和手机，选择执行任务的主电脑。</p>`;
        return;
      }
      if (!state.relaySession?.deviceToken) {
        relayDeviceListSignature = "";
        box.innerHTML = `<p style="margin:0;color:var(--text-faint);font-size:12px;">还没有连上中转站，重新登录后会列出同账号设备。</p>`;
        return;
      }
      if (!state.relayDevices.length) {
        relayDeviceListSignature = "";
        box.innerHTML = `<p style="margin:0;color:var(--text-faint);font-size:12px;">正在读取设备…</p>`;
        return;
      }
      const devices = [...state.relayDevices].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(b.online) - Number(a.online) || String(a.name || "").localeCompare(String(b.name || ""), "zh"));
      box.innerHTML = devices.map((device) => {
        const mine = device.id === state.relaySession.deviceId;
        const seen = device.online ? "" : formatDeviceLastSeen(device.lastSeenAt);
        const tags = [devicePlatformLabel(device.platform), device.online ? "在线" : (seen ? `离线 · ${seen}` : "离线"), mine ? "本机" : ""].filter(Boolean).join(" · ");
        const picked = device.isPrimary ? "is-primary" : "";
        const desktop = ["mac", "windows", "linux"].includes(device.platform);
        const eligible = desktop && device.online;
        return `<div class="settings-row device-row ${picked}">
          <div class="label"><strong>${escapeHtml(device.name || "未命名设备")}</strong><span>${escapeHtml(tags)}</span></div>
          <div class="device-actions"><label class="device-pick ${picked}">
            <input type="radio" name="relayPrimary" value="${escapeHtml(device.id)}" ${eligible && !relayPrimaryBusy ? "" : "disabled"} ${device.isPrimary ? "checked" : ""} />
            ${device.isPrimary ? "当前主电脑" : desktop ? device.online ? "设为主电脑" : "离线不可设置" : "聊天同步端"}
          </label><button type="button" class="device-remove" data-remove-device="${escapeHtml(device.id)}" ${relayPrimaryBusy ? "disabled" : ""} aria-label="删除设备 ${escapeHtml(device.name || "未命名设备")}">删除设备</button></div>
        </div>`;
      }).join("") + (devices.length < 2 ? `<p style="margin:8px 0 0;color:var(--text-faint);font-size:12px;">目前只有这一台。其他电脑或手机用同一账号登录后，会在这里显示。任务始终在主电脑执行。</p>` : "");
      relayDeviceListSignature = relayDevicesSignature();
      box.querySelectorAll("[data-remove-device]").forEach((button) => button.addEventListener("click", () => removeRelayDevice(button.dataset.removeDevice)));
      box.querySelectorAll('input[name="relayPrimary"]').forEach((input) => {
        input.addEventListener("change", () => {
          if (input.checked) setRelayPrimary(input.value);
        });
      });
    }

    /**
     * 把指定设备设为唯一主设备。只有主设备会用本机 Cursor、Codex 等资源执行回复。
     * @param {string} deviceId 中转站设备 ID
     * @returns {Promise<void>}
     */
    async function setRelayPrimary(deviceId) {
      if (!state.relaySession?.deviceToken || !deviceId || relayPrimaryBusy) return;
      const target = state.relayDevices.find((device) => device.id === deviceId);
      if (!target?.online) { renderRelayDeviceList(); return toast("离线不可设置"); }
      const token = state.relaySession.deviceToken;
      const previous = state.relayDevices.find((device) => device.isPrimary);
      if (previous?.id === deviceId) return;
      relayPrimaryBusy = true;
      $$('#relayDeviceList input[name="relayPrimary"]').forEach((input) => { input.disabled = true; });
      try {
        await relayRequest("POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/primary`, token, null);
        if (state.relaySession?.deviceToken !== token) return;
        console.info(`[chorus] 已请求切换主设备 device=${deviceId}`);
        await loadRelayDevices();
        if (state.relaySession?.deviceToken !== token) return;
        const current = state.relayDevices.find((device) => device.id === deviceId);
        toast(current?.isPrimary ? `已将「${current.name || "该设备"}」设为主设备` : "已更新主设备");
        if ($("#settingsOverlay")?.classList.contains("open") && state.settingsSection === "general") renderSettings();
        else renderRelayDeviceList();
      } catch (error) {
        if (state.relaySession?.deviceToken !== token) return;
        console.error("[chorus] 设置主设备失败", error);
        toast(error instanceof Error ? error.message : "设置主设备失败");
        renderRelayDeviceList();
      } finally {
        relayPrimaryBusy = false;
        if (state.relaySession?.deviceToken === token) renderRelayDeviceList();
      }
    }

    /**
     * 删除账号设备并撤销它的登录会话。
     * @param {string} deviceId 目标设备编号
     * @returns {Promise<void>} 完成后刷新列表，删除本机则清理本地登录
     * 注意事项：删除主电脑会暂停执行，必须重新选择在线主电脑；不会删除电脑文件。
     */
    async function removeRelayDevice(deviceId) {
      const token = state.relaySession?.deviceToken;
      const device = state.relayDevices.find((item) => item.id === deviceId);
      if (!token || !device || relayPrimaryBusy) return;
      const mine = deviceId === state.relaySession.deviceId;
      if (!window.confirm(`删除设备「${device.name || "未命名设备"}」并撤销登录？${device.isPrimary ? "删除后需重新选择在线主电脑才能执行任务。" : "该设备重新登录后可再次加入。"}`)) return;
      relayPrimaryBusy = true; renderRelayDeviceList();
      try {
        await relayRequest("DELETE", `/api/v1/devices/${encodeURIComponent(deviceId)}`, token, null);
        if (state.relaySession?.deviceToken !== token) return;
        console.info(`[chorus] 设备已删除 device=${deviceId} primary=${Boolean(device.isPrimary)}`);
        if (mine) await logout();
        else {
          await loadRelayDevices();
          if (state.relaySession?.deviceToken !== token) return;
          await pullRelayState();
          if (state.relaySession?.deviceToken === token) toast("设备已删除，登录已撤销");
        }
      } catch (error) {
        if (state.relaySession?.deviceToken === token) toast(readableError(error));
        console.warn(`[chorus] 删除设备未完成 status=${error.status || "network"}`);
      } finally { relayPrimaryBusy = false; if (state.relaySession?.deviceToken === token) renderRelayDeviceList(); }
    }

    /**
     * 打开通用设置时刷新设备列表。
     * @returns {void}
     */
    function refreshRelayDevicesInSettings() {
      const box = $("#relayDeviceList");
      if (!box || !state.relaySession?.deviceToken) return;
      const token = state.relaySession.deviceToken;
      loadRelayDevices().then(() => {
        if (state.relaySession?.deviceToken !== token) return;
        if ($("#relayDeviceList")) renderRelayDeviceList();
      }).catch((error) => {
        if (state.relaySession?.deviceToken !== token) return;
        const target = $("#relayDeviceList");
        if (target) target.innerHTML = `<p style="margin:0;color:var(--text-faint);font-size:12px;">${escapeHtml(error instanceof Error ? error.message : "读取设备失败")}</p>`;
      });
    }

    function scheduleRelayPush(delayMs = 400) {
      if (relayApplying || !state.relayReady || !state.relaySession?.deviceToken || !isPrimaryDevice()) return;
      if (relayPushTimer) clearTimeout(relayPushTimer);
      relayPushTimer = setTimeout(() => { relayPushTimer = null; pushRelayState(); }, delayMs);
    }

    function hasDesktopModelStorage() {
      return Boolean(window.chorusDesktop?.saveModelSettings && window.chorusDesktop?.getModelSettings);
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    function renderAttachmentChips(attachments = []) {
      if (!attachments.length) return "";
      return `<div class="msg-actions">${attachments
        .map((file) => `<span class="chip">附件 · ${escapeHtml(file.name)} · ${formatFileSize(Number(file.size) || 0)}</span>`)
        .join("")}</div>`;
    }

    function avatarStyle(name) {
      return AVATAR_COLORS[name] || AVATAR_COLORS.default;
    }

    function getAgent(id) {
      return state.agents.find((a) => a.id === id);
    }

    function getRoom(id) {
      return state.rooms.find((r) => r.id === id);
    }

    function activeRoom() {
      return getRoom(state.activeRoomId);
    }

    function nowTime() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    function toast(text) {
      const el = $("#toast");
      el.textContent = text;
      el.classList.add("show");
      clearTimeout(toast._t);
      const stay = Math.min(8000, Math.max(2800, String(text).length * 80));
      toast._t = setTimeout(() => el.classList.remove("show"), stay);
    }

    function updateClock() {
      const d = new Date();
      if (!$("#clock")) return;
      $("#clock").textContent = d.toLocaleString("zh-CN", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function renderRooms() {
      const q = $("#sidebarSearch").value.trim().toLocaleLowerCase();
      $("#roomList").innerHTML = state.rooms.filter((room) => !q || room.name.toLocaleLowerCase().includes(q))
        .map((room) => `<li><button type="button" class="room-item ${room.id === state.activeRoomId && state.panelMode === "room" ? "active" : ""}" data-room="${escapeHtml(room.id)}" aria-current="${room.id === state.activeRoomId && state.panelMode === "room"}"><span class="dot"></span><span class="meta"><div class="name">${escapeHtml(room.name)}</div><div class="sub">${room.agentIds.length} 位成员 · ${room.rule === "mention" ? "按需点名" : "自然群聊"}</div></span></button></li>`).join("") || '<li class="side-empty">没有匹配的团队</li>';
    }

    function renderAgents() {
      const q = $("#sidebarSearch").value.trim().toLocaleLowerCase();
      $("#agentList").innerHTML = state.agents.filter((agent) => !q || `${agent.name} ${agent.role}`.toLocaleLowerCase().includes(q)).map((agent) => {
        const color = avatarStyle(agent.name);
        const selected = state.panelMode === "agent" && agent.id === state.selectedAgentId;
        const running = state.running?.agentId === agent.id || state.running?.agentIds?.includes(agent.id);
        return `<li><button type="button" class="agent-item ${selected ? "selected" : ""}" data-agent="${escapeHtml(agent.id)}" aria-current="${selected}"><span class="avatar" style="background:${color.bg};color:${color.fg}">${escapeHtml(agent.initial)}</span><span class="agent-meta"><div class="name">${escapeHtml(agent.name)}</div><div class="harness">${escapeHtml(agent.role)} · ${escapeHtml(backendLabel(agent))}</div></span><span class="agent-presence ${running ? "running" : agentReady(agent) ? "ready" : ""}" title="${running ? "正在运行" : agentReady(agent) ? "已配置" : "待配置"}"></span></button></li>`;
      }).join("") || '<li class="side-empty">没有匹配的 Agent</li>';
    }

    function defaultModel(provider) {
      return provider === "anthropic" ? "claude-sonnet-4-5" : provider === "local" ? "qwen2.5" : provider === "custom" ? "" : "gpt-4.1";
    }

    function backendLabel(agent) {
      return agent.backend && agent.backend !== "model" ? HARNESS_LABEL[agent.backend] : agent.model || "自定义模型";
    }

    function agentReady(agent) {
      if (desktopManagedAgent(agent) && !usingDesktopAgent(agent)) return false;
      if (usingDesktopAgent(agent)) return (agent.backend || "model") === "model" || Boolean(state.settings.localExecution && agent.workspace?.trim());
      if ((agent.backend || "model") !== "model") {
        const status = state.harnessStatus[agent.backend];
        return Boolean(window.chorusDesktop && state.settings.localExecution && agent.workspace?.trim() && status?.available && status.authenticated !== false);
      }
      const key = agent.provider === "custom" ? "custom" : agent.provider;
      if (["local", "custom"].includes(key)) return Boolean(agent.model && (key === "local" || agent.endpoint));
      return Boolean(hasDesktopModelStorage() ? state.desktopModelSettings[`${key}Configured`] : state.settings.apiKeys?.[key]);
    }

    function chatContext() {
      const team = state.panelMode === "room";
      const owner = team ? activeRoom() : activeChatAgent();
      if (!owner) return { team, owner: null, thread: [], key: "" };
      if (!Array.isArray(owner.messages)) owner.messages = [];
      return { team, owner, thread: owner.messages, key: `${team ? "room" : "agent"}:${owner.id}` };
    }

    function saveDraft() {
      if (!state.draftKey) return;
      state.drafts[state.draftKey] = { text: $("#composerInput").value, attachments: state.pendingAttachments.map((file) => ({ ...file })) };
    }

    function restoreDraft() {
      const context = chatContext();
      state.draftKey = context.key;
      const draft = state.drafts[context.key];
      $("#composerInput").value = draft?.text || "";
      state.pendingAttachments = draft?.attachments?.map((file) => ({ ...file })) || [];
      renderComposerAttachments();
      updateComposer();
    }

    /**
     * 更新输入框高度与发送、停止和终端按钮状态。
     * @param 无
     * @returns {void}
     * 注意事项：目录准备期间禁用发送；输入框增高时仅让原本贴底的读者继续跟随。
     */
    function updateComposer() {
      const box = $("#messages");
      const follow = box.scrollHeight - box.clientHeight - box.scrollTop <= 2;
      const context = chatContext();
      const input = $("#composerInput");
      input.disabled = !window.chorusDesktop && !context.owner;
      input.style.height = "auto";
      input.style.height = `${Math.min(160, Math.max(50, input.scrollHeight))}px`;
      $("#btnSend").disabled = !context.owner || state.sending || state.preparingSend || state.connectionBusy || state.attachmentLoads.has(state.draftKey) || !(input.value.trim() || state.pendingAttachments.length);
      $("#btnSend").hidden = state.sending;
      $("#btnStop").hidden = !state.sending || (!isPrimaryDevice() && !state.desktopConnectionInfo);
      $("#btnStop").disabled = state.stopRequested;
      $("#btnComposerMode").hidden = true;
      $("#btnTerminal").disabled = state.sending || state.connectionBusy;
      if (follow) box.scrollTop = box.scrollHeight;
    }

    /**
     * 更新当前会话的运行提示，保留手动阅读位置与已有的贴底状态。
     * @param 无
     * @returns {void}
     * 注意事项：兼容旧主电脑同步的群聊文案；提示条改变消息区域高度，须提前判断是否贴底。
     */
    function renderRunning() {
      const box = $("#messages");
      const follow = box.scrollHeight - box.clientHeight - box.scrollTop <= 2;
      const viewing = state.running?.key === chatContext().key;
      $("#typing").hidden = !viewing;
      if (viewing) $("#typingText").textContent = String(state.running.label || "").replace(/ 正在查看群聊…$/, " 正在思考…");
      updateComposer();
      if (follow) box.scrollTop = box.scrollHeight;
    }

    function normalizeStoredMessages(messages, ownerId) {
      return C.normalizeMessages(messages, [ownerId]);
    }

    function ensureAgentThread(agent) {
      if (typeof agent.workspace !== "string") agent.workspace = "";
      if (!Array.isArray(agent.messages) || agent.messages.length === 0) {
        agent.messages = [{ id: `d-${agent.id}`, type: "day", text: "今天" }];
      }
      return agent;
    }

    /**
     * 当前中间栏正在进行的单独对话。
     * @returns {object | undefined} 选中的 Agent
     */
    function activeChatAgent() {
      return getAgent(state.selectedAgentId) || state.agents[0];
    }

    /**
     * 缩短工作区路径，避免顶栏溢出。
     * @param {string} path 原始路径
     * @returns {string} 展示用路径
     */
    function shortPath(path) {
      const value = String(path || "").trim();
      if (!value) return "";
      if (value.length <= 42) return value;
      return `${value.slice(0, 16)}…${value.slice(-18)}`;
    }

    /**
     * 把底层 IPC / 网络错误整理成可读提示。
     * @param {unknown} raw 原始错误
     * @returns {string} 用户可见文案
     */
    function friendlyErrorMessage(raw) {
      return String(raw instanceof Error ? raw.message : raw || "调用失败")
        .replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "").slice(0, 1200);
    }

    function renderMemberStack() {
      const context = chatContext();
      const owner = context.owner;
      $("#roomTitle").textContent = owner?.name || "选择一个 Agent";
      $("#titleSub").textContent = owner?.name || "Agent 工作台";
      $("#chatAvatar").textContent = context.team ? "#" : owner?.initial || "C";
      $("#roomSub").textContent = context.team
        ? `${owner?.agentIds.length || 0} 位成员 · ${owner?.rule === "mention" ? "@ 指定成员回应" : "成员并行参与，共享上下文"}`
        : `${owner?.role || "独立私聊"} · ${owner ? backendLabel(owner) : "待配置"}`;
      if (!window.chorusDesktop && !owner) {
        const loggedIn = Boolean(state.relaySession?.deviceToken && state.user?.verified);
        $("#roomTitle").textContent = loggedIn ? "等待电脑同步" : "登录以同步电脑聊天";
        $("#titleSub").textContent = loggedIn ? "同步电脑聊天" : "电脑与手机实时同步";
        $("#roomSub").textContent = loggedIn ? "主电脑保持 Chorus 运行，配置会自动同步，也可在这里新建 Agent 和团队" : "使用和电脑相同的账号登录，查看聊天与电脑配置";
      }
      $("#contextPill").textContent = !window.chorusDesktop && !owner ? "账号同步" : context.team ? "团队共享对话" : "独立私聊";
      $("#composerInput").placeholder = context.team ? "描述任务，让团队一起推进；也可以 @ 指定成员…" : `给 ${owner?.name || "Agent"} 发消息…`;
      const members = context.team ? (owner?.agentIds || []).map(getAgent).filter(Boolean) : [owner].filter(Boolean);
      const cli = members.filter((agent) => (agent.backend || "model") !== "model");
      $("#composerHint").textContent = cli.length ? `${cli.map((agent) => agent.name).join("、")} 使用完整编程后台 · 发送即在绑定工作区执行 · 终端可直接输入和审批` : context.team ? (owner?.rule === "mention" ? "团队共享上下文 · @ 指定成员回应" : "团队共享上下文 · 按相关性发言 · 成员可互相 @") : "对话与附件仅保存在当前 Agent 私聊";
      if (!window.chorusDesktop) {
        $("#composerHint").textContent = owner ? "聊天实时同步 · 任务由主电脑执行 · 可管理 Agent 与团队" : state.relaySession?.deviceToken ? "可新建 Agent 和团队，配置自动同步到主电脑" : "登录账号后同步电脑聊天";
        if (!owner) $("#composerInput").placeholder = state.relaySession?.deviceToken ? "等待电脑同步聊天配置…" : "先登录账号以同步电脑聊天…";
      }
      const strip = $("#teamStrip");
      strip.hidden = !context.team;
      strip.innerHTML = context.team ? (owner?.agentIds || []).map(getAgent).filter(Boolean).map((agent) => {
        const color = avatarStyle(agent.name);
        return `<button type="button" class="member-chip" data-open-agent="${escapeHtml(agent.id)}" title="打开 ${escapeHtml(agent.name)} 的私聊"><span class="mini-av" style="background:${color.bg};color:${color.fg}">${escapeHtml(agent.initial)}</span>${escapeHtml(agent.name)}</button>`;
      }).join("") + '<span class="strip-note">点击成员进入私聊 ↗</span>' : "";
      renderRunning();
    }

    /** 说明非主设备可管理共享配置，实际执行仍在主电脑。 */
    function relayWelcome(context) {
      const loggedIn = Boolean(state.relaySession?.deviceToken && state.user?.verified);
      const hasConversation = Boolean(context.owner);
      const title = !loggedIn ? "登录账号，<br>同步电脑聊天。" : !hasConversation ? "创建 Agent，<br>组建协作团队。" : context.team ? `和「${escapeHtml(context.owner.name)}」开始讨论。` : `和 ${escapeHtml(context.owner.name)} 开始聊天。`;
      const hint = !loggedIn ? "先登录和电脑相同的账号" : !hasConversation ? "主电脑保持 Chorus 运行" : "消息交给主电脑执行";
      const description = !loggedIn ? "登录后自动显示电脑的团队、Agent 和聊天记录。电脑和手机都连接同一中转站，无需在手机配置执行后台。" : !hasConversation ? "可在这里新建 Agent、创建团队并选择模型和内核。项目路径填写主电脑上的实际目录，任务由主电脑执行。" : "可在这里新建和编辑 Agent、管理团队，配置关联主电脑。手机发送消息后，电脑上的 Agent 执行，回复会实时同步到这里。";
      return `<div class="empty-state"><div class="empty-eyebrow">电脑与手机实时同步</div><h3>${title}</h3><p>所有设备共享 Agent、团队与聊天。配置路径属于主电脑，执行任务时请保持主电脑运行 Chorus。</p><div class="ready-card"><span class="ready-icon">${loggedIn && hasConversation ? "✓" : "◇"}</span><div class="ready-text"><strong>${hint}</strong><p>${description}</p>${!loggedIn ? '<button type="button" data-setup="auth">登录账号 →</button> ' : ""}<button type="button" data-setup="connection">中转站连接 →</button>${hasConversation ? ' <button type="button" data-setup="details">查看电脑配置 →</button>' : ""}</div></div></div>`;
    }

    function relayExecutionDescription() {
      if (!state.relaySession?.deviceToken) return "登录同一账号后，可管理 Agent、团队及主电脑配置。";
      const hasDesktop = state.relayDevices.some((device) => device.isPrimary && ["mac", "windows", "linux"].includes(device.platform));
      if (!state.relayReady || !state.relayConfigSynced || !hasDesktop) return "可在这里配置 Agent 与团队；执行任务和检测路径时请保持主电脑在线。";
      return `任务与文件操作在主电脑执行。主电脑执行开关：${state.settings.localExecution ? "已开启" : "已关闭"}。`;
    }

    /**
     * 更新聊天内容，并按照用户刷新前的阅读位置决定是否跟随新消息。
     * @param {HTMLElement} box 消息滚动容器
     * @param {string} html 本次完整消息内容
     * @param {string} key 含账号作用域的会话标识
     * @param {boolean | undefined} pin true 主动跳到底部，false 保持位置，省略则仅贴底时跟随
     * @returns {void}
     * 注意事项：切换会话默认显示最新消息；同步完成滚动，不排队延迟操作干扰后续手势。
     */
    function updateMessageViewport(box, html, key, pin) {
      const previous = messageViews.get(box);
      const changed = previous?.key !== key;
      if (!changed && previous.html === html && pin !== true) return;

      // ------------ 重绘前记录阅读锚点，贴底状态必须在内容增长前判断 ---------------
      const previousScroll = box.scrollTop;
      const follow = changed || pin === true || (pin !== false && box.scrollHeight - box.clientHeight - previousScroll <= 2);
      const top = box.getBoundingClientRect().top;
      const anchor = follow ? null : [...box.querySelectorAll("[data-message-id]")].find((item) => item.getBoundingClientRect().bottom > top);
      const anchorId = anchor?.dataset.messageId;
      const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
      if (changed || previous.html !== html) box.innerHTML = html;
      messageViews.set(box, { key, html });

      // ------------ 原地恢复可见消息，避免历史补齐或重试改变上方消息高度时跳动 ---------------
      if (follow) box.scrollTop = box.scrollHeight;
      else {
        const restored = anchorId ? [...box.querySelectorAll("[data-message-id]")].find((item) => item.dataset.messageId === anchorId) : null;
        box.scrollTop = restored ? box.scrollTop + restored.getBoundingClientRect().top - box.getBoundingClientRect().top - offset : previousScroll;
      }
      console.debug(`[chorus] 聊天视图更新 follow=${follow} switched=${changed} scrollTop=${box.scrollTop}`);
    }

    /**
     * 渲染当前团队或私聊，并由统一视口逻辑保护历史阅读位置。
     * @param {object} options 滚动选项，pin 含义见 updateMessageViewport
     * @returns {void}
     * 注意事项：后台刷新不可强制贴底，仅用户主动发送时传入 pin: true。
     */
    function renderMessages({ pin } = {}) {
      const context = chatContext();
      const box = $("#messages");
      const key = JSON.stringify([state.accountScope, context.key]);
      const messages = context.thread.filter((item) => item.type !== "day");
      box.classList.toggle("is-empty", !messages.length);
      if (!messages.length) {
        if (!window.chorusDesktop) { updateMessageViewport(box, relayWelcome(context), key, pin); return; }
        const members = context.team ? (context.owner?.agentIds || []).map(getAgent).filter(Boolean) : [context.owner].filter(Boolean);
        const pending = members.filter((agent) => !agentReady(agent));
        const html = `<div class="empty-state"><div class="empty-eyebrow">${context.team ? "THINK TOGETHER, BUILD TOGETHER" : "YOUR PERSONAL AGENT"}</div><h3>${context.team ? "把想法交给团队，<br>一起推进下一步。" : `和 ${escapeHtml(context.owner?.name || "Agent")} 开始协作。`}</h3><p>${context.team ? "一个空间，多个视角。成员按相关性参与讨论，用你选择的模型或编程后台，从讨论走向实现。" : escapeHtml(context.owner?.persona || "创建角色，选择模型或编程后台，开始你的第一段对话。")}</p><div class="ready-card"><span class="ready-icon">${pending.length ? "◇" : "✓"}</span><div class="ready-text"><strong>${pending.length ? "前往设置完善配置" : "配置已就绪，可以开始讨论"}</strong><p>${pending.length ? `${pending.map((agent) => escapeHtml(agent.name)).join("、")} 还未连接。填写模型密钥，或编辑 Agent 选择本机 CLI。` : "输入任务，或选择下方的开场方向。模型与内核仍需有可用额度和网络。"}</p><button type="button" data-setup="models">模型与密钥 →</button> <button type="button" data-setup="harness">本机内核 →</button></div></div><div class="starter-grid"><button type="button" class="starter-card" data-prompt="我想构建一个新产品。请先帮我澄清用户、核心需求与验收标准，再给出实现方案。"><strong>梳理一个新想法 ↗</strong><span>从需求、边界和验收标准开始</span></button><button type="button" class="starter-card" data-prompt="请从设计、实现和审查的角度，共同分析这个问题："><strong>一起解决问题 ↗</strong><span>结合不同角色，给出可执行的下一步</span></button></div></div>`;
        updateMessageViewport(box, html, key, pin);
        return;
      }
      const html = `<div class="day-sep">${context.team ? "团队讨论" : "独立私聊"} · ${messages.length} 条消息</div>` + messages.map((message) => {
        const human = message.from === "you";
        const agent = getAgent(message.from);
        const color = avatarStyle(agent?.name || message.author);
        const name = human ? "你" : agent?.name || message.author || "已移除的成员";
        const body = message.error ? `<div class="msg-body is-error">${escapeHtml(friendlyErrorMessage(message.text))}</div>` : `<div class="msg-body ${human ? "" : "md"}">${human ? formatBody(message.text) : renderMarkdown(message.text)}</div>`;
        return `<div class="msg ${human ? "you" : ""}" data-message-id="${escapeHtml(message.id)}">${human ? "" : `<div class="av" style="background:${color.bg};color:${color.fg}">${escapeHtml(agent?.initial || name.slice(0, 1))}</div>`}<div class="msg-bubble"><div class="msg-head"><span class="who">${escapeHtml(name)}</span><span class="when">${escapeHtml(message.time || "")}</span></div>${body}${renderAttachmentChips(message.attachments)}${message.chips?.length ? `<div class="msg-actions">${message.chips.map((chip) => `<span class="chip ${message.error ? "error" : "live"}">${escapeHtml(chip)}</span>`).join("")}</div>` : ""}<div class="msg-utilities"><button type="button" data-copy="${escapeHtml(message.id)}">复制</button>${message.error && agent && message.requestId ? `<button type="button" data-retry="${escapeHtml(message.id)}" ${state.sending ? "disabled" : ""}>重试此回复</button><button type="button" data-edit-failed="${escapeHtml(agent.id)}">检查配置</button>` : ""}</div></div></div>`;
      }).join("");
      updateMessageViewport(box, html, key, pin);
    }

    function setPanelCollapsed(collapsed) {
      state.panelCollapsed = collapsed;
      $("#appBody").classList.toggle("panel-collapsed", collapsed);
      document.documentElement.classList.toggle("panel-sheet-open", !collapsed && window.innerWidth <= 900);
      $("#btnTogglePanel").setAttribute("aria-pressed", String(!collapsed));
      $("#btnTogglePanel").title = collapsed ? "显示详情" : "隐藏详情";
    }

    function openPanel(mode, { agentId = null, expand = true } = {}) {
      saveDraft();
      state.panelMode = mode;
      if (mode === "agent" && agentId) state.selectedAgentId = agentId;
      if (!getAgent(state.selectedAgentId)) state.selectedAgentId = state.agents[0]?.id;
      if (expand && window.innerWidth > 900) setPanelCollapsed(false);
      else if (window.innerWidth <= 900) setPanelCollapsed(true);
      document.documentElement.classList.remove("drawer-open");
      renderRooms(); renderAgents(); renderMemberStack(); renderMessages(); renderPanel();
      restoreDraft();
      persistApp();
    }

    function roomsContainingAgent(agentId) {
      return state.rooms.filter((r) => r.agentIds.includes(agentId));
    }

    function renderPanel() {
      const body = $("#panelBody");
      const title = $("#panelTitle");

      if (state.panelMode === "agent") {
        const a = getAgent(state.selectedAgentId);
        if (!a) {
          title.textContent = "Agent";
          body.innerHTML = `<div class="panel-empty">选择一个 Agent<br/>查看人设与内核</div>`;
          return;
        }
        const c = avatarStyle(a.name);
        const joined = roomsContainingAgent(a.id);
        title.textContent = `Agent · ${a.name}`;
        body.innerHTML = `
          <div class="agent-card-hero">
            <div class="big-av" style="background:${c.bg};color:${c.fg}">${escapeHtml(a.initial)}</div>
            <h3>${escapeHtml(a.name)}</h3>
            <p>${escapeHtml(a.role)}</p>
          </div>
          <div class="field">
            <label>人设</label>
            <div class="value">${escapeHtml(a.persona)}</div>
          </div>
          <div class="field">
            <label>Agent 后台</label>
            <div class="value mono">${escapeHtml(backendLabel(a))}${(a.backend || "model") === "model" ? `<br>${escapeHtml(a.provider)}` : " · 完整编程，可修改文件"}${usingDesktopAgent(a) ? "<br>通过已连接的 Mac 运行" : ""}</div>
          </div>
          <div class="field">
            <label>执行内核</label>
            <div class="value">
              <span class="harness-pill ${escapeHtml(a.harness)}">${escapeHtml(HARNESS_LABEL[a.harness] || "仅对话")}</span>
            </div>
          </div>
          <div class="field">
            <label>文件空间</label>
            <div class="value">${a.harness === "none" && (a.backend || "model") === "model" ? "纯对话，无需文件目录" : a.workspaceMode === "auto" || !a.workspace ? "自动管理 · 主电脑为 Agent 准备独立目录" : escapeHtml(a.workspace)}</div>
            <div class="workspace-empty">工作区保存 Agent 创建的文件，聊天记录单独保存；仅聊天时目录可能为空。需要操作已有项目时，可在编辑 Agent 中绑定主电脑上的目录。</div>
          </div>
          <div class="field">
            <label>所属团队</label>
            <div class="value">
              ${
                joined.length
                  ? `<div class="rooms-joined">${joined
                      .map((r) => `<span>${escapeHtml(r.name)}</span>`)
                      .join("")}</div>`
                  : `<span style="color:var(--text-faint);font-size:12px">尚未加入团队（可在团队详情里添加）</span>`
              }
            </div>
          </div>
          <div class="panel-actions">
            ${canEditAgentConfig() ? '<button class="btn-block" type="button" id="btnEditAgent">编辑 Agent</button>' : '<div class="workspace-empty">登录同一账号后可编辑配置。</div>'}
          </div>`;
        $("#btnEditAgent")?.addEventListener("click", () => openEditAgentModal(a.id));
        return;
      }

      // ---- 群设置（点群聊时）----
      const room = activeRoom();
      if (!room) { title.textContent = "团队"; body.innerHTML = `<div class="panel-empty">${window.chorusDesktop ? "请选择或创建一个团队" : "登录后选择电脑已同步的团队"}</div>`; return; }
      title.textContent = `团队详情 · ${room.name}`;
      const managed = !canEditAgentConfig();
      const baseRevision = state.relaySession?.revision || 0, configRevision = state.relayConfigRevision;
      const nameDraft = state.roomNameDraft?.id === room.id ? state.roomNameDraft : null;
      const members = room.agentIds.map(getAgent).filter(Boolean);
      const outsiders = state.agents.filter((a) => !room.agentIds.includes(a.id));

      body.innerHTML = `
        <div class="field">
          <label>团队名称</label>
          <div class="inline-edit">
            <input id="roomNameEdit" value="${escapeHtml(nameDraft?.name ?? room.name)}" maxlength="40" />
            <button type="button" id="btnSaveRoomName">保存</button>
          </div>
        </div>
        <div class="field">
          <label>协作方式</label>
          <select id="teamRule" class="team-rule" aria-label="团队回应规则"><option value="free" ${room.rule === "free" ? "selected" : ""}>自然群聊 · 按相关性发言</option><option value="mention" ${room.rule === "mention" ? "selected" : ""}>仅点名 · @ 成员回应</option></select>
          <div class="value">团队共享讨论与附件。成员先判断是否与自己有关，有需要再发言，也可 @ 其他成员继续协作。私聊独立保存。</div>
        </div>
        <div class="field">
          <label>团队成员（${members.length}）</label>
          <div id="roomMembers">
            ${
              members.length
                ? members
                    .map((a) => {
                      const c = avatarStyle(a.name);
                      const canKick = members.length > 1;
                      return `<div class="member-row">
                        <span class="avatar" style="width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;background:${c.bg};color:${c.fg}">${escapeHtml(a.initial)}</span>
                        <div class="info">
                          <div class="name">${escapeHtml(a.name)}</div>
                          <div class="meta">${escapeHtml(backendLabel(a))}</div>
                        </div>
                        <button type="button" class="kick" data-team-edit="${escapeHtml(a.id)}">配置</button><button type="button" class="kick" data-kick="${escapeHtml(a.id)}" ${canKick ? "" : "disabled"} title="${canKick ? "移出团队" : "至少保留一人"}">移出</button>
                      </div>`;
                    })
                    .join("")
                : `<div class="panel-empty" style="padding:16px 0">暂无成员</div>`
            }
          </div>
        </div>
        <div class="field">
          <label>添加成员</label>
          <div class="invite-list" id="inviteList">
            ${
              outsiders.length
                ? outsiders
                    .map((a) => {
                      const c = avatarStyle(a.name);
                      return `<button type="button" data-invite="${a.id}">
                        <span class="avatar" style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;background:${c.bg};color:${c.fg}">${escapeHtml(a.initial)}</span>
                        <span>${escapeHtml(a.name)}</span>
                        <span style="margin-left:auto;font-size:11px;color:var(--text-faint)">+ 加入</span>
                      </button>`;
                    })
                    .join("")
                : `<div style="font-size:12px;color:var(--text-faint);padding:4px 0">所有 Agent 都已在团队里</div>`
            }
          </div>
        </div>`;

      body.insertAdjacentHTML("beforeend", '<button type="button" class="btn-block danger" id="btnDeleteRoom">删除团队</button>');
      if (managed) $$('input,select,[data-kick],[data-invite],#btnSaveRoomName,#btnDeleteRoom', body).forEach((element) => { element.disabled = true; });
      if (!isPrimaryDevice()) {
        const note = document.createElement("div"); note.className = "workspace-empty";
        note.textContent = "团队配置由同账号设备共享，所有任务与文件操作在主电脑执行。"; body.prepend(note);
      }
      $("#roomNameEdit")?.addEventListener("input", (event) => {
        state.roomNameDraft = { id: room.id, name: event.target.value, baseRevision: nameDraft?.baseRevision ?? baseRevision, configRevision: nameDraft?.configRevision ?? configRevision };
      });
      $("#teamRule")?.addEventListener("change", (event) => saveRoomConfig(room.id, { rule: event.target.value }, { baseRevision, configRevision }));
      $$(`[data-team-edit]`, body).forEach((button) => button.addEventListener("click", () => openEditAgentModal(button.dataset.teamEdit)));
      $("#btnSaveRoomName")?.addEventListener("click", () => {
        const name = $("#roomNameEdit").value.trim();
        if (!name) return toast("团队名称不能为空");
        return saveRoomConfig(room.id, { name }, state.roomNameDraft || { baseRevision, configRevision });
      });
      $$("[data-kick]", body).forEach((button) => button.addEventListener("click", () => {
        if (room.agentIds.length <= 1) return toast("团队至少保留一个 Agent");
        return saveRoomConfig(room.id, { agentIds: room.agentIds.filter((id) => id !== button.dataset.kick) }, { baseRevision, configRevision });
      }));
      $$("[data-invite]", body).forEach((button) => button.addEventListener("click", () => {
        if (!room.agentIds.includes(button.dataset.invite)) return saveRoomConfig(room.id, { agentIds: [...room.agentIds, button.dataset.invite] }, { baseRevision, configRevision });
      }));
      $("#btnDeleteRoom")?.addEventListener("click", () => deleteRoom(room.id, { baseRevision, configRevision }));
    }

    /**
     * 保存群名称、回应规则或成员列表。
     * @param {string} id 群 ID
     * @param {object} config 本次修改的字段
     * @param {object} draft 表单版本基准
     * @returns {Promise<void>} 保存结果已展示
     * 注意事项：失败不先改本地对象，避免同步把失败配置当成成功。
     */
    async function saveRoomConfig(id, config, draft) {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      const room = getRoom(id);
      if (!room) return;
      try {
        if (state.relaySession?.deviceToken) {
          if (!await saveRelayConfig("PATCH", `/api/v1/rooms/${encodeURIComponent(id)}`, { config }, draft, () => Boolean(getRoom(id)))) return;
        } else Object.assign(room, config);
        if (config.name !== undefined && state.roomNameDraft === draft && state.roomNameDraft?.name?.trim() === config.name) state.roomNameDraft = null;
        renderAll(); toast("团队配置已保存");
      } catch (error) { toast(readableError(error)); }
    }

    /**
     * 删除群及其聊天记录，成员本身仍保留。
     * @param {string} id 群 ID
     * @param {object} draft 版本基准
     * @returns {Promise<void>} 删除结果已展示
     * 注意事项：先明确确认，有在途任务时服务端拒绝删除。
     */
    async function deleteRoom(id, draft) {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      const room = getRoom(id);
      if (!room || !window.confirm(`确定删除团队「${room.name}」及其聊天记录？Agent 本身会保留。`)) return;
      try {
        if (state.relaySession?.deviceToken) {
          if (!await saveRelayConfig("DELETE", `/api/v1/rooms/${encodeURIComponent(id)}`, {}, draft, () => Boolean(getRoom(id)))) return;
        } else state.rooms = state.rooms.filter((item) => item.id !== id);
        if (state.activeRoomId === id) state.activeRoomId = state.rooms[0]?.id || "";
        if (state.roomNameDraft?.id === id) state.roomNameDraft = null;
        renderAll(); toast("团队已删除");
      } catch (error) { toast(readableError(error)); }
    }

    function renderAll() {
      renderRooms(); renderAgents(); renderMemberStack(); renderMessages(); renderPanel();
      setPanelCollapsed(state.panelCollapsed);
      persistApp();
    }

    function escapeHtml(s) {
      return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function formatBody(text) {
      const escaped = escapeHtml(text);
      return highlightMentions(escaped);
    }

    /**
     * 高亮 @Agent 提及。
     * @param {string} html 已转义文本
     * @returns {string} 带 mention 的 HTML
     */
    function highlightMentions(html) {
      const names = state.agents
        .map((agent) => escapeHtml(agent.name))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp);
      if (!names.length) return html;
      return html.replace(
        new RegExp(`@(${names.join("|")})(?=$|\\s|[，。,.!?！？:：;；])`, "giu"),
        '<span class="mention">@$1</span>',
      );
    }

    /**
     * 行内 Markdown（需先 escape）。
     * @param {string} source 原始行内文本
     * @returns {string} HTML
     */
    function renderMarkdownInline(source) {
      const slots = [];
      let text = escapeHtml(source).replace(/`([^`\n]+)`/g, (_, code) => {
        const i = slots.length;
        slots.push(`<code>${code}</code>`);
        return `%%CODE_${i}%%`;
      });
      text = highlightMentions(text);
      text = text.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );
      text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
      text = text.replace(/(^|[^\w_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
      text = text.replace(/%%CODE_(\d+)%%/g, (_, i) => slots[Number(i)] || "");
      return text;
    }

    /**
     * 将普通文本段落解析为块级 Markdown HTML。
     * @param {string} raw 不含 fence 的文本
     * @returns {string} HTML
     */
    function renderMarkdownBlocks(raw) {
      const lines = String(raw || "").split("\n");
      const out = [];
      let i = 0;

      /**
       * 当前行是否是新的块起始。
       * @param {string} line 行文本
       * @returns {boolean}
       */
      function isBlockStart(line) {
        const t = line.trim();
        if (!t) return true;
        if (/^#{1,3}\s+/.test(line)) return true;
        if (/^>\s?/.test(line)) return true;
        if (/^[-*+]\s+/.test(line)) return true;
        if (/^\d+\.\s+/.test(line)) return true;
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
        if (/^\|.+\|/.test(t)) return true;
        return false;
      }

      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          i += 1;
          continue;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
          out.push("<hr>");
          i += 1;
          continue;
        }
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          out.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
          i += 1;
          continue;
        }
        if (/^>\s?/.test(line)) {
          const quote = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            quote.push(lines[i].replace(/^>\s?/, ""));
            i += 1;
          }
          out.push(`<blockquote>${renderMarkdownBlocks(quote.join("\n"))}</blockquote>`);
          continue;
        }
        if (/^[-*+]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
            items.push(`<li>${renderMarkdownInline(lines[i].replace(/^[-*+]\s+/, ""))}</li>`);
            i += 1;
          }
          out.push(`<ul>${items.join("")}</ul>`);
          continue;
        }
        if (/^\d+\.\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
            items.push(`<li>${renderMarkdownInline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
            i += 1;
          }
          out.push(`<ol>${items.join("")}</ol>`);
          continue;
        }
        if (/^\|.+\|/.test(line.trim())) {
          const rows = [];
          while (i < lines.length && /^\|.+\|/.test(lines[i].trim())) {
            rows.push(lines[i].trim());
            i += 1;
          }
          const parsed = rows
            .filter((row) => !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(row))
            .map((row) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
          if (parsed.length) {
            const [head, ...body] = parsed;
            const thead = `<tr>${head.map((cell) => `<th>${renderMarkdownInline(cell)}</th>`).join("")}</tr>`;
            const tbody = body.map((row) => `<tr>${row.map((cell) => `<td>${renderMarkdownInline(cell)}</td>`).join("")}</tr>`).join("");
            out.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
          }
          continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
          para.push(lines[i]);
          i += 1;
        }
        // 若 isBlockStart 在非空行误拦，至少吃掉当前行
        if (!para.length && lines[i] !== undefined) {
          para.push(lines[i]);
          i += 1;
        }
        if (para.length) {
          out.push(`<p>${renderMarkdownInline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
        }
      }
      return out.join("");
    }

    /**
     * 将 Agent 回复按 Markdown 渲染为安全 HTML。
     * @param {string} source 原始文本
     * @returns {string} HTML
     */
    function renderMarkdown(source) {
      const text = String(source ?? "").replace(/\r\n/g, "\n");
      if (!text.trim()) return "";
      const parts = [];
      const fenceRe = /```([^\n`]*)\n?([\s\S]*?)```/g;
      let last = 0;
      let match;
      while ((match = fenceRe.exec(text))) {
        if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
        parts.push({ type: "fence", code: match[2].replace(/\n$/, "") });
        last = match.index + match[0].length;
      }
      if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
      if (!parts.length) parts.push({ type: "text", value: text });
      return parts
        .map((part) => {
          if (part.type === "fence") return `<pre><code>${escapeHtml(part.code)}</code></pre>`;
          return renderMarkdownBlocks(part.value);
        })
        .join("");
    }

    function openOverlay(id) {
      overlayFocus.set(id, document.activeElement);
      $(`#${id}`).classList.add("open");
      $(".desk").inert = true;
      requestAnimationFrame(() => $(`#${id} button, #${id} input`)?.focus());
    }
    function closeOverlay(id) {
      if (!$(`#${id}`).classList.contains("open")) return;
      $(`#${id}`).classList.remove("open");
      $(".desk").inert = Boolean($(".overlay.open"));
      overlayFocus.get(id)?.focus();
      overlayFocus.delete(id);
    }

    function selectChoice(containerSel, attr, value) {
      $$(`${containerSel} .choice`).forEach((el) => {
        el.classList.toggle("selected", el.dataset[attr] === value);
      });
    }

    function applyTheme(theme) {
      state.settings.theme = theme;
      localStorage.setItem("chorus-theme", theme);
      document.documentElement.setAttribute("data-theme", theme);
    }

    function resetAgentWizard() {
      ++state.agentModalEpoch;
      const provider = ["openai", "anthropic", "local", "custom"].includes(state.settings.defaultProvider)
        ? state.settings.defaultProvider
        : "openai";
      state.agentModalMode = "create";
      state.editingAgentId = null;
      state.agentWizardStep = 1;
      state.agentDraft = { id: `a-${crypto.randomUUID()}`, provider, harness: "none", backend: "model", harnessModel: "", baseRevision: state.relaySession?.revision || 0, configRevision: state.relayConfigRevision };
      selectChoice("#backendChoices", "backend", "model");
      $("#agentName").value = "";
      $("#agentRole").value = "";
      $("#agentPersona").value = "";
      $("#agentWorkspace").value = "";
      $("#modelId").value = provider === "anthropic" ? "claude-sonnet-4-5" : provider === "local" ? "qwen2.5" : "gpt-4.1";
      $("#modelEndpoint").value = "";
      selectChoice("#providerChoices", "provider", provider);
      selectChoice("#harnessChoices", "harness", "none");
      $("#customEndpointRow").hidden = true;
      syncAgentWizardUI();
    }

    function syncAgentWizardUI() {
      for (const [draftName, choices, chooser] of [["agentDraft", "#harnessChoices", "#chooseCreateWorkspace"], ["editDraft", "#editHarnessChoices", "#chooseEditWorkspace"]]) {
        const draft = state[draftName];
        const cli = (draft.backend || "model") !== "model";
        if (cli) { draft.harness = draft.backend; selectChoice(choices, "harness", draft.backend); }
        const grid = $(choices);
        grid.hidden = cli;
        let note = $(".backend-harness-note", grid.parentElement);
        if (!note) { note = document.createElement("p"); note.className = "sub-hint backend-harness-note"; grid.after(note); }
        note.hidden = !cli;
        note.textContent = `执行内核跟随后台：${HARNESS_LABEL[draft.backend] || ""}。发送消息即可编程，文件空间自动管理，终端可直接输入和审批。`;
        $$("[data-harness]", grid).forEach((button) => { button.disabled = cli; });
        $(chooser).hidden = !isPrimaryDevice() || !window.chorusDesktop?.chooseWorkspace;
        const prefix = draftName === "agentDraft" ? "create" : "edit";
        $(`#${prefix}WorkspaceOptions`).hidden = !cli && draft.harness === "none";
        renderHarnessModelChoice(prefix);
      }
      $("#modelConfigCreate").hidden = (state.agentDraft.backend || "model") !== "model";
      $("#modelConfigEdit").hidden = (state.editDraft.backend || "model") !== "model";
      const isEdit = state.agentModalMode === "edit";
      $("#agentFormCreate").hidden = isEdit;
      $("#agentFormEdit").hidden = !isEdit;
      $("#agentSteps").hidden = isEdit;
      $("#agentDelete").hidden = !isEdit || !canEditAgentConfig();
      $("#agentBack").hidden = isEdit || state.agentWizardStep === 1;

      const executionConfig = $("#editExecutionConfig");
      if (executionConfig) executionConfig.hidden = false;
      if (isEdit) {
        $("#agentModalTitle").textContent = "编辑 Agent";
        $("#agentStepHint").textContent = "修改角色、执行内核与模型，配置关联主电脑";
        $("#agentNext").textContent = "保存修改";
        return;
      }
      const step = state.agentWizardStep;
      $("#agentStep1").hidden = step !== 1;
      $("#agentStep2").hidden = step !== 2;
      $("#agentStep3").hidden = step !== 3;
      $("#agentNext").textContent = step === 3 ? "创建 Agent" : "下一步";
      const hints = ["第 1 步 · 人设与角色", "第 2 步 · 选择模型或完整编程后台", "第 3 步 · 工作区自动创建，无需填写"];
      $("#agentModalTitle").textContent = "新建 Agent";
      $("#agentStepHint").textContent = hints[step - 1];
      $$("#agentSteps .step").forEach((el, i) => {
        el.classList.toggle("on", i === step - 1);
        el.classList.toggle("done", i < step - 1);
      });
      $("#customEndpointRow").hidden = state.agentDraft.provider !== "custom";
    }

    function openAgentModal() {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      resetAgentWizard();
      openOverlay("agentOverlay");
      setTimeout(() => $("#agentName").focus(), 50);
    }

    function openEditAgentModal(agentId) {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      const a = getAgent(agentId);
      if (!a) return;
      if (desktopManagedAgent(a) && !state.relaySession?.deviceToken) return toast("这个 Agent 的配置来自 Mac，请在 Mac 上修改后重新同步连接");
      ++state.agentModalEpoch;
      state.agentModalMode = "edit";
      state.editingAgentId = agentId;
      state.editDraft = {
        provider: a.provider,
        backend: a.backend || "model",
        harness: a.harness,
        harnessModel: a.harnessModel || "",
        baseRevision: state.relaySession?.revision || 0,
        configRevision: state.relayConfigRevision,
      };
      $("#editAgentName").value = a.name;
      $("#editAgentRole").value = a.role;
      $("#editAgentPersona").value = a.persona;
      $("#editAgentLabel").value = a.label || "";
      $("#editAgentWorkspace").value = a.workspaceMode === "auto" ? "" : a.workspace || "";
      $("#editProjectDetails").open = Boolean($("#editAgentWorkspace").value);
      $("#editModelId").value = a.model;
      $("#editModelEndpoint").value = a.endpoint || "";
      $("#editTemperature").value = a.temperature ?? 0.7;
      selectChoice("#editProviderChoices", "provider", a.provider);
      selectChoice("#editBackendChoices", "backend", a.backend || "model");
      selectChoice("#editHarnessChoices", "harness", a.harness);
      $("#editEndpointRow").hidden = a.provider !== "custom";
      syncAgentWizardUI();
      openOverlay("agentOverlay");
      setTimeout(() => $("#editAgentName").focus(), 50);
    }

    /**
     * 保存 Agent 配置，已有目录保留，空目录自动创建。
     * @param 无
     * @returns {Promise<void>} 保存完成或已显示校验错误
     * 注意事项：异步目录创建结束后再次确认编辑对象和账号仍有效。
     */
    async function saveEditedAgent() {
      if (!canEditAgentConfig() || (!isPrimaryDevice() && !state.relayReady)) return toast("请先恢复中转站连接，再保存配置");
      const scope = state.accountScope, token = state.relaySession?.deviceToken, attempt = authAttemptEpoch, conversation = conversationEpoch, hostEpoch = state.hostConfigEpoch;
      const epoch = state.agentModalEpoch;
      const agent = getAgent(state.editingAgentId);
      if (!agent) return;
      if (state.sending) return toast("请先停止这个 Agent 的任务，再修改配置");
      const draft = { ...agent, name: $("#editAgentName").value.trim(), role: $("#editAgentRole").value.trim() || "协作者", persona: $("#editAgentPersona").value.trim(), label: $("#editAgentLabel").value.trim() };
      Object.assign(draft, { backend: state.editDraft.backend || "model", provider: state.editDraft.provider, model: $("#editModelId").value.trim(), endpoint: $("#editModelEndpoint").value.trim(), temperature: Math.min(2, Math.max(0, Number($("#editTemperature").value) || 0)), harness: state.editDraft.harness, harnessModel: state.editDraft.harnessModel || "", workspaceMode: $("#editAgentWorkspace").value.trim() ? "project" : "auto", workspace: $("#editAgentWorkspace").value.trim() });
      try {
        C.validateAgent(draft, state.agents, agent.id);
        await normalizeAgentWorkspace(draft);
        await prepareDesktopWorkspaces([draft]);
        if (scope !== state.accountScope || token !== state.relaySession?.deviceToken || attempt !== authAttemptEpoch || conversation !== conversationEpoch || hostEpoch !== state.hostConfigEpoch || !canEditAgentConfig()) return;
        if (state.sending || epoch !== state.agentModalEpoch || state.editingAgentId !== agent.id || !$("#agentOverlay").classList.contains("open")) return;
        C.validateAgent(draft, state.agents, agent.id);
        draft.initial = draft.name.slice(0, 1).toUpperCase();
        if (state.relaySession?.deviceToken && state.relayReady) {
          if (!await saveRelayAgentConfig(draft)) return;
          closeOverlay("agentOverlay"); renderAll(); toast(`已保存「${draft.name}」，由主电脑执行`); return;
        }
      } catch (error) { return toast(readableError(error)); }
      draft.initial = draft.name.slice(0, 1).toUpperCase();
      Object.assign(agent, draft);
      closeOverlay("agentOverlay");
      renderAll();
      toast(`已保存「${agent.name}」`);
    }

    /**
     * 删除成员并由服务端原子清理群引用。
     * @param 无
     * @returns {Promise<void>} 删除结果已展示
     * 注意事项：有在途任务时由服务端拒绝；账号或编辑窗口变化时不更新界面。
     */
    async function deleteEditedAgent() {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      const id = state.editingAgentId, epoch = state.agentModalEpoch;
      const a = getAgent(id);
      if (!a) return;
      if (state.agents.length <= 1) {
        toast("至少保留一个 Agent");
        return;
      }
      if (state.sending) return toast("请等待当前任务结束后再删除成员");
      if (!window.confirm(`确定删除 Agent「${a.name}」吗？它会同时从所有群聊中移除。`)) return;
      if (state.relaySession?.deviceToken) {
        try {
          if (!await saveRelayConfig("DELETE", `/api/v1/agents/${encodeURIComponent(id)}`, {}, state.editDraft, () => epoch === state.agentModalEpoch && $("#agentOverlay").classList.contains("open"))) return;
        } catch (error) { return toast(readableError(error)); }
      } else {
      state.agents = state.agents.filter((x) => x.id !== id);
      state.rooms.forEach((r) => {
        r.agentIds = r.agentIds.filter((x) => x !== id);
        if (r.agentIds.length === 0 && state.agents[0]) r.agentIds = [state.agents[0].id];
      });
      }
      closeOverlay("agentOverlay");
      if (state.selectedAgentId === id) state.selectedAgentId = state.agents[0]?.id || null;
      openPanel("agent", { agentId: state.selectedAgentId, expand: true });
      renderAll();
      toast(`已删除「${a.name}」`);
    }

    /**
     * 创建 Agent，并在电脑上自动创建按名称隔离的工作区。
     * @param 无
     * @returns {Promise<void>} 创建完成或已显示校验错误
     * 注意事项：可选路径仅校验已有项目目录；没有执行内核的 Agent 无需创建目录。
     */
    async function createAgentFromWizard() {
      const epoch = state.agentModalEpoch, scope = state.accountScope, hostEpoch = state.hostConfigEpoch;
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      if (state.sending) return toast("请等待当前任务结束后再创建 Agent");
      const draft = { id: state.agentDraft.id, name: $("#agentName").value.trim(), role: $("#agentRole").value.trim() || "协作者", persona: $("#agentPersona").value.trim(), provider: state.agentDraft.provider, backend: state.agentDraft.backend || "model", model: $("#modelId").value.trim(), endpoint: $("#modelEndpoint").value.trim(), harness: state.agentDraft.harness, harnessModel: state.agentDraft.harnessModel || "", workspaceMode: $("#agentWorkspace").value.trim() ? "project" : "auto", workspace: $("#agentWorkspace").value.trim() };
      try {
        C.validateAgent(draft, state.agents, draft.id);
        await normalizeAgentWorkspace(draft);
        await prepareDesktopWorkspaces([draft]);
        if (scope !== state.accountScope || hostEpoch !== state.hostConfigEpoch || state.sending || epoch !== state.agentModalEpoch || state.agentModalMode !== "create" || !$("#agentOverlay").classList.contains("open")) return;
        C.validateAgent(draft, state.agents, draft.id);
      } catch (error) { return toast(readableError(error)); }
      const id = draft.id;
      if (state.relaySession?.deviceToken) {
        const config = C.gatewaySnapshot([draft], [], true).agents[0]; delete config.id;
        try {
          if (!await saveRelayConfig("POST", "/api/v1/agents", { id, config }, state.agentDraft, () => epoch === state.agentModalEpoch && state.agentModalMode === "create" && $("#agentOverlay").classList.contains("open"))) return;
        } catch (error) { return toast(readableError(error)); }
      } else state.agents.push({ ...draft, id, initial: draft.name.slice(0, 1).toUpperCase(), label: "", temperature: 0.7, messages: [] });
      closeOverlay("agentOverlay");
      openPanel("agent", { agentId: id, expand: true });
      toast(`已创建 Agent「${draft.name}」，可在团队详情中加入团队`);
    }

    const SETTINGS_META = {
      connection: { title: "中转站连接", desc: "电脑与手机通过同一账号双向同步聊天" },
      general: { title: "通用", desc: "账号、已登录设备与主设备" },
      appearance: { title: "外观", desc: "背景模式与界面主题" },
      agent: { title: "Agent 默认", desc: "新建 Agent 时的默认行为与时区" },
      harness: { title: "主电脑与内核", desc: "配置主电脑上的 Codex / Claude Code / Cursor" },
      models: { title: "模型与密钥", desc: "为每个 Provider 配置密钥；模型和服务地址在 Agent 中选择" },
      approvals: { title: "审批与安全", desc: "当前版本的执行边界与安全说明" },
      notifications: { title: "通知", desc: "应用焦点时抑制、完成任务时提醒" },
      updates: { title: "更新与关于", desc: "版本与产品信息" },
    };

    async function loadDesktopModelSettings() {
      if (!isPrimaryDevice()) return loadRemoteHostSettings();
      if (!hasDesktopModelStorage()) return;
      const epoch = state.hostConfigEpoch;
      const saved = await window.chorusDesktop.getModelSettings();
      if (epoch !== state.hostConfigEpoch || !isPrimaryDevice()) return;
      state.desktopModelSettings = {
        openaiConfigured: Boolean(saved?.openaiConfigured),
        anthropicConfigured: Boolean(saved?.anthropicConfigured),
        customConfigured: Boolean(saved?.customConfigured),
        ollamaBase: String(saved?.ollamaBase || "http://127.0.0.1:11434"),
      };
      if (!state.hostSettingsDirty && state.settingsSection === "models" && $("#settingsOverlay").classList.contains("open")) renderSettings();
    }

    async function initializeDesktopModelSettings() {
      if (!isPrimaryDevice() || !hasDesktopModelStorage()) return;
      const epoch = state.hostConfigEpoch;
      try {
        const legacy = state.legacyDesktopKeys;
        if (legacy && (legacy.openai || legacy.anthropic || legacy.custom || legacy.ollamaBase)) {
          await window.chorusDesktop.saveModelSettings(legacy);
          if (epoch !== state.hostConfigEpoch || !isPrimaryDevice()) return;
          state.legacyDesktopKeys = null;
        }
        state.settings.apiKeys = {
          openai: "",
          anthropic: "",
          custom: "",
          ollamaBase: legacy?.ollamaBase || state.settings.apiKeys?.ollamaBase || "http://127.0.0.1:11434",
        };
        await loadDesktopModelSettings();
        if (epoch !== state.hostConfigEpoch || !isPrimaryDevice()) return;
        renderAgents(); renderMessages({ pin: false });
        persistApp();
      } catch (error) {
        if (epoch !== state.hostConfigEpoch || !isPrimaryDevice()) return;
        console.error("[chorus] 初始化系统密钥存储失败", error);
        toast("密钥迁移失败，原存档已保留。请检查系统密钥库后重启应用，期间的修改尚未保存。");
      }
    }

    function renderSettings() {
      const settingsHostEpoch = state.hostConfigEpoch;
      const settingsRenderEpoch = state.settingsRenderEpoch = (state.settingsRenderEpoch || 0) + 1;
      updateExecutionSettingsVisibility();
      const key = state.settingsSection;
      const meta = SETTINGS_META[key];
      $("#settingsTitle").textContent = meta.title;
      $("#settingsDesc").textContent = meta.desc;
      $$("#settingsNav button").forEach((b) => b.classList.toggle("active", b.dataset.settings === key));
      const s = state.settings;
      const box = $("#settingsContent");

      if (key === "connection" || key === "general") {
        const status = { online: "实时连接已建立", connecting: "正在建立实时连接", reconnecting: "连接断开，正在重连", offline: "尚未登录中转站", error: "聊天同步失败" }[state.relayStatus] || "等待连接";
        box.innerHTML = `${key === "general" ? `<div class="settings-block"><h4>账号与使用方式</h4><div class="settings-row"><div class="label"><strong>${state.user ? escapeHtml(state.user.name) : window.chorusDesktop ? "本机工作台" : "登录账号以同步电脑聊天"}</strong><span>${state.user?.verified ? escapeHtml(state.user.email) : window.chorusDesktop ? "未登录时可以在本机使用 Agent。登录后按账号同步电脑和手机的聊天。" : "电脑和手机使用同一个账号；任意已登录设备可编辑 Agent，任务与文件都在主电脑执行。"}</span></div><button class="ghost-btn" id="setAccountBtn">${state.user ? "管理账号" : "登录账号"}</button></div></div>
        <div class="settings-block"><h4>Agent 执行</h4><div class="settings-row"><div class="label"><strong>${isPrimaryDevice() ? "允许在本机执行" : "在主电脑执行"}</strong><span>${isPrimaryDevice() ? "Codex、Claude Code 和 Cursor 使用这台电脑上配置的工作区。保持应用运行，手机提交的消息会在主电脑执行。" : relayExecutionDescription()}</span></div>${canEditAgentConfig() ? `<button type="button" class="toggle ${s.localExecution ? "on" : ""}" data-toggle="localExecution" aria-label="允许主电脑执行" aria-pressed="${s.localExecution}"></button>` : ""}</div></div>` : ""}
        <div class="settings-block"><h4>账号中转同步</h4><div class="settings-row"><div class="label"><strong>${escapeHtml(status)}</strong><span>${state.relayError ? escapeHtml(state.relayError) + " · " : ""}填写自己的中转站地址后，电脑和手机可实时同步团队讨论与私聊；手机发送的消息由主电脑执行，断线恢复后自动补齐历史。</span></div></div><div class="form-row"><label for="relayBaseUrl">中转站服务地址</label><input id="relayBaseUrl" value="${escapeHtml(relayBaseUrl())}" placeholder="https://relay.example.com/agents-team" inputmode="url" spellcheck="false" /></div><button class="ghost-btn" id="btnSaveRelayUrl">保存地址</button> <button class="ghost-btn" id="btnRelayReconnect">${state.relaySession ? "重新连接" : "登录并连接"}</button><div id="relayDeviceList"></div></div>`;
        $("#setAccountBtn")?.addEventListener("click", () => { closeOverlay("settingsOverlay"); openAuthModal(); });
        $("#btnSaveRelayUrl").addEventListener("click", () => {
          if (state.authPending) return toast("账号操作进行中，请完成后再修改中转站地址");
          if (state.sending) return toast("请先停止当前任务，再修改中转站地址");
          if (window.ChorusUpdateUI?.isBusy()) return toast("正在下载更新，请完成后再修改中转站地址");
          const url = normalizeRelayBaseUrl($("#relayBaseUrl").value);
          if (!url) return toast("请使用 HTTPS 中转站地址；本地调试可使用局域网 HTTP，地址不能包含查询参数或凭据");
          if (url !== relayBaseUrl()) {
            ++authAttemptEpoch; resetAuthPasswords(); clearRelaySession(); resetConversationEditor(true); s.relayBaseUrl = url;
            // 服务器地址属于本机偏好；另一个服务器需要重新认证。
            state.user = null; localStorage.removeItem("chorus-user"); renderAccount();
            window.dispatchEvent(new Event("chorus-relay-changed"));
          }
          persistApp(); renderSettings(); toast("地址已保存，请在这个中转站登录账号");
        });
        $("#btnRelayReconnect").addEventListener("click", () => {
          if (state.relaySession?.deviceToken) { startRelayLoop(); toast("正在重新连接中转站"); }
          else { closeOverlay("settingsOverlay"); openAuthModal(); }
        });
        bindSettingToggles(); renderRelayDeviceList(); refreshRelayDevicesInSettings();
        return;
      }

      if (key === "appearance") {
        box.innerHTML = `
          <div class="settings-block">
            <h4>背景模式</h4>
            <div class="settings-row">
              <div class="label"><strong>主题</strong><span>Follow System / Light / Dark（立即应用）</span></div>
              <div class="segmented" id="themeSeg">
                <button type="button" data-theme-opt="system" class="${s.theme === "system" ? "on" : ""}">随系统</button>
                <button type="button" data-theme-opt="dark" class="${s.theme === "dark" ? "on" : ""}">Dark</button>
                <button type="button" data-theme-opt="light" class="${s.theme === "light" ? "on" : ""}">Light</button>
              </div>
            </div>
          </div>
          <div class="settings-block">
            <h4>预览</h4>
            <div class="settings-row">
              <div class="label"><strong>当前生效</strong><span id="themeEffective">—</span></div>
              <span style="font-size:12px;color:var(--text-faint)">切换后立即应用到整个窗口</span>
            </div>
          </div>`;
        updateThemeEffectiveLabel();
        $$("#themeSeg button").forEach((btn) => {
          btn.addEventListener("click", () => {
            applyTheme(btn.dataset.themeOpt);
            persistApp();
            renderSettings();
            toast(`外观 → ${btn.textContent}`);
          });
        });
        return;
      }

      if (["harness", "models"].includes(key) && !isPrimaryDevice() && !state.hostSettingsLoaded) {
        box.innerHTML = `<div class="settings-block"><h4>主电脑配置</h4><p>${state.hostSettingsLoading ? "正在读取主电脑的实际配置…" : escapeHtml(state.hostSettingsError || "保持主电脑在线并更新到最新版本，即可在这里配置内核路径与模型。")}</p><button type="button" class="ghost-btn" id="reloadHostSettings" ${state.hostSettingsLoading ? "disabled" : ""}>重新读取主电脑配置</button></div>`;
        $("#reloadHostSettings").addEventListener("click", loadRemoteHostSettings);
        return;
      }

      if (key === "agent") {
        box.innerHTML = `
          <div class="settings-block">
            <h4>新建默认值</h4>
            <div class="settings-row">
              <div class="label"><strong>默认 Provider</strong><span>创建 Agent 时预选的模型供应商</span></div>
              <div class="segmented" id="defProvSeg">
                <button type="button" data-defp="openai" class="${s.defaultProvider === "openai" ? "on" : ""}">OpenAI</button>
                <button type="button" data-defp="anthropic" class="${s.defaultProvider === "anthropic" ? "on" : ""}">Anthropic</button>
                <button type="button" data-defp="local" class="${s.defaultProvider === "local" ? "on" : ""}">本地</button>
                <button type="button" data-defp="custom" class="${s.defaultProvider === "custom" ? "on" : ""}">自定义</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="label"><strong>工作区说明</strong><span>文件目录自动管理；需要改已有项目时，在编辑 Agent 中选择绑定目录</span></div>
            </div>
          </div>`;
        $$("#defProvSeg button").forEach((btn) => {
          btn.addEventListener("click", () => {
            saveSharedSettings({ defaultProvider: btn.dataset.defp });
          });
        });
        return;
      }

      if (key === "harness") {
        box.innerHTML = `
          <div class="settings-block">
            <h4>主电脑编程内核</h4><p class="form-help">以下路径与检测结果属于主电脑。填写主电脑上的可执行文件路径，留空则自动查找。</p>
            ${harnessRow("Codex", "codex", "自动查找 codex；未登录时可在这里打开账号页")}
            ${harnessRow("Claude Code", "claude", "自动查找 claude")}
            ${harnessRow("Cursor", "cursor", "自动查找 Cursor CLI 的 agent 或 cursor-agent")}
          </div>
          <div class="settings-block">
            <p style="font-size:12px;color:var(--text-faint);line-height:1.5;">Cursor 内核连接的是终端里的 Cursor CLI，不是 Cursor 编辑器窗口。未安装时在终端执行 <code>curl https://cursor.com/install -fsS | bash</code>，然后重新检测。内核账号登录需在主电脑上完成确认。</p>
          </div>
          <div class="settings-block">
            <button class="primary-btn" type="button" id="saveHarnessPaths">保存路径并检测</button>
            <button class="ghost-btn" type="button" id="refreshHarnesses" style="margin-left:8px;">重新检测</button>
          </div>`;
        $$("[data-harness-path]").forEach((input) => input.addEventListener("input", () => { state.hostSettingsDirty = true; }));
        $("#saveHarnessPaths")?.addEventListener("click", async (event) => {
          if (settingsHostEpoch !== state.hostConfigEpoch) return toast("主电脑已改变，请重新读取配置");
          const button = event.currentTarget, inputs = $$("[data-harness-path]");
          button.disabled = true; inputs.forEach((input) => { input.disabled = true; });
          try {
            await saveHarnessPaths(settingsRenderEpoch);
            if (settingsHostEpoch !== state.hostConfigEpoch) return;
            toast("Harness 路径已保存并重新检测");
          } catch (error) {
            if (settingsHostEpoch === state.hostConfigEpoch) toast(error instanceof Error ? error.message : "Harness 配置保存失败");
          } finally {
            inputs.forEach((input) => { if (input.isConnected) input.disabled = false; });
            if (button.isConnected) button.disabled = false;
          }
        });
        $("#refreshHarnesses")?.addEventListener("click", () => refreshHarnessStatus({ announce: true }));
        $$("[data-harness-login]").forEach((button) => {
          button.addEventListener("click", () => loginHarness(button.dataset.harnessLogin, button));
        });
        return;
      }

      if (key === "models") {
        const secureStorage = hasDesktopModelStorage() || !isPrimaryDevice();
        const desktopSettings = state.desktopModelSettings;
        const openaiPlaceholder = secureStorage && desktopSettings.openaiConfigured ? "已安全保存；留空则保留" : "sk-…";
        const customPlaceholder = secureStorage && desktopSettings.customConfigured ? "已安全保存；留空则保留" : "可留空（服务无需认证时）";
        const anthropicPlaceholder = secureStorage && desktopSettings.anthropicConfigured ? "已安全保存；留空则保留" : "sk-ant-…";
        box.innerHTML = `
          <div class="settings-block">
            <h4>主电脑 API Keys（${secureStorage ? "系统加密存储" : "本机存储"}）</h4>
            <div class="form-row"><label for="keyOpenai">OpenAI 官方 ${secureStorage ? (desktopSettings.openaiConfigured ? "· 已配置" : "· 未配置") : ""}</label><input id="keyOpenai" type="password" placeholder="${openaiPlaceholder}" value="${secureStorage ? "" : escapeHtml(s.apiKeys?.openai || "")}" autocomplete="off" /></div>
            <div class="form-row"><label for="keyAnthropic">Anthropic ${secureStorage ? (desktopSettings.anthropicConfigured ? "· 已配置" : "· 未配置") : ""}</label><input id="keyAnthropic" type="password" placeholder="${anthropicPlaceholder}" value="${secureStorage ? "" : escapeHtml(s.apiKeys?.anthropic || "")}" autocomplete="off" /></div>
            <div class="form-row"><label for="keyCustom">自定义 Endpoint 专用密钥 ${secureStorage && desktopSettings.customConfigured ? "· 已配置" : ""}</label><input id="keyCustom" type="password" placeholder="${customPlaceholder}" value="${secureStorage ? "" : escapeHtml(s.apiKeys?.custom || "")}" autocomplete="off" /><p class="form-help">仅发送给自定义模型地址，OpenAI / Anthropic 密钥不会自动转发。</p></div>
            <div class="form-row"><label for="keyOllama">本地 Ollama Base URL</label><input id="keyOllama" value="${escapeHtml(secureStorage ? desktopSettings.ollamaBase : s.apiKeys?.ollamaBase || "http://127.0.0.1:11434")}" /></div>
            <p style="font-size:12px;color:var(--text-faint);line-height:1.45;">${secureStorage ? "密钥由 macOS 加密能力保护，不会写入聊天记录或 localStorage；已配置的密钥不会回填明文。" : "当前平台没有系统密钥库桥接，密钥只保存在此应用的本机存储中。"}配置保存到主电脑；这里的路径与 localhost 都指主电脑。远程提交的密钥加密传输，不回填明文。</p>
          </div>
          <div class="settings-block">
            <button class="primary-btn" type="button" id="saveKeys">保存并用于对话</button>
          </div>`;
        $$("#keyOpenai,#keyAnthropic,#keyCustom,#keyOllama").forEach((input) => input.addEventListener("input", () => { state.hostSettingsDirty = true; }));
        $("#saveKeys")?.addEventListener("click", async (event) => {
          if (settingsHostEpoch !== state.hostConfigEpoch) return toast("主电脑已改变，请重新读取配置");
          const button = event.currentTarget, inputs = $$("#keyOpenai,#keyAnthropic,#keyCustom,#keyOllama");
          button.disabled = true; inputs.forEach((input) => { input.disabled = true; });
          const values = {
            openai: $("#keyOpenai").value.trim(),
            anthropic: $("#keyAnthropic").value.trim(),
            custom: $("#keyCustom").value.trim(),
            ollamaBase: $("#keyOllama").value.trim() || "http://127.0.0.1:11434",
          };
          try {
            if (!isPrimaryDevice()) {
              const epoch = state.hostConfigEpoch;
              const saved = await hostConfigClient().command("model.save", values);
              if (state.hostConfigEpoch !== epoch) return;
              state.desktopModelSettings = saved;
              if (settingsRenderEpoch === state.settingsRenderEpoch) { state.hostSettingsDirty = false; renderSettings(); }
            } else if (secureStorage) {
              await window.chorusDesktop.saveModelSettings(values);
              if (settingsHostEpoch !== state.hostConfigEpoch || !isPrimaryDevice()) return;
              state.settings.apiKeys = { openai: "", anthropic: "", custom: "", ollamaBase: values.ollamaBase };
              if (settingsRenderEpoch === state.settingsRenderEpoch) state.hostSettingsDirty = false;
              await loadDesktopModelSettings();
            } else {
              values.ollamaBase = C.endpoint(values.ollamaBase);
              state.settings.apiKeys = values;
              persistApp();
              renderSettings();
            }
            if (settingsHostEpoch !== state.hostConfigEpoch) return;
            renderAgents(); renderMessages({ pin: false });
            toast("模型配置已保存，之后发消息会调用对应模型");
          } catch (error) {
            if (settingsHostEpoch === state.hostConfigEpoch) toast(error instanceof Error ? error.message : "模型配置保存失败");
          } finally {
            inputs.forEach((input) => { if (input.isConnected) input.disabled = false; });
            if (button.isConnected) button.disabled = false;
          }
        });
        return;
      }

      if (key === "approvals") {
        box.innerHTML = `
          <div class="settings-block">
            <h4>当前执行边界</h4>
            <div class="settings-row">
              <div class="label"><strong>本机执行总开关</strong><span>在「通用」中${s.localExecution ? "已允许" : "已关闭"}；关闭时不会启动任何 Harness</span></div>
              <span style="font-size:12px;color:${s.localExecution ? "var(--accent-2)" : "var(--danger)"}">${s.localExecution ? "已允许" : "已关闭"}</span>
            </div>
            <div class="settings-row">
              <div class="label"><strong>工作区限制</strong><span>编程后台使用当前 Agent 自己的工作区；发送消息即可执行，继续同一线程会恢复原生 CLI 会话。同一工作区的终端和聊天互斥，聊天前请关闭占用它的终端。</span></div>
              <span style="font-size:12px;color:var(--accent-2)">已启用</span>
            </div>
          </div>
          <div class="settings-block">
            <h4>命令审批</h4>
            <div class="settings-row">
              <div class="label"><strong>由原生 CLI 策略控制</strong><span>完整终端原样显示 CLI 的登录、菜单和审批，可直接输入确认。聊天采用 CLI 后台运行模式；实际权限由当前后台和工作区配置决定。</span></div>
            </div>
          </div>`;
        return;
      }

      if (key === "notifications") {
        box.innerHTML = `
          <div class="settings-block">
            <h4>应用通知</h4>
            <div class="settings-row">
              <div class="label"><strong>所有 Agent 完成后通知</strong><span>开启后适用于所有 Agent，窗口未聚焦时提醒任务完成或失败</span></div>
              <button type="button" class="toggle ${s.notifyApp ? "on" : ""}" data-toggle="notifyApp" aria-pressed="${String(s.notifyApp)}"></button>
            </div>
            <div class="settings-row">
              <div class="label"><strong>提示音</strong><span>收到通知时播放短音</span></div>
              <button type="button" class="toggle ${s.notifySound ? "on" : ""}" data-toggle="notifySound" aria-pressed="${String(s.notifySound)}"></button>
            </div>
            <div class="settings-row">
              <div class="label"><strong>聚焦时抑制</strong><span>Chorus 在前台时不弹系统通知</span></div>
              <span style="font-size:12px;color:var(--text-faint)">默认开启</span>
            </div>
          </div>`;
        bindSettingToggles();
        return;
      }

      // updates
      box.innerHTML = `
        <div class="settings-block" id="appUpdateSettings"></div>
        <div class="settings-block">
          <h4>关于</h4>
          <div class="settings-row">
            <div class="label"><strong>Chorus</strong><span>多 Agent 群聊 · 自定义模型 · Harness 内核</span></div>
          </div>
          <div class="settings-row">
            <div class="label"><strong>快捷键</strong><span>⌘, 打开设置 · ⌘N 新建 Agent · Enter 发送</span></div>
          </div>
        </div>`;
      window.ChorusUpdateUI?.renderSettings(box);
    }

    function normalizeHarnessResult(value) {
      if (typeof value === "boolean") {
        return { available: value, path: "", version: "", authenticated: null, checking: false, error: "" };
      }
      return {
        available: Boolean(value?.available),
        path: String(value?.path || ""),
        version: String(value?.version || ""),
        authenticated: typeof value?.authenticated === "boolean" ? value.authenticated : null,
        checking: false,
        error: String(value?.error || ""),
      };
    }

    function harnessRow(name, key, desc) {
      const status = state.harnessStatus[key];
      let label = "未安装";
      let statusClass = "off";
      if (status.checking) {
        label = "检测中…";
        statusClass = "warn";
      } else if (status.available) {
        statusClass = status.authenticated === false ? "warn" : "ok";
        if (status.authenticated === true) label = "已安装 · 已登录";
        else if (status.authenticated === false) label = "已安装 · 未登录";
        else label = "已安装";
      }
      const details = [status.error, status.path, status.version].filter(Boolean).join(" · ");
      const canLogin = isPrimaryDevice() && (key === "codex" || key === "cursor") && status.available && status.authenticated === false && !status.checking;
      return `<div class="settings-row">
        <div class="label" style="flex:1;min-width:0;">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(details || desc)}</span>
          <input class="harness-path-input" data-harness-path="${key}" value="${escapeHtml(state.harnessPaths[key] || "")}" placeholder="留空自动探测；也可填可执行文件绝对路径" />
          ${canLogin ? `<button type="button" class="ghost-btn" data-harness-login="${key}" style="margin-top:8px;">使用账号登录</button>` : ""}
        </div>
        <span style="font-size:12px;white-space:nowrap;"><span class="status-dot ${statusClass}"></span>${label}</span>
      </div>`;
    }

    async function loadHarnessPaths() {
      if (!isPrimaryDevice() || !window.chorusDesktop?.getHarnessSettings) return;
      const epoch = state.hostConfigEpoch;
      const saved = await window.chorusDesktop.getHarnessSettings();
      if (epoch !== state.hostConfigEpoch || !isPrimaryDevice()) return;
      state.harnessPaths = {
        codex: String(saved?.codex || ""),
        claude: String(saved?.claude || ""),
        cursor: String(saved?.cursor || ""),
      };
    }

    async function refreshHarnessStatus({ announce = false } = {}) {
      if (!isPrimaryDevice()) { await loadRemoteHostSettings(); if (announce && state.hostSettingsLoaded) toast("主电脑内核检测完成"); return; }
      const keys = ["codex", "claude", "cursor"], epoch = state.hostConfigEpoch;
      const current = () => epoch === state.hostConfigEpoch && isPrimaryDevice();
      keys.forEach((key) => {
        state.harnessStatus[key] = { ...state.harnessStatus[key], checking: true };
      });
      if (!state.hostSettingsDirty && state.settingsSection === "harness" && $("#settingsOverlay").classList.contains("open")) renderSettings();
      try {
        await loadHarnessPaths();
        if (!current()) return;
        if (!window.chorusDesktop?.probeHarness) throw new Error("当前平台不支持本机 Harness");
        const found = await window.chorusDesktop.probeHarness();
        if (!current()) return;
        keys.forEach((key) => {
          state.harnessStatus[key] = normalizeHarnessResult(found?.[key]);
        });
        await Promise.all(keys.map((key) => loadHarnessModels(key, true)));
        if (!current()) return;
        if (announce) toast("Harness 检测完成");
      } catch (error) {
        if (!current()) return;
        keys.forEach((key) => {
          state.harnessStatus[key] = { available: false, path: "", version: "", authenticated: null, checking: false, error: "" };
        });
        if (announce) toast(error instanceof Error ? error.message : "Harness 检测失败");
      }
      if (!state.hostSettingsDirty && state.settingsSection === "harness" && $("#settingsOverlay").classList.contains("open")) renderSettings();
    }

    async function saveHarnessPaths(settingsEpoch = state.settingsRenderEpoch) {
      const epoch = state.hostConfigEpoch;
      const next = {};
      $$("[data-harness-path]").forEach((input) => {
        next[input.dataset.harnessPath] = input.value.trim();
      });
      if (isPrimaryDevice()) await window.chorusDesktop.saveHarnessSettings(next);
      else await hostConfigClient().command("harness.save", next);
      if (state.hostConfigEpoch !== epoch) return;
      state.harnessPaths = { ...state.harnessPaths, ...next };
      if (settingsEpoch === state.settingsRenderEpoch) { state.hostSettingsDirty = false; await refreshHarnessStatus(); }
    }

    /**
     * 打开 Codex 或 Cursor 的账号登录，结束后重新检测。
     * @param {"codex"|"cursor"} key 内核标识
     * @param {HTMLButtonElement} button 触发按钮
     * @returns {Promise<void>}
     */
    async function loginHarness(key, button) {
      if (!isPrimaryDevice() || !window.chorusDesktop?.loginHarness) {
        toast("请在主电脑上完成内核账号登录");
        return;
      }
      button.disabled = true;
      toast("已打开登录页，请在浏览器里完成账号确认");
      try {
        const result = await window.chorusDesktop.loginHarness(key);
        await refreshHarnessStatus();
        toast(result?.ok ? "登录流程已结束，已重新检测" : (result?.text || "登录未完成"));
      } catch (error) {
        toast(error instanceof Error ? error.message : "登录失败");
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    }

    function bindSettingToggles() {
      $$("[data-toggle]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const k = btn.dataset.toggle;
          const next = !state.settings[k];
          if (k === "localExecution") { await saveSharedSettings({ localExecution: next }); return; }
          if (k === "notifyApp" && next && "Notification" in window && Notification.permission === "default") {
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
              toast("系统通知权限未开启");
              return;
            }
          }
          state.settings[k] = next;
          btn.classList.toggle("on", state.settings[k]);
          btn.setAttribute("aria-pressed", String(state.settings[k]));
          persistApp();
          toast("已更新");
        });
      });
    }

    function updateThemeEffectiveLabel() {
      const el = $("#themeEffective");
      if (!el) return;
      if (state.settings.theme === "system") {
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        el.textContent = `随系统 → 当前 ${dark ? "Dark" : "Light"}`;
      } else {
        el.textContent = state.settings.theme === "dark" ? "强制 Dark" : "强制 Light";
      }
    }

    function openSettings(section = "general") {
      state.hostSettingsDirty = false;
      state.settingsSection = section;
      renderSettings();
      openOverlay("settingsOverlay");
      if (["models", "harness"].includes(section)) {
        if (!isPrimaryDevice()) loadRemoteHostSettings();
        else if (section === "models") loadDesktopModelSettings().catch((error) => toast(readableError(error)));
        else refreshHarnessStatus();
      }
    }

    /**
     * 渲染侧边栏账号资料与服务器确认的只读员工身份。
     * @param 无
     * @returns {void} 更新头像、姓名和账号说明
     * 注意事项：身份使用文本节点展示；未连接会话时不显示管理员标记。
     */
    function renderAccount() {
      const av = $("#accountAvatar");
      const name = $("#accountName");
      const sub = $("#accountSub");
      const loggedIn = Boolean(state.relaySession?.deviceToken && state.user?.verified);
      const accountLabel = loggedIn ? "账号管理：退出登录或切换账号" : "登录或注册账号";
      $("#btnAccount").title = accountLabel; $("#btnAccount").setAttribute("aria-label", accountLabel);
      $("#btnHeaderAccount").textContent = loggedIn ? "账号" : "登录";
      $("#btnHeaderAccount").title = accountLabel; $("#btnHeaderAccount").setAttribute("aria-label", accountLabel);
      if (!state.user) {
        av.innerHTML = "";
        av.textContent = "?";
        av.style.background = "";
        av.style.color = "";
        name.textContent = window.chorusDesktop ? "本机工作台" : "登录账号";
        sub.textContent = window.chorusDesktop ? "本机使用 · 登录以同步手机" : "同步电脑聊天与回复";
        return;
      }
      if (state.user.picture) {
        av.textContent = "";
        av.style.background = "transparent";
        av.innerHTML = `<img alt="" src="${escapeHtml(state.user.picture)}" />`;
      } else {
        av.innerHTML = "";
        av.textContent = state.user.name.slice(0, 1).toUpperCase();
        av.style.background = state.user.provider === "google" ? "#e8f0fe" : "var(--accent-soft)";
        av.style.color = state.user.provider === "google" ? "#1967d2" : "var(--accent)";
      }
      name.textContent = state.user.name;
      const identity = state.relaySession?.deviceToken && state.user.verified && state.user.role === "superadmin"
        ? ` · 超级管理员 · 工号 ${state.user.employeeId}` : "";
      sub.textContent = state.user.verified ? `${state.user.email}${identity}` : "本机身份 · 请重新登录以同步";
    }

    /**
     * 更新账号弹窗的登录状态、登录方式与只读员工身份。
     * @param 无
     * @returns {void} 更新弹窗文字与登录区域可见性
     * 注意事项：不提供角色或工号编辑入口；缓存中的管理员角色不会被恢复。
     */
    function syncAuthModal() {
      const loggedIn = !!state.relaySession?.deviceToken && state.user?.verified === true;
      const registering = state.authMode === "register", busy = Boolean(state.authPending);
      $("#authLoggedOut").hidden = loggedIn;
      $("#authLoggedIn").hidden = !loggedIn;
      $("#authNameRow").hidden = !registering;
      $("#authConfirmRow").hidden = !registering;
      $("#authGoogleChoices").hidden = registering;
      $("#regName").disabled = busy || !registering;
      $("#regName").required = registering;
      $("#regEmail").disabled = busy;
      $("#regEmail").autocomplete = registering ? "email" : "username";
      $("#regPassword").disabled = busy;
      $("#regPassword").autocomplete = registering ? "new-password" : "current-password";
      $("#regPassword").placeholder = registering ? "设置密码" : "输入密码";
      $("#authPasswordHelp").hidden = !registering;
      $("#regPasswordConfirm").disabled = busy || !registering;
      $("#regPasswordConfirm").required = registering;
      $("#btnRegister").hidden = registering;
      $("#btnAuthLoginMode").hidden = !registering;
      $("#authModePrompt").textContent = registering ? "已有账号？" : "还没有账号？";
      $("#btnEmailLogin").textContent = state.authPending === "email" ? registering ? "正在注册…" : "正在登录…" : registering ? "注册并登录" : "登录";
      for (const selector of ["#btnEmailLogin", "#btnRegister", "#btnAuthLoginMode", "#btnLogout", "#btnSwitchAccount"]) $(selector).disabled = busy;
      $$('[data-password-target]').forEach((button) => { button.disabled = busy; });
      const googleConfigured = state.authProviders?.baseUrl === relayBaseUrl() ? state.authProviders.googleConfigured : null;
      $("#btnGoogleLogin").disabled = busy || googleConfigured === false;
      $("#googleLoginLabel").textContent = state.authPending === "google" ? "等待 Google 授权…" : googleConfigured === false ? "Google 登录（暂未启用）" : "使用 Google 登录";
      $("#btnLogout").textContent = state.authPending === "logout" ? "正在退出…" : "退出登录";
      $("#btnSwitchAccount").textContent = state.authPending === "switch" ? "正在切换…" : "切换账号";
      $("#authError").textContent = state.authError || "";
      $("#authError").hidden = !state.authError;
      if (loggedIn) {
        $("#authTitle").textContent = "当前账号";
        $("#authDesc").textContent = state.user.role === "superadmin" ? `超级管理员 · 工号 ${state.user.employeeId}` : "管理登录状态";
        $("#authProfileName").textContent = state.user.name;
        $("#authProfileEmail").textContent = state.user.email;
        $("#authProviderPill").textContent = state.user.provider === "google" ? "Google" : state.user.verified ? "邮箱账号" : "旧本机身份";
      } else {
        $("#authTitle").textContent = registering ? "注册账号" : "登录 Chorus";
        $("#authDesc").textContent = registering ? "创建邮箱账号，用于同步电脑和手机聊天" : "用邮箱和密码登录，实时同步电脑和手机聊天";
      }
    }

    /**
     * 在账号弹窗显示当前操作的可读错误。
     * @param {string} message 用户可读说明，空串清除错误
     * @returns {void} 更新原地错误文字
     * 注意事项：只显示经过错误转换的说明，禁止传入密码、令牌或原始响应体。
     */
    function setAuthError(message = "") {
      state.authError = String(message);
      $("#authError").textContent = state.authError;
      $("#authError").hidden = !state.authError;
    }

    /**
     * 清空认证密码并恢复密码遮挡，避免操作切换后残留秘密。
     * @param 无
     * @returns {void} 清理密码、确认密码及可见状态
     * 注意事项：不清除邮箱，模式切换时允许用户继续填写同一邮箱。
     */
    function resetAuthPasswords() {
      for (const selector of ["#regPassword", "#regPasswordConfirm"]) { $(selector).value = ""; $(selector).type = "password"; }
      $$('[data-password-target]').forEach((button) => {
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-label", button.dataset.passwordTarget === "regPasswordConfirm" ? "显示确认密码" : "显示密码");
      });
    }

    /**
     * 切换独立的邮箱登录或注册模式。
     * @param {string} mode login 或 register
     * @returns {void} 更新字段、提交按钮及自动填充语义
     * 注意事项：认证请求进行时不能切换；注册名称和确认密码不会作为登录要求。
     */
    function setAuthMode(mode = "login") {
      if (state.authPending) return;
      state.authMode = mode === "register" ? "register" : "login";
      resetAuthPasswords(); setAuthError(); syncAuthModal();
    }

    /**
     * 切换指定认证密码框的可见性。
     * @param {HTMLButtonElement} button 带有允许的 passwordTarget 的眼睛按钮
     * @returns {void} 更新密码类型、屏幕阅读器标签与按压状态
     * 注意事项：仅允许两个认证密码字段；保留光标位置，不读取或记录密码正文。
     */
    function toggleAuthPassword(button) {
      if (state.authPending || !["regPassword", "regPasswordConfirm"].includes(button.dataset.passwordTarget)) return;
      const input = $(`#${button.dataset.passwordTarget}`);
      const start = input.selectionStart, end = input.selectionEnd;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}${button.dataset.passwordTarget === "regPasswordConfirm" ? "确认密码" : "密码"}`);
      input.focus({ preventScroll: true });
      if (typeof start === "number") input.setSelectionRange(start, end);
    }

    /**
     * 读取公开认证配置，展示 Google 当前可用状态。
     * @param 无
     * @returns {Promise<void>} 完成当前服务地址的认证能力显示
     * 注意事项：未填写中转站时不发送请求；晚到配置不能覆盖新地址或新认证操作。
     */
    async function loadAuthProviders() {
      const base = relayBaseUrl(), attempt = authAttemptEpoch;
      if (!base) return;
      try {
        const config = await relayRequest("GET", "/api/v1/config", null, null);
        if (base !== relayBaseUrl() || attempt !== authAttemptEpoch) return;
        state.authProviders = { baseUrl: base, googleConfigured: config.googleConfigured === true };
        syncAuthModal();
      } catch (_) { console.warn("[chorus] 认证能力配置暂不可用"); }
    }

    /**
     * 打开账号登录弹窗，首次使用时引导配置中转站。
     * @param 无
     * @returns {void} 展示账号弹窗并读取可用登录方式
     * 注意事项：未配置中转站时引导到设置；请求进行时保留当前状态并清除上一次密码。
     */
    function openAuthModal() {
      if (!relayBaseUrl()) { openSettings("connection"); toast("请先填写自己的中转站地址"); return; }
      if (!state.authPending) setAuthMode("login");
      syncAuthModal();
      openOverlay("authOverlay");
      if (!state.relaySession?.deviceToken) loadAuthProviders();
    }

    /**
     * 建立已认证的账号同步会话并显示成功结果。
     * @param {object} session 真实认证接口返回的会话
     * @param {string} [authenticatedBaseUrl] 发起认证时使用的中转站地址
     * @param {number} [attempt] 当前认证操作编号
     * @returns {Promise<boolean>} 当前操作是否成功建立账号身份
     * 注意事项：账号认证成功后同步暂时失败会后台重试，不能误报注册失败；旧操作不回写新账号。
     */
    async function loginAs(session, authenticatedBaseUrl = relayBaseUrl(), attempt = authAttemptEpoch) {
      if (attempt !== authAttemptEpoch) return false;
      if (authenticatedBaseUrl !== relayBaseUrl()) throw new Error("登录期间中转站地址已改变，请重新登录");
      if (state.sending) throw new Error("请先停止当前任务，再切换账号");
      let connected, syncDeferred = false;
      try { connected = await connectRelaySession(session); }
      catch (error) {
        if (attempt !== authAttemptEpoch || authenticatedBaseUrl !== relayBaseUrl() || state.relaySession?.deviceToken !== session.deviceToken) return false;
        if (error.status === 401) { clearRelaySession(); throw error; }
        // 登录与注册已经由服务器完成，聊天同步失败不能让用户重复注册同一账号。
        connected = true; syncDeferred = true; state.relayReady = true;
        startRelayLoop(); renderAccount();
        console.warn("[chorus] 账号认证成功，聊天同步等待后台重试");
      }
      if (!connected || attempt !== authAttemptEpoch || authenticatedBaseUrl !== relayBaseUrl() || state.relaySession?.deviceToken !== session.deviceToken) return false;
      try { localStorage.setItem("chorus-user", JSON.stringify(state.user)); }
      catch (_) { console.error("[chorus] 已认证账号缓存写入失败"); }
      resetAuthPasswords(); setAuthError();
      syncAuthModal(); closeOverlay("authOverlay");
      toast(syncDeferred ? "已登录；聊天同步暂时失败，网络恢复后自动重试" : `已登录并连接中转站：${state.user.name}`);
      console.info("[chorus] ------------- 账号认证完成 --------------");
      return true;
    }

    /**
     * 安全退出当前账号，并按需打开干净的邮箱登录界面。
     * @param {boolean} [switchAccount] 是否在退出后打开邮箱登录以切换账号
     * @returns {Promise<boolean>} 当前账号是否已经在本机安全退出
     * 注意事项：每个异步阶段检查操作版本；旧退出只撤销旧令牌，不能清除新身份；断网允许本机退出。
     */
    async function logout(switchAccount = false) {
      if (state.authPending) return false;
      const action = switchAccount ? "switch" : "logout";
      state.authPending = action;
      setAuthError(); syncAuthModal();
      console.info("[chorus] ------------- 清理本机账号开始 --------------");
      const attempt = ++authAttemptEpoch;
      const token = state.relaySession?.deviceToken, base = state.relaySession?.baseUrl || relayBaseUrl(), scope = state.accountScope;
      let serverConfirmed = !token;
      ++conversationEpoch;
      const stopping = state.sending ? stopRun() : Promise.resolve();
      // 先保存当前账号，再立即隔离本机状态；服务器注销广播或旧任务结果不能恢复旧界面。
      persistApp(); clearRelaySession(); closeOverlay("terminalOverlay");
      if (typeof ChorusTerminalUI !== "undefined") {
        try { await waitForAuthCompletion(ChorusTerminalUI.reset(), 3000); }
        catch (_) { console.warn("[chorus] 旧终端清理尚未确认，旧视图已隔离"); }
      }
      if (attempt !== authAttemptEpoch || base !== relayBaseUrl() || state.accountScope !== scope || state.relaySession?.deviceToken || state.authPending !== action) {
        // 终端清理期间身份可能已经变化；仍尽力撤销捕获的旧令牌，但不再清理当前账号。
        if (token) {
          try { await waitForAuthCompletion(ChorusRelayClient.request(base, "POST", "/api/v1/auth/logout", token, {}), 7000); }
          catch (_) { console.warn("[chorus] 旧账号服务端注销未确认，当前身份保持不变"); }
        }
        return false;
      }
      resetConversationEditor(true);
      state.user = null; state.accountScope = "";
      state.agents = []; state.rooms = []; state.drafts = {}; state.activeRoomId = ""; state.selectedAgentId = "";
      state.running = null; state.sending = false; state.preparingSend = false; state.activeRunId = ""; state.requestController = null; state.stopRequested = false;
      try { localStorage.removeItem("chorus-user"); localStorage.removeItem("chorus-app"); }
      catch (_) { console.error("[chorus] 旧账号缓存移除失败，本机身份已隔离"); }
      $("#regEmail").value = ""; $("#regName").value = "";
      resetAuthPasswords(); persistApp(); renderAccount(); renderAll();
      try {
        try { await waitForAuthCompletion(stopping, 3000); }
        catch (_) { console.warn("[chorus] 本机任务停止尚未确认，旧结果已隔离"); }
        // 先撤销当前令牌，再让同一设备发起新登录，防止两个账号操作争用设备会话。
        if (token) {
          try { await waitForAuthCompletion(ChorusRelayClient.request(base, "POST", "/api/v1/auth/logout", token, {}), 7000); serverConfirmed = true; }
          catch (error) { serverConfirmed = error.status === 401; console.warn("[chorus] 服务端注销未确认，本机继续安全退出"); }
        }
        console.info("[chorus] ------------- 本机账号已安全退出 --------------");
      } finally { if (attempt === authAttemptEpoch) { state.authPending = ""; syncAuthModal(); } }
      if (attempt !== authAttemptEpoch) return false;
      setAuthMode("login");
      if (switchAccount) { openOverlay("authOverlay"); loadAuthProviders(); }
      else closeOverlay("authOverlay");
      toast(serverConfirmed ? switchAccount ? "已退出，请登录另一个账号" : "已退出登录" : "已在本机退出；网络异常，服务端注销尚未确认");
      return true;
    }

    /**
     * 有界等待停止任务或服务器注销，避免断网阻止本机退出。
     * @param {Promise} operation 已发起的任务停止或注销操作
     * @param {number} timeoutMs 本机最多等待的毫秒数
     * @returns {Promise<unknown>} 操作结果，超时则抛出可读异常
     * 注意事项：超时后的旧请求可能晚到，但客户端身份操作编号与服务端令牌版本会阻止它影响新会话。
     */
    async function waitForAuthCompletion(operation, timeoutMs) {
      let timer;
      try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("注销操作超时")), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    }

    /**
     * 把群、Agent、偏好和登录态写到本机。Mac 密钥单独交给系统加密存储。
     * @returns {void}
     */
    function persistApp() {
      publishGatewayConfig().catch(() => {});
      if (state.legacyDesktopKeys && (state.legacyDesktopKeys.openai || state.legacyDesktopKeys.anthropic || state.legacyDesktopKeys.custom)) return;
      try {
        const settings = { ...state.settings, apiKeys: { ...state.settings.apiKeys } };
        if (hasDesktopModelStorage()) delete settings.apiKeys;
        const payload = {
          accountScope: state.accountScope,
          configRevision: state.relayConfigRevision || 0,
          harnessModels: state.harnessModels,
          version: state.version,
          agents: state.agents,
          rooms: state.rooms.map((room) => ({
            id: room.id,
            name: room.name,
            agentIds: room.agentIds,
            rule: room.rule,
            workspace: room.workspace || "",
            messages: room.messages || [],
          })),
          activeRoomId: state.activeRoomId,
          selectedAgentId: state.selectedAgentId,
          panelMode: state.panelMode,
          panelCollapsed: state.panelCollapsed,
          drafts: state.drafts,
          desktopAgentIds: state.desktopAgentIds,
          desktopRoomIds: state.desktopRoomIds,
          settings,
          user: state.user,
          composerMode: state.composerMode,
        };
        localStorage.setItem("chorus-app", JSON.stringify(payload));
        if (state.accountScope) localStorage.setItem(`chorus-account:${state.accountScope}`, JSON.stringify(payload));
        state.persistError = false;
        scheduleRelayPush();
      } catch (error) {
        console.error("[chorus] 保存本地数据失败", error);
        if (!state.persistError) toast("本机数据未保存，请检查可用存储空间；当前对话仍在窗口中。");
        state.persistError = true;
      }
    }

    /**
     * 启动时恢复上次的群聊和配置。没有存档时保留内置示例。
     * @param 无
     * @returns {void} 恢复本机聊天、配置与待验证账号资料
     * 注意事项：存档中的空数组必须保持为空，仅字段缺省时保留示例；缓存不能授予员工身份。
     */
    function loadPersisted() {
      try {
        const raw = localStorage.getItem("chorus-app");
        if (!raw) return;
        const data = JSON.parse(raw);
        state.accountScope = String(data.accountScope || "");
        state.relayConfigRevision = Number(data.configRevision) || 0;
        state.harnessModels = Object.fromEntries(Object.entries(data.harnessModels || {}).map(([key, catalog]) => [key, { ...catalog, loading: false }]));
        if (Array.isArray(data.agents)) {
          const providerIds = ["openai", "anthropic", "local", "custom"];
          const harnessIds = Object.keys(HARNESS_LABEL);
          state.agents = data.agents.map((agent, index) => {
            const name = String(agent?.name || `Agent ${index + 1}`).slice(0, 24);
            const temperature = Number(agent?.temperature);
            const id = String(agent?.id || `a-restored-${index}`);
            return {
              id,
              name,
              role: String(agent?.role || "自定义角色").slice(0, 120),
              persona: String(agent?.persona || "尚未填写人设。").slice(0, 8000),
              provider: providerIds.includes(agent?.provider) ? agent.provider : "openai",
              model: String(agent?.model || "gpt-4.1").slice(0, 200),
            backend: ["model", "codex", "claude", "cursor"].includes(agent?.backend) ? agent.backend : "model",
              harness: ["codex", "claude", "cursor"].includes(agent?.backend) ? agent.backend : harnessIds.includes(agent?.harness) ? agent.harness : "none",
              initial: name.slice(0, 1).toUpperCase(),
              label: String(agent?.label || "").slice(0, 80),
              endpoint: String(agent?.endpoint || "").slice(0, 2000),
              temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.7,
              harnessModel: String(agent?.harnessModel || "").slice(0, 200),
              workspaceMode: agent?.workspaceMode === "auto" || !agent?.workspace ? "auto" : "project",
              workspace: String(agent?.workspace || "").slice(0, 4000),
              messages: normalizeStoredMessages(agent?.messages, id),
              ...(!window.chorusDesktop && (agent?.desktopManaged || (Array.isArray(data.desktopAgentIds) && data.desktopAgentIds.includes(id))) ? { desktopManaged: true } : {}),
            };
          });
        }
        if (Array.isArray(data.rooms)) {
          const agentIds = new Set(state.agents.map((agent) => agent.id));
          state.rooms = data.rooms.map((room, index) => {
            const members = Array.isArray(room?.agentIds) ? room.agentIds.map(String).filter((id) => agentIds.has(id)) : [];
            if (!members.length && state.agents[0]) members.push(state.agents[0].id);
            return {
              id: String(room?.id || `r-restored-${index}`),
              name: String(room?.name || `群聊 ${index + 1}`).slice(0, 40),
              agentIds: [...new Set(members)],
              rule: room?.rule === "mention" ? "mention" : "free",
              workspace: String(room?.workspace || "").slice(0, 4000),
            messages: C.normalizeMessages(room?.messages),
            };
          });
          state.activeRoomId = state.rooms.some((room) => room.id === data.activeRoomId) ? data.activeRoomId : state.rooms[0]?.id || "";
        }
        if (data.settings) {
          const legacyKeys = { ...state.settings.apiKeys, ...(data.settings.apiKeys || {}) };
          state.legacyDesktopKeys = hasDesktopModelStorage() ? legacyKeys : null;
          state.settings = {
            ...state.settings,
            theme: ["system", "dark", "light"].includes(data.settings.theme) ? data.settings.theme : state.settings.theme,
            localExecution: data.settings.localExecution !== false,
            relayEnabled: true,
            notifyApp: data.settings.notifyApp !== false,
            notifySound: Boolean(data.settings.notifySound),
            defaultProvider: ["openai", "anthropic", "local", "custom"].includes(data.settings.defaultProvider) ? data.settings.defaultProvider : "openai",
            googleClientId: String(data.settings.googleClientId || "").slice(0, 300),
            relayBaseUrl: normalizeRelayBaseUrl(data.settings.relayBaseUrl) || DEFAULT_RELAY_BASE_URL,
            desktopConnection: { baseUrl: String(data.settings.desktopConnection?.baseUrl || "").slice(0, 2000), token: String(data.settings.desktopConnection?.token || "").slice(0, 1000) },
            apiKeys: hasDesktopModelStorage() ? { openai: "", anthropic: "",
          custom: "", ollamaBase: legacyKeys.ollamaBase } : legacyKeys,
          };
        }
        if (data.user?.email) {
          state.user = normalizeRelayAccount(data.user);
        }
        state.composerMode = "discuss";
        state.desktopAgentIds = !window.chorusDesktop && Array.isArray(data.desktopAgentIds) ? data.desktopAgentIds.filter((id) => typeof id === "string" && state.agents.some((agent) => agent.id === id)) : [];
        state.desktopRoomIds = !window.chorusDesktop && Array.isArray(data.desktopRoomIds) ? data.desktopRoomIds.filter((id) => typeof id === "string" && state.rooms.some((room) => room.id === id)) : [];
        if (state.agents.some((agent) => agent.id === data.selectedAgentId)) state.selectedAgentId = data.selectedAgentId;
        state.panelMode = data.panelMode === "agent" ? "agent" : "room";
        state.panelCollapsed = window.innerWidth <= 900 || data.panelCollapsed === true;
        state.drafts = data.drafts && typeof data.drafts === "object" ? data.drafts : {};
      } catch (error) {
        console.error("[chorus] 读取本地数据失败", error);
      }
    }

    function openRoomModal() {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      ++state.roomModalEpoch;
      state.roomDraft = { id: `r-${crypto.randomUUID()}`, baseRevision: state.relaySession?.revision || 0, configRevision: state.relayConfigRevision };
      $("#roomName").value = "";
      state.roomRule = "free";
      $("#ruleFree").classList.add("selected");
      $("#ruleMention").classList.remove("selected");
      $("#roomAgentPick").innerHTML = state.agents
        .map((a) => {
          const c = avatarStyle(a.name);
          return `<label>
            <input type="checkbox" value="${a.id}" ${a.id !== "a4" ? "checked" : ""} />
            <span class="avatar" style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;background:${c.bg};color:${c.fg}">${escapeHtml(a.initial)}</span>
            <span>${escapeHtml(a.name)} <span style="color:var(--text-faint);font-size:11px">· ${HARNESS_LABEL[a.harness]}</span></span>
          </label>`;
        })
        .join("");
      openOverlay("roomOverlay");
      setTimeout(() => $("#roomName").focus(), 50);
    }

    /**
     * 从表单创建账号共享群组。
     * @param 无
     * @returns {Promise<void>} 创建结果已展示
     * 注意事项：使用稳定 ID 防止重试重复创建，冲突或失败时保留表单。
     */
    async function createRoomFromModal() {
      if (!canEditAgentConfig()) return toast("请先登录并同步账号配置");
      const name = $("#roomName").value.trim();
      if (!name) return toast("请填写团队名称");
      const checked = $$("#roomAgentPick input:checked").map((el) => el.value);
      if (!checked.length) return toast("至少选择一个 Agent");
      const epoch = state.roomModalEpoch, id = state.roomDraft.id;
      const config = { name, agentIds: checked, rule: state.roomRule, workspace: "" };
      const button = $("#roomCreate");
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (state.relaySession?.deviceToken) {
          if (!await saveRelayConfig("POST", "/api/v1/rooms", { id, config }, state.roomDraft, () => epoch === state.roomModalEpoch && $("#roomOverlay").classList.contains("open"))) return;
        } else state.rooms.push({ id, ...config, messages: [] });
        state.activeRoomId = id; state.selectedAgentId = checked[0];
        closeOverlay("roomOverlay"); openPanel("room", { expand: true });
        toast(`已创建团队「${name}」`); persistApp();
      } catch (error) { toast(readableError(error)); }
      finally { if (button.isConnected) button.disabled = false; }
    }

    function messageContent(message) { return C.content(message); }

    function mentionedAgents(text, members) { return C.responders(text, members, "mention"); }

    function pickResponders(text) {
      const context = chatContext();
      if (!context.team) return context.owner ? [context.owner] : [];
      return C.responders(text, (context.owner?.agentIds || []).map(getAgent).filter(Boolean), context.owner?.rule);
    }

    /**
     * 校验本轮成员是否具备本机或已连接电脑的执行条件。
     * @param {string} mode 讨论或执行模式
     * @param {object[]} responders 本轮实际回应成员
     * @returns {string} 校验错误；空字符串表示可以发送
     * 注意事项：发送入口已自动准备默认目录；手机不要求本地工作区。
     */
    function validateSend(mode, responders) {
      if (state.connectionBusy) return "正在连接，请稍候再发送";
      if (!isPrimaryDevice() && !state.desktopConnectionInfo && !state.relaySession?.deviceToken) return "请先登录并连接中转站，电脑保持在线";
      if (!responders.length) return state.panelMode === "room" ? "这个团队按点名回应，请用 @ 选择成员" : "请选择一个 Agent";
      if (!isPrimaryDevice() && !state.desktopConnectionInfo) {
        if (!state.relaySession?.deviceToken || !state.relayReady) return "请先登录并连接中转站，电脑保持在线";
        return "";
      }
      const disconnected = responders.find((agent) => desktopManagedAgent(agent) && !usingDesktopAgent(agent));
      if (disconnected) return state.desktopConnectionInfo ? `${disconnected.name} 不在这台 Mac 当前的 Agent 白名单中，请在 Mac 配置后重新同步` : `${disconnected.name} 来自 Mac，请在设置 → 桌面连接重新连接`;
      const remote = responders.filter(usingDesktopAgent);
      if (remote.length && state.panelMode === "room" && !state.desktopRoomIds.includes(state.activeRoomId)) return "这个团队尚未在 Mac 配置，请在 Mac 创建团队后重新同步桌面连接";
      const cli = responders.filter((agent) => mode === "execute" || (agent.backend || "model") !== "model");
      if (cli.length) {
        if (!state.settings.localExecution) return "Mac 本机执行已关闭，请在 Mac 设置 → 通用开启";
        const unbound = cli.filter((agent) => mode === "execute" && (!agent.harness || agent.harness === "none"));
        if (unbound.length) return `${unbound.map((agent) => agent.name).join("、")} 尚未绑定执行内核。请编辑成员配置，或 @ 已配置的成员`;
        const missing = cli.filter((agent) => !agent.workspace?.trim());
        if (missing.length) return `${missing.map((agent) => agent.name).join("、")} 的默认工作区尚未准备，请重试或检查电脑目录权限`;
        const unsupported = cli.find((agent) => !usingDesktopAgent(agent) && !(mode === "execute" ? window.chorusDesktop?.runHarness : window.chorusDesktop?.completeChat));
        if (unsupported) return `${unsupported.name} 使用完整编程后台，请在设置 → 桌面连接中连接 Mac`;
      }
      return "";
    }

    /**
     * 发送当前消息，由电脑执行或由手机下发到电脑。
     * @param 无
     * @returns {Promise<void>} 消息下发或本轮回复完成
     * 注意事项：发送前准备成员默认目录；团队成员各自使用自己的工作区。
     */
    async function sendMessage() {
      if (state.sending || state.preparingSend || state.authPending) return;
      if (state.attachmentLoads.has(state.draftKey)) return toast("附件正在读取，请稍候再发送");
      const text = $("#composerInput").value.trim();
      const attachments = state.pendingAttachments.map((file) => ({ ...file }));
      if (!text && !attachments.length) return;
      const context = chatContext();
      const responders = pickResponders(text);
      const mode = state.composerMode;
      const epoch = conversationEpoch;
      const scope = state.accountScope;
      const attempt = authAttemptEpoch;
      state.preparingSend = true; updateComposer();
      try { await prepareDesktopWorkspaces(responders); }
      catch (error) { return toast(readableError(error)); }
      finally { if (conversationEpoch === epoch && state.accountScope === scope && authAttemptEpoch === attempt) { state.preparingSend = false; updateComposer(); } }
      if (conversationEpoch !== epoch || state.accountScope !== scope || authAttemptEpoch !== attempt) return;
      const invalid = validateSend(mode, responders);
      if (invalid) return toast(invalid);
      const message = { id: `u-${crypto.randomUUID()}`, from: "you", text: text || "请查看附件。", time: nowTime(), attachments, mode };
      context.thread.push(message);
      $("#composerInput").value = "";
      state.pendingAttachments = [];
      delete state.drafts[context.key];
      $("#composerFiles").value = "";
      renderComposerAttachments(); hideMention(); renderMessages({ pin: chatContext().key === context.key ? true : undefined }); updateComposer(); persistApp();
      if (!isPrimaryDevice() && !state.desktopConnectionInfo) {
        state.sending = true;
        updateComposer();
        try { await sendToPrimaryDevice(messageContent(message), responders, mode, message, context); if (conversationEpoch === epoch && state.accountScope === scope && authAttemptEpoch === attempt) toast("已下发给主设备，等待结果同步"); }
        catch (error) {
          if (conversationEpoch === epoch && state.accountScope === scope && authAttemptEpoch === attempt) {
            context.thread.push({ id: `e-${crypto.randomUUID()}`, from: responders[0].id, text: readableError(error), time: nowTime(), error: true, requestId: message.id, mode }); renderMessages();
          }
        }
        finally { if (conversationEpoch === epoch && state.accountScope === scope && authAttemptEpoch === attempt) { state.sending = false; updateComposer(); persistApp(); } }
        return;
      }
      await dispatchAgentReplies({ userText: messageContent(message), responders, mode, context, requestId: message.id });
    }

    async function sendToPrimaryDevice(userText, responders, mode, userMessage, context = chatContext()) {
      const token = state.relaySession?.deviceToken;
      if (!token) throw new Error("请先登录并连接中转站");
      const result = await relayRequest("POST", "/api/v1/dispatches", token, {
        clientRequestId: userMessage.id,
        mode: mode === "execute" ? "execute" : "discuss",
        ...(context.team ? { roomId: context.owner.id } : { agentId: context.owner.id }),
        userText, userMessage, attachments: userMessage.attachments || [],
        responders: responders.map((agent) => ({ agentId: agent.id })),
      });
      if (state.relaySession?.deviceToken !== token) return;
      if (result.state) { applyRelaySnapshot(result.state); refreshRelayView(); }
      state.relaySession.revision = Number(result.revision) || state.relaySession.revision;
      saveRelaySession();
    }

    /**
     * 把指定群最近对话整理成模型消息，并合并连续同角色消息以兼容 Anthropic。
     * @param {object} agent 当前回复成员
     * @param {string} userText 本轮用户输入（含附件正文）
     * @param {object} context 群聊或私聊上下文
     * @param {string} beforeId 重试时截取历史的位置
     * @param {string} triggerId 触发本次群聊观察的消息编号
     * @returns {{role: string, content: string}[]} 模型上下文
     * 注意事项：群聊控制指令随消息发送，确保主机执行与手机网关采用相同的参与规则。
     */
    function buildModelMessages(agent, userText, context = chatContext(), beforeId = "", triggerId = "") {
      const messages = C.modelMessages(context.thread, agent, state.agents, userText, context.team, beforeId);
      if (context.team) {
        const members = (context.owner.agentIds || []).map(getAgent).filter(Boolean);
        const instruction = C.groupInstructions(agent, members, context.owner.name, context.thread.find((message) => message.id === triggerId));
        if (messages.at(-1)?.role === "user") messages.at(-1).content += `\n\n${instruction}`;
        else messages.push({ role: "user", content: instruction });
      }
      return messages;
    }

    /**
     * 执行一个成员本轮回复，团队和私聊使用该成员自己的目录。
     * @param {object} agent 执行成员
     * @param {string} userText 本轮任务文本
     * @param {object} [options] 聊天上下文、运行编号及取消信号
     * @returns {Promise<object>} 回复正文、来源和错误状态
     * 注意事项：不使用团队共享目录；手机只调用已授权的电脑配置。
     */
    async function produceReply(agent, userText, { mode, context = { team: false, owner: agent, thread: ensureAgentThread(agent).messages, key: `agent:${agent.id}` }, beforeId = "", triggerId = "", runId = "", signal, onText } = {}) {
      const messages = buildModelMessages(agent, userText, context, beforeId, triggerId);
      const desktop = window.chorusDesktop;
      if (desktopManagedAgent(agent) && !usingDesktopAgent(agent)) throw new Error("这个 Agent 的 Mac 连接或白名单已失效，请重新同步桌面配置");
      if (usingDesktopAgent(agent)) {
        const connection = { ...state.settings.desktopConnection };
        const active = state.activeRuns?.get(runId);
        if (active) active.connection = connection;
        const result = await ChorusGatewayClient.request(connection, "POST", "/chat", { agentId: agent.id, messages, threadKey: context.key, runId, mode: mode === "execute" ? "execute" : "discuss" }, signal, onText);
        if (result.ok === false) throw new Error(result.text || "Mac 后台执行失败");
        if (typeof result.text !== "string" || !result.text.trim()) throw new Error("Mac 后台没有返回有效结果");
        return { text: result.text, chips: [`${result.via === "model" ? backendLabel(agent) : HARNESS_LABEL[result.via] || backendLabel(agent)} · Mac`] };
      }
      if (desktop?.prepareAgentWorkspaces) await prepareDesktopWorkspaces([agent]);
      await publishGatewayConfig();
      if (signal?.aborted) throw new Error("任务已停止");
      if (mode === "execute") {
        if (!desktop?.runHarness) throw new Error("执行内核仅在 Mac 上运行");
        if (!state.settings.localExecution || agent.harness === "none" || !agent.workspace?.trim()) throw new Error("请配置执行内核、工作区并开启本机执行");
        const transcript = messages.map((item) => `${item.role === "assistant" ? agent.name : "上下文"}：${item.content}`).join("\n\n");
        const result = await desktop.runHarness({ harness: agent.harness, harnessModel: agent.harnessModel || "", workspaceMode: agent.workspaceMode, agentName: agent.name, cwd: agent.workspace, runId, threadKey: context.key, agentId: agent.id, prompt: `你是 ${agent.name}（${agent.role}）。${agent.persona}\n${context.team ? `你正在参与团队「${context.owner.name}」，先按群聊参与规则判断是否需要你执行，再处理与你相关的任务。` : "请处理当前私聊任务。"}\n\n${transcript}` }, onText);
        return { text: result.text || "内核没有返回输出", chips: [`${HARNESS_LABEL[agent.harness]} · ${result.ok ? "已执行" : "失败"}`], error: !result.ok };
      }
      const contextualAgent = context.team ? { ...agent, persona: `${agent.persona}\n你正在参与团队「${context.owner.name}」。请遵守消息中的群聊参与规则，先判断相关性，再决定是否回应或执行；不需要参与时按约定保持沉默。` } : agent;
      if (desktop?.completeChat) {
        const payload = { agent: contextualAgent, messages, workspace: agent.workspace || "", runId, threadKey: context.key, agentId: agent.id };
        if (!hasDesktopModelStorage()) payload.keys = state.settings.apiKeys;
        const result = await desktop.completeChat(payload, onText);
        return { text: result.text, chips: [result.via === "model" ? backendLabel(agent) : HARNESS_LABEL[result.via] || backendLabel(agent)] };
      }
      if ((agent.backend || "model") !== "model") throw new Error(`${HARNESS_LABEL[agent.backend]} 编程后台需要连接 Mac`);
      return { text: await completeChatInPage(contextualAgent, messages, state.settings.apiKeys || {}, signal, onText), chips: [backendLabel(agent)] };
    }

    async function completeChatInPage(agent, messages, keys, signal, onText) {
      return ChorusModelClient.complete(agent, messages, keys, signal, onText);
    }

    /**
     * 驱动群聊相关性观察和成员间点名，或执行单个私聊回复。
     * @param {object} options 任务文本、成员、上下文、请求标识与继续执行检查
     * @returns {Promise<void>} 完成本轮成员回复或安全停止旧账号任务
     * 注意事项：静默结果不保存、不通知；捕获账号及编辑器版本，旧账号晚到结果不能写回。
     */
    async function dispatchAgentReplies({ userText, responders, mode, context = chatContext(), requestId = "", retryId = "", canContinue = () => true, onRunStart = () => {} }) {
      if (!responders.length || state.sending) return;
      const epoch = conversationEpoch, scope = state.accountScope, attempt = authAttemptEpoch;
      const members = context.team ? (context.owner.agentIds || []).map(getAgent).filter(Boolean) : responders;
      const previous = context.team && !retryId ? context.thread.filter((message) => message.requestId === requestId && !message.streaming) : [];
      const group = context.team && !retryId ? C.groupTurnQueue(members, responders, previous, requestId) : null;
      const direct = responders.map((agent) => ({ agent, triggerId: retryId ? context.thread.find((message) => message.id === retryId)?.replyTo || requestId : requestId }));
      const activeRuns = new Map();
      state.activeRuns = activeRuns;
      let renderTimer = null, saveTimer = null;
      state.sending = true;
      state.stopRequested = false;
      /** 校验任务仍归当前账号；参数：无；返回：布尔值；注意事项：晚到分片和租约失效结果均丢弃。 */
      function current() { return conversationEpoch === epoch && state.accountScope === scope && authAttemptEpoch === attempt && canContinue(); }
      /** 批量刷新分片；参数：无；返回：无；注意事项：控制 DOM 与磁盘频率，保持现有阅读锚点。 */
      function scheduleStream() {
        if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; if (current() && chatContext().key === context.key) renderMessages(); }, 80);
        if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; if (current()) persistApp(); }, 800);
      }
      /** 刷新全部运行成员；参数：无；返回：无；注意事项：同步保留单成员字段以兼容旧客户端。 */
      function updateRunning() {
        if (!current()) return;
        const running = [...activeRuns.values()].map((run) => run.agent);
        state.running = running.length ? { key: context.key, agentId: running[0].id, agentIds: running.map((agent) => agent.id), label: `${running.map((agent) => agent.name).join("、")} 正在回复…` } : null;
        renderRunning(); renderAgents(); scheduleRelayPush(0);
      }
      /**
       * 执行单成员并将累计正文写回当前消息对象。
       * @param {object} turn 成员与触发消息
       * @param {object} snapshot 本波只读上下文
       * @returns {Promise<object|null>} 完成消息或沉默、失效时的空值
       * 注意事项：通过消息 ID 更新，避免中转快照替换对象导致分片写入失效引用。
       */
      async function runTurn({ agent, triggerId }, snapshot) {
        if (!current() || state.stopRequested) return null;
        const runId = `run-${crypto.randomUUID()}`;
        const controller = new AbortController();
        const run = { agent, controller, connection: null };
        activeRuns.set(runId, run);
        state.activeRunId = runId;
        onRunStart(runId);
        updateRunning();
        const partial = context.thread.find((item) => item.streaming && item.from === agent.id && item.requestId === requestId && (!context.team || item.replyTo === triggerId));
        const reply = { id: retryId || partial?.id || `m-${crypto.randomUUID()}`, from: agent.id, author: agent.name, time: nowTime(), requestId, ...(context.team ? { replyTo: triggerId } : {}), mode };
        let settled = false;
        /** 保存当前回复；参数：无；返回：无；注意事项：重试和中转合并均按稳定 ID 覆盖。 */
        function saveReply() {
          const index = context.thread.findIndex((item) => item.id === reply.id);
          if (index >= 0) context.thread[index] = { ...reply };
          else context.thread.push({ ...reply });
        }
        /** 接收累计正文；参数：text 为完整已生成文本；返回：无；注意事项：隐藏未完成沉默标记并拒绝取消后分片。 */
        function onText(text) {
          if (settled || !current() || state.stopRequested || controller.signal.aborted || typeof text !== "string" || !text) return;
          if (context.team && "[[CHORUS_SILENT]]".startsWith(text.trim())) return;
          Object.assign(reply, { text, streaming: true, chips: ["正在生成…"] });
          saveReply(); scheduleStream();
        }
        try {
          const produced = await produceReply(agent, userText, { mode, context: snapshot, beforeId: retryId, triggerId, runId, signal: controller.signal, onText });
          if (!current()) return null;
          if (state.stopRequested) throw new Error("任务已停止");
          if (context.team && !produced.error && C.silentGroupReply(produced.text)) {
            console.info(`[chorus] 群聊成员选择保持沉默 agent=${agent.id} request=${requestId} trigger=${triggerId}`);
            const stale = context.thread.findIndex((item) => item.id === reply.id);
            if (stale >= 0) context.thread.splice(stale, 1);
            return null;
          }
          Object.assign(reply, produced, { streaming: false });
          notifyAgentResult(agent, context, produced.text, produced.error);
        } catch (error) {
          if (!current()) return null;
          const detail = state.stopRequested ? "任务已停止。" : readableError(error);
          Object.assign(reply, { text: reply.text ? `${reply.text}\n\n${detail}` : detail, streaming: false, error: true, chips: [state.stopRequested ? "已停止" : "调用失败"] });
        } finally {
          settled = true;
          activeRuns.delete(runId);
          updateRunning();
        }
        if (!current()) return null;
        saveReply();
        if (chatContext().key === context.key) renderMessages();
        persistApp();
        return reply;
      }
      try {
        // ------------ 每波并行观察；共享目录排队，依赖点名在下一波执行 ---------------
        while (current() && !state.stopRequested) {
          const wave = [];
          for (let turn = group ? group.next() : direct.shift(); turn; turn = group ? group.next() : direct.shift()) wave.push(turn);
          if (!wave.length) break;
          // 同一波所有成员读取一致的已完成历史，不让先到分片改变其他成员的输入。
          const snapshot = { ...context, thread: context.thread.filter((message) => !message.streaming).map((message) => ({ ...message })) };
          const workspaces = new Map();
          const slots = Array(8).fill(null);
          console.info(`[chorus] ------------- 并行处理成员 count=${wave.length} request=${requestId} --------------`);
          const results = await Promise.all(wave.map((turn, index) => {
            const agent = turn.agent;
            const workspace = (mode === "execute" || (agent.backend || "model") !== "model") ? String(agent.workspace || "").trim().replace(/\/+$/, "") : "";
            const prior = [workspace && workspaces.get(workspace), slots[index % slots.length]].filter(Boolean);
            // 网关最多支持八个活跃任务；每个执行槽和工作区都等待前一项完成。
            const operation = prior.length ? Promise.all(prior).then(() => runTurn(turn, snapshot)) : runTurn(turn, snapshot);
            slots[index % slots.length] = operation;
            if (workspace) workspaces.set(workspace, operation);
            return operation;
          }));
          if (!current()) break;
          for (const reply of results) if (reply && group) group.record(reply);
        }
        if (group?.limited()) console.info(`[chorus] 群聊自动互动达到上限 request=${requestId}`);
      } finally {
        if (renderTimer) clearTimeout(renderTimer);
        if (saveTimer) clearTimeout(saveTimer);
        if (conversationEpoch === epoch && state.accountScope === scope && authAttemptEpoch === attempt) {
          state.sending = false; state.running = null; state.activeRunId = ""; state.activeRuns = new Map(); state.activeRunConnection = null; state.requestController = null; state.stopRequested = false;
          renderRunning(); renderAgents(); renderMessages({ pin: false }); persistApp();
          if (state.relaySession?.deviceToken) runRelayLoop();
        }
      }
    }

    /**
     * 同时终止本轮所有成员及等待执行的共享目录任务。
     * @param 无
     * @returns {Promise<void>} 所有远端取消请求完成
     * 注意事项：先同步中止全部信号，再并发请求内核取消，避免某个网络请求拖延其他成员。
     */
    async function stopRun() {
      if (!state.sending || state.stopRequested) return;
      state.stopRequested = true;
      const runs = [...(state.activeRuns || new Map()).entries()];
      state.requestController?.abort();
      for (const [, run] of runs) run.controller.abort();
      updateComposer();
      const outcomes = await Promise.allSettled(runs.map(([runId, run]) => run.connection ? ChorusGatewayClient.request(run.connection, "POST", "/cancel", { runId }) : window.chorusDesktop?.cancelRun?.(runId)));
      const failure = outcomes.find((result) => result.status === "rejected");
      if (failure) toast(readableError(failure.reason));
    }

    async function retryReply(id) {
      if (state.sending) return;
      const context = chatContext();
      const reply = context.thread.find((item) => item.id === id);
      const request = context.thread.find((item) => item.id === reply?.requestId);
      const agent = getAgent(reply?.from);
      if (!request || !agent) return toast("原消息或 Agent 已不存在");
      const invalid = validateSend(reply.mode, [agent]);
      if (invalid) return toast(invalid);
      if (!isPrimaryDevice() && !state.desktopConnectionInfo) {
        const retry = { ...request, id: `u-${crypto.randomUUID()}` };
        try { await sendToPrimaryDevice(messageContent(retry), [agent], reply.mode, retry, context); toast("已提交电脑重新执行"); }
        catch (error) { toast(readableError(error)); }
        return;
      }
      await dispatchAgentReplies({ userText: messageContent(request), responders: [agent], mode: reply.mode, context, requestId: request.id, retryId: id });
    }

    function readableError(error) {
      return friendlyErrorMessage(error);
    }

    function renderComposerAttachments() {
      const box = $("#composerAttachments");
      box.hidden = state.pendingAttachments.length === 0;
      box.innerHTML = state.pendingAttachments
        .map((file) => `<span class="attachment-item">
          <span class="attachment-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)} · ${formatFileSize(file.size)}</span>
          <button type="button" data-remove-attachment="${escapeHtml(file.id)}" title="移除附件" aria-label="移除 ${escapeHtml(file.name)}">×</button>
        </span>`)
        .join("");
      $$('[data-remove-attachment]', box).forEach((button) => {
        button.addEventListener("click", () => {
          state.pendingAttachments = state.pendingAttachments.filter((file) => file.id !== button.dataset.removeAttachment);
          renderComposerAttachments(); saveDraft(); updateComposer(); persistApp();
        });
      });
    }

    function isTextAttachment(file) {
      if (file.type.startsWith("text/")) return true;
      return /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html?|css|s[ac]ss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|php|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|sh|zsh|bash|fish|sql|ya?ml|toml|ini|conf|env|log)$/i.test(file.name);
    }

    async function addAttachments(files) {
      const epoch = conversationEpoch;
      const key = state.draftKey;
      if (state.attachmentLoads.has(key)) return toast("附件正在读取，请稍候再添加");
      state.attachmentLoads.add(key); updateComposer();
      saveDraft();
      const original = state.drafts[key] || { text: "", attachments: [] };
      const attachments = original.attachments;
      const incoming = [...files];
      let total = attachments.reduce((sum, file) => sum + file.size, 0);
      let skipped = 0;
      for (const file of incoming) {
        if (attachments.length >= MAX_ATTACHMENTS || !isTextAttachment(file) || file.size > MAX_ATTACHMENT_BYTES || total + file.size > MAX_ATTACHMENT_TOTAL_BYTES) { skipped++; continue; }
        try {
          const text = await file.text();
          if (epoch !== conversationEpoch) return;
          attachments.push({ id: `f-${crypto.randomUUID()}`, name: file.name, size: file.size, text });
          total += file.size;
        } catch (_) { skipped++; }
      }
      state.attachmentLoads.delete(key);
      const latest = state.drafts[key] || original;
      latest.attachments = attachments;
      state.drafts[key] = latest;
      if (state.draftKey === key) { state.pendingAttachments = attachments.map((file) => ({ ...file })); renderComposerAttachments(); updateComposer(); }
      persistApp();
      if (skipped) toast(`有 ${skipped} 个附件未加入：仅支持文本文件，最多 5 个、单个 256 KB、合计 512 KB`);
    }

    function playNotificationTone() {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 720;
        gain.gain.setValueAtTime(0.04, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.18);
        oscillator.addEventListener("ended", () => context.close());
      } catch (_error) {
        // 系统阻止自动音频时静默跳过，不影响任务结果。
      }
    }

    /**
     * 根据应用总开关提醒任意 Agent 的执行结果。
     * @param {object} agent 完成任务的成员
     * @param {object} _context 所属聊天上下文
     * @param {string} text 执行结果摘要
     * @param {boolean} failed 是否执行失败
     * @returns {void}
     * 注意事项：忽略旧版成员级开关；前台聚焦时抑制弹窗，关闭总开关也关闭提示音。
     */
    function notifyAgentResult(agent, _context, text, failed) {
      if (!state.settings.notifyApp || document.hasFocus()) return;
      if (state.settings.notifySound) playNotificationTone();
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const notification = new Notification(`${agent.name} · ${failed ? "执行失败" : "任务完成"}`, {
        body: `${agent.name} · ${String(text).replace(/\s+/g, " ").slice(0, 180)}`,
      });
      notification.addEventListener("click", () => window.focus());
    }

    function showMention(filter = "") {
      const members = chatContext().team ? (activeRoom()?.agentIds || []).map(getAgent).filter(Boolean) : [activeChatAgent()].filter(Boolean);
      const q = filter.trimStart().toLocaleLowerCase();
      const list = members.filter((a) => !q || a.name.toLocaleLowerCase().includes(q));
      const pop = $("#mentionPop");
      if (!list.length) {
        pop.classList.remove("open");
        return;
      }
      pop.innerHTML = list
        .map((a, i) => {
          const c = avatarStyle(a.name);
          return `<button type="button" class="${i === 0 ? "active" : ""}" data-mention="${escapeHtml(a.name)}">
            <span class="avatar" style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:${c.bg};color:${c.fg}">${escapeHtml(a.initial)}</span>
            ${escapeHtml(a.name)}
            <span style="margin-left:auto;font-size:11px;color:var(--text-faint)">${escapeHtml(HARNESS_LABEL[a.harness] || "仅对话")}</span>
          </button>`;
        })
        .join("");
      pop.classList.add("open");
      $$("#mentionPop button").forEach((btn) => {
        btn.addEventListener("click", () => insertMention(btn.dataset.mention));
      });
    }

    function hideMention() {
      $("#mentionPop").classList.remove("open");
    }

    function insertMention(name) {
      const input = $("#composerInput");
      const v = input.value;
      const caret = input.selectionStart;
      const tail = input.selectionEnd;
      const before = v.slice(0, caret);
      const at = before.lastIndexOf("@");
      if (at >= 0) {
        input.value = before.slice(0, at) + "@" + name + " " + v.slice(tail);
      } else {
        input.value = v + "@" + name + " ";
      }
      const nextCaret = at >= 0 ? at + name.length + 2 : input.value.length;
      input.setSelectionRange(nextCaret, nextCaret);
      hideMention();
      input.focus();
    }

    const overlayFocus = new Map();
    $("#sidebarSearch").addEventListener("input", () => { renderRooms(); renderAgents(); });
    $("#teamStrip").addEventListener("click", (event) => {
      const button = event.target.closest("[data-open-agent]");
      if (button) openPanel("agent", { agentId: button.dataset.openAgent });
    });
    $("#btnStop").addEventListener("click", stopRun);
    $("#btnTerminal").addEventListener("click", openTerminal);
    for (const [buttonId, inputId] of [["#chooseCreateWorkspace", "#agentWorkspace"], ["#chooseEditWorkspace", "#editAgentWorkspace"]]) {
      $(buttonId).addEventListener("click", async (event) => {
        if (!window.chorusDesktop?.chooseWorkspace) return;
        const button = event.currentTarget, epoch = state.agentModalEpoch;
        button.disabled = true;
        try {
          const workspace = await window.chorusDesktop.chooseWorkspace();
          if (workspace && epoch === state.agentModalEpoch && $("#agentOverlay").classList.contains("open")) $(inputId).value = workspace;
        } catch (error) { toast(readableError(error)); }
        finally { if (button.isConnected) button.disabled = false; }
      });
    }
    $("#messages").addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.setup === "auth") return openAuthModal();
      if (button.dataset.setup === "details") return setPanelCollapsed(false);
      if (button.dataset.setup) return openSettings(button.dataset.setup);
      if (button.dataset.prompt) { $("#composerInput").value = button.dataset.prompt; $("#composerInput").focus(); saveDraft(); updateComposer(); persistApp(); return; }
      if (button.dataset.retry) return retryReply(button.dataset.retry);
      if (button.dataset.editFailed) return openEditAgentModal(button.dataset.editFailed);
      if (button.dataset.copy) {
        const message = chatContext().thread.find((item) => item.id === button.dataset.copy);
        if (!message) return;
        try { if (!await ChorusPlatform.copyText(message.text)) throw new Error("系统剪贴板不可用"); toast("已复制消息"); }
        catch (_) { toast("无法访问剪贴板，请选中消息文字复制"); }
      }
    });
    for (const prefix of ["create", "edit"]) {
      $(`#${prefix}HarnessModel`).addEventListener("change", (event) => {
        const draft = prefix === "create" ? state.agentDraft : state.editDraft;
        draft.harnessModel = event.target.value;
      });
      $(`#refresh${prefix === "create" ? "Create" : "Edit"}Models`).addEventListener("click", async () => {
        const draft = prefix === "create" ? state.agentDraft : state.editDraft;
        const harness = (draft.backend || "model") === "model" ? draft.harness : draft.backend;
        await loadHarnessModels(harness, true);
        renderHarnessModelChoice(prefix);
      });
    }
    for (const [selector, draft] of [["#backendChoices", "agentDraft"], ["#editBackendChoices", "editDraft"]]) {
      $(selector).addEventListener("click", (event) => {
        const button = event.target.closest("[data-backend]");
        if (!button) return;
        state[draft].backend = button.dataset.backend;
        state[draft].harnessModel = "";
        selectChoice(selector, "backend", button.dataset.backend); syncAgentWizardUI();
      });
    }
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); openAgentModal(); }
      const overlay = $(".overlay.open");
      if (overlay && event.key === "Tab") {
        const focusable = $$('button:not(:disabled),input,textarea,select,summary,a[href]', overlay).filter((element) => !element.hidden && element.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    window.addEventListener("beforeunload", () => { saveDraft(); persistApp(); });

    // ---- Events ----
    $("#roomList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-room]");
      if (!btn) return;
      state.activeRoomId = btn.dataset.room;
      openPanel("room", { expand: true });
      renderRooms();
    });

    $("#agentList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-agent]");
      if (!btn) return;
      openPanel("agent", { agentId: btn.dataset.agent, expand: true });
    });

    $("#btnCollapsePanel").addEventListener("click", () => setPanelCollapsed(true));
    $("#btnExpandPanel").addEventListener("click", () => setPanelCollapsed(false));
    $("#btnTogglePanel").addEventListener("click", () => setPanelCollapsed(!state.panelCollapsed));

    $("#btnNewAgent")?.addEventListener("click", openAgentModal);
    $("#btnNewAgentSide").addEventListener("click", openAgentModal);
    $("#btnNewRoom")?.addEventListener("click", openRoomModal);
    $("#btnNewRoomSide").addEventListener("click", openRoomModal);
    $("#btnOpenSettings").addEventListener("click", () => openSettings("general"));
    $("#btnAccount").addEventListener("click", openAuthModal);
    $("#btnHeaderAccount").addEventListener("click", openAuthModal);

    $("#btnGoogleLogin").addEventListener("click", async (event) => {
      if (state.authPending) return;
      if (state.sending) return setAuthError("请先停止当前任务，再登录账号");
      state.authPending = "google"; setAuthError(); syncAuthModal();
      const authenticatedBaseUrl = relayBaseUrl();
      const attempt = ++authAttemptEpoch;
      try {
        console.info("[chorus] ------------- Google 浏览器认证开始 --------------");
        const session = await ChorusPlatform.googleLogin(authenticatedBaseUrl, { device: { clientDeviceId: getOrCreateClientDeviceId(), name: currentDeviceName(state.user), platform: currentClientPlatform() } });
        if (attempt !== authAttemptEpoch) return;
        await loginAs(session, authenticatedBaseUrl, attempt);
      } catch (error) { if (attempt === authAttemptEpoch) { setAuthError(readableError(error)); console.warn("[chorus] Google 认证未完成"); } }
      finally { if (attempt === authAttemptEpoch) { state.authPending = ""; syncAuthModal(); } }
    });
    $("#btnComposerMode").addEventListener("click", () => {
      state.composerMode = "discuss";
      updateComposer();
    });
    /**
     * 使用中转站真实邮箱密码接口登录或注册。
     * @param {string} action login 或 register，必须与当前表单模式一致
     * @returns {Promise<boolean>} 当前认证操作是否成功
     * 注意事项：确认密码只在本机校验；不重复提交，不记录密码、账号正文或设备令牌。
     */
    async function emailLogin(action = state.authMode === "register" ? "register" : "login") {
      if (state.authPending) return false;
      if (state.sending) { setAuthError("请先停止当前任务，再登录账号"); return false; }
      const email = $("#regEmail").value.trim();
      const name = action === "register" ? $("#regName").value.trim() : "";
      const password = $("#regPassword").value;
      const bytes = new TextEncoder().encode(password).byteLength;
      if (!email || !$("#regEmail").checkValidity()) { setAuthError("请输入有效邮箱"); return false; }
      if (bytes < 8 || bytes > 72) { setAuthError(bytes < 8 ? "密码太短，请使用更长的密码" : "密码太长，请缩短密码后重试"); return false; }
      if (action === "register" && !name) { setAuthError("请输入姓名"); return false; }
      if (action === "register" && password !== $("#regPasswordConfirm").value) { setAuthError("两次输入的密码不一致"); return false; }
      state.authPending = "email"; setAuthError(); syncAuthModal();
      const authenticatedBaseUrl = relayBaseUrl();
      const attempt = ++authAttemptEpoch;
      try {
        console.info(`[chorus] ------------- 邮箱${action === "register" ? "注册" : "登录"}开始 --------------`);
        const session = await relayRequest("POST", "/api/v1/auth/email", null, { email, name, password, action, device: { clientDeviceId: getOrCreateClientDeviceId(), name: currentDeviceName({ name: name || email }), platform: currentClientPlatform() } });
        if (attempt !== authAttemptEpoch || authenticatedBaseUrl !== relayBaseUrl()) return false;
        return await loginAs(session, authenticatedBaseUrl, attempt);
      } catch (error) {
        if (attempt === authAttemptEpoch) { setAuthError(readableError(error)); console.warn(`[chorus] 邮箱${action === "register" ? "注册" : "登录"}未完成`); }
        return false;
      } finally { if (attempt === authAttemptEpoch) { state.authPending = ""; syncAuthModal(); } }
    }
    $("#authEmailForm").addEventListener("submit", (event) => { event.preventDefault(); emailLogin(); });
    $("#btnRegister").addEventListener("click", () => setAuthMode("register"));
    $("#btnAuthLoginMode").addEventListener("click", () => setAuthMode("login"));
    $$('[data-password-target]').forEach((button) => button.addEventListener("click", () => toggleAuthPassword(button)));
    $("#btnLogout").addEventListener("click", () => logout());
    $("#btnSwitchAccount").addEventListener("click", () => logout(true));

    $$("#settingsNav button").forEach((btn) => {
      btn.addEventListener("click", () => {
        openSettings(btn.dataset.settings);
      });
    });

    $$("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeOverlay(btn.dataset.close));
    });

    $$(".overlay").forEach((ov) => {
      ov.addEventListener("click", (e) => {
        if (e.target === ov) closeOverlay(ov.id);
      });
    });

    $("#providerChoices").addEventListener("click", (e) => {
      const choice = e.target.closest(".choice");
      if (!choice) return;
      selectChoice("#providerChoices", "provider", choice.dataset.provider);
      state.agentDraft.provider = choice.dataset.provider;
      $("#modelId").value = defaultModel(choice.dataset.provider);
      $("#customEndpointRow").hidden = choice.dataset.provider !== "custom";
    });

    $("#harnessChoices").addEventListener("click", (e) => {
      if ((state.agentDraft.backend || "model") !== "model") return;
      const choice = e.target.closest(".choice");
      if (!choice) return;
      selectChoice("#harnessChoices", "harness", choice.dataset.harness);
      state.agentDraft.harness = choice.dataset.harness;
      state.agentDraft.harnessModel = ""; syncAgentWizardUI();
    });

    $("#editProviderChoices").addEventListener("click", (e) => {
      const choice = e.target.closest(".choice");
      if (!choice) return;
      selectChoice("#editProviderChoices", "provider", choice.dataset.provider);
      state.editDraft.provider = choice.dataset.provider;
      $("#editModelId").value = defaultModel(choice.dataset.provider);
      $("#editEndpointRow").hidden = choice.dataset.provider !== "custom";
    });

    $("#editHarnessChoices").addEventListener("click", (e) => {
      if ((state.editDraft.backend || "model") !== "model") return;
      const choice = e.target.closest(".choice");
      if (!choice) return;
      selectChoice("#editHarnessChoices", "harness", choice.dataset.harness);
      state.editDraft.harness = choice.dataset.harness;
      state.editDraft.harnessModel = ""; syncAgentWizardUI();
    });

    $("#agentNext").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (button.disabled) return;
      if (state.agentModalMode === "edit") {
        button.disabled = true;
        try { await saveEditedAgent(); } finally { button.disabled = false; }
        return;
      }
      if (state.agentWizardStep < 3) {
        if (state.agentWizardStep === 1 && !$("#agentName").value.trim()) {
          toast("先给 Agent 起个名字");
          return;
        }
        state.agentWizardStep += 1;
        syncAgentWizardUI();
      } else {
        button.disabled = true;
        try { await createAgentFromWizard(); } finally { button.disabled = false; }
      }
    });

    $("#agentBack").addEventListener("click", () => {
      if (state.agentWizardStep > 1) {
        state.agentWizardStep -= 1;
        syncAgentWizardUI();
      }
    });

    $("#agentDelete").addEventListener("click", deleteEditedAgent);

    $("#ruleFree").addEventListener("click", () => {
      state.roomRule = "free";
      $("#ruleFree").classList.add("selected");
      $("#ruleMention").classList.remove("selected");
    });
    $("#ruleMention").addEventListener("click", () => {
      state.roomRule = "mention";
      $("#ruleMention").classList.add("selected");
      $("#ruleFree").classList.remove("selected");
    });

    $("#roomCreate").addEventListener("click", createRoomFromModal);
    $("#btnSend").addEventListener("click", sendMessage);
    $("#composerInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    $("#composerInput").addEventListener("input", () => {
      const v = $("#composerInput").value;
      const caret = $("#composerInput").selectionStart;
      const before = v.slice(0, caret);
      const match = before.match(/@([^@\s]*)$/u);
      if (match) showMention(match[1]);
      else hideMention();
      saveDraft(); updateComposer();
      clearTimeout(draftTimer); draftTimer = setTimeout(persistApp, 300);
    });

    $("#btnMention").addEventListener("click", () => {
      const input = $("#composerInput");
      input.value += (input.value && !input.value.endsWith(" ") ? " @" : "@");
      input.focus();
      showMention("");
    });

    $("#btnAttach").addEventListener("click", () => $("#composerFiles").click());
    $("#composerFiles").addEventListener("change", () => {
      const files = $("#composerFiles").files;
      if (files?.length) addAttachments(files);
      $("#composerFiles").value = "";
    });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettings(state.settingsSection || "general");
        return;
      }
      if (e.key === "Escape") {
        closeOverlay("agentOverlay");
        closeOverlay("roomOverlay");
        closeOverlay("settingsOverlay");
        closeOverlay("authOverlay");
        closeOverlay("terminalOverlay");
        hideMention();
      }
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.settings.theme === "system") {
        applyTheme("system");
        updateThemeEffectiveLabel();
      }
    });

    /**
     * 启动时读取版本、密钥状态，并检测本机 Codex / Claude Code / Cursor。
     * @returns {Promise<void>}
     * 参数：无。注意事项：仅主电脑创建默认目录，手机展示同步后的实际路径。
     */
    async function bootDesktopBridge() {
      try {
        if (window.chorusDesktop?.getAppInfo) state.appInfo = await window.chorusDesktop.getAppInfo();
        await initializeDesktopModelSettings();
        await prepareDesktopWorkspaces();
        if (window.chorusDesktop?.probeHarness) await refreshHarnessStatus();
        await publishGatewayConfig();
        if (window.chorusDesktop?.getGatewayStatus) await refreshGatewayStatus();

      } catch (error) {
        console.error("[chorus] 桌面桥初始化失败", error);
        toast(error instanceof Error ? error.message : "桌面能力初始化失败");
      }
      renderAll(); renderMessages({ pin: false });
      await bootRelaySync();
    }

    /**
     * 主电脑领取并执行待办，手机和其他电脑同步历史及执行状态。
     * @param 无
     * @returns {Promise<void>} 完成本轮设备、身份和聊天同步
     * 注意事项：身份每 30 秒向服务器复核；旧账号请求失败不得清除当前新会话。
     */
    async function runRelayLoop() {
      if (!state.relayReady || !state.relaySession?.deviceToken || state.connectionBusy) return;
      if (relayLoopBusy) { relayLoopQueued = true; return; }
      relayLoopBusy = true;
      const token = state.relaySession.deviceToken;
      const base = state.relaySession.baseUrl, accountId = state.relaySession.accountId, scope = state.accountScope;
      try {
        await refreshRelayAccount();
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        await loadRelayDevices();
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        await pullRelayState();
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        if (isPrimaryDevice() && !state.sending && !relayDrainBusy) drainPrimaryDispatches().catch(() => {});
        if (isPrimaryDevice()) scheduleRelayPush();
      } catch (error) {
        if (state.relaySession?.deviceToken === token && state.relaySession.baseUrl === base
          && state.relaySession.accountId === accountId && state.accountScope === scope && error.status === 401) {
          clearRelaySession(); renderAccount(); syncAuthModal(); toast("登录已过期，请重新登录");
        }
      } finally {
        relayLoopBusy = false;
        if (relayLoopQueued) { relayLoopQueued = false; setTimeout(runRelayLoop, 0); }
      }
    }

    /**
     * WebSocket 负责实时通知，每 30 秒做一次补偿检查。
     * @returns {void}
     */
    function startRelayLoop() {
      if (!state.relayReady || !state.relaySession?.deviceToken) return;
      if (relayLoopTimer) clearInterval(relayLoopTimer);
      relayLoopTimer = setInterval(runRelayLoop, 30000);
      startHostConfigLoop();
      relayRealtime?.close();
      const token = state.relaySession.deviceToken;
      relayRealtime = ChorusRelayClient.realtime({ baseUrl: relayBaseUrl(), token,
        onEvent: (event) => {
          if (state.relaySession?.deviceToken !== token) return;
          if (event.type === "host-config.updated") runHostConfigLoop();
          if (["catchup", "hello", "state", "dispatches", "devices", "state.updated", "devices.updated", "dispatch.created", "dispatch.updated"].includes(event.type)) runRelayLoop();
        },
        onStatus: (status) => {
          if (state.relaySession?.deviceToken !== token) return;
          state.relayStatus = status;
          if (status === "unauthorized") clearRelaySession();
          if (state.settingsSection === "connection" && $("#settingsOverlay").classList.contains("open")) renderSettings();
        },
      });
      runRelayLoop();
    }

    /**
     * 非主设备在版本变新时拉回主设备写好的回复。
     * @returns {Promise<void>}
     */
    async function pullRelayStateIfNewer() { return pullRelayState();
    }

    /**
     * 主设备依次执行尚未完成的下发任务，并把回复写回中转站。
     * @returns {Promise<void>}
     */
    async function drainPrimaryDispatches() {
      if (relayDrainBusy) return;
      const token = state.relaySession?.deviceToken;
      relayDrainBusy = true;
      try {
        while (isPrimaryDevice() && !state.sending && state.relaySession?.deviceToken === token) {
          const payload = await relayRequest("POST", "/api/v1/dispatches/claim", token, {});
          if (state.relaySession?.deviceToken !== token || !isPrimaryDevice()) return;
          const job = payload.dispatch;
          if (!job?.id || relayJobsInFlight.has(job.id)) break;
          relayJobsInFlight.add(job.id);
          try { await executePrimaryDispatch(job); }
          finally { relayJobsInFlight.delete(job.id); }
        }
      } finally { relayDrainBusy = false; }
    }

    /** 确认租约前 15 秒停止执行；续租请求挂起时也不能越过安全期限。 */
    function watchDispatchLease({ expiresAt, current, renew, cancel, now = () => Date.now() }) {
      let lost = false;
      let closed = false;
      let renewing = false;
      let watchdog = null;
      let heartbeat = null;
      const parsed = Date.parse(expiresAt || "");
      let deadline = Math.min(now() + 90000, Number.isFinite(parsed) ? parsed : Infinity);
      const lose = (message) => {
        if (lost || closed) return;
        lost = true;
        clearTimeout(watchdog); clearInterval(heartbeat);
        Promise.resolve(cancel(message)).catch(() => {});
      };
      const armDeadline = () => {
        clearTimeout(watchdog);
        const remaining = deadline - 15000 - now();
        if (remaining <= 0) return lose("任务领取即将过期，已停止电脑执行。恢复连接后会重新领取。");
        watchdog = setTimeout(() => lose("无法确认任务续租，已在领取过期前停止电脑执行。"), remaining);
      };
      const beat = async () => {
        if (closed || lost || renewing) return;
        if (!current()) return lose("执行设备或账号已改变，已停止原任务。");
        if (now() >= deadline - 15000) return lose("任务领取即将过期，已停止电脑执行。");
        renewing = true;
        const startedAt = now();
        try {
          await renew();
          if (closed || lost) return;
          if (!current()) return lose("执行设备或账号已改变，已停止原任务。");
          // 以请求发出时刻计算，网络延迟不会延长本机认可的租约。
          deadline = startedAt + 90000;
          armDeadline();
        } catch (error) {
          if (closed || lost) return;
          const permanent = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
          if (permanent) lose("中转站已拒绝任务续租，已停止原任务，等待重新领取。");
          else if (now() >= deadline - 15000) lose("无法确认任务续租，已停止原任务。");
        } finally { renewing = false; }
      };
      armDeadline();
      if (!lost) heartbeat = setInterval(beat, 20000);
      return {
        valid: () => !lost && current() && now() < deadline - 15000,
        close() { closed = true; clearTimeout(watchdog); clearInterval(heartbeat); },
      };
    }

    /**
     * 在主设备上执行一条来自其他设备的消息。
     * @param {object} job 中转站任务
     * @returns {Promise<void>}
     */
    async function executePrimaryDispatch(job) {
      const token = state.relaySession?.deviceToken;
      const base = state.relaySession?.baseUrl;
      const resultPath = `/api/v1/dispatches/${encodeURIComponent(job.id)}/result`;
      const current = () => state.relaySession?.deviceToken === token && state.relaySession?.baseUrl === base && isPrimaryDevice();
      const submitResult = (body) => ChorusRelayClient.request(base, "POST", resultPath, token, body);
      let activeRunId = "";
      const lease = watchDispatchLease({ expiresAt: job.leaseExpiresAt, current,
        renew: () => submitResult({ claimToken: job.claimToken, status: "running" }),
        cancel: (message) => {
          if (state.activeRunId === activeRunId && state.sending) stopRun().catch(() => {});
          if (current()) toast(message);
        },
      });
      try {
        await pullRelayState();
        if (!lease.valid()) return;
        const owner = job.roomId ? getRoom(job.roomId) : getAgent(job.agentId || job.responders?.[0]?.agentId || job.payload?.[0]?.agentId);
        if (!owner) throw new Error("主电脑找不到这段聊天，请同步电脑配置后重试");
        owner.messages ||= [];
        const context = { team: Boolean(job.roomId), owner, thread: owner.messages, key: `${job.roomId ? "room" : "agent"}:${owner.id}` };
        const request = job.userMessage || (job.payload || []).find((item) => item.message)?.message;
        const requestId = request?.id || job.clientRequestId || job.id;
        if (request && !context.thread.some((message) => message.id === requestId)) context.thread.push({ ...request, id: requestId, from: "you", attachments: request.attachments || job.attachments || [] });
        const responders = (job.responders || job.payload || []).map((item) => getAgent(item.agentId)).filter(Boolean);
        if (!responders.length) throw new Error("主电脑找不到要执行的 Agent");
        const completed = context.thread.filter((message) => message.requestId === requestId && !message.streaming);
        const pending = context.team ? responders : responders.filter((agent) => !completed.some((message) => message.from === agent.id));
        await dispatchAgentReplies({ userText: String(job.userText || ""), responders: pending, mode: job.mode === "execute" ? "execute" : "discuss", context, requestId, canContinue: () => lease.valid(), onRunStart: (runId) => { activeRunId = runId; } });
        const replies = context.thread.filter((message) => message.requestId === requestId).map((message) => ({ agentId: message.from, message }));
        if (!lease.valid()) return;
        await flushRelayState(() => lease.valid());
        if (!lease.valid()) return;
        lease.close();
        const done = await submitResult({ claimToken: job.claimToken, status: "done", replies });
        if (state.relaySession?.deviceToken !== token) return;
        state.relaySession.revision = Math.max(Number(done.revision) || 0, state.relaySession.revision);
        saveRelaySession(); persistApp();
      } catch (error) {
        if (lease.valid()) await submitResult({ claimToken: job.claimToken, status: "failed", errorMessage: readableError(error).slice(0, 1000) }).catch(() => {});
      } finally { lease.close(); }
    }

    /**
     * 启动时确认服务器账号身份并恢复中转站同步会话。
     * @param 无
     * @returns {Promise<void>} 完成身份确认、历史拉取与实时连接启动
     * 注意事项：缓存角色不可信；身份请求晚到或会话改变时不启动旧账号连接。
     */
    async function bootRelaySync() {
      loadRelaySession();
      updateExecutionSettingsVisibility();
      if (!state.relaySession?.deviceToken || !state.user?.verified) {
        if (!window.chorusDesktop) { state.agents = []; state.rooms = []; state.running = null; state.relayConfigSynced = false; refreshRelayView(); }
        return;
      }
      if (state.accountScope !== `${relayBaseUrl()}:${state.relaySession.accountId}`) { clearRelaySession(); return; }
      const token = state.relaySession.deviceToken;
      const base = state.relaySession.baseUrl, accountId = state.relaySession.accountId, scope = state.accountScope;
      try {
        if (!await refreshRelayAccount(true)) return;
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        await pullRelayState();
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        state.relayReady = true;
        await loadRelayDevices();
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        refreshRelayView(); startRelayLoop(); scheduleRelayPush(0);
      } catch (error) {
        if (state.relaySession?.deviceToken !== token || state.relaySession.baseUrl !== base
          || state.relaySession.accountId !== accountId || state.accountScope !== scope || relayBaseUrl() !== base) return;
        if (error.status === 401) { clearRelaySession(); renderAccount(); syncAuthModal(); }
        else {
          state.relayReady = true; startRelayLoop();
          toast("中转站暂时无法连接，网络恢复后会重新同步");
        }
      }
    }

    loadPersisted();
    loadRelaySession();
    applyTheme(state.settings.theme);
    renderAccount();
    const modeButton = $("#btnComposerMode");
    if (modeButton) modeButton.hidden = true;
    updateClock();
    setInterval(updateClock, 30_000);
    renderAll();
    restoreDraft();
    bootDesktopBridge();
