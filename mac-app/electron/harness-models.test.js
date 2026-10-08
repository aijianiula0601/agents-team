const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { listHarnessModels, normalizeModels, parseCursorModels } = require("./harness-models");

/** 创建协议测试 CLI；参数为测试上下文、内核名和脚本；返回可执行路径；只写入隔离临时目录。 */
function fakeCli(t, name, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-models-"));
  const executable = path.join(root, name);
  fs.writeFileSync(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return executable;
}

test("Codex 按官方握手后分页发现模型，不发送推理请求", async (t) => {
  const executable = fakeCli(t, "codex", `
    const readline = require("node:readline");
    let initialized = false;
    if (process.argv[2] !== "app-server") process.exit(2);
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: {} }));
      else if (request.method === "initialized") initialized = true;
      else if (request.method === "model/list" && initialized) console.log(JSON.stringify({ id: request.id, result: request.params.cursor ? { data: [{ model: "second-model", displayName: "第二个模型" }], nextCursor: null } : { data: [{ id: "ui-id", model: "first-model", displayName: "首个模型" }], nextCursor: "page-two" } }));
      else process.exit(3);
    });
  `);
  const result = await listHarnessModels("codex", { codex: executable });
  assert.equal(result.source, "codex-app-server");
  assert.deepEqual(result.models, [{ id: "first-model", label: "首个模型" }, { id: "second-model", label: "第二个模型" }]);
});

test("Claude 只读取 SDK initialize 返回目录，禁止发送用户聊天", async (t) => {
  const executable = fakeCli(t, "claude", `
    const readline = require("node:readline");
    const args = process.argv.slice(2);
    if (!args.includes("stream-json") || !args.includes("--strict-mcp-config")) process.exit(2);
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.type !== "control_request" || request.request.subtype !== "initialize") process.exit(3);
      console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: [{ value: "account-model", displayName: "账户可用模型", description: "实际目录" }] } } }));
    });
  `);
  const result = await listHarnessModels("claude", { claude: executable });
  assert.equal(result.source, "claude-sdk-initialize");
  assert.deepEqual(result.models, [{ id: "account-model", label: "账户可用模型", description: "实际目录" }]);
});

test("Cursor --list-models 解析真实文本目录，忽略提示、标题、ANSI 和重复项", async (t) => {
  const executable = fakeCli(t, "cursor-agent", `
    if (process.argv[2] !== "--list-models") process.exit(2);
    console.log("Available models\\n\\x1b[32mauto - Auto (current, default)\\x1b[0m\\nmodel-a - 模型 A\\nmodel-a - 模型 A\\nTip: use --model <id>");
  `);
  const result = await listHarnessModels("cursor", { cursor: executable });
  assert.equal(result.source, "cursor-list-models");
  assert.deepEqual(result.models, [{ id: "auto", label: "Auto" }, { id: "model-a", label: "模型 A" }]);
  assert.deepEqual(normalizeModels(parseCursorModels('{"models":[{"id":"json-model","displayName":"JSON 模型"}]}')), [{ id: "json-model", label: "JSON 模型" }]);
});

test("隐藏模型与控制字符编号不进入下拉框，缺失 CLI 不产生硬编码模型", async () => {
  assert.deepEqual(normalizeModels([{ id: "visible", label: "可选" }, { id: "secret", hidden: true }, { id: "--unsafe" }, { id: "line\nmodel" }]), [{ id: "visible", label: "可选" }]);
  const missing = await listHarnessModels("codex", { codex: "/chorus/no-such-cli" });
  assert.deepEqual(missing.models, []);
  assert.match(missing.error, /不存在或不可执行/);
});

test("目录查询超时与错误退出明确返回错误，不泄露 CLI stderr", async (t) => {
  const executable = fakeCli(t, "codex", 'process.stderr.write("secret-account-information"); setInterval(() => {}, 1000);');
  const result = await listHarnessModels("codex", { codex: executable }, { timeoutMs: 300 });
  assert.deepEqual(result.models, []);
  assert.match(result.error, /超时/);
  assert.equal(JSON.stringify(result).includes("secret-account-information"), false);
  const failed = fakeCli(t, "cursor-agent", 'process.stderr.write("secret-account-information"); process.exit(2);');
  const failure = await listHarnessModels("cursor", { cursor: failed });
  assert.match(failure.error, /退出码 2/);
  assert.equal(JSON.stringify(failure).includes("secret-account-information"), false);
});
