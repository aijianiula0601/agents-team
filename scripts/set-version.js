#!/usr/bin/env node
/**
 * 统一设置双端下一次发布版本，并递增 Android 构建号。
 * 参数：命令行第一个参数为 x.y.z，第二个可选参数为新的 Android versionCode。
 * 返回值：成功时退出码 0，参数错误时非零。
 * 注意事项：只更新版本元数据，不构建或上传；Android 同一发布渠道必须保持签名不变。
 */
const fs = require("node:fs");
const path = require("node:path");
const { compareVersions } = require("../shared/web/updates");
const log = require("../mac-app/electron/log");

const root = path.resolve(__dirname, "..");
const version = process.argv[2];
const gradlePath = path.join(root, "android-app/android/app/build.gradle");
const gradle = fs.readFileSync(gradlePath, "utf8");
const currentBuild = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
const build = process.argv[3] === undefined ? currentBuild + 1 : Number(process.argv[3]);
const packages = ["mac-app/package.json", "mac-app/package-lock.json", "android-app/package.json", "android-app/package-lock.json"];

try {
  log.info("------------- 校验发布版本 --------------");
  const edits = packages.map((name) => {
    const file = path.join(root, name), data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (compareVersions(version, data.version) <= 0) throw new Error(`新版本必须高于 ${name} 当前版本 ${data.version}`);
    data.version = version;
    if (data.packages?.[""]) data.packages[""].version = version;
    return [file, `${JSON.stringify(data, null, 2)}\n`];
  });
  if (!Number.isSafeInteger(build) || build <= currentBuild || build > 2100000000) throw new Error(`Android 构建号必须是大于 ${currentBuild} 且不超过 2100000000 的整数`);
  edits.push([gradlePath, gradle.replace(/versionCode\s+\d+/, `versionCode ${build}`).replace(/versionName\s+"[^"]+"/, `versionName "${version}"`)]);
  const htmlPath = path.join(root, "shared/web/index.html");
  edits.push([htmlPath, fs.readFileSync(htmlPath, "utf8").replace(/\?v=\d+\.\d+\.\d+/g, `?v=${version}`)]);
  const appPath = path.join(root, "shared/web/app.js");
  edits.push([appPath, fs.readFileSync(appPath, "utf8").replace(/appInfo: \{ name: "Chorus", version: "[^"]+" \}/, `appInfo: { name: "Chorus", version: "${version}" }`)]);
  // ------------ 所有参数通过后统一更新源文件 ---------------
  for (const [file, content] of edits) fs.writeFileSync(file, content);
  log.info(`发布版本已设置 version=${version} androidBuild=${build}；下一步运行 scripts/build-mac.sh 和 scripts/build-apk.sh，再在管理页上传发布。`);
} catch (error) {
  log.error("设置发布版本失败", error);
  process.exitCode = 1;
}
