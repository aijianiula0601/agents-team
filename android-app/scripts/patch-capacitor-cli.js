/** Capacitor CLI 6 的旧默认导入不兼容 tar 7；保持安全依赖并兼容模板解压。 */
const fs = require("node:fs");
const path = require("node:path");

const cliRoot = path.dirname(require.resolve("@capacitor/cli/package.json"));
const file = path.join(cliRoot, "dist/util/template.js");
const source = fs.readFileSync(file, "utf8");
const before = 'const tar_1 = tslib_1.__importDefault(require("tar"));';
const after = 'const tar_1 = { default: require("tar") };';

if (typeof require("tar").extract !== "function") {
  throw new Error("tar.extract 不可用，请重新安装 Android 构建依赖");
}
if (source.includes(before)) {
  fs.writeFileSync(file, source.replace(before, after));
  console.log("[chorus] 已修正 Capacitor CLI 6 与 tar 7 的模板导入兼容性");
} else if (!source.includes(after)) {
  throw new Error("Capacitor CLI 模板实现已改变，请检查 tar 导入兼容性");
}
