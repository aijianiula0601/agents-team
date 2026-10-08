/* 手机通过带令牌的本机网关调用 Mac 后台，凭据不放进 URL。 */
(function (root) {
  function connection(value) {
    const baseUrl = root.ChorusConversation.endpoint(value?.baseUrl || "");
    const url = new URL(baseUrl);
    if (url.protocol === "http:" && !localHost(url.hostname)) throw new Error("Mac 连接请使用局域网地址；公网连接必须使用 HTTPS");
    const token = String(value?.token || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("请填写 Mac 显示的完整 64 位连接令牌");
    return { baseUrl, token };
  }

  function localHost(value) {
    const host = value.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
    if (host.includes(":")) return /^f[cd][a-f0-9]{2}:/.test(host) || /^fe[89ab][a-f0-9]:/.test(host);
    const parts = host.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
    const [first, second] = parts.map(Number);
    return first === 127 || first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254);
  }

  /**
   * 调用 Mac 网关并按需轮询累计正文。
   * @param {object} config 已授权连接配置
   * @param {string} method GET 或 POST
   * @param {string} path 相对接口路径
   * @param {object} body 请求内容
   * @param {AbortSignal} signal 取消信号
   * @param {function} onText 累计正文回调
   * @returns {Promise<object>} 最终响应
   * 注意事项：聊天无总时限；分片轮询使用短请求，兼容 CapacitorHttp 不支持流式响应的限制。
   */
  async function request(config, method, path, body, signal, onText) {
    const saved = connection(config);
    if (!["GET", "POST"].includes(method) || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("Mac 请求地址无效");
    const isChat = method === "POST" && path === "/chat";
    const streaming = isChat && typeof onText === "function";
    const encoded = body === undefined ? undefined : JSON.stringify(streaming ? { ...body, stream: true } : body);
    if (encoded !== undefined && new TextEncoder().encode(encoded).length > 1024 * 1024) throw new Error("请求不能超过 1 MB，请缩短历史或附件");
    const controller = new AbortController();
    const cancelRunId = isChat && typeof body?.runId === "string" ? body.runId : null;
    let dispatched = false;
    let cancelling = false;
    const cancelRemote = () => {
      if (!cancelRunId || !dispatched || cancelling) return;
      cancelling = true;
      // CapacitorHttp 不支持 AbortSignal；用独立请求终止对应 CLI，不让停止按钮仅取消页面等待。
      request(saved, "POST", "/cancel", { runId: cancelRunId }).catch(() => {});
    };
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = !isChat || streaming ? setTimeout(abort, 30000) : null;
    const headers = { Authorization: `Bearer ${saved.token}`, "Content-Type": "application/json" };
    let cancel;
    const stopped = new Promise((_, reject) => {
      cancel = () => {
        cancelRemote();
        reject(new Error(signal?.aborted ? "任务已停止" : "Mac 连接超时"));
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      if (controller.signal.aborted) throw new Error("任务已停止");
      const native = root.Capacitor?.getPlatform?.() === "android" && root.Capacitor.Plugins?.CapacitorHttp;
      const url = `${saved.baseUrl}${path}`;
      dispatched = true;
      const pending = native
        ? native.request({ url, method, headers, ...(encoded === undefined ? {} : { data: JSON.parse(encoded) }), responseType: "text", connectTimeout: 15000, readTimeout: isChat && !streaming ? 0 : 30000, disableRedirects: true })
          .then((r) => ({ status: r.status, text: typeof r.data === "string" ? r.data : JSON.stringify(r.data) || "" }))
        : fetch(url, { method, headers, ...(encoded === undefined ? {} : { body: encoded }), signal: controller.signal, redirect: "error", credentials: "omit" })
          .then(async (r) => ({ status: r.status, text: await r.text() }));
      const response = await Promise.race([pending, stopped]);
      if (controller.signal.aborted) throw new Error(signal?.aborted ? "任务已停止" : "Mac 连接超时");
      if (!Number.isInteger(response.status) || typeof response.text !== "string") throw new Error("Mac 返回格式无效，请检查地址与端口");
      if (new TextEncoder().encode(response.text).length > 5 * 1024 * 1024) throw new Error("Mac 返回内容过大");
      let json;
      try { json = JSON.parse(response.text); } catch (_) { throw new Error("Mac 返回格式无效，请检查地址与端口"); }
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Mac 返回格式无效，请检查地址与端口");
      if (response.status < 200 || response.status >= 300) {
        const detail = typeof json.error?.message === "string" ? json.error.message : typeof json.error === "string" ? json.error : typeof json.message === "string" ? json.message : "Mac 请求失败";
        throw new Error(`HTTP ${response.status}：${detail}`);
      }
      clearTimeout(timer);
      if (streaming && json.status === "running") {
        if (!cancelRunId || json.runId !== cancelRunId) throw new Error("Mac 返回任务编号无效");
        let text = "";
        while (!controller.signal.aborted) {
          if (typeof json.text === "string" && json.text !== text) { text = json.text; onText(text); }
          if (controller.signal.aborted) throw new Error("任务已停止");
          if (json.status === "error") throw new Error(typeof json.error === "string" ? json.error : "Mac 后台执行失败");
          if (json.status === "complete") return json;
          if (json.status !== "running") throw new Error("Mac 返回任务状态无效");
          let pollTimer;
          try { await Promise.race([new Promise((resolve) => { pollTimer = setTimeout(resolve, 250); }), stopped]); }
          finally { clearTimeout(pollTimer); }
          json = await Promise.race([request(saved, "GET", `/chat/${encodeURIComponent(cancelRunId)}`, undefined, controller.signal), stopped]);
          if (json.runId !== cancelRunId) throw new Error("Mac 返回任务编号无效");
        }
        throw new Error("任务已停止");
      }
      if (streaming && typeof json.text === "string" && !controller.signal.aborted) onText(json.text);
      return json;
    } catch (error) {
      if (streaming) cancelRemote();
      if (controller.signal.aborted) throw new Error(signal?.aborted ? "任务已停止" : "Mac 连接超时");
      if (error?.code === "SocketTimeoutException") {
        cancelRemote();
        throw new Error("Mac 连接超时，请检查网络与主设备");
      }
      if (error?.name === "TypeError" || ["ConnectException", "UnknownHostException", "SocketException", "SSLHandshakeException", "SSLPeerUnverifiedException"].includes(error?.code)) {
        cancelRemote();
        throw new Error("连接不到 Mac，请检查同一网络、地址、端口以及 Mac 是否仍在运行");
      }
      const message = typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "Mac 请求失败";
      throw new Error(message.replace(new RegExp(saved.token, "gi"), "[已隐藏]"));
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      signal?.removeEventListener("abort", abort);
    }
  }
  root.ChorusGatewayClient = { connection, request };
})(globalThis);
