const crypto = require("crypto");
const log = require("./log");

const MAX_PAYLOAD_BYTES = 96 * 1024;

/**
 * 构造只服务于当前账号主电脑的配置执行器。
 * @param {object} handlers 已验证的原生配置操作，键名必须来自固定白名单
 * @returns {{setContext: Function, execute: Function}} 身份更新及命令执行入口
 * 注意事项：私钥仅驻留主进程内存，换账号或失去主设备资格立即废弃；不记录配置正文。
 */
function createHostConfig(handlers) {
  let identity = null;
  let privateKey = null;
  const completed = new Map();

  /** 更新主设备身份；参数为账号、设备及主角色；返回可发布的公钥或 null；同一身份保持密钥。 */
  function setContext(context) {
    if (!context?.primary) {
      identity = null; privateKey = null; completed.clear();
      return null;
    }
    if (![context.accountId, context.deviceId].every((value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw new Error("主电脑身份无效");
    if (identity?.accountId === context.accountId && identity.targetDeviceId === context.deviceId) return { ...identity };
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    identity = { accountId: context.accountId, targetDeviceId: context.deviceId, keyId: crypto.randomUUID(), publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
    completed.clear();
    log.info("------------- 主电脑远程配置会话已更新 --------------");
    return { ...identity };
  }

  /**
   * 执行经中转站领取的白名单配置命令。
   * @param {object} command 绑定账号、设备、公钥和到期时间的命令
   * @returns {Promise<unknown>} 不含密钥明文的操作结果
   * 注意事项：模型设置只接受加密信封；重复任务共享结果，身份变化后不交付旧结果。
   */
  async function execute(command) {
    const current = identity;
    if (!current || command?.accountId !== current.accountId || command.targetDeviceId !== current.targetDeviceId || command.keyId !== current.keyId) throw new Error("主电脑配置身份已变化，请刷新后重试");
    if (typeof command.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.id) || !Number.isFinite(Date.parse(command.expiresAt)) || Date.parse(command.expiresAt) <= Date.now() || Date.parse(command.expiresAt) > Date.now() + 190000) throw new Error("配置命令已过期或格式无效");
    if (!Object.hasOwn(handlers, command.action)) throw new Error("不支持的主电脑配置操作");
    for (const [id, entry] of completed) if (entry.expiresAt <= Date.now()) completed.delete(id);
    if (completed.has(command.id)) return completed.get(command.id).promise;
    if (completed.size >= 128) throw new Error("主电脑配置请求过多，请稍后重试");
    /** 校验异步保存前的主设备资格；无参数；无返回值；身份变化立即阻断后续写盘。 */
    const assertCurrent = () => { if (identity !== current) throw new Error("主电脑配置身份已变化，请重试"); };
    const operation = Promise.resolve().then(async () => {
      assertCurrent();
      const payload = command.action === "model.save" ? decryptPayload(command, privateKey) : command.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw new Error("配置参数格式无效");
      log.info(`------------- 执行主电脑配置 action=${command.action} --------------`);
      const result = await handlers[command.action](payload, assertCurrent);
      if (identity !== current) throw new Error("主电脑配置身份已变化，请刷新后确认");
      log.info(`主电脑配置执行完成 action=${command.action}`);
      return result;
    });
    completed.set(command.id, { promise: operation, expiresAt: Date.parse(command.expiresAt) });
    return operation;
  }
  return { setContext, execute };
}

/**
 * 解密绑定目标身份的模型设置，支持大于 RSA 单块容量的 API Key。
 * @param {object} command 带 RSA-OAEP 包裹密钥和 AES-GCM 密文的命令
 * @param {crypto.KeyObject} privateKey 当前会话私钥
 * @returns {object} 仅在原生保存期间使用的模型设置
 * 注意事项：身份作为 GCM 附加认证数据，任何信封篡改都返回统一错误，不回显密钥。
 */
function decryptPayload(command, privateKey) {
  let key;
  try {
    const envelope = command.payload;
    if (envelope?.algorithm !== "RSA-OAEP-256/A256GCM" || typeof envelope.key !== "string" || typeof envelope.iv !== "string" || typeof envelope.data !== "string" || envelope.data.length > MAX_PAYLOAD_BYTES) throw new Error("invalid");
    key = crypto.privateDecrypt({ key: privateKey, oaepHash: "sha256", padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.key, "base64"));
    const iv = Buffer.from(envelope.iv, "base64");
    const data = Buffer.from(envelope.data, "base64");
    if (key.length !== 32 || iv.length !== 12 || data.length < 17) throw new Error("invalid");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify([command.accountId, command.targetDeviceId, command.keyId, command.action])));
    decipher.setAuthTag(data.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    try { return JSON.parse(plaintext.toString("utf8")); }
    finally { plaintext.fill(0); }
  } catch (_) { throw new Error("无法解密主电脑模型设置，请刷新连接后重新保存"); }
  finally { key?.fill(0); }
}

module.exports = { createHostConfig };
