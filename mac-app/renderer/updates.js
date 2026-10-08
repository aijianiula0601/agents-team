/* 在线更新：检查公开版本清单，安装包下载与完整性验证交给原生层。 */
(function defineUpdates(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChorusUpdates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function updatesModule() {
  "use strict";

  /**
   * 比较三段稳定版本号。
   * @param {string} left 待比较版本；right 当前版本
   * @returns {number} 大于、等于、小于分别返回正数、零、负数
   * 注意事项：只接受稳定版本，非法或预发布版本不参与自动更新。
   */
  function compareVersions(left, right) {
    const pattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
    if (!pattern.test(left) || !pattern.test(right)) throw new Error("版本号格式无效，请使用 x.y.z");
    const a = left.split(".").map(Number), b = right.split(".").map(Number);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  }

  /**
   * 校验更新清单是否适用于当前设备。
   * @param {object|null} release 服务端清单；info 原生版本；base 中转站地址
   * @returns {object|null} 可更新清单或无更新
   * 注意事项：拒绝跨源、跨平台、降级和不完整清单；原生下载前会再次校验。
   */
  function validateRelease(release, info, base) {
    if (release == null) return null;
    if (!release.id || release.platform !== info.platform || ![info.arch, "universal"].includes(release.arch)
      || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > 2 * 1024 ** 3
      || !/^[a-f0-9]{64}$/i.test(release.sha256 || "") || typeof release.notes !== "string") throw new Error("更新清单不完整或不适用于当前设备");
    const source = new URL(base), download = new URL(release.downloadUrl, `${base}/`);
    if (download.origin !== source.origin || download.username || download.password || download.hash
      || !download.pathname.startsWith(`${source.pathname.replace(/\/+$/, "")}/api/v1/releases/`)) throw new Error("更新下载地址不可信");
    const newer = compareVersions(release.version, info.version);
    if (info.platform === "android") {
      if (!Number.isSafeInteger(release.buildNumber) || release.buildNumber < 1) throw new Error("Android 更新缺少有效构建号");
      if (release.buildNumber <= info.buildNumber || newer < 0) return null;
    } else if (newer <= 0) return null;
    return { ...release, downloadUrl: download.href };
  }

  /**
   * 创建两端共享的更新状态控制器。
   * @param {object} options 注入原生适配器、请求、中转地址、状态回调、日志和时钟
   * @returns {object} check、download、invalidate 与 snapshot 操作
   * 注意事项：不依赖登录，不存储秘密，服务器切换后丢弃旧清单及晚到响应。
   */
  function createController({ adapter, request, getBaseUrl, onChange = () => {}, log = () => {}, now = Date.now }) {
    let view = { status: adapter ? "idle" : "unsupported", info: null, release: null, message: "", percent: 0, checkedAt: null };
    let generation = 0, checking = null, downloading = null, checkedBase = "", permissionWaiting = false, progressUnsubscribe = null;

    /** 发布状态；参数 patch 为变化字段；返回新状态；注意不暴露内部可变对象。 */
    function update(patch) { view = { ...view, ...patch }; onChange({ ...view }); return { ...view }; }

    /** 清除旧站点清单；无参数及返回值；注意下载进行中由界面阻止更换中转站。 */
    function invalidate() { generation++; checking = null; checkedBase = ""; update({ status: adapter ? "idle" : "unsupported", release: null, message: "", checkedAt: null }); }

    /**
     * 查询当前设备可用版本。
     * @param {boolean} force 手动检查可绕过一分钟节流
     * @returns {Promise<object>} 更新后的视图状态
     * 注意事项：合并重复检查，错误保留重试入口，下载期间不打断状态。
     */
    async function check(force = false) {
      if (!adapter || downloading || permissionWaiting) return { ...view };
      const base = getBaseUrl();
      if (checkedBase && checkedBase !== base) invalidate();
      if (checking) return checking;
      if (!force && view.checkedAt && now() - view.checkedAt < 60_000) return { ...view };
      const epoch = ++generation;
      checkedBase = base;
      update({ status: "checking", message: "正在检查新版本…", release: null });
      // ------------ 读取安装版本并获取最新清单 ---------------
      checking = (async () => {
        try {
          const info = await adapter.getUpdateInfo();
          if (epoch !== generation || base !== getBaseUrl()) return { ...view };
          update({ info });
          const params = new URLSearchParams({ platform: info.platform, arch: info.arch, currentVersion: info.version, currentBuild: String(info.buildNumber || 0) });
          const payload = await request(base, "GET", `/api/v1/releases/latest?${params}`, "");
          if (epoch !== generation || base !== getBaseUrl()) return { ...view };
          if (!payload || !Object.hasOwn(payload, "release")) throw new Error("中转站返回了无效的更新清单");
          const release = validateRelease(payload.release, info, base);
          log(`更新检查完成 platform=${info.platform} current=${info.version} available=${release?.version || "none"}`);
          return update({ status: release ? "available" : "current", release, checkedAt: now(), message: release ? `发现新版本 ${release.version}` : "当前已是最新版本" });
        } catch (error) {
          if (epoch !== generation || base !== getBaseUrl()) return { ...view };
          const message = error.status === 404 ? "此中转站尚未启用版本发布" : `检查失败：${error.message || "请检查网络后重试"}`;
          log(`更新检查失败 status=${error.status || "unknown"}`);
          return update({ status: "error", message, checkedAt: now() });
        } finally { if (epoch === generation) checking = null; }
      })();
      return checking;
    }

    /**
     * 下载选定版本并交给系统安装。
     * @param 无
     * @returns {Promise<object>} 下载或安装界面状态
     * 注意事项：重复点击合并；只原生层保存安装包，网页不接触安装文件路径。
     */
    async function download() {
      if (downloading) return downloading;
      if (permissionWaiting) return { ...view };
      if (!adapter || !view.release) return { ...view };
      if (checkedBase !== getBaseUrl()) { invalidate(); return check(true); }
      const release = view.release, base = checkedBase, epoch = generation;
      update({ status: "downloading", percent: 0, message: "正在下载更新…" });
      // ------------ 原生流式下载、校验与安装 ---------------
      downloading = (async () => {
        try {
          progressUnsubscribe?.();
          progressUnsubscribe = await adapter.subscribe((progress) => {
            if (epoch !== generation) return;
            const status = ["downloading", "verifying", "ready", "installing", "error"].includes(progress.status) ? progress.status : "downloading";
            update({ status, percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)), message: String(progress.message || ""), ...(["installing", "error"].includes(status) ? { permissionRequired: false } : {}) });
            if (permissionWaiting && ["installing", "error"].includes(status)) { permissionWaiting = false; progressUnsubscribe?.(); progressUnsubscribe = null; }
          });
          const result = await adapter.downloadUpdate({ relayUrl: base, release });
          if (epoch !== generation) return { ...view };
          permissionWaiting = Boolean(result.permissionRequired);
          log(`更新安装包处理完成 version=${release.version} status=${result.status}`);
          return update({ status: result.permissionRequired ? "ready" : "installing", percent: 100, permissionRequired: Boolean(result.permissionRequired), message: result.permissionRequired ? "请在系统设置允许安装应用，返回后继续安装" : "已打开系统安装界面，请按提示完成安装" });
        } catch (error) {
          if (epoch !== generation) return { ...view };
          log(`更新下载失败 version=${release.version}`);
          return update({ status: "error", message: `更新失败：${error.message || "请重试"}` });
        } finally { if (!permissionWaiting) { progressUnsubscribe?.(); progressUnsubscribe = null; } downloading = null; }
      })();
      return downloading;
    }

    return { check, download, invalidate, snapshot: () => ({ ...view }), isBusy: () => Boolean(downloading || permissionWaiting) };
  }

  return { compareVersions, validateRelease, createController };
});
