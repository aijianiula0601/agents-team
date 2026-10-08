const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const afterPack = require("./prepare-pty");

function bundle(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-prepare-pty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = path.join(root, "Chorus.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty");
  const context = { electronPlatformName: "darwin", arch: 3, appOutDir: root, packager: { appInfo: { productFilename: "Chorus" } } };
  return { root, module, context };
}

test("mac 包必须包含当前架构原生模块与可执行 helper", async (t) => {
  const { module, context } = bundle(t);
  const native = path.join(module, "prebuilds/darwin-arm64");
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, "pty.node"), "synthetic module");
  fs.writeFileSync(path.join(native, "spawn-helper"), "synthetic helper", { mode: 0o644 });
  await afterPack(context);
  assert.equal(fs.statSync(path.join(native, "spawn-helper")).mode & 0o111, 0o111);
});

test("Release 模块优先被加载时，不允许只有 prebuild 目录包含 helper", async (t) => {
  const { module, context } = bundle(t);
  for (const dir of ["build/Release", "prebuilds/darwin-arm64"]) {
    fs.mkdirSync(path.join(module, dir), { recursive: true });
    fs.writeFileSync(path.join(module, dir, "pty.node"), "synthetic module");
  }
  fs.writeFileSync(path.join(module, "prebuilds/darwin-arm64/spawn-helper"), "synthetic helper");
  await assert.rejects(afterPack(context), /组件不完整/);
});

test("缺少 unpacked 终端组件时构建失败，避免交付不能启动终端的包", async (t) => {
  const { context } = bundle(t);
  await assert.rejects(afterPack(context), /组件不完整/);
});
