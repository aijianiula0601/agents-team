const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * 展开用户目录缩写，供可执行文件和工作区路径共用。
 * @param {string} input 用户路径
 * @returns {string} 展开后的路径；未填写时返回空字符串
 * 注意事项：不创建目录，不将远端路径映射为本机路径。
 */
function expandHome(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (raw === "~") return os.homedir();
  return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}

/**
 * 校验显式项目目录在执行电脑真实存在且可读写。
 * @param {string} input 本机项目路径
 * @returns {string} 消除符号链接后的绝对路径
 * 注意事项：不创建或替换显式项目；自动目录由 agent-workspaces 模块准备。
 */
function validateWorkspace(input) {
  if (typeof input !== "string") throw new Error("工作区路径格式无效");
  const expanded = expandHome(input);
  if (!expanded) throw new Error("项目目录未填写，请使用自动管理或选择已有项目");
  const absolute = path.resolve(expanded);
  try {
    const resolved = fs.realpathSync(absolute);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not-directory");
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    return resolved;
  } catch (_error) {
    throw new Error(`工作区不存在、不是目录或不可写：${absolute}`);
  }
}

module.exports = { expandHome, validateWorkspace };
