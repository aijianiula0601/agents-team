/* 完整 PTY 终端：xterm 原样渲染 CLI，独立会话传递输入、审批与尺寸。 */
(function (root) {
  let term, fit, config, view, generation = 0, resizeFrame, initialized = false, resetCompletion = null, openEpoch = 0;
  const knownViews = new Set();
  const retiringViews = new Set();
  const retiredSessionIds = new Set();
  const $ = (selector) => root.document.querySelector(selector);
  const visible = () => $("#terminalOverlay").classList.contains("open");
  const current = (target) => view === target && target.generation === generation;
  const keyOf = (agent, options) => JSON.stringify([options.connectionKey || "", options.threadKey || "", agent.id, agent.workspace, agent.harnessModel, agent.backend !== "model" ? agent.backend : agent.harness]);
  const missingSession = (error) => /HTTP 404|终端会话不存在|terminal.*not found/i.test(error.message || "");
  const expiredConnection = (error) => missingSession(error) || /HTTP (401|403)|已关闭|已失效/.test(error.message || "");

  function status(target, text) {
    if (current(target)) $("#terminalStatus").textContent = text;
  }

  function controls() {
    const ready = view?.session?.status === "running" && view.connected && !view.closing;
    $("#terminalCloseSession").disabled = !view?.session || Boolean(view.closing);
    $("#terminalSendLine").disabled = !ready || Boolean(view.lineSending);
    $("#terminalLine").disabled = !ready || Boolean(view.lineSending);
    for (const button of $("#terminalKeys").querySelectorAll("button")) button.disabled = !ready;
    if (term) term.options.disableStdin = !ready;
  }

  /**
   * 释放一个视图持有的轮询与后台订阅。
   * @param {object|null} target 当前或已经离开的终端视图
   * @returns {void}
   * 注意事项：订阅释放失败不阻止账号清理，不记录终端内容或异常原文。
   */
  function releaseView(target) {
    if (!target) return;
    root.clearInterval(target.poll);
    target.poll = null;
    try { target.unsubscribe?.(); }
    catch (_) { root.console?.warn("[chorus] 终端订阅释放失败，旧视图已失效"); }
    target.unsubscribe = null;
  }

  /**
   * 合并终端尺寸更新请求，并忽略账号重置前排队的旧帧。
   * @param 无
   * @returns {void}
   * 注意事项：旧帧不能在新账号打开后调整新会话尺寸。
   */
  function scheduleResize() {
    if (resizeFrame) return;
    const epoch = generation;
    const requestFrame = root.requestAnimationFrame || ((callback) => root.setTimeout(callback, 16));
    let frame;
    frame = requestFrame(() => { if (resizeFrame === frame) resizeFrame = null; if (generation === epoch) resize(view); });
    resizeFrame = frame;
  }

  /**
   * 尽力关闭退出账号后已经失效的原生会话。
   * @param {object} target 捕获旧 adapter 的视图
   * @param {object} session 旧后台返回的会话描述
   * @returns {Promise<void>} 关闭尝试已完成，失败只记脱敏日志
   * 注意事项：保留正在结束的旧请求标记，禁止关闭新视图已经使用的会话编号。
   */
  function closeRetiredSession(target, session) {
    if (!session?.sessionId || !target.adapter) return Promise.resolve();
    const adapter = target.adapter;
    const sessionId = session.sessionId;
    retiredSessionIds.add(session.sessionId);
    target.retiringSessionId = session.sessionId;
    target.closePending = true;
    retiringViews.add(target);
    target.closeTask = Promise.resolve().then(() => {
      if (view?.session?.sessionId === sessionId && current(view)) return;
      return adapter.close(sessionId);
    }).catch(() => { root.console?.warn("[chorus] 旧账号终端关闭失败，界面与输入已清理"); }).finally(() => {
      target.closePending = false;
      if (!target.pendingOpen) { retiringViews.delete(target); target.session = null; target.adapter = null; }
    });
    return target.closeTask;
  }

  /**
   * 退出或切换账号时同步清空终端状态，再等待旧会话尽力关闭。
   * @param 无
   * @returns {Promise<void>} 最长等待三秒；晚到的旧请求仍保持失效并自行关闭
   * 注意事项：首次 await 前使所有旧视图失效，销毁 xterm 以隔离尚未解析的旧帧；不会清理新账号视图。
   */
  async function reset() {
    // ------------ 先使旧账号视图与排队输入失效，再异步关闭后台 ---------------
    generation += 1; openEpoch += 1;
    const previous = [...knownViews];
    const closingIds = new Set([...retiringViews].filter((target) => target.closePending).map((target) => target.retiringSessionId));
    knownViews.clear();
    view = null; config = null;
    if (resizeFrame) {
      if (root.cancelAnimationFrame) root.cancelAnimationFrame(resizeFrame);
      else root.clearTimeout?.(resizeFrame);
      resizeFrame = null;
    }
    for (const target of previous) {
      target.retired = true; target.closing = true; target.connected = false; target.writeEpoch += 1;
      target.agent = null; target.options = null;
      releaseView(target);
      target.flushResolve?.(); target.flushResolve = null;
      if (target.pendingOpen) retiringViews.add(target);
      if (target.session && !closingIds.has(target.session.sessionId)) {
        closingIds.add(target.session.sessionId);
        closeRetiredSession(target, target.session);
      } else if (!target.pendingOpen && !target.closePending) { target.session = null; target.adapter = null; }
    }
    const previousTerm = term;
    term = null; fit = null;
    try { previousTerm?.dispose(); }
    catch (_) { root.console?.warn("[chorus] 旧终端释放失败，已移除界面"); }
    $("#terminalCanvas").replaceChildren();
    $("#terminalAgent").replaceChildren(); $("#terminalAgent").value = "";
    $("#terminalLine").value = ""; $("#terminalStatus").textContent = "";
    controls();
    root.console?.info("[chorus] 终端账号状态已重置，旧订阅、视图和输入已清理");
    let timeout;
    const waiting = Promise.race([
      Promise.all([...retiringViews].map((target) => target.closeTask).filter(Boolean)),
      new Promise((resolve) => { timeout = root.setTimeout(resolve, 3000); }),
    ]);
    resetCompletion = waiting;
    try { await waiting; }
    finally { root.clearTimeout?.(timeout); if (resetCompletion === waiting) resetCompletion = null; }
  }

  function fitVisible() {
    if (!term || !visible()) return;
    const rect = $("#terminalCanvas").getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) fit.fit();
  }

  async function resize(target, force = false) {
    if (!target?.session || !current(target) || !visible() || target.session.status !== "running") return;
    fitVisible();
    const size = { cols: Math.min(500, Math.max(2, term.cols)), rows: Math.min(300, Math.max(2, term.rows)) };
    const sizeKey = `${size.cols}:${size.rows}`;
    if (!force && target.sizeKey === sizeKey) return;
    target.sizeKey = sizeKey;
    try { await target.adapter.resize(target.session.sessionId, size); }
    catch (error) { if (current(target)) { target.sizeKey = ""; status(target, error.message); } }
  }

  function append(target, snapshot) {
    if (!current(target) || !Number.isSafeInteger(snapshot.nextOffset)) return;
    const start = Number.isSafeInteger(snapshot.startOffset) ? snapshot.startOffset : 0;
    if (snapshot.nextOffset < target.offset) return;
    if (snapshot.reset && start > target.offset) {
      term.reset();
      target.offset = start;
    }
    if (start > target.offset) return;
    const output = String(snapshot.output || "").slice(Math.max(0, target.offset - start));
    if (output) term.write(output);
    target.offset = snapshot.nextOffset;
    if (target.session.status === "running") target.session.status = snapshot.status || "running";
    if (snapshot.exitCode !== undefined && (snapshot.status !== "running" || target.session.status === "running")) target.session.exitCode = snapshot.exitCode;
    const recovered = !target.connected;
    target.connected = true;
    target.failures = 0;
    target.nextReadAt = 0;
    status(target, target.session.status === "running"
      ? "原生 CLI 正在运行 · 输入和审批会直接送到终端"
      : `终端已结束${target.session.exitCode != null ? ` · 退出码 ${target.session.exitCode}` : ""}`);
    controls();
    if (recovered) resize(target, true);
    if (target.session.status !== "running") root.clearInterval(target.poll);
  }

  async function read(target = view) {
    if (!target?.session || !current(target) || target.reading || target.closing || Date.now() < target.nextReadAt) return;
    if (!visible() && Date.now() - target.lastReadAt < 3000) return;
    target.reading = true;
    target.lastReadAt = Date.now();
    const id = target.session.sessionId, after = target.offset;
    try {
      const snapshot = await target.adapter.read(id, { after });
      if (current(target) && target.session?.sessionId === id && !target.closing) append(target, snapshot);
    } catch (error) {
      if (!current(target) || target.closing) return;
      target.connected = false;
      target.writeEpoch += 1;
      if (target.session.status !== "running") {
        status(target, `终端已结束 · 退出码 ${target.session.exitCode ?? "—"}`);
        return;
      }
      if (expiredConnection(error)) {
        target.session.status = "disconnected";
        root.clearInterval(target.poll);
        status(target, `终端连接已失效，请重新打开面板：${error.message}`);
        controls(); return;
      }
      target.failures += 1;
      target.nextReadAt = Date.now() + Math.min(10000, 500 * 2 ** Math.min(target.failures, 5));
      status(target, `连接暂时中断，正在重连：${error.message}`);
      controls();
    } finally { target.reading = false; }
  }

  /**
   * 按 Unicode 边界顺序发送终端输入。
   * @param {string} data 原生键盘或粘贴数据
   * @returns {Promise<void>|undefined} 当前输入队列，未连接时不发送
   * 注意事项：账号重置后取消未发出的块，不记录输入内容，也不自动重放失败输入。
   */
  function write(data) {
    const target = view;
    if (!target?.session || target.session.status !== "running" || !target.connected || target.closing || typeof data !== "string" || !data) return;
    if (data === "\x03") target.writeEpoch += 1;
    // 大段粘贴分块发送，保留输入顺序且不拆开 Unicode 代理对；后端限制单块 64 KB。
    const epoch = target.writeEpoch;
    for (let start = 0; start < data.length;) {
      let end = Math.min(data.length, start + 16000);
      if (end < data.length && /^[\uDC00-\uDFFF]$/.test(data[end])) end -= 1;
      const chunk = data.slice(start, end);
      start = end;
      target.writes = target.writes.catch(() => {}).then(async () => {
        if (target.retired || target.closing || !target.session || target.writeEpoch !== epoch || !target.connected) return;
        try { await target.adapter.write(target.session.sessionId, chunk); }
        catch (error) {
          target.writeEpoch += 1; target.connected = false;
          if (current(target)) controls();
          status(target, `输入发送失败，请检查终端后再输入：${error.message}`);
        }
      });
    }
    return target.writes;
  }

  async function sendLine() {
    const target = view, input = $("#terminalLine");
    if (!target?.session || !input.value || input.disabled) return;
    const text = input.value, epoch = target.writeEpoch;
    input.value = ""; target.lineSending = true; controls();
    let sent = false;
    try {
      term.paste(text);
      await target.writes;
      if (!current(target) || target.closing || !target.connected || target.writeEpoch !== epoch) return;
      // Codex 等 TUI 会把同一批次的文本和回车识别成粘贴；提交回车单独发送。
      await new Promise((resolve) => root.setTimeout(resolve, 150));
      if (!current(target) || target.closing || !target.connected || target.writeEpoch !== epoch) return;
      await write("\r");
      sent = target.connected && target.writeEpoch === epoch;
    } finally {
      target.lineSending = false;
      if (current(target)) {
        if (!sent && !input.value) input.value = text;
        controls();
      }
    }
  }

  /**
   * 切换终端成员，保持同账号内的原生会话可复用。
   * @param {object} agent 要打开的成员
   * @param {object} [options] 当前聊天、连接和 adapter 配置
   * @returns {Promise<void>} 已打开终端或已展示连接错误
   * 注意事项：账号重置后的旧 open 必须关闭捕获的旧会话；旧请求未结束时不打开相同会话键。
   */
  async function select(agent, options = config) {
    if (!agent) return;
    releaseView(view);
    const target = {
      generation: ++generation, key: keyOf(agent, options), agent, options, session: null,
      adapter: null, offset: 0, connected: false, closing: false, reading: false, retired: false, pendingOpen: false, closePending: false,
      writes: Promise.resolve(), writeEpoch: 0, lineSending: false, failures: 0, nextReadAt: 0, lastReadAt: 0,
    };
    knownViews.add(target);
    view = target;
    $("#terminalLine").value = "";
    status(target, "正在启动完整终端…");
    controls();
    try {
      // reset 不会清空 xterm 尚未解析的写队列；先等旧帧解析完，避免串到新终端。
      await new Promise((resolve) => {
        target.flushResolve = resolve;
        term.write("", () => { target.flushResolve = null; resolve(); });
      });
      if (!current(target)) return;
      term.reset();
      if ([...retiringViews].some((previous) => previous.key === target.key && (previous.pendingOpen || previous.closePending))) throw new Error("旧账号终端尚在关闭，请稍后重新打开");
      target.adapter = options.adapter(agent);
      fitVisible();
      target.pendingOpen = true;
      const result = await target.adapter.open({
        harness: agent.backend !== "model" ? agent.backend : agent.harness,
        cwd: agent.workspace, workspaceMode: agent.workspaceMode, agentName: agent.name, harnessModel: agent.harnessModel || "", agentId: agent.id, threadKey: options.threadKey,
        cols: Math.min(500, Math.max(2, term.cols)), rows: Math.min(300, Math.max(2, term.rows)),
      });
      target.pendingOpen = false;
      if (target.retired) {
        await closeRetiredSession(target, result);
        return;
      }
      if (!current(target)) {
        // 复用会话继续在本账号运行，但保留最小编号信息供退出时关闭，不缓存输出正文。
        target.session = { sessionId: result.sessionId, status: result.status, exitCode: result.exitCode };
        // 只清理已放弃的全新终端；用户之前正在运行的复用会话继续保留。
        if (result.reused === false && view?.key !== target.key) await target.adapter.close(result.sessionId).catch(() => {});
        return;
      }
      if (retiredSessionIds.has(result.sessionId)) {
        await closeRetiredSession(target, result);
        throw new Error("前一账号的终端尚未关闭，请恢复连接后重新打开");
      }
      target.session = { sessionId: result.sessionId, status: result.status, exitCode: result.exitCode };
      append(target, result);
      if (target.adapter.subscribe) target.unsubscribe = target.adapter.subscribe((event) => {
        if (!current(target) || target.closing || event.sessionId !== target.session?.sessionId) return;
        if (event.type === "data" && event.nextOffset > target.offset) {
          if (event.startOffset > target.offset) { read(target); return; }
          append(target, { output: event.data, startOffset: event.startOffset, nextOffset: event.nextOffset, status: "running" });
        } else if (event.type === "exit") {
          target.session.status = event.status || "exited";
          target.session.exitCode = event.exitCode;
          root.clearInterval(target.poll);
          status(target, event.status === "closed" ? "终端已关闭；下次打开会重新启动" : `终端已结束 · 退出码 ${event.exitCode ?? "—"}`);
          controls();
          if (event.status !== "closed") read(target);
        }
      });
      target.poll = root.setInterval(() => read(target), target.adapter.subscribe ? 3000 : 350);
      await resize(target);
      await read(target);
      if (current(target) && visible()) term.focus();
    } catch (error) { status(target, error.message); if (current(target)) controls(); }
    finally {
      target.pendingOpen = false;
      if (target.retired && !target.closePending) { retiringViews.delete(target); target.session = null; target.adapter = null; }
    }
  }

  async function closeCurrent() {
    const target = view;
    if (!target?.session || target.closing) return;
    const id = target.session.sessionId;
    target.closing = true;
    target.writeEpoch += 1;
    controls();
    try {
      await target.adapter.close(id);
      releaseView(target);
      target.session = null;
      if (current(target)) { status(target, "终端已关闭；下次打开会重新启动"); controls(); }
    } catch (error) {
      if (missingSession(error)) {
        releaseView(target); target.session = null;
        if (current(target)) { status(target, "终端已经结束；下次打开会重新启动"); controls(); }
        return;
      }
      target.closing = false;
      if (current(target)) { status(target, error.message); controls(); }
    }
  }

  /**
   * 创建当前生命周期的 xterm，并且只绑定一次静态界面事件。
   * @param 无
   * @returns {void}
   * 注意事项：旧 xterm 的晚到输入不能发给新视图；重置后创建全新终端解析器。
   */
  function initialize() {
    if (!term) {
      term = new root.Terminal({ fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace', fontSize: 13,
        cursorBlink: true, scrollback: 5000, screenReaderMode: true,
        theme: { background: "#17191d", foreground: "#e7e9ee", cursor: "#efbb72" }, allowProposedApi: false });
      fit = new root.FitAddon.FitAddon();
      const instance = term;
      term.loadAddon(fit); term.open($("#terminalCanvas"));
      term.onData((data) => { if (term === instance) write(data); });
    }
    if (initialized) return;
    initialized = true;
    // CLI 的 Ctrl+N、Tab、Esc 等按键只交给终端，不触发应用的全局快捷键。
    $("#terminalCanvas").addEventListener("keydown", (event) => event.stopPropagation());
    $("#terminalAgent").addEventListener("change", (event) => select(config?.agents.find((item) => item.id === event.target.value)));
    $("#terminalKeys").addEventListener("click", (event) => {
      const key = event.target.closest("[data-terminal-key]")?.dataset.terminalKey;
      const data = { enter: "\r", tab: "\t", esc: "\x1b", ctrlc: "\x03", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C" }[key];
      if (!data) return;
      write(data); if (visible()) term.focus();
    });
    $("#terminalSendLine").addEventListener("click", sendLine);
    $("#terminalLine").addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); $("#terminalSendLine").click();
      }
    });
    $("#terminalCloseSession").addEventListener("click", closeCurrent);
    root.addEventListener("resize", scheduleResize);
    root.visualViewport?.addEventListener("resize", scheduleResize);
    new root.ResizeObserver(scheduleResize).observe($("#terminalCanvas"));
  }

  root.ChorusTerminalUI = {
    reset,
    /**
     * 打开当前账号终端面板，等待账号清理的有限关闭阶段。
     * @param {object} options 成员、聊天和可信 adapter 配置
     * @returns {Promise<void>} 已选择成员并完成当前视图初始化
     * 注意事项：重置期间发出的旧 open 会失效，不复用上一账号的终端输出或会话编号。
     */
    async open(options) {
      const epoch = ++openEpoch;
      if (resetCompletion) await resetCompletion;
      if (epoch !== openEpoch) return;
      initialize();
      const previousId = view && view.options.threadKey === options.threadKey ? view.agent.id : "";
      config = { ...options, agents: [...options.agents] };
      const selected = config.agents.find((item) => item.id === options.selectedAgentId)
        || config.agents.find((item) => item.id === previousId) || config.agents[0];
      $("#terminalAgent").replaceChildren(...config.agents.map((item) => {
        const option = root.document.createElement("option"); option.value = item.id;
        option.textContent = `${item.name} · ${item.backend !== "model" ? item.backend : item.harness}`;
        return option;
      }));
      if (!selected) {
        releaseView(view); generation += 1; view = null;
        $("#terminalStatus").textContent = "请先配置一个编程内核并绑定工作区";
        controls(); return;
      }
      $("#terminalAgent").value = selected.id;
      await select(selected, config);
    },
  };
})(globalThis);
