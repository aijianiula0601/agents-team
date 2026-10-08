const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { DEFAULT_WORKSPACE_ROOT, prepareAgentWorkspaces, resolveAgentWorkspace } = require("./agent-workspaces");

/**
 * 创建隔离临时目录并注册清理，避免验收触及用户真实项目。
 * @param {node:test.TestContext} t 当前测试上下文
 * @returns {string} 临时默认根目录
 * 注意事项：清理仅针对本测试创建的临时目录。
 */
function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-workspaces-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("默认根路径与用户指定一致，中文成员自动创建目录并保留内容", (t) => {
  assert.equal(DEFAULT_WORKSPACE_ROOT, path.join(os.homedir(), "Documents/chorus/agent-teams/workspace"));
  assert.equal(path.isAbsolute(DEFAULT_WORKSPACE_ROOT), true);
  assert.equal(DEFAULT_WORKSPACE_ROOT.includes("~"), false);
  const root = temporaryRoot(t);
  const agents = [{ id: "architect", name: "架构师" }, { id: "coder", name: "Coder" }];
  const first = prepareAgentWorkspaces(agents, { root });
  assert.equal(first[0].workspace, path.join(fs.realpathSync(root), "架构师"));
  assert.equal(first[1].workspace, path.join(fs.realpathSync(root), "Coder"));
  fs.writeFileSync(path.join(first[0].workspace, "keep.txt"), "保留原内容");
  assert.deepEqual(prepareAgentWorkspaces(agents, { root }), first);
  assert.equal(fs.readFileSync(path.join(first[0].workspace, "keep.txt"), "utf8"), "保留原内容");
});

test("已有非空工作区完整保留，同时主动创建缺失公共根目录", (t) => {
  const root = temporaryRoot(t);
  const missingRoot = path.join(root, "chorus/agent-teams/workspace");
  const agents = [{ id: "a", name: "已有成员", workspace: "/old/custom/project" }];
  assert.deepEqual(prepareAgentWorkspaces(agents, { root: missingRoot }), [{ id: "a", workspace: "/old/custom/project" }]);
  assert.equal(fs.statSync(missingRoot).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(missingRoot), []);
  assert.equal(fs.existsSync(path.join(missingRoot, "已有成员")), false);
});

test("空成员列表也主动创建公共根，重复准备不会创建额外目录", (t) => {
  const root = temporaryRoot(t);
  const missingRoot = path.join(root, "chorus/agent-teams/workspace");
  assert.deepEqual(prepareAgentWorkspaces([], { root: missingRoot }), []);
  assert.equal(fs.statSync(missingRoot).isDirectory(), true);
  const inode = fs.statSync(missingRoot).ino;
  assert.deepEqual(prepareAgentWorkspaces([], { root: missingRoot }), []);
  assert.equal(fs.statSync(missingRoot).ino, inode);
  assert.deepEqual(fs.readdirSync(missingRoot), []);
});

test("主进程启动主动准备空成员根，目录异常也保留窗口打开", async () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const bootstrap = mainSource.match(/async function bootstrap\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(bootstrap);
  for (const failRoot of [false, true]) {
    const stages = [];
    const context = {
      app: { requestSingleInstanceLock: () => true, on() {}, whenReady: async () => {}, quit() { throw new Error("不应退出应用"); } },
      mainWindow: null,
      prepareAgentWorkspaces: (agents) => { assert.equal(agents.length, 0); stages.push("root"); if (failRoot) throw new Error("synthetic permission denied"); },
      log: { error: (message, error) => { assert.match(message, /目录权限/); assert.match(error.message, /permission denied/); stages.push("visible-error"); } },
      installAppMenu: () => stages.push("menu"),
      createMainWindow: () => { stages.push("window"); return { synthetic: true }; },
    };
    vm.runInNewContext(`this.bootstrap = ${bootstrap};`, context);
    await context.bootstrap();
    assert.equal(stages[0], "root");
    assert.equal(stages.at(-1), "window");
    assert.equal(stages.includes("visible-error"), failRoot);
    assert.equal(context.mainWindow.synthetic, true);
  }
});

test("空名、相对路径、分隔符和超长中文名称都限定为独立单层目录", (t) => {
  const root = temporaryRoot(t);
  const agents = ["", ".", "..", "../越界", "/tmp/越界", "a\\b", "a/b", "a:b", "工程师".repeat(100), "\u0000"].map((name, index) => ({ id: `a${index}`, name }));
  const result = prepareAgentWorkspaces(agents, { root });
  assert.equal(new Set(result.map((item) => item.workspace)).size, agents.length);
  for (const item of result) {
    assert.equal(path.dirname(item.workspace), fs.realpathSync(root));
    assert.equal(fs.statSync(item.workspace).isDirectory(), true);
    assert.ok(Buffer.byteLength(path.basename(item.workspace), "utf8") <= 255);
  }
});

test("大小写、NFC 与派生摘要名称的碰撞都按稳定编号隔离", (t) => {
  const root = temporaryRoot(t);
  const suffix = crypto.createHash("sha256").update("a").digest("hex").slice(0, 12);
  const agents = [{ id: "a", name: "Coder" }, { id: "b", name: "coder" }, { id: "c", name: `Coder-${suffix}` }, { id: "d", name: "é" }, { id: "e", name: "e\u0301" }];
  const first = prepareAgentWorkspaces(agents, { root });
  assert.equal(new Set(first.map((item) => item.workspace.toLocaleLowerCase("en-US"))).size, agents.length);
  const reversed = prepareAgentWorkspaces([...agents].reverse(), { root });
  for (const item of first) assert.equal(reversed.find((other) => other.id === item.id).workspace, item.workspace);
});

test("新默认目录避开已有显式成员目录，保留显式 raw 路径", (t) => {
  const root = temporaryRoot(t);
  const explicit = path.join(root, "研发员");
  fs.mkdirSync(explicit);
  const result = prepareAgentWorkspaces([{ id: "old", name: "已有成员", workspace: explicit }, { id: "new", name: "研发员" }], { root });
  assert.equal(result[0].workspace, explicit);
  assert.notEqual(fs.realpathSync(result[0].workspace), fs.realpathSync(result[1].workspace));
  assert.match(path.basename(result[1].workspace), /^研发员-/);
});

test("默认子目录拒绝向外和向内的符号链接，不能共用其他成员的真实目录", (t) => {
  const root = temporaryRoot(t);
  const inside = path.join(root, "乙");
  fs.mkdirSync(inside);
  fs.symlinkSync(inside, path.join(root, "甲"), "dir");
  assert.throws(() => prepareAgentWorkspaces([{ id: "a", name: "甲" }, { id: "b", name: "乙" }], { root }), /不能使用符号链接/);
  const outside = temporaryRoot(t);
  fs.symlinkSync(outside, path.join(root, "外链"), "dir");
  assert.throws(() => prepareAgentWorkspaces([{ id: "c", name: "外链" }], { root }), /不能使用符号链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("无效编号与同名文件在创建或执行前明确拒绝", (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => prepareAgentWorkspaces([{ id: "", name: "成员" }], { root }), /编号无效/);
  assert.throws(() => prepareAgentWorkspaces([{ id: "a", name: "甲" }, { id: "a", name: "乙" }], { root }), /编号无效或重复/);
  fs.writeFileSync(path.join(root, "成员"), "existing-file");
  assert.throws(() => prepareAgentWorkspaces([{ id: "a", name: "成员" }], { root }), /不是目录/);
  assert.equal(fs.readFileSync(path.join(root, "成员"), "utf8"), "existing-file");
});

test("自动工作区忽略其他电脑的绝对路径，显式项目保留本机严格校验", (t) => {
  const root = temporaryRoot(t);
  const foreign = temporaryRoot(t);
  const agent = { id: "coder", name: "工程师", workspace: foreign, workspaceMode: "auto" };
  const workspace = resolveAgentWorkspace(agent, { root });
  assert.equal(workspace, path.join(fs.realpathSync(root), "工程师"));
  assert.notEqual(workspace, fs.realpathSync(foreign));
  assert.equal(prepareAgentWorkspaces([agent], { root })[0].workspace, workspace);
  assert.equal(resolveAgentWorkspace({ ...agent, workspaceMode: "project" }, { root }), fs.realpathSync(foreign));
  assert.throws(() => resolveAgentWorkspace({ ...agent, workspaceMode: "project", workspace: "/chorus/missing-project" }, { root }), /工作区不存在/);
  assert.throws(() => resolveAgentWorkspace({ ...agent, workspaceMode: "project", workspace: "" }, { root }), /项目目录未填写/);
});
