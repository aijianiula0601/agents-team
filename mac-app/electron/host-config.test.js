const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createHostConfig } = require("./host-config");
const { createClient, encryptModelSettings } = require("../../shared/web/host-config");

/** 组装短期命令；参数为当前公钥及覆盖项；返回可执行命令；测试不读取用户配置。 */
function command(key, extra = {}) { return { ...key, id: crypto.randomUUID(), action: "model.save", expiresAt: new Date(Date.now() + 180000).toISOString(), ...extra }; }

/** 创建测试主机身份；参数为执行器；返回公开密钥；每次使用独立账号与设备。 */
function identify(host) { return host.setContext({ accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), primary: true }); }

test("跨平台信封只在主电脑解密，大密钥不进入请求明文，结果只含配置状态", async () => {
  const secret = `secret-${"a".repeat(16000)}`;
  let saved;
  let job;
  const host = createHostConfig({ "model.save": (value) => { saved = value; return { openaiConfigured: true }; } });
  const key = identify(host);
  const client = createClient({ crypto: crypto.webcrypto, pollMs: 1, request: async (method, path, payload) => {
    if (path.endsWith("/key")) return { key };
    if (method === "POST") {
      assert.equal(JSON.stringify(payload).includes(secret), false);
      job = command(key, payload);
      job.result = await host.execute(job);
      job.status = "done";
      return { command: job };
    }
    throw new Error("unexpected request");
  } });
  assert.deepEqual(await client.command("model.save", { openai: secret, ollamaBase: "http://127.0.0.1:11434" }), { openaiConfigured: true });
  assert.equal(saved.openai, secret);
  assert.equal(JSON.stringify(job).includes(secret), false);
});

test("模型明文、被篡改信封、错误设备和到期命令不会保存", async () => {
  let count = 0;
  const host = createHostConfig({ "model.save": () => { count += 1; } });
  const key = identify(host);
  const encrypted = await encryptModelSettings(key, { openai: "secret-test" }, crypto.webcrypto);
  await assert.rejects(host.execute(command(key, { payload: { openai: "plaintext" } })), /解密/);
  await assert.rejects(host.execute(command(key, { payload: { ...encrypted, data: encrypted.data.slice(0, 20) + "AAAA" + encrypted.data.slice(24) } })), /解密/);
  await assert.rejects(host.execute(command(key, { payload: encrypted, targetDeviceId: crypto.randomUUID() })), /身份/);
  await assert.rejects(host.execute(command(key, { payload: encrypted, expiresAt: new Date(Date.now() - 1).toISOString() })), /过期/);
  assert.equal(count, 0);
});

test("身份切换清除私钥，同一命令不重复保存，晚到查询不交付新账号", async () => {
  let count = 0;
  let resolve;
  const host = createHostConfig({ "harness.save": () => { count += 1; return { paths: {} }; }, "settings.get": () => new Promise((done) => { resolve = done; }) });
  const key = identify(host);
  const write = command(key, { action: "harness.save", payload: {} });
  await Promise.all([host.execute(write), host.execute(write)]);
  assert.equal(count, 1);
  const read = host.execute(command(key, { action: "settings.get", payload: {} }));
  await Promise.resolve();
  host.setContext({ primary: false });
  resolve({ modelSettings: {} });
  await assert.rejects(read, /身份/);
  await assert.rejects(host.execute(write), /身份/);
  const next = host.setContext({ accountId: key.accountId, deviceId: key.targetDeviceId, primary: true });
  assert.notEqual(next.keyId, key.keyId);
});

test("等待期间账号变化会停止轮询；已失败的命令明确返回错误", async () => {
  let current = true;
  let reads = 0;
  const host = createHostConfig({});
  const key = identify(host);
  const client = createClient({ crypto: crypto.webcrypto, pollMs: 1, current: () => current, request: async (method) => {
    if (method === "GET") { reads += 1; return { key }; }
    current = false;
    return { command: { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 10000).toISOString(), status: "pending" } };
  } });
  await assert.rejects(client.command("settings.get"), /账号/);
  assert.equal(reads, 1);
  const failed = createClient({ crypto: crypto.webcrypto, request: async (method) => method === "GET" ? { key } : { command: { expiresAt: new Date(Date.now() + 10000).toISOString(), status: "failed", errorMessage: "项目路径不存在" } } });
  await assert.rejects(failed.command("workspace.normalize", { path: "/missing" }), /项目路径不存在/);
});

test("服务已换主但本端尚未收到通知时，不将旧主电脑表单提交给新主电脑", async () => {
  const host = createHostConfig({});
  const key = identify(host);
  let writes = 0;
  const client = createClient({ crypto: crypto.webcrypto, expectedTargetDeviceId: crypto.randomUUID(), request: async (method) => {
    if (method !== "GET") writes += 1;
    return { key };
  } });
  await assert.rejects(client.command("harness.save", { cursor: "/old-host/cursor-agent" }), /主电脑已改变/);
  assert.equal(writes, 0);
});
