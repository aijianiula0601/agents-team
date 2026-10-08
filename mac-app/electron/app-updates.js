const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const log = require("./log");

const MAX_PACKAGE_SIZE = 2 * 1024 * 1024 * 1024;

/** 规范化更新源；参数为地址和开发标记；返回 URL；禁止凭据、查询及非回环明文地址。 */
function relayAddress(value, development) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("更新服务地址无效");
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(development && local && url.protocol === "http:"))) throw new Error("更新服务必须使用可信 HTTPS 地址");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** 比较正式版本；参数为新版和当前版本；返回是否升级；不接受不明确的版本格式或降级。 */
function newerVersion(next, current) {
  if (![next, current].every((value) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value))) return false;
  const before = current.split(".").map(Number);
  const after = next.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (after[index] !== before[index]) return after[index] > before[index];
  }
  return false;
}

/** 请求同源资源；参数为地址、可信源及中止信号；返回成功响应；每次重定向重新校验且最多四次。 */
async function sameOriginResponse(address, origin, signal) {
  let url = new URL(address);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    if (url.origin !== origin || url.username || url.password || url.hash) throw new Error("更新下载地址或重定向不可信");
    const response = await fetch(url, { redirect: "manual", signal, headers: { "Accept-Encoding": "identity" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("更新服务重定向缺少地址");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`更新服务响应异常（${response.status}）`);
    }
    return response;
  }
  throw new Error("更新服务重定向次数过多");
}

/**
 * 管理单个桌面升级下载。
 * 参数：Electron app、shell、进度回调及原生可信更新源；返回只读信息和下载接口。
 * 注意事项：正式包仅接受显式配置的原生可信源；页面传入的安装包元数据不能作为下载依据。
 */
function createAppUpdater({ app, shell, onProgress = () => {}, trustedRelay = process.env.CHORUS_UPDATE_RELAY_URL || "" }) {
  let active = false;

  /** 读取原生安装版本；无参数；返回平台、CPU 和版本；不从网页读取版本号。 */
  function getUpdateInfo() {
    return { platform: "mac", arch: process.arch, version: app.getVersion(), buildNumber: 0 };
  }

  /**
   * 下载并打开安装包；参数为 relayUrl 和页面选中的 release；返回安装器打开状态。
   * 注意事项：重新获取最新清单、流式校验大小及 SHA-256，失败清除临时文件，全程只允许一个任务。
   */
  async function downloadUpdate(payload) {
    if (active) throw new Error("已有更新正在下载，请稍候");
    active = true;
    let temporary = "";
    let received = 0;
    let total = 0;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("更新下载超时，请重试")), 30 * 60 * 1000);
    let idleTimeout;
    /** 更新空闲截止时间；无参数、无返回值；网络连续三十秒无数据时中断下载。 */
    function refreshIdleTimeout() {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(new Error("更新下载无响应，请重试")), 30000);
    }
    /** 发送安全进度；参数为阶段和可选提示；无返回值；不暴露本地文件路径。 */
    function progress(status, message) {
      onProgress({ status, received, total, percent: total ? Math.min(100, Math.floor(received * 100 / total)) : 0, ...(message ? { message } : {}) });
    }
    try {
      const base = relayAddress(payload?.relayUrl, !app.isPackaged);
      const localDevelopment = !app.isPackaged && base.protocol === "http:";
      // ------------ 安装包仅信任构建方显式配置的更新源，本地调试可使用回环地址 ---------------
      if (!trustedRelay && !localDevelopment) throw new Error("请先配置原生可信更新源");
      if (trustedRelay && base.href !== relayAddress(trustedRelay, !app.isPackaged).href && !localDevelopment) throw new Error("该中转站尚未配置为原生可信更新源");
      if (!payload?.release?.id || typeof payload.release.id !== "string") throw new Error("更新版本无效，请重新检查更新");
      const info = getUpdateInfo();
      const manifestUrl = new URL(`${base.href.replace(/\/$/, "")}/api/v1/releases/latest`);
      for (const [key, value] of Object.entries({ platform: info.platform, arch: info.arch, currentVersion: info.version, currentBuild: info.buildNumber })) manifestUrl.searchParams.set(key, value);
      log.info("------------- 校验桌面更新清单 --------------");
      refreshIdleTimeout();
      const response = await sameOriginResponse(manifestUrl, base.origin, controller.signal);
      const chunks = [];
      let manifestBytes = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        refreshIdleTimeout();
        manifestBytes += chunk.length;
        if (manifestBytes > 1024 * 1024) throw new Error("更新清单过大");
        chunks.push(chunk);
      }
      const release = JSON.parse(Buffer.concat(chunks).toString("utf8")).release;
      if (!release || release.id !== payload.release.id || release.platform !== "mac" || ![info.arch, "universal"].includes(release.arch) || !newerVersion(release.version, info.version)) throw new Error("更新版本已变化或不适用于本机，请重新检查更新");
      if (!Number.isSafeInteger(release.size) || release.size <= 0 || release.size > MAX_PACKAGE_SIZE || !/^[a-f0-9]{64}$/i.test(release.sha256) || typeof release.fileName !== "string" || !release.fileName.toLowerCase().endsWith(".dmg") || typeof release.downloadUrl !== "string") throw new Error("更新清单的文件信息无效");
      total = release.size;
      const downloadUrl = new URL(release.downloadUrl, `${base.href.replace(/\/$/, "")}/`);
      log.info(`------------- 下载桌面更新 ${release.version}，${total} 字节 --------------`);
      progress("downloading");
      refreshIdleTimeout();
      const download = await sameOriginResponse(downloadUrl, base.origin, controller.signal);
      const length = download.headers.get("content-length");
      if (length !== null && Number(length) !== total) {
        await download.body.cancel();
        throw new Error("安装包大小与发布清单不一致");
      }
      const directory = path.join(app.getPath("userData"), "updates");
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      temporary = path.join(directory, `${crypto.randomUUID()}.part`);
      const destination = path.join(directory, "Chorus-update.dmg");
      const hash = crypto.createHash("sha256");
      let lastProgress = 0;
      const verifier = new Transform({
        /** 流式计数和摘要；参数为数据块、编码、回调；无返回值；超出声明大小立即拒绝。 */
        transform(chunk, _encoding, callback) {
          refreshIdleTimeout();
          received += chunk.length;
          if (received > total) return callback(new Error("安装包超过声明大小"));
          hash.update(chunk);
          if (Date.now() - lastProgress >= 250) { progress("downloading"); lastProgress = Date.now(); }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(download.body), verifier, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      clearTimeout(idleTimeout);
      progress("verifying");
      if (received !== total || hash.digest("hex") !== release.sha256.toLowerCase()) throw new Error("安装包完整性校验失败，请重新下载");
      await fs.promises.rename(temporary, destination);
      temporary = "";
      progress("ready");
      const openError = await shell.openPath(destination);
      if (openError) throw new Error("无法打开安装包，请重试或联系管理员");
      progress("installing", "安装包已打开，请将 Chorus 拖入应用程序文件夹完成更新");
      log.info(`桌面更新 ${release.version} 已验证并打开安装包`);
      return { status: "installing" };
    } catch (error) {
      const message = controller.signal.aborted ? "更新下载超时，请重试" : error.message;
      progress("error", message);
      log.error("桌面更新失败", error);
      throw new Error(message);
    } finally {
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(idleTimeout);
      if (temporary) await fs.promises.unlink(temporary).catch(() => {});
      active = false;
    }
  }
  return { getUpdateInfo, downloadUpdate };
}

module.exports = { createAppUpdater, newerVersion, relayAddress };
