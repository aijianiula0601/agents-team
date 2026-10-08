/** 共享配置真实双节点验收：仅操作随机测试账号、内存设置和临时目录，不运行模型 CLI。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const log = require("../mac-app/electron/log");
const { createHostConfig } = require("../mac-app/electron/host-config");
const { validateWorkspace } = require("../mac-app/electron/workspace-paths");
const { createClient } = require("../shared/web/host-config");
const { mergeSnapshots } = require("../shared/web/relay-client");

const nodeA = process.env.RELAY_TEST_NODE_A || "";
const nodeB = process.env.RELAY_TEST_NODE_B || "";
const sessions = [];
const executors = [];
let workspace;
let checks = 0;
let shuttingDown = false;

/** 记录一组验收通过；参数为不含凭据的检查名称；无返回值；不输出接口正文。 */
function passed(name) { checks++; log.info(`共享配置验收通过：${name}`); }

/**
 * 发送真实中转请求并严格验证状态码。
 * @param {string} base 节点地址
 * @param {string} method HTTP 方法
 * @param {string} endpoint 相对接口路径
 * @param {string|null} token 随机测试设备令牌
 * @param {object|undefined} body 可选正文
 * @param {number} expected 预期 HTTP 状态，默认 200
 * @returns {Promise<object>} 解码后的接口结果
 * 注意事项：错误仅记录方法、路径和状态，不回显密码、令牌或密文。
 */
async function request(base, method, endpoint, token, body, expected = 200) {
  const response = await fetch(`${base}${endpoint}`, {
    method, headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: "error",
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${endpoint}：预期 HTTP ${expected}，实际 ${response.status}`);
  return data;
}

/**
 * 在一个节点登录随机测试设备并登记清理。
 * @param {string} base 节点地址
 * @param {object} credentials 本次随机测试账号的邮箱与密码
 * @param {string} platform mac 或 android
 * @param {string} action register 或 login
 * @returns {Promise<object>} 账号与设备会话
 * 注意事项：设备编号随机生成，清理仅注销本脚本登记的会话。
 */
async function login(base, credentials, platform, action = "login") {
  const session = await request(base, "POST", "/api/v1/auth/email", null, { ...credentials, action, name: "共享配置自动验收", device: { clientDeviceId: crypto.randomUUID(), name: "共享配置验收临时设备", platform } });
  sessions.push({ base, session });
  return session;
}

/**
 * 从当前节点读取版本后提交单个共享配置操作。
 * @param {string} base 节点地址
 * @param {object} session 随机测试会话
 * @param {string} method HTTP 方法
 * @param {string} endpoint 配置接口路径
 * @param {object} body 白名单配置
 * @returns {Promise<object>} 保存后的完整快照
 * 注意事项：本脚本顺序修改，出现冲突即失败，不掩盖服务端错误。
 */
async function mutate(base, session, method, endpoint, body = {}) {
  const current = await request(base, "GET", "/api/v1/state", session.deviceToken);
  return request(base, method, endpoint, session.deviceToken, { ...body, baseRevision: current.revision });
}

/**
 * 以真实共享客户端发起命令，在两节点竞争领取后交由隔离原生执行器处理。
 * @param {object} options 源设备、主设备、执行器、动作与测试正文
 * @returns {Promise<object>} 领取命令和源设备收到的结果或错误
 * 注意事项：模型明文仅留在进程内存；所有 HTTP 请求均检查不存在测试密钥明文。
 */
async function roundTrip({ source, primary, other, outsider, host, action, payload = {}, secret = "", isolate = false, failed = false }) {
  let queued;
  const created = new Promise((resolve) => { queued = resolve; });
  const client = createClient({ crypto: crypto.webcrypto, current: () => !shuttingDown, expectedTargetDeviceId: primary.device.id, pollMs: 50, timeoutMs: 20000, request: async (method, endpoint, body) => {
    if (secret) assert.ok(!JSON.stringify(body || {}).includes(secret), "配置请求含测试密钥明文");
    const result = await request(nodeB, method, endpoint, source.deviceToken, body);
    if (method === "POST") queued(result.command);
    return result;
  } });
  const pending = client.command(action, payload).then((result) => ({ result }), (error) => ({ error }));
  const enqueued = await Promise.race([created, pending.then((outcome) => { throw outcome.error || new Error("命令未经领取便结束"); })]);
  assert.equal(enqueued.payload, undefined);
  const claims = await Promise.all([nodeA, nodeB].map((base) => request(base, "GET", "/api/v1/host-config/commands", primary.deviceToken)));
  const claimed = claims.map((item) => item.command).filter(Boolean);
  assert.equal(claimed.length, 1, "两节点必须只交付一份配置命令");
  const command = claimed[0];
  assert.equal(command.id, enqueued.id);
  assert.equal(command.sourceDeviceId, source.device.id);
  assert.equal(command.sourceHash, undefined); assert.equal(command.claimHash, undefined);
  if (secret) {
    assert.equal(command.payload.algorithm, "RSA-OAEP-256/A256GCM");
    assert.ok(!JSON.stringify(command).includes(secret), "领取结果含测试密钥明文");
  }
  const endpoint = `/api/v1/host-config/commands/${command.id}`;
  if (isolate) {
    await request(nodeA, "GET", endpoint, other.deviceToken, undefined, 404);
    await request(nodeB, "GET", endpoint, outsider.deviceToken, undefined, 410);
    await request(nodeA, "PUT", endpoint, source.deviceToken, { claimToken: command.claimToken, result: {} }, 403);
    await request(nodeB, "PUT", endpoint, primary.deviceToken, { claimToken: "invalid", result: {} }, 403);
  }
  let result, errorMessage;
  try { result = await host.execute(command); }
  catch (error) { errorMessage = error.message; }
  if (secret) assert.ok(!JSON.stringify(result || {}).includes(secret), "原生结果含测试密钥明文");
  assert.equal(Boolean(errorMessage), failed, "原生操作结果与预期不符");
  const completed = await request(nodeA, "PUT", endpoint, primary.deviceToken, { claimToken: command.claimToken, ...(errorMessage ? { errorMessage } : { result }) });
  assert.equal(completed.command.status, failed ? "failed" : "done");
  assert.equal(completed.command.payload, undefined);
  assert.equal(completed.command.claimToken, undefined);
  // 模拟结果回执丢失后再次确认；已经完成的结果不能被迟到错误改成失败。
  const replay = await request(nodeB, "PUT", endpoint, primary.deviceToken, { claimToken: command.claimToken, errorMessage: "模拟迟到回执" });
  assert.equal(replay.command.status, completed.command.status);
  const outcome = await pending;
  assert.equal(Boolean(outcome.error), failed);
  if (!failed) assert.deepEqual(outcome.result, completed.command.result);
  return { command, ...outcome };
}

/**
 * 验证真实双节点共享配置及主电脑配置通道。
 * @param 无
 * @returns {Promise<void>} 所有检查完成
 * 注意事项：账号、密码及模型设置均为合成数据，原生处理器不调用系统密钥库或 CLI。
 */
async function main() {
  // ------------ 校验用户显式指定的双节点地址 ---------------
  if (!nodeA || !nodeB) throw new Error("真实验收需要配置 RELAY_TEST_NODE_A 和 RELAY_TEST_NODE_B");
  const suffix = crypto.randomBytes(8).toString("hex");
  const credentials = { email: `chorus-config-e2e-${suffix}@example.test`, password: crypto.randomBytes(24).toString("base64url") };
  const primary = await login(nodeA, credentials, "mac", "register");
  const secondary = await login(nodeB, credentials, "mac");
  const phone = await login(nodeB, credentials, "android");
  const outsider = await login(nodeA, { email: `chorus-config-other-${suffix}@example.test`, password: crypto.randomBytes(24).toString("base64url") }, "android", "register");
  assert.equal(primary.device.isPrimary, true);
  assert.equal(secondary.device.isPrimary, false); assert.equal(phone.device.isPrimary, false);
  assert.equal(primary.account.id, secondary.account.id); assert.equal(primary.account.id, phone.account.id);
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "chorus-shared-config-e2e-"));
  const realWorkspace = await fs.realpath(workspace);

  // ------------ 共享配置增删改及历史保护 ---------------
  const initial = { configRevision: 0, agents: [{ id: "baseline", name: "验收基准", backend: "model", provider: "openai", model: "synthetic-model", messages: [{ id: "private-history", from: "you", text: "需要保留的私聊历史" }] }], rooms: [{ id: "baseline-room", name: "验收群", agentIds: ["baseline"], rule: "free", workspace: "", messages: [{ id: "room-history", from: "you", text: "需要保留的群历史" }] }], settings: { localExecution: true, defaultProvider: "openai" } };
  await request(nodeA, "PUT", "/api/v1/state", primary.deviceToken, { baseRevision: 0, state: initial });
  const before = await request(nodeB, "GET", "/api/v1/state", secondary.deviceToken);
  const createAgent = { id: "secondary-agent", config: { name: "副电脑成员", backend: "cursor", harness: "cursor", workspaceMode: "auto", workspace: "" } };
  await mutate(nodeB, secondary, "POST", "/api/v1/agents", createAgent);
  await mutate(nodeA, phone, "POST", "/api/v1/agents", { id: "phone-agent", config: { name: "手机成员", backend: "cursor", harness: "cursor", workspaceMode: "project", workspace: realWorkspace } });
  await mutate(nodeB, phone, "POST", "/api/v1/rooms", { id: "created-room", config: { name: "手机新群", agentIds: ["baseline", "secondary-agent", "phone-agent"], rule: "mention", workspace: realWorkspace } });
  await mutate(nodeA, secondary, "PATCH", "/api/v1/agents/baseline", { config: { name: "远端修改成员", persona: "配置属于主电脑" } });
  await mutate(nodeB, phone, "PATCH", "/api/v1/rooms/baseline-room", { config: { name: "远端修改群", agentIds: ["baseline", "phone-agent"], rule: "mention", workspace: realWorkspace } });
  let current = await mutate(nodeB, secondary, "PATCH", "/api/v1/settings", { config: { localExecution: false, defaultProvider: "anthropic" } });
  assert.equal(current.state.agents.length, 3); assert.equal(current.state.rooms.length, 2);
  assert.equal(current.state.agents.find((agent) => agent.id === "baseline").messages[0].id, "private-history");
  assert.equal(current.state.rooms.find((room) => room.id === "baseline-room").messages[0].id, "room-history");
  assert.equal(current.state.settings.localExecution, false); assert.equal(current.state.settings.defaultProvider, "anthropic");
  await request(nodeA, "PATCH", "/api/v1/agents/baseline", outsider.deviceToken, { baseRevision: 0, config: { name: "不得跨账号修改" } }, 404);
  assert.equal((await request(nodeA, "GET", "/api/v1/state", outsider.deviceToken)).state.agents.length, 0);
  passed("副电脑和手机创建编辑成员与群、共享设置、历史保留与账号隔离");

  await request(nodeA, "PUT", "/api/v1/state", primary.deviceToken, { baseRevision: current.revision, state: before.state }, 409);
  await request(nodeB, "PUT", "/api/v1/state", primary.deviceToken, { baseRevision: current.revision, state: { ...before.state, configRevision: current.state.configRevision } }, 409);
  const replayCreate = await request(nodeA, "POST", "/api/v1/agents", secondary.deviceToken, { ...createAgent, baseRevision: before.revision });
  assert.equal(replayCreate.revision, current.revision);
  current.state.agents.find((agent) => agent.id === "secondary-agent").workspace = realWorkspace;
  const backfill = await request(nodeA, "PUT", "/api/v1/state", primary.deviceToken, { baseRevision: current.revision, state: current.state });
  assert.equal(backfill.state.configRevision, current.state.configRevision);
  assert.equal(backfill.state.agents.find((agent) => agent.id === "secondary-agent").workspace, realWorkspace);
  const stale = structuredClone(backfill);
  await mutate(nodeB, phone, "DELETE", "/api/v1/agents/phone-agent");
  current = await mutate(nodeA, secondary, "DELETE", "/api/v1/rooms/created-room");
  assert.ok(current.state.rooms.every((room) => !room.agentIds.includes("phone-agent")));
  assert.equal(current.state.agents.length, 2); assert.equal(current.state.rooms.length, 1);
  await request(nodeB, "PUT", "/api/v1/state", primary.deviceToken, { baseRevision: current.revision, state: { ...stale.state, configRevision: current.state.configRevision } }, 409);
  const merged = mergeSnapshots(current.state, stale.state);
  assert.equal(merged.agents.length, 2); assert.equal(merged.rooms.length, 1);
  const saved = await request(nodeA, "PUT", "/api/v1/state", primary.deviceToken, { baseRevision: current.revision, state: merged });
  assert.equal(saved.state.rooms[0].messages[0].id, "room-history");
  passed("旧主电脑快照与伪造版本不能覆盖配置，自动目录可回填，删除项不会复活");

  // ------------ 主机配置使用真实加密模块，仅把合成值存入内存 ---------------
  const syntheticSecret = crypto.randomBytes(32).toString("base64url");
  let modelWrites = 0;
  const modelSettings = { openaiConfigured: false, anthropicConfigured: false, customConfigured: false, ollamaBase: "http://127.0.0.1:11434" };
  const host = createHostConfig({
    /** 保存合成模型设置；参数为解密后的测试正文；返回脱敏状态；不访问用户钥匙串。 */
    "model.save": (payload) => { assert.ok(payload.openai === syntheticSecret, "原生解密后的测试值不匹配"); modelWrites++; modelSettings.openaiConfigured = true; return { ...modelSettings }; },
    /** 返回合成模型状态；无业务参数；返回独立公开副本；不包含测试密钥。 */
    "model.get": () => ({ ...modelSettings }),
    /** 在验收临时目录内使用真实路径校验器；参数为路径；返回规范路径；不创建用户项目。 */
    "workspace.normalize": (payload) => { assert.ok(path.resolve(payload.path).startsWith(`${workspace}${path.sep}`) || payload.path === workspace, "仅允许验收临时目录"); return validateWorkspace(payload.path); },
  });
  executors.push(host);
  const key = host.setContext({ accountId: primary.account.id, deviceId: primary.device.id, primary: true });
  const published = await request(nodeA, "PUT", "/api/v1/host-config/key", primary.deviceToken, key);
  assert.equal(published.key.publisherHash, undefined);
  await request(nodeB, "PUT", "/api/v1/host-config/key", phone.deviceToken, key, 403);
  const exchanged = await roundTrip({ source: phone, primary, other: secondary, outsider, host, action: "model.save", payload: { openai: syntheticSecret, ollamaBase: modelSettings.ollamaBase }, secret: syntheticSecret, isolate: true });
  assert.equal(exchanged.result.openaiConfigured, true); assert.equal(modelWrites, 1);
  await host.execute(exchanged.command); assert.equal(modelWrites, 1);
  const stateAfterHost = await request(nodeB, "GET", "/api/v1/state", phone.deviceToken);
  assert.ok(!JSON.stringify(stateAfterHost).includes(syntheticSecret));
  assert.ok(!JSON.stringify(stateAfterHost).includes(exchanged.command.id));
  const validPath = await roundTrip({ source: secondary, primary, other: phone, outsider, host, action: "workspace.normalize", payload: { path: workspace } });
  assert.equal(validPath.result, realWorkspace);
  const invalidPath = await roundTrip({ source: phone, primary, other: secondary, outsider, host, action: "workspace.normalize", payload: { path: path.join(workspace, "does-not-exist") }, failed: true });
  assert.match(invalidPath.error.message, /工作区不存在/);
  passed("跨节点加密命令独占领取、原生解密去重、回执幂等、源设备隔离与主电脑路径校验");

  // ------------ 换主后旧公钥、命令和回写立即失效 ---------------
  const pendingID = crypto.randomUUID();
  await request(nodeB, "POST", "/api/v1/host-config/commands", phone.deviceToken, { id: pendingID, action: "model.get", payload: {}, targetDeviceId: key.targetDeviceId, keyId: key.keyId, generation: published.key.generation });
  const oldClaim = (await request(nodeA, "GET", "/api/v1/host-config/commands", primary.deviceToken)).command;
  assert.equal(oldClaim.id, pendingID);
  await request(nodeB, "GET", "/api/v1/devices", secondary.deviceToken);
  await request(nodeA, "POST", `/api/v1/devices/${secondary.device.id}/primary`, phone.deviceToken, {}, 403);
  await request(nodeA, "POST", `/api/v1/devices/${secondary.device.id}/primary`, secondary.deviceToken, {});
  host.setContext({ primary: false });
  await assert.rejects(host.execute(oldClaim), /身份/);
  await request(nodeB, "GET", "/api/v1/host-config/key", phone.deviceToken, undefined, 409);
  await request(nodeA, "PUT", `/api/v1/host-config/commands/${pendingID}`, primary.deviceToken, { claimToken: oldClaim.claimToken, result: {} }, 403);
  const nextHost = createHostConfig({}); executors.push(nextHost);
  const nextKey = nextHost.setContext({ accountId: primary.account.id, deviceId: secondary.device.id, primary: true });
  await request(nodeB, "PUT", "/api/v1/host-config/key", secondary.deviceToken, nextKey);
  await request(nodeA, "GET", `/api/v1/host-config/commands/${pendingID}`, phone.deviceToken, undefined, 409);
  await request(nodeB, "POST", "/api/v1/host-config/commands", phone.deviceToken, { id: crypto.randomUUID(), action: "model.get", payload: {}, targetDeviceId: key.targetDeviceId, keyId: key.keyId, generation: published.key.generation }, 409);
  await request(nodeA, "DELETE", "/api/v1/host-config/key", primary.deviceToken);
  assert.equal((await request(nodeB, "GET", "/api/v1/host-config/key", phone.deviceToken)).key.targetDeviceId, secondary.device.id);
  passed("切换主电脑撤销旧命令与密钥，旧设备清理不能删除新主电脑连接");
  log.info(`共享配置真实双节点验收完成：${checks} 组通过`);
}

/**
 * 注销所有随机测试会话并清理临时目录。
 * @param 无
 * @returns {Promise<void>} 清理完成
 * 注意事项：任一注销失败都会令脚本失败，不静默报告完整清理。
 */
async function cleanup() {
  shuttingDown = true;
  executors.forEach((host) => host.setContext({ primary: false }));
  const results = await Promise.allSettled(sessions.map(({ base, session }) => request(base, "POST", "/api/v1/auth/logout", session.deviceToken, {})));
  const failures = results.filter((result) => result.status === "rejected").length;
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  if (failures) { process.exitCode = 1; log.error(`随机测试会话注销失败 ${failures} 个`); }
  else if (sessions.length) log.info(`随机测试会话已全部注销：${sessions.length} 个；临时目录已删除`);
}

if (!process.argv.includes("--run-live")) log.info("仅显式运行真实验收：配置 RELAY_TEST_NODE_A/B 后执行 node scripts/shared-config-e2e.js --run-live");
else main().catch((error) => { process.exitCode = 1; log.error("共享配置验收失败", error); }).finally(cleanup);
