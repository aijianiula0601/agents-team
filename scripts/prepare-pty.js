/** node-pty 的 npm 预编译包未保留 spawn-helper 执行位，开发与打包时统一补齐。 */
const fs = require("node:fs");
const path = require("node:path");

function prepare(directory, platform = process.platform, arch = process.arch) {
  let nativeDirectory = "";
  for (const subdir of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const candidate = path.join(directory, subdir);
    if (!nativeDirectory && fs.existsSync(path.join(candidate, "pty.node"))) nativeDirectory = candidate;
    const helper = path.join(candidate, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  if (platform === "darwin" && (!nativeDirectory || !fs.existsSync(path.join(nativeDirectory, "spawn-helper")))) {
    throw new Error(`node-pty 终端组件不完整，缺少 ${arch} 原生模块或 spawn-helper：${directory}`);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents/Resources");
  const arch = typeof context.arch === "string" ? context.arch : context.arch === 0 ? "x64" : "arm64";
  prepare(path.join(resources, "app.asar.unpacked/node_modules/node-pty"), "darwin", arch);
};

if (require.main === module) {
  const pkg = require.resolve("node-pty/package.json", { paths: [path.join(__dirname, "../mac-app")] });
  prepare(path.dirname(pkg));
}
