const log = require("./log");

/**
 * 增量读取模型 SSE 或 NDJSON，返回累计正文并即时通知调用者。
 * @param {Response} response 已鉴权且 HTTP 成功的模型响应
 * @param {object} options provider、label、onText、onActivity 以及正文和字节上限
 * @returns {Promise<string>} 模型最终正文
 * 注意事项：按 UTF-8 解码跨包字符；错误和未结束的流不能被误判为成功，日志不含正文。
 */
async function readModelStream(response, options) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${options.label}没有返回内容`);
  const decoder = new TextDecoder();
  const sse = /text\/event-stream/i.test(response.headers.get("content-type") || "");
  let buffer = "";
  let eventLines = [];
  let text = "";
  let size = 0;
  let finished = false;

  /** 解析单条模型事件；参数为 JSON 或结束标记；无返回值；只公开回复正文。 */
  function accept(raw) {
    if (!raw.trim()) return;
    if (raw.trim() === "[DONE]") { finished = true; return; }
    let event;
    try { event = JSON.parse(raw); } catch (_) { throw new Error(`${options.label}返回了无法解析的流式数据`); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(`${options.label}返回的流式数据格式无效`);
    if (event.error || event.type === "error") {
      const detail = typeof event.error === "string" ? event.error : event.error?.message || event.message || "流式生成失败";
      throw new Error(`${options.label}请求失败：${String(detail).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000)}`);
    }
    let delta = "";
    if (options.provider === "anthropic") {
      if (event.type === "content_block_start" && event.content_block?.type === "text") delta = event.content_block.text || "";
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") delta = event.delta.text || "";
      if (event.type === "message_stop") finished = true;
    } else if (options.provider === "ollama") {
      delta = event.message?.content || "";
      if (event.done === true) finished = true;
    } else {
      const choice = event.choices?.find((item) => item.index === 0) || event.choices?.[0];
      const content = choice?.delta?.content;
      delta = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text || "").join("") : "";
      if (choice?.finish_reason) finished = true;
    }
    if (typeof delta !== "string" || !delta) return;
    if (text.length + delta.length > options.maxTextLength) throw new Error(`${options.label}返回内容过长`);
    text += delta;
    // ------------ 将真实生成片段累计后交给 IPC 或手机增量通道 ---------------
    if (typeof options.onText === "function") {
      try { options.onText(text); } catch (_) { log.error("模型流式展示回调失败，继续读取响应"); }
    }
  }

  /** 处理完整的一行；参数为去掉换行符的内容；无返回值；SSE 多行 data 按事件边界合并。 */
  function line(value) {
    if (!sse) { accept(value); return; }
    if (!value) {
      if (eventLines.length) accept(eventLines.join("\n"));
      eventLines = [];
    } else if (value.startsWith("data:")) eventLines.push(value.slice(5).replace(/^ /, ""));
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) throw new Error(`${options.label}返回内容过大`);
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
      if (finished) { await reader.cancel(); break; }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer.replace(/\r$/, ""));
    if (eventLines.length) accept(eventLines.join("\n"));
    if (!finished) throw new Error(`${options.label}响应中断，请重试`);
    log.info(`模型流式回复完成 provider=${options.provider} bytes=${size} chars=${text.length}`);
    return text;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

module.exports = { readModelStream };
