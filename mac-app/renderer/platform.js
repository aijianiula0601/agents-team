/* 原生能力与响应式抽屉统一适配，导航只切换对话，不自动打开详情。 */
(function definePlatform(root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory;
  else root.ChorusPlatform = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function createPlatform(runtime) {
  const query = new URLSearchParams(runtime.location?.search || "").get("platform");
  const native = runtime.Capacitor?.getPlatform?.();
  const platform = ["mac", "android", "web"].includes(query) ? query : native === "android" ? "android" : runtime.chorusDesktop ? "mac" : "web";
  let activeLogin = null;

  function legacyCopy(value) {
    const document = runtime.document;
    if (!document?.body || typeof document.execCommand !== "function") return false;
    const active = document.activeElement;
    const selection = runtime.getSelection?.();
    const ranges = [];
    for (let i = 0; selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    const input = document.createElement("textarea");
    input.value = value;
    input.readOnly = true;
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    input.setAttribute("aria-hidden", "true");
    document.body.appendChild(input);
    try {
      input.select();
      input.setSelectionRange(0, value.length);
      return document.execCommand("copy") === true;
    } catch (_error) {
      return false;
    } finally {
      input.remove();
      active?.focus?.({ preventScroll: true });
      if (selection && ranges.length) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }

  /** 优先使用原生剪贴板；网页回退必须确认复制成功，避免错误提示或假成功。 */
  async function copyText(text) {
    if (typeof text !== "string" || text.length > 8 * 1024 * 1024) return false;
    try {
      if (runtime.chorusDesktop?.copyText && await runtime.chorusDesktop.copyText(text)) return true;
    } catch (_error) { /* 原生能力不可用时继续尝试网页回退。 */ }
    try {
      const clipboard = runtime.Capacitor?.Plugins?.ChorusClipboard;
      if (clipboard?.writeText && (await clipboard.writeText({ text }))?.copied === true) return true;
    } catch (_error) { /* 旧安装包没有插件时仍可尝试网页复制。 */ }
    try {
      if (runtime.navigator?.clipboard?.writeText) {
        await runtime.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_error) { /* Electron file:// 与旧 WebView 可能拒绝网页剪贴板权限。 */ }
    return legacyCopy(text);
  }

  /** 使用服务端 OAuth 配置和回调，不要求手机或桌面用户填写 Google 客户端 ID。 */
  function googleLogin(relayUrl, options = {}) {
    if (activeLogin) return Promise.reject(new Error("Google 登录正在进行，请在浏览器完成"));
    const auth = runtime.ChorusRelayAuth;
    if (!auth?.googleLogin) return Promise.reject(new Error("Google 登录组件未加载"));
    let browserWindow;
    // 网页需要在点击时同步创建窗口，防止异步请求后浏览器拦截授权弹窗。
    if (!runtime.chorusDesktop && native !== "android") browserWindow = runtime.open?.("about:blank", "_blank");
    const openBrowser = async (url) => {
      if (runtime.chorusDesktop?.openGoogleAuthorization) {
        await runtime.chorusDesktop.openGoogleAuthorization(url);
      } else if (native === "android") {
        const browser = runtime.Capacitor?.Plugins?.Browser;
        if (!browser?.open) throw new Error("系统浏览器不可用，请更新安装包");
        await browser.open({ url });
      } else {
        if (!browserWindow || browserWindow.closed) throw new Error("浏览器阻止了登录窗口，请允许弹窗后重试");
        browserWindow.opener = null;
        browserWindow.location.replace(url);
      }
    };
    activeLogin = auth.googleLogin({
      ...options, relayUrl, openBrowser, nativeHttp: native === "android" ? runtime.Capacitor?.Plugins?.CapacitorHttp : undefined,
      fetchImpl: runtime.fetch?.bind(runtime),
    }).finally(() => {
      activeLogin = null;
      try { browserWindow?.close(); } catch (_error) { /* 用户可能已经关闭授权窗口。 */ }
    });
    return activeLogin;
  }

  return { platform, copyText, googleLogin };
});

(function initChorusPlatform() {
  if (typeof document === "undefined") return;
  const query = new URLSearchParams(location.search).get("platform");
  const native = window.Capacitor?.getPlatform?.();
  const platform = ["mac", "android", "web"].includes(query) ? query : native === "android" ? "android" : window.chorusDesktop ? "mac" : "web";
  document.documentElement.dataset.platform = platform;
  const root = document.documentElement;
  const body = document.getElementById("appBody");
  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  body.appendChild(backdrop);
  const closeNavigation = () => { root.classList.remove("drawer-open"); setPanelCollapsed(true); };
  backdrop.addEventListener("click", closeNavigation);
  document.getElementById("btnMobileMenu").addEventListener("click", () => {
    setPanelCollapsed(true); root.classList.add("drawer-open");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNavigation();
  });
  const small = matchMedia("(max-width: 900px)");
  small.addEventListener("change", () => { closeNavigation(); });
  if (small.matches) setPanelCollapsed(true);

  window.chorusDesktop?.onOpenSettings?.(() => document.getElementById("btnOpenSettings").click());
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link || platform !== "android") return;
    if (!/^https?:/i.test(link.href)) { event.preventDefault(); return; }
    if (window.Capacitor?.Plugins?.Browser) {
      event.preventDefault();
      window.Capacitor.Plugins.Browser.open({ url: link.href }).catch(() => toast("无法打开外部链接"));
    }
  });
  if (platform === "android") {
    window.Capacitor?.Plugins?.App?.addListener("backButton", () => {
      const overlay = document.querySelector(".overlay.open");
      if (overlay) { closeOverlay(overlay.id); return; }
      if (root.classList.contains("drawer-open") || root.classList.contains("panel-sheet-open")) { closeNavigation(); return; }
      if (document.getElementById("mentionPop").classList.contains("open")) { hideMention(); return; }
      window.Capacitor.Plugins.App.minimizeApp();
    });
  }
})();
