/* Google 授权由中转站完成；客户端只打开系统浏览器，并在 HTTPS 请求体内轮询领取会话。 */
(function defineRelayAuth(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChorusRelayAuth = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function relayAuthFactory() {
  function normalizeRelayUrl(value) {
    let url;
    try { url = new URL(String(value || "").trim()); } catch (_error) { throw new Error("中转站地址无效"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("中转站必须使用 HTTPS");
    if (url.username || url.password || url.search || url.hash) throw new Error("中转站地址不能包含凭据、查询参数或片段");
    return url.toString().replace(/\/+$/, "");
  }

  function validateGoogleAuthorizationUrl(value) {
    if (typeof value !== "string" || value.length > 16384) throw new Error("Google 授权地址无效");
    let url;
    try { url = new URL(value); } catch (_error) { throw new Error("Google 授权地址无效"); }
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.port
        || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash
        || url.searchParams.get("response_type") !== "code" || !url.searchParams.get("state")
        || !url.searchParams.get("client_id") || !url.searchParams.get("redirect_uri")) {
      throw new Error("Google 授权地址无效");
    }
    for (const key of url.searchParams.keys()) {
      if (/token|secret|password/i.test(key)) throw new Error("Google 授权地址包含不允许的凭据");
    }
    return url.toString();
  }

  function abortError() { return new Error("Google 登录已取消"); }

  function withAbort(promise, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError());
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
  }

  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const abort = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function post(baseUrl, endpoint, body, options) {
    if (options.signal.aborted) throw abortError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      let status;
      let data;
      if (options.nativeHttp?.request) {
        const response = await withAbort(options.nativeHttp.request({
          url: baseUrl + endpoint, method: "POST", headers, data: body,
          disableRedirects: true, responseType: "text", connectTimeout: 15000, readTimeout: 15000,
        }), controller.signal);
        status = response.status;
        data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
      } else {
        const response = await withAbort(options.fetchImpl(baseUrl + endpoint, {
          method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
          credentials: "omit", cache: "no-store", redirect: "error",
        }), controller.signal);
        status = response.status;
        data = await withAbort(response.json(), controller.signal);
      }
      if (status < 200 || status >= 300) {
        const raw = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : "");
        const message = String(raw || `Google 登录失败（HTTP ${status}）`).slice(0, 500);
        const error = new Error(body.pollToken ? message.split(body.pollToken).join("[已隐藏]") : message);
        error.status = status;
        throw error;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("中转站返回的登录数据无效");
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw options.signal.aborted ? abortError() : new Error("Google 登录服务请求超时，请重试");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    }
  }

  /** 返回中转站验证后的设备会话，不接受仅凭邮箱或客户端提供的个人资料登录。 */
  async function googleLogin(options) {
    const baseUrl = normalizeRelayUrl(options.relayUrl);
    if (typeof options.openBrowser !== "function") throw new Error("系统浏览器不可用");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) throw abortError();
    options.signal?.addEventListener("abort", abort, { once: true });
    const requestedTimeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 300000;
    let timedOut = false;
    let timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(requestedTimeout, 600000)));
    const requestOptions = { ...options, signal: controller.signal, fetchImpl: options.fetchImpl || globalThis.fetch };
    try {
      const started = await post(baseUrl, "/api/v1/auth/google/start", { device: options.device }, requestOptions);
      if (typeof started.authId !== "string" || !started.authId || typeof started.pollToken !== "string" || !started.pollToken) {
        throw new Error("中转站返回的登录请求无效");
      }
      const url = validateGoogleAuthorizationUrl(started.authorizationUrl);
      // pollToken 只发给中转站，永远不交给外部浏览器。
      await withAbort(options.openBrowser(url), controller.signal);
      const expiresIn = Number(started.expiresIn);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Infinity;
      const interval = Number.isFinite(options.pollIntervalMs) ? Math.max(0, options.pollIntervalMs) : 1500;
      while (!controller.signal.aborted) {
        if (Date.now() >= expiresAt) throw new Error("Google 登录已过期，请重试");
        const result = await post(baseUrl, "/api/v1/auth/google/poll", {
          authId: started.authId, pollToken: started.pollToken,
        }, requestOptions);
        if (result.status === "done") {
          const session = result.session;
          if (typeof session?.deviceToken !== "string" || !session.deviceToken || !session.account?.id
              || !session.account?.email || session.account?.provider !== "google") {
            throw new Error("中转站返回的登录会话无效");
          }
          return session;
        }
        if (result.status === "failed") throw new Error("Google 登录未完成，请重试");
        if (result.status !== "pending") throw new Error("中转站返回的登录状态无效");
        await wait(interval, controller.signal);
      }
      throw abortError();
    } catch (error) {
      if (timedOut) throw new Error("Google 登录超时，请在浏览器完成后重试");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  return { googleLogin, normalizeRelayUrl, validateGoogleAuthorizationUrl };
});
