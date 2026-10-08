const log = require("./log");
const { readModelStream } = require("./model-stream");

const REQUEST_TIMEOUT_MS = 120000;
const MAX_RESPONSE_LENGTH = 200000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const ALLOWED_PROVIDERS = new Set(["openai", "anthropic", "local", "custom"]);

/**
 * 按 Agent 的 Provider 调用真实对话模型。
 * @param {object} agent Agent 配置
 * @param {{role: string, content: string}[]} messages 不含 system 的近期对话
 * @param {{openai?: string, anthropic?: string, custom?: string, ollamaBase?: string}} [keys] 主进程密钥
 * @param {{signal?: AbortSignal, onText?: (text: string) => void}} [options] 取消信号和累计正文回调
 * @returns {Promise<string>} 模型回复正文
 */
async function completeChat(agent, messages, keys = {}, options = {}) {
  const normalizedAgent = normalizeAgent(agent);
  const normalizedMessages = normalizeMessages(messages);
  const provider = normalizedAgent.provider;
  const system = `你是 ${normalizedAgent.name || "Agent"}，角色：${normalizedAgent.role || "协作者"}。\n${normalizedAgent.persona}\n请根据提供的对话上下文协作，用中文直接回复，无法确认的内容应明确说明。`;
  log.info(`对话请求 provider=${provider} model=${normalizedAgent.model || ""}`);

  if (provider === "anthropic") {
    return completeAnthropic(normalizedAgent, system, normalizedMessages, cleanSecret(keys.anthropic), options);
  }
  if (provider === "local") {
    const base = normalizeBaseUrl(keys.ollamaBase || "http://127.0.0.1:11434", {
      label: "Ollama Base URL",
      localOnly: true,
    });
    return completeOllama(normalizedAgent, system, normalizedMessages, base, options);
  }

  const isCustom = provider === "custom";
  const base = isCustom
    ? normalizeBaseUrl(normalizedAgent.endpoint, { label: "自定义 Endpoint", localOnly: false })
    : "https://api.openai.com/v1";
  return completeOpenAI(normalizedAgent, system, normalizedMessages, cleanSecret(isCustom ? keys.custom : keys.openai), base, !isCustom, options);
}

/**
 * 调用 OpenAI 兼容的 chat completions。
 */
async function completeOpenAI(agent, system, messages, apiKey, baseUrl, requireKey, options) {
  if (requireKey && !apiKey) {
    throw new Error("还没有 OpenAI API Key。请到设置 → 模型与密钥里填写。");
  }
  if (!baseUrl) throw new Error("自定义 Endpoint 为空");
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model: agent.model || "gpt-4.1",
    stream: true,
    messages: [{ role: "system", content: system }, ...messages],
  };
  // 推理模型不接受自由温度参数；桌面与手机应发送相同的模型配置。
  if (!/^(gpt-5|o[134])(?:[.-]|$)/i.test(body.model)) body.temperature = agent.temperature;
  const json = await fetchJson(joinUrl(baseUrl, "chat/completions"), {
    ...options,
    label: "模型",
    streamProvider: "openai",
    headers,
    body,
  });
  const text = json.streamedText ?? extractOpenAIText(json.choices?.[0]?.message?.content);
  if (!text.trim()) throw new Error("模型没有返回内容");
  return limitModelOutput(text);
}

/**
 * 调用 Anthropic Messages API。
 */
async function completeAnthropic(agent, system, messages, apiKey, options) {
  if (!apiKey) throw new Error("还没有 Anthropic API Key。请到设置 → 模型与密钥里填写。");
  const anthropicMessages = mergeConsecutiveMessages(messages);
  if (anthropicMessages[0]?.role === "assistant") {
    anthropicMessages.unshift({ role: "user", content: "请结合此前对话继续回答。" });
  }
  const json = await fetchJson("https://api.anthropic.com/v1/messages", {
    ...options,
    label: "Anthropic",
    streamProvider: "anthropic",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: {
      model: agent.model || "claude-sonnet-4-5",
      stream: true,
      max_tokens: 2048,
      temperature: agent.temperature,
      system,
      messages: anthropicMessages,
    },
  });
  const text = json.streamedText ?? (Array.isArray(json.content) ? json.content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
  if (!text.trim()) throw new Error("Anthropic 没有返回内容");
  return limitModelOutput(text);
}

/**
 * 调用本机 Ollama chat 接口。
 */
async function completeOllama(agent, system, messages, baseUrl, options) {
  const json = await fetchJson(joinUrl(baseUrl, "api/chat"), {
    ...options,
    label: "Ollama",
    streamProvider: "ollama",
    headers: { "Content-Type": "application/json" },
    body: {
      model: agent.model || "qwen2.5",
      stream: true,
      messages: [{ role: "system", content: system }, ...messages],
    },
  });
  const text = json.streamedText ?? (typeof json.message?.content === "string" ? json.message.content.trim() : "");
  if (!text.trim()) throw new Error("Ollama 没有返回内容");
  return limitModelOutput(text);
}

/**
 * 发送模型请求并读取普通 JSON 或真实流式回复。
 * @param {string} url 已验证的模型接口
 * @param {object} options 请求体、凭据、取消信号、流式类型和可选空闲超时
 * @returns {Promise<object>} 模型 JSON 或包含 streamedText 的流式结果
 * 注意事项：超时衡量连续无数据时长，持续生成不受总时长限制；所有错误仍遮蔽密钥。
 */
async function fetchJson(url, options) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) throw new Error("任务已停止");
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer;
  /** 续期网络空闲计时；无参数和返回值；不会限制活跃长任务的总时长。 */
  const activity = () => {
    clearTimeout(timer);
    timer = setTimeout(abort, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    timer.unref?.();
  };
  activity();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      redirect: "error",
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error(`${options.label}返回内容过大`);
    }
    activity();
    if (response.ok && options.streamProvider && /text\/event-stream|(?:x-)?ndjson/i.test(response.headers.get("content-type") || "")) {
      const streamedText = await readModelStream(response, { provider: options.streamProvider, label: options.label, onText: options.onText, onActivity: activity, maxBytes: MAX_RESPONSE_BYTES, maxTextLength: MAX_RESPONSE_LENGTH });
      return { streamedText };
    }
    const raw = await readResponse(response, options.label, activity);
    let json = {};
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch (_error) {
        throw new Error(`${options.label}返回了无法解析的数据（${response.status}）`);
      }
    }
    if (!response.ok) {
      const detail = cleanRemoteError(json?.error?.message || json?.error?.type || json?.error || json?.message);
      throw new Error(`${options.label}请求失败（${response.status}）${detail ? `：${detail}` : ""}`);
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error(`${options.label}返回的数据格式无效`);
    }
    return json;
  } catch (error) {
    if (options.signal?.aborted) throw new Error("任务已停止");
    if (controller.signal.aborted) throw new Error(`${options.label}请求超时，请稍后重试`);
    const message = safeErrorMessage(error);
    if (message.startsWith(options.label)) throw new Error(redactSecrets(message, options.headers));
    throw new Error(`${options.label}连接失败：${redactSecrets(message, options.headers)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** 按字节限制响应体，避免未声明 Content-Length 的接口无限返回数据。 */
async function readResponse(response, label, onActivity) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${label}返回内容过大`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function redactSecrets(message, headers = {}) {
  let safe = message;
  for (const [name, value] of Object.entries(headers)) {
    if (!/authorization|api-key/i.test(name) || typeof value !== "string") continue;
    const secret = value.replace(/^Bearer\s+/i, "");
    if (secret) safe = safe.split(secret).join("[已隐藏]");
  }
  return safe;
}

function normalizeAgent(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw new Error("Agent 配置无效");
  const provider = cleanString(agent.provider || "openai", 32);
  if (!ALLOWED_PROVIDERS.has(provider)) throw new Error("不支持的模型 Provider");
  return {
    provider,
    name: cleanString(agent.name, 120),
    role: cleanString(agent.role, 240),
    persona: cleanString(agent.persona, 12000),
    model: cleanString(agent.model, 240),
    endpoint: cleanString(agent.endpoint, 2048),
    temperature: normalizeTemperature(agent.temperature),
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("对话内容为空");
  if (messages.length > 60) throw new Error("对话记录过长");
  let total = 0;
  return messages.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("对话格式无效");
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) throw new Error("对话中存在空消息");
    // 附件和历史必须完整传送；按 UTF-8 字节检查总量，超限直接拒绝。
    total += Buffer.byteLength(content, "utf8");
    if (total > MAX_MESSAGE_BYTES) throw new Error("对话内容和附件合计不能超过 1 MB，请缩短历史或附件");
    return {
      role: item.role === "assistant" ? "assistant" : "user",
      content,
    };
  });
}

function normalizeBaseUrl(value, options) {
  const raw = cleanString(value, 2048);
  if (!raw) throw new Error(`${options.label} 为空`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error(`${options.label} 不是有效 URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${options.label} 不能在 URL 中包含凭据`);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${options.label} 只支持 http 或 https`);
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (options.localOnly && !loopback) throw new Error(`${options.label} 必须指向本机地址`);
  if (parsed.protocol === "http:" && !loopback) {
    throw new Error(`${options.label} 的远程地址必须使用 HTTPS，避免泄露 API Key`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match) && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255);
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function mergeConsecutiveMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous?.role === message.role) previous.content += `\n\n${message.content}`;
    else merged.push({ ...message });
  }
  return merged;
}

function extractOpenAIText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function normalizeTemperature(value) {
  const number = Number(value ?? 0.7);
  if (!Number.isFinite(number)) return 0.7;
  return Math.min(2, Math.max(0, number));
}

function cleanSecret(value) {
  if (typeof value !== "string") return "";
  if (value.length > 16384) throw new Error("API Key 格式无效");
  return value.trim();
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function cleanRemoteError(value) {
  if (typeof value === "object" && value) value = value.message || value.type;
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
}

function safeErrorMessage(error) {
  if (!(error instanceof Error)) return "未知错误";
  return error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function limitModelOutput(value) {
  const text = String(value || "").trim();
  if (text.length > MAX_RESPONSE_LENGTH) throw new Error("模型返回内容过长");
  return text;
}

module.exports = {
  completeChat,
  fetchJson,
  isLoopbackHost,
  normalizeAgent,
  normalizeBaseUrl,
  normalizeMessages,
};
