/* 中转站客户端：消息合并、带超时的请求与可恢复的实时通知。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChorusRelayClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  function normalizeBaseUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
      if (url.protocol === "http:" && !localHost(url.hostname)) return "";
      return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
    } catch (_) { return ""; }
  }

  function localHost(value) {
    const host = value.toLowerCase().replace(/^\[|\]$/g, "");
    if (["localhost", "::1"].includes(host) || host.endsWith(".local")) return true;
    if (host.includes(":")) return /^f[cd][a-f0-9]{2}:/.test(host) || /^fe[89ab][a-f0-9]:/.test(host);
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = parts;
    return first === 127 || first === 10 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31 || first === 169 && second === 254;
  }

  /** 同一消息按 ID 去重；保留远端新增消息和本机尚未上传的回复。 */
  function mergeMessages(remote, local) {
    const messages = new Map();
    for (const message of [...(remote || []), ...(local || [])]) {
      if (message && message.id) messages.set(String(message.id), { ...messages.get(String(message.id)), ...message });
    }
    return [...messages.values()];
  }

  /**
   * 按远端配置版本合并主电脑快照，同时保留未上传的回复。
   * @param {object} remote 中转站返回的完整快照
   * @param {object} local 本机快照及已经应用的 configRevision
   * @returns {object} 可安全应用和重新上传的快照
   * 注意事项：新版本采用完整成员、群与共享设置；本机偏好、密钥、执行状态和模型目录不被远端覆盖。
   */
  function mergeSnapshots(remote, local) {
    const remoteConfigNewer = Number(remote?.configRevision || 0) > Number(local?.configRevision || 0);
    const mergeOwners = (name) => {
      const remoteOwners = new Map((remote?.[name] || []).map((owner) => [owner.id, owner]));
      const localOwners = new Map((local?.[name] || []).map((owner) => [owner.id, owner]));
      // ------------ 采用完整配置集合，避免旧快照恢复已删除项或丢掉新增项 ---------------
      const owners = remoteConfigNewer ? remote?.[name] || [] : Array.isArray(local?.[name]) ? local[name] : remote?.[name] || [];
      return owners.map((owner) => ({ ...owner, messages: mergeMessages(remoteOwners.get(owner.id)?.messages, localOwners.get(owner.id)?.messages) }));
    };
    const snapshot = { ...remote, ...local };
    if (remoteConfigNewer) {
      snapshot.settings = { ...local?.settings };
      // 只有执行开关与默认服务商属于账号配置，不能把其他设备的偏好或凭据带回本机。
      for (const key of ["localExecution", "defaultProvider"]) {
        if (remote?.settings?.[key] !== undefined) snapshot.settings[key] = remote.settings[key];
      }
    }
    return { ...snapshot, configRevision: Math.max(Number(remote?.configRevision || 0), Number(local?.configRevision || 0)), agents: mergeOwners("agents"), rooms: mergeOwners("rooms") };
  }

  async function request(baseUrl, method, path, token, body) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base || !path.startsWith("/") || path.startsWith("//")) throw new Error("中转站请求地址无效");
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
    const encoded = body == null ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).length > 32 * 1024 * 1024) throw new Error("聊天同步内容超过 32 MB，请导出历史后精简记录");
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("中转站连接超时")); }, 30000);
    });
    try {
      const native = root.Capacitor?.getPlatform?.() === "android" && root.Capacitor.Plugins?.CapacitorHttp;
      const result = native
        ? native.request({ url: `${base}${path}`, method, headers, ...(body == null ? {} : { data: body }), responseType: "text", connectTimeout: 15000, readTimeout: 30000, disableRedirects: true })
          .then((response) => ({ status: response.status, payload: typeof response.data === "string" ? JSON.parse(response.data) : response.data }))
        : root.fetch(`${base}${path}`, { method, headers, ...(body == null ? {} : { body: encoded }), signal: controller.signal, credentials: "omit", redirect: "error" })
          .then(async (response) => ({ status: response.status, payload: await response.json() }));
      const { status, payload } = await Promise.race([result, timeout]);
      if (status < 200 || status >= 300) {
        const error = new Error(payload?.error?.message || payload?.message || (typeof payload?.error === "string" ? payload.error : "") || `中转站请求失败 (${status})`);
        error.status = status; error.code = payload?.error?.code || payload?.code || ""; error.payload = payload;
        throw error;
      }
      return payload;
    } finally { clearTimeout(timer); }
  }

  /** 设备令牌不放进 URL；短期一次性 ticket 每次重连重新申请。 */
  function realtime({ baseUrl, token, onEvent, onStatus, WebSocketClass = root.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout, ticketRequest = request }) {
    let socket = null;
    let timer = null;
    let generation = 0;
    let stopped = false;
    let attempts = 0;
    const status = (value) => onStatus?.(value);
    const reconnect = () => {
      if (stopped || timer) return;
      status("reconnecting");
      timer = setTimer(() => { timer = null; connect(); }, Math.min(30000, 1000 * (2 ** Math.min(attempts++, 5))));
    };
    const connect = async () => {
      const epoch = ++generation;
      status("connecting");
      try {
        const result = await ticketRequest(baseUrl, "POST", "/api/v1/realtime/ticket", token, {});
        if (stopped || epoch !== generation) return;
        if (!result.ticket) throw new Error("中转站未返回实时连接凭证");
        const url = new URL(`${normalizeBaseUrl(baseUrl)}/ws`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", result.ticket);
        const currentSocket = new WebSocketClass(url.toString());
        socket = currentSocket;
        currentSocket.onopen = () => { if (!stopped && epoch === generation) { attempts = 0; status("online"); onEvent?.({ type: "catchup" }); } };
        currentSocket.onmessage = (event) => {
          if (stopped || epoch !== generation) return;
          try { onEvent?.(JSON.parse(event.data)); } catch (_) { /* 忽略非协议消息。 */ }
        };
        currentSocket.onerror = () => { if (!stopped && epoch === generation) currentSocket.close(); };
        currentSocket.onclose = () => { if (!stopped && epoch === generation) reconnect(); };
      } catch (error) {
        if (stopped || epoch !== generation) return;
        if (error.status === 401) { stopped = true; status("unauthorized"); return; }
        reconnect();
      }
    };
    connect();
    return { close() { stopped = true; ++generation; if (timer) clearTimer(timer); timer = null; socket?.close(); status("offline"); } };
  }
  return { normalizeBaseUrl, mergeMessages, mergeSnapshots, request, realtime };
});
