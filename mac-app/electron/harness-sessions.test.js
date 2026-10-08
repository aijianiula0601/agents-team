const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { HarnessSessions, harnessSessionKey } = require("./harness-sessions");

test("会话按后台、工作区、聊天和成员隔离，conversationId 为兼容别名", () => {
  const options = { threadKey: "room:main", agentId: "coder" };
  const key = harnessSessionKey(options, "codex", "/workspace/one");
  assert.equal(key, harnessSessionKey({ conversationId: "room:main", agentId: "coder" }, "codex", "/workspace/one"));
  assert.notEqual(key, harnessSessionKey(options, "cursor", "/workspace/one"));
  assert.notEqual(key, harnessSessionKey(options, "codex", "/workspace/two"));
  assert.notEqual(key, harnessSessionKey({ ...options, threadKey: "private:coder" }, "codex", "/workspace/one"));
  assert.notEqual(key, harnessSessionKey({ ...options, agentId: "designer" }, "codex", "/workspace/one"));
  assert.equal(harnessSessionKey({}, "codex", "/workspace/one"), "");
  assert.throws(() => harnessSessionKey({ threadKey: "a\nb" }, "codex", "/workspace/one"), /对话编号/);
});

test("CLI 会话索引可跨进程重启恢复，只存哈希和编号且限制文件权限", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-sessions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness-sessions.json");
  const key = harnessSessionKey({ threadKey: "private:writer", agentId: "writer" }, "codex", directory);
  const store = new HarnessSessions(file);
  store.set(key, "session-123");
  assert.equal(new HarnessSessions(file).get(key), "session-123");
  assert.equal(new HarnessSessions(file).get("f".repeat(64)), "");
  const saved = fs.readFileSync(file, "utf8");
  assert.equal(saved.includes("private:writer"), false);
  assert.equal(saved.includes(directory), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.set(key, "--last"), /会话编号/);
});

test("损坏会话索引明确报错，不能覆盖或续接其他用户会话", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-sessions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness-sessions.json");
  fs.writeFileSync(file, "broken");
  const store = new HarnessSessions(file);
  assert.throws(() => store.set("a".repeat(64), "session-123"), /索引已损坏/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken");
});
