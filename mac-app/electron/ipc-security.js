const path = require("path");
const { fileURLToPath } = require("url");

/**
 * 只允许主窗口的本地顶层 frame 调用高权限 IPC，避免未来引入 iframe 或意外导航后越权。
 * @param {Electron.IpcMainInvokeEvent} event IPC 事件
 * @param {Electron.WebContents} expectedWebContents 主窗口 webContents
 * @param {string} rendererFile 允许的本地页面
 * @returns {void}
 */
function assertTrustedIpc(event, expectedWebContents, rendererFile) {
  if (!event || !expectedWebContents || event.sender !== expectedWebContents) {
    throw new Error("拒绝来自未知窗口的请求");
  }
  const frame = event.senderFrame;
  if (!frame || frame !== expectedWebContents.mainFrame) {
    throw new Error("拒绝来自子页面的请求");
  }
  if (!isTrustedRendererUrl(frame.url, rendererFile)) throw new Error("拒绝来自未知页面的请求");
}

function isTrustedRendererUrl(rawUrl, rendererFile) {
  try {
    const source = new URL(rawUrl);
    if (source.protocol !== "file:") return false;
    // loadFile 会带上 ?platform=mac，比较路径前去掉查询串，避免误拒主窗口。
    source.search = "";
    source.hash = "";
    return path.resolve(fileURLToPath(source)) === path.resolve(rendererFile);
  } catch (_error) {
    return false;
  }
}

/**
 * 仅允许把普通网页链接交给系统浏览器，禁止 file/javascript/data 等协议。
 * @param {string} rawUrl 待打开 URL
 * @returns {boolean}
 */
function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
  } catch (_error) {
    return false;
  }
}

module.exports = { assertTrustedIpc, isSafeExternalUrl, isTrustedRendererUrl };
