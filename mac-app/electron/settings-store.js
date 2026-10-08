const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const STORE_FILE = "desktop-settings.json";
const STORE_VERSION = 1;
const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

/**
 * 读取桌面端设置文件。文件只保存密文和非敏感配置，损坏时明确报错，避免静默覆盖。
 * @returns {{version: number, secrets: object, ollamaBase: string, harnessPaths: object}}
 */
function readStore() {
  const file = getStorePath();
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error("桌面设置文件无效");
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("桌面设置格式无效");
    }
    return {
      version: STORE_VERSION,
      secrets: isPlainObject(parsed.secrets) ? parsed.secrets : {},
      ollamaBase: cleanString(parsed.ollamaBase, 2048) || DEFAULT_OLLAMA_BASE,
      harnessPaths: isPlainObject(parsed.harnessPaths) ? parsed.harnessPaths : {},
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyStore();
    if (error instanceof SyntaxError) throw new Error("桌面设置文件已损坏，请删除后重新配置");
    throw error;
  }
}

/**
 * 保存模型密钥。空字符串表示保留现值，null 表示清除，避免设置页不回填明文时误删密钥。
 * @param {{openai?: string|null, anthropic?: string|null, custom?: string|null, ollamaBase?: string}} input
 * @returns {{openaiConfigured: boolean, anthropicConfigured: boolean, customConfigured: boolean, ollamaBase: string}}
 */
function saveModelSettings(input) {
  if (!isPlainObject(input)) throw new Error("模型设置格式无效");
  const store = readStore();
  updateSecret(store.secrets, "openai", input.openai);
  updateSecret(store.secrets, "anthropic", input.anthropic);
  updateSecret(store.secrets, "custom", input.custom);
  if (Object.prototype.hasOwnProperty.call(input, "ollamaBase")) {
    store.ollamaBase = cleanString(input.ollamaBase, 2048) || DEFAULT_OLLAMA_BASE;
  }
  writeStore(store);
  return modelSettingsFromStore(store);
}

/**
 * 返回可展示的模型设置，不把密钥明文交给渲染进程。
 * @returns {{openaiConfigured: boolean, anthropicConfigured: boolean, customConfigured: boolean, ollamaBase: string}}
 */
function getModelSettings() {
  return modelSettingsFromStore(readStore());
}

/**
 * 仅供主进程发起模型请求时解密密钥。
 * @param {string} [provider] 仅解密当前 Provider 的密钥，避免无关密钥故障影响本机模型。
 * @returns {{openai: string, anthropic: string, custom: string, ollamaBase: string}}
 */
function getModelSecrets(provider) {
  const store = readStore();
  return {
    openai: !provider || provider === "openai" ? decryptSecret(store.secrets.openai) : "",
    anthropic: !provider || provider === "anthropic" ? decryptSecret(store.secrets.anthropic) : "",
    custom: !provider || provider === "custom" ? decryptSecret(store.secrets.custom) : "",
    ollamaBase: store.ollamaBase || DEFAULT_OLLAMA_BASE,
  };
}

/**
 * 保存已经过 harness 模块严格校验的自定义可执行路径。
 * @param {{codex?: string, claude?: string, cursor?: string}} paths
 * @returns {{codex: string, claude: string, cursor: string}}
 */
function saveHarnessSettings(paths) {
  if (!isPlainObject(paths)) throw new Error("Harness 设置格式无效");
  const store = readStore();
  store.harnessPaths = {
    codex: cleanString(paths.codex, 4096),
    claude: cleanString(paths.claude, 4096),
    cursor: cleanString(paths.cursor, 4096),
  };
  writeStore(store);
  return { ...store.harnessPaths };
}

/**
 * @returns {{codex: string, claude: string, cursor: string}}
 */
function getHarnessSettings() {
  const paths = readStore().harnessPaths;
  return {
    codex: cleanString(paths.codex, 4096),
    claude: cleanString(paths.claude, 4096),
    cursor: cleanString(paths.cursor, 4096),
  };
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    secrets: {},
    ollamaBase: DEFAULT_OLLAMA_BASE,
    harnessPaths: {},
  };
}

function getStorePath() {
  return path.join(app.getPath("userData"), STORE_FILE);
}

function writeStore(store) {
  const file = getStorePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify(
    {
      version: STORE_VERSION,
      secrets: store.secrets || {},
      ollamaBase: store.ollamaBase || DEFAULT_OLLAMA_BASE,
      harnessPaths: store.harnessPaths || {},
    },
    null,
    2,
  );
  try {
    fs.writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function updateSecret(secrets, key, value) {
  if (value === undefined || value === "") return;
  if (value === null) {
    delete secrets[key];
    return;
  }
  if (typeof value !== "string") throw new Error("API Key 格式无效");
  const normalized = value.trim();
  if (!normalized || normalized.length > 16384) throw new Error("API Key 格式无效");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统钥匙串当前不可用，无法安全保存 API Key");
  }
  secrets[key] = safeStorage.encryptString(normalized).toString("base64");
}

function decryptSecret(value) {
  if (!value) return "";
  if (typeof value !== "string" || value.length > 65536) throw new Error("已保存的 API Key 格式无效");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统钥匙串当前不可用，无法读取 API Key");
  }
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch (_error) {
    throw new Error("无法解密已保存的 API Key，请清除后重新配置");
  }
}

function modelSettingsFromStore(store) {
  return {
    openaiConfigured: Boolean(store.secrets.openai),
    anthropicConfigured: Boolean(store.secrets.anthropic),
    customConfigured: Boolean(store.secrets.custom),
    ollamaBase: store.ollamaBase || DEFAULT_OLLAMA_BASE,
  };
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  getHarnessSettings,
  getModelSecrets,
  getModelSettings,
  saveHarnessSettings,
  saveModelSettings,
};
