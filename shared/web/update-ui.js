/**
 * 绑定原生更新与侧栏、设置页。
 * 参数：从浏览器全局读取桥接和中转站配置；返回值：无。
 * 注意事项：仅原生安装包显示下载入口；自动检查失败不打断聊天。
 */
(function initUpdateUI() {
  "use strict";
  const desktop = window.chorusDesktop;
  const android = window.Capacitor?.getPlatform?.() === "android" && window.Capacitor?.Plugins?.ChorusUpdates;
  const adapter = desktop?.getUpdateInfo ? {
    getUpdateInfo: () => desktop.getUpdateInfo(),
    downloadUpdate: (options) => desktop.downloadUpdate(options),
    subscribe: (listener) => desktop.onUpdateProgress(listener),
  } : android ? {
    getUpdateInfo: () => android.getUpdateInfo(),
    downloadUpdate: (options) => android.downloadUpdate(options),
    subscribe: async (listener) => { const handle = await android.addListener("updateProgress", listener); return () => handle.remove(); },
  } : null;
  const button = document.getElementById("btnAppUpdate");
  const mobile = document.getElementById("btnMobileUpdate");
  const controller = window.ChorusUpdates.createController({
    adapter, request: window.ChorusRelayClient.request, getBaseUrl: () => relayBaseUrl(), onChange: render,
    log: (message) => console.info(`[chorus-updates] ${message}`),
  });

  /** 获取状态的按钮文案；参数 view 为当前状态；返回中文文案；注意下载进度只读。 */
  function actionLabel(view) {
    if (view.status === "checking") return "正在检查…";
    if (view.status === "downloading") return `正在下载 ${Math.round(view.percent)}%`;
    if (view.status === "verifying") return "正在校验安装包…";
    if (view.permissionRequired) return "等待系统安装授权";
    if (["ready", "installing"].includes(view.status)) return "重新打开安装";
    if (view.status === "error" && view.release) return "重试下载更新";
    return view.release ? `下载更新 ${view.release.version}` : "检查更新";
  }

  /**
   * 将状态同步到两个入口和设置页。
   * @param {object} view 更新状态
   * @returns {void}
   * 注意事项：所有服务端文本均通过 textContent 写入，避免更新说明注入脚本。
   */
  function render(view = controller.snapshot()) {
    const busy = ["checking", "downloading", "verifying"].includes(view.status) || view.permissionRequired;
    for (const node of [button, mobile]) {
      if (!node) continue;
      node.hidden = !view.release;
      node.disabled = busy;
      node.title = actionLabel(view);
      node.setAttribute("aria-label", actionLabel(view));
      const label = node.querySelector("[data-update-label]");
      if (label) label.textContent = actionLabel(view);
    }
    const container = document.getElementById("appUpdateSettings");
    if (!container) return;
    container.querySelector("[data-update-version]").textContent = view.info ? `${view.info.version}${view.info.platform === "android" ? ` · 构建 ${view.info.buildNumber}` : ""}` : state.appInfo?.version || "—";
    const stageMessage = { downloading: "正在下载更新，请保持网络连接", verifying: "下载完成，正在校验安装包", ready: "安装包已就绪", installing: "已打开系统安装界面，请按提示完成安装" }[view.status];
    container.querySelector("[data-update-status]").textContent = view.message || stageMessage || (adapter ? "启动及每隔 15 分钟自动检查，也可以手动检查" : "请使用支持在线更新的 Mac 或 Android 安装包");
    const notes = container.querySelector("[data-update-notes]");
    notes.hidden = !view.release;
    notes.textContent = view.release ? `${view.release.version} · ${(view.release.size / 1024 / 1024).toFixed(1)} MB\n${view.release.notes || "此版本未填写更新说明"}` : "";
    const download = container.querySelector("[data-update-download]");
    download.hidden = !view.release;
    download.textContent = actionLabel(view);
    download.disabled = busy;
    container.querySelector("[data-update-check]").disabled = !adapter || busy;
  }

  /**
   * 在设置页填充更新操作区。
   * @param {HTMLElement} box 设置内容容器
   * @returns {void}
   * 注意事项：重建页面时只绑定本次按钮，不重复订阅原生事件。
   */
  function renderSettings(box) {
    const container = box.querySelector("#appUpdateSettings");
    if (!container) return;
    container.innerHTML = '<h4>应用更新</h4><div class="settings-row"><div class="label"><strong>当前版本</strong><span data-update-version></span></div><button type="button" class="ghost-btn" data-update-check>检查更新</button></div><p class="update-status" role="status" data-update-status></p><pre class="update-notes" data-update-notes hidden></pre><button type="button" class="primary-btn" data-update-download hidden>下载更新</button><p class="update-help">Mac 下载后打开 DMG，拖入「应用程序」完成更新；Android 下载后按系统提示覆盖安装。现有账号与聊天记录会保留。</p>';
    container.querySelector("[data-update-check]").addEventListener("click", () => controller.check(true));
    container.querySelector("[data-update-download]").addEventListener("click", () => controller.download());
    render();
  }

  // ------------ 左下角入口与前后台检查 ---------------
  button?.addEventListener("click", () => { openSettings("updates"); controller.download(); });
  mobile?.addEventListener("click", () => { openSettings("updates"); controller.download(); });
  window.addEventListener("online", () => controller.check());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) controller.check(); });
  window.addEventListener("chorus-relay-changed", () => { controller.invalidate(); controller.check(true); });
  const timer = window.setInterval(() => { if (!document.hidden) controller.check(); }, 15 * 60_000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
  window.ChorusUpdateUI = { renderSettings, isBusy: controller.isBusy };
  controller.check();
})();
