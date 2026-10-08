/**
 * Chorus 主进程日志。
 * 功能：把关键流程写到 stdout，便于开发时看执行痕迹。
 * 注意事项：禁止把 API Key、OAuth code、token 传进来。
 */

/**
 * 记录一条信息日志。
 * @param {string} message 已脱敏的说明
 * @returns {void}
 */
function info(message) {
  console.log(`[chorus] ${message}`);
}

/**
 * 记录一条错误日志。
 * @param {string} message 错误说明
 * @param {unknown} [error] 原始异常，只输出 message
 * @returns {void}
 */
function error(message, error) {
  const detail = error instanceof Error ? error.message : "";
  console.error(`[chorus] ${message}${detail ? ` ${detail}` : ""}`);
}

module.exports = { info, error };
