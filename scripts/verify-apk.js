#!/usr/bin/env node
/**
 * 校验 Android 交付包并保存可复核报告。
 * 参数：APK 路径、Android Build Tools 目录、报告路径；环境变量提供预期证书及历史签名开关。
 * 返回值：成功退出 0，校验失败退出 1。
 * 注意事项：只读取本地 APK，不上传文件；这些检查不能替代手机厂商的恶意软件检测。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const log = require("../mac-app/electron/log");

const legacyCertificate = "b6b00d787ded826ebdd47909531adffb6b9a9f31ca7a36ccccc6249e72f1c859";

/**
 * 检查真实 APK 的签名、发布属性、版本和权限。
 * @param {object} options 安装包、工具目录、预期版本/构建号/证书及历史签名开关
 * @returns {object} 不包含密钥的安装包检查报告
 * 注意事项：历史兼容模式只接受已交付 0.5.5 的原证书，不接受任意新建调试证书。
 */
function verifyApk({ apkPath, buildTools, version, buildNumber, certificate, legacySigning = false }) {
  if (!/^[a-f0-9]{64}$/i.test(certificate || "")) throw new Error("必须提供有效的预期签名证书 SHA-256");
  const options = { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 };
  const badging = execFileSync(path.join(buildTools, "aapt"), ["dump", "badging", apkPath], options);
  const manifest = execFileSync(path.join(buildTools, "aapt"), ["dump", "xmltree", apkPath, "AndroidManifest.xml"], options);
  const pkg = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  if (!pkg || pkg[1] !== "com.chorus.app" || Number(pkg[2]) !== buildNumber || pkg[3] !== version) throw new Error("APK 包名或版本与项目配置不一致");
  if (badging.includes("application-debuggable") || /android:testOnly[^\n]*0xffffffff/.test(manifest)) throw new Error("禁止交付可调试或 testOnly APK");
  const permissions = [...badging.matchAll(/^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gm)].map((match) => match[1]);
  const allowed = new Set(["android.permission.INTERNET", "android.permission.REQUEST_INSTALL_PACKAGES", "com.chorus.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"]);
  if (permissions.some((permission) => !allowed.has(permission))) throw new Error(`APK 出现未经审核的权限：${permissions.filter((permission) => !allowed.has(permission)).join(", ")}`);
  for (const permission of allowed) {
    if (!permissions.includes(permission)) throw new Error(`APK 缺少现有功能所需权限：${permission}`);
  }
  // ------------ 校验真实签名与对齐，避免仅检查源码却交付错误产物 ---------------
  const signing = execFileSync(path.join(buildTools, "apksigner"), ["verify", "--verbose", "--print-certs", apkPath], options);
  const certificates = [...signing.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)$/gm)].map((match) => match[1]);
  if (certificates.length !== 1 || certificates[0] !== certificate.toLowerCase()) throw new Error("APK 签名与预期证书不一致，不能作为原渠道更新包交付");
  if (legacySigning ? certificates[0] !== legacyCertificate : certificates[0] === legacyCertificate || /certificate DN:.*CN=Android Debug/.test(signing)) throw new Error("调试证书只能通过明确的历史兼容签名模式使用");
  execFileSync(path.join(buildTools, "zipalign"), ["-c", "-p", "4", apkPath], options);
  const report = {
    packageName: pkg[1], version, buildNumber, debuggable: false, testOnly: false, permissions,
    signingMode: legacySigning ? "legacy-upgrade" : "release", certificateSha256: certificates[0],
    size: fs.statSync(apkPath).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex"),
    signatureVerified: true, zipAligned: true, deviceMalwareScanVerified: false,
  };
  log.info(`APK 检查通过 version=${version} build=${buildNumber} debuggable=false signing=${report.signingMode} sha256=${report.sha256}`);
  return report;
}

if (require.main === module) {
  try {
    log.info("------------- 校验 Android 交付包 --------------");
    const [apkPath, buildTools, reportPath] = process.argv.slice(2);
    if (!apkPath || !buildTools || !reportPath) throw new Error("用法：node scripts/verify-apk.js APK路径 BuildTools目录 报告路径");
    const root = path.resolve(__dirname, "..");
    const gradle = fs.readFileSync(path.join(root, "android-app/android/app/build.gradle"), "utf8");
    const version = JSON.parse(fs.readFileSync(path.join(root, "android-app/package.json"), "utf8")).version;
    const buildNumber = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
    const report = verifyApk({ apkPath, buildTools, version, buildNumber, certificate: process.env.CHORUS_ANDROID_EXPECTED_CERT_SHA256, legacySigning: process.env.CHORUS_ANDROID_LEGACY_SIGNING === "1" });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    log.error("Android 交付包检查失败", error);
    process.exitCode = 1;
  }
}

module.exports = { verifyApk, legacyCertificate };
