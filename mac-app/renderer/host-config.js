/* 主电脑配置通道：短期请求、身份绑定与端到端模型密钥加密。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChorusHostConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const BASE = "/api/v1/host-config";

  /**
   * 构造不持久化配置正文的远程客户端。
   * @param {object} options request(method,path,body) 绑定当前已认证账号，crypto 可供测试注入
   * @returns {object} 配置命令和主电脑领取、回写方法
   * 注意事项：调用方在账号变化时废弃实例；current 可中止旧身份的等待与回写。
   */
  function createClient({ request, current = () => true, expectedTargetDeviceId = "", crypto = root.crypto, pollMs = 500, timeoutMs = 180000 }) {
    if (typeof request !== "function") throw new Error("缺少主电脑配置连接");
    /** 确认创建客户端时的账号仍有效；无参数；无返回值；失效时不再发送请求。 */
    function assertCurrent() { if (!current()) throw new Error("账号或主电脑已改变，请重新打开设置"); }
    /** 发起受身份保护的请求；参数为 HTTP 方法、相对路径与正文；返回接口结果；不缓存参数。 */
    async function send(method, path, body) { assertCurrent(); const result = await request(method, `${BASE}${path}`, body); assertCurrent(); return result; }
    return {
      /** 发布主电脑公钥；参数为原生公开身份；返回已发布公钥；不会传递私钥。 */
      publishKey: (key) => send("PUT", "/key", key),
      /** 清除本设备发布的公钥；无参数；返回操作状态；已换主时服务端保留新主公钥。 */
      clearKey: () => send("DELETE", "/key"),
      /** 领取下一条主电脑配置命令；无参数；返回命令或 null；仅当前主电脑可调用。 */
      claim: async () => (await send("GET", "/commands")).command || null,
      /** 回写配置结果；参数为领取命令、脱敏结果和可选错误；返回完成状态；服务端校验领取令牌。 */
      complete: (command, result, errorMessage = "") => send("PUT", `/commands/${encodeURIComponent(command.id)}`, { claimToken: command.claimToken, ...(errorMessage ? { errorMessage: String(errorMessage).slice(0, 1000) } : { result }) }),
      /**
       * 请求主电脑读取或修改配置，并等待明确成功或失败。
       * @param {string} action 固定白名单操作
       * @param {object} payload 配置参数，默认空对象
       * @returns {Promise<unknown>} 主电脑脱敏结果
       * 注意事项：模型设置自动加密；取消等待不会自动重发，避免重复保存。
       */
      async command(action, payload = {}) {
        const { key } = await send("GET", "/key");
        if (!key) throw new Error("主电脑未连接或版本较旧，请保持最新版本的主电脑在线");
        if (expectedTargetDeviceId && key.targetDeviceId !== expectedTargetDeviceId) throw new Error("主电脑已改变，请刷新设备与配置后重新保存");
        const encrypted = action === "model.save" ? await encryptModelSettings(key, payload, crypto) : payload;
        assertCurrent();
        const created = await send("POST", "/commands", { id: crypto.randomUUID(), action, payload: encrypted, targetDeviceId: key.targetDeviceId, keyId: key.keyId, generation: key.generation });
        const deadline = Math.min(Date.now() + timeoutMs, Date.parse(created.command.expiresAt));
        let command = created.command;
        while (Date.now() < deadline) {
          assertCurrent();
          if (command.status === "done") return command.result;
          if (command.status === "failed") throw new Error(command.errorMessage || "主电脑配置未完成");
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          command = (await send("GET", `/commands/${encodeURIComponent(command.id)}`)).command;
        }
        throw new Error("等待主电脑配置超时，请确认主电脑在线后刷新设置");
      },
    };
  }

  /**
   * 用主电脑公钥加密模型配置，兼容桌面和 Android WebCrypto。
   * @param {object} identity 主电脑公开身份和 SPKI 公钥
   * @param {object} payload 模型密钥及 Ollama 地址
   * @param {Crypto} crypto WebCrypto 实现
   * @returns {Promise<object>} 可经过中转站的加密信封
   * 注意事项：随机 AES 密钥由 RSA-OAEP 包裹，身份字段参与完整性验证；无明文存储副本。
   */
  async function encryptModelSettings(identity, payload, crypto = root.crypto) {
    if (!crypto?.subtle) throw new Error("当前设备缺少安全加密能力，请更新应用后重试");
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.length > 65536) throw new Error("模型设置过大");
    const publicKey = await crypto.subtle.importKey("spki", fromBase64(identity.publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    try {
      const aes = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
      const additionalData = new TextEncoder().encode(JSON.stringify([identity.accountId, identity.targetDeviceId, identity.keyId, "model.save"]));
      const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, aes, bytes);
      const key = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey);
      return { algorithm: "RSA-OAEP-256/A256GCM", key: toBase64(key), iv: toBase64(iv), data: toBase64(data) };
    } finally { rawKey.fill(0); bytes.fill(0); }
  }

  /** 编码二进制信封；参数为 ArrayBuffer；返回 base64；分段转换避免大密钥触发栈限制。 */
  function toBase64(value) {
    const bytes = new Uint8Array(value);
    let text = "";
    for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return root.btoa(text);
  }
  /** 解码公开密钥；参数为 base64；返回字节数组；非法编码由原生解析器拒绝。 */
  function fromBase64(value) { return Uint8Array.from(root.atob(value), (character) => character.charCodeAt(0)); }
  return { createClient, encryptModelSettings };
});
