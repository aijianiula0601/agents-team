const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function storeFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let encryptionAvailable = true;
  const decrypted = [];
  const electron = {
    app: { getPath: () => directory },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (text) => Buffer.from(`test-encrypted:${text}`),
      decryptString: (buffer) => {
        const value = buffer.toString().replace(/^test-encrypted:/, "");
        decrypted.push(value);
        return value;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "settings-store.js"), "utf8"), {
    module,
    require: (name) => name === "electron" ? electron : require(name),
    Buffer,
    process,
  }, { filename: "settings-store.js" });
  return {
    store: module.exports,
    file: path.join(directory, "desktop-settings.json"),
    decrypted,
    disableEncryption: () => { encryptionAvailable = false; },
  };
}

test("自定义网关密钥独立保存，空输入保留、null 明确清除", (t) => {
  const { store, file } = storeFor(t);
  const saved = store.saveModelSettings({ openai: "openai-test-secret", custom: "custom-test-secret" });
  assert.equal(saved.openaiConfigured, true);
  assert.equal(saved.customConfigured, true);
  assert.equal(saved.custom, undefined);
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.notEqual(disk.secrets.custom, "custom-test-secret");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.saveModelSettings({ custom: "" });
  assert.equal(store.getModelSecrets("custom").custom, "custom-test-secret");
  store.saveModelSettings({ custom: null });
  assert.equal(store.getModelSettings().customConfigured, false);
  assert.equal(store.getModelSecrets("openai").openai, "openai-test-secret");
});

test("只读取当前 provider 的密钥，无关密钥不经过解密", (t) => {
  const { store, decrypted, disableEncryption } = storeFor(t);
  store.saveModelSettings({ openai: "openai-test-secret", anthropic: "anthropic-test-secret", custom: "custom-test-secret" });
  assert.equal(store.getModelSecrets("custom").custom, "custom-test-secret");
  assert.deepEqual(decrypted, ["custom-test-secret"]);
  disableEncryption();
  assert.equal(store.getModelSecrets("local").ollamaBase, "http://127.0.0.1:11434");
  assert.throws(() => store.getModelSecrets("openai"), /钥匙串当前不可用/);
});

test("钥匙串不可用时拒绝保存，且不覆盖旧配置", (t) => {
  const { store, file, disableEncryption } = storeFor(t);
  store.saveModelSettings({ openai: "old-test-secret" });
  const before = fs.readFileSync(file, "utf8");
  disableEncryption();
  assert.throws(() => store.saveModelSettings({ custom: "new-test-secret" }), /无法安全保存/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("损坏设置文件不会被静默清空后覆盖", (t) => {
  const { store, file } = storeFor(t);
  fs.writeFileSync(file, "broken-settings");
  assert.throws(() => store.saveModelSettings({ custom: "test-secret" }), /已损坏/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken-settings");
});
