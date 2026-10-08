/* 浏览器 / Android 的模型接口；自定义服务仅使用单独配置的密钥。 */
(function (root) {
  /**
   * 发送模型请求并在浏览器逐块读取响应。
   * @param {string} url 接口地址
   * @param {object} headers 请求头
   * @param {object} body 请求体
   * @param {AbortSignal} signal 取消信号
   * @param {function} onChunk 收到解码文本块时调用
   * @returns {Promise<object>} HTTP 状态和完整原文
   * 注意事项：原生 HTTP 不支持分块，手机常规任务通过 Mac 网关流式同步；总任务不设时间上限。
   */
  async function request(url, headers, body, signal, onChunk) {
    const native = root.Capacitor?.getPlatform?.() === "android" && root.Capacitor.Plugins?.CapacitorHttp;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new Error("请求已取消"));
      signal.addEventListener("abort", abort, { once: true });
    });
    /** 读取真实网络响应；参数：无；返回：状态和正文；注意事项：UTF-8 解码保留跨包字符并限制响应大小。 */
    async function receive() {
      if (native) {
        const response = await native.request({ url, method: "POST", headers, data: body, responseType: "text", connectTimeout: 15000, readTimeout: 120000, disableRedirects: true });
        const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        if (new TextEncoder().encode(raw).length > 5 * 1024 * 1024) throw new Error("模型返回内容过大");
        const ok = response.status >= 200 && response.status < 300;
        if (ok && !signal.aborted) onChunk(raw);
        return { status: response.status, ok, raw };
      }
      const response = await root.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
      if (!response.body?.getReader) {
        const raw = await response.text();
        if (new TextEncoder().encode(raw).length > 5 * 1024 * 1024) throw new Error("模型返回内容过大");
        if (response.ok && !signal.aborted) onChunk(raw);
        return { status: response.status, ok: response.ok, raw };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let raw = "", size = 0;
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5 * 1024 * 1024) throw new Error("模型返回内容过大");
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;
          if (response.ok && !signal.aborted) onChunk(chunk);
        }
        const tail = decoder.decode();
        raw += tail;
        if (response.ok && !signal.aborted && tail) onChunk(tail);
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { status: response.status, ok: response.ok, raw };
    }
    try {
      if (signal.aborted) throw new Error("请求已取消");
      return await Promise.race([receive(), cancelled]);
    } finally { signal.removeEventListener("abort", abort); }
  }

  /**
   * 调用 OpenAI、Anthropic 或 Ollama，并持续推送累计正文。
   * @param {object} agent 成员模型配置
   * @param {object[]} messages 上下文
   * @param {object} keys 当前账号密钥
   * @param {AbortSignal} signal 外部取消信号
   * @param {function} onText 累计正文回调
   * @returns {Promise<string>} 最终完整正文
   * 注意事项：SSE 与 NDJSON 按帧解析，工具调用和思考字段不会混入用户正文。
   */
  async function complete(agent, messages, keys, signal, onText) {
    const system = `你是 ${agent.name}，角色：${agent.role}。\n${agent.persona}\n用中文回复，结合对话中其他团队成员的意见。`;
    const headers = { "Content-Type": "application/json" };
    let url, body;
    if (agent.provider === "anthropic") {
      if (!keys.anthropic) throw new Error("还没有 Anthropic API Key，请到设置 → 模型与密钥填写");
      url = "https://api.anthropic.com/v1/messages";
      Object.assign(headers, { "x-api-key": keys.anthropic, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
      body = { model: agent.model, max_tokens: 4096, system, messages, temperature: agent.temperature, stream: true };
      if (messages[0]?.role === "assistant") body.messages = [{ role: "user", content: "请结合此前对话继续回答。" }, ...messages];
    } else if (agent.provider === "local") {
      url = `${root.ChorusConversation.endpoint(keys.ollamaBase || "http://127.0.0.1:11434")}/api/chat`;
      body = { model: agent.model, stream: true, messages: [{ role: "system", content: system }, ...messages] };
    } else {
      const custom = agent.provider === "custom";
      const key = custom ? keys.custom : keys.openai;
      if (!custom && !key) throw new Error("还没有 OpenAI API Key，请到设置 → 模型与密钥填写");
      const base = custom ? root.ChorusConversation.endpoint(agent.endpoint) : "https://api.openai.com/v1";
      url = `${base}/chat/completions`;
      if (key) headers.Authorization = `Bearer ${key}`;
      body = { model: agent.model, messages: [{ role: "system", content: system }, ...messages], stream: true };
      if (!/^(gpt-5|o[134])(?:[.-]|$)/i.test(agent.model)) body.temperature = agent.temperature;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let idleTimer, timedOut = false;
    /** 重置网络空闲计时；参数：无；返回：无；注意事项：持续分片的长任务没有总时长限制。 */
    function renewIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; controller.abort(); }, 120000); }
    renewIdle();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    let pending = "", text = "", streamed = false, completed = false;
    const eventData = [];
    /** 解析单帧模型事件；参数：data 为完整数据；返回：无；注意事项：错误交给统一脱敏处理，结束标记用于识别意外断流。 */
    function consumeEvent(data) {
      if (!data) return;
      if (data.trim() === "[DONE]") { streamed = true; completed = true; return; }
      let event;
      try { event = JSON.parse(data); } catch (_) { throw new Error("模型流式数据无法解析，请检查接口格式"); }
      if (event.error) throw new Error(typeof event.error === "string" ? event.error : event.error.message || "模型流式响应失败");
      streamed = true;
      if (event.type === "message_stop" || event.done === true || event.choices?.some((choice) => choice.finish_reason != null)) completed = true;
      let delta = agent.provider === "anthropic" ? event.type === "content_block_delta" && event.delta?.type === "text_delta" ? event.delta.text : event.type === "content_block_start" ? event.content_block?.text : "" : agent.provider === "local" ? event.message?.content : event.choices?.[0]?.delta?.content;
      if (Array.isArray(delta)) delta = delta.filter((item) => item.type === "text").map((item) => item.text).join("");
      if (typeof delta === "string" && delta && !controller.signal.aborted) { text += delta; onText?.(text); }
    }
    /** 读取一行协议文本；参数：line 为完整行；返回：无；注意事项：SSE 多行 data 在空行结束后合并，心跳忽略。 */
    function consumeLine(line) {
      const value = line.replace(/\r$/, "");
      if (agent.provider === "local") { if (value.trim()) consumeEvent(value); return; }
      if (!value) { if (eventData.length) consumeEvent(eventData.splice(0).join("\n")); return; }
      if (value.startsWith("data:")) eventData.push(value.slice(5).replace(/^ /, ""));
    }
    /** 拼接网络文本块；参数：chunk 为任意分片；返回：无；注意事项：只有完整行才交给解析，并续期空闲限制。 */
    function consume(chunk) {
      renewIdle();
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); consumeLine(line); }
    }
    try {
      const response = await request(url, headers, body, controller.signal, consume);
      if (controller.signal.aborted) throw new Error("任务已停止");
      if (response.ok && pending.trim()) consumeLine(pending);
      if (response.ok && eventData.length) consumeEvent(eventData.splice(0).join("\n"));
      if (streamed && !completed) throw new Error("模型流式响应意外中断，请重试以获取完整回复");
      if (!streamed || !response.ok) {
        let json;
        try { json = JSON.parse(response.raw); } catch (_) { throw new Error(`模型返回的数据无法解析（HTTP ${response.status}），请检查服务地址`); }
        if (!response.ok) throw new Error(`HTTP ${response.status}：${String(json.error?.message || json.error || json.message || "请求失败").slice(0, 500)}`);
        text = agent.provider === "anthropic" ? (json.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n") : agent.provider === "local" ? json.message?.content : json.choices?.[0]?.message?.content;
        if (Array.isArray(text)) text = text.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        if (typeof text === "string") onText?.(text);
      }
      if (controller.signal.aborted) throw new Error("任务已停止");
      if (typeof text !== "string" || !text.trim()) throw new Error("模型没有返回内容，请检查模型 ID 和接口格式");
      return text.trim();
    } catch (error) {
      if (controller.signal.aborted) throw new Error(timedOut && !signal?.aborted ? "模型连接长时间未返回数据，请检查网络后重试" : "任务已停止");
      if (error instanceof TypeError) throw new Error("无法连接模型服务，请检查网络、服务地址及浏览器跨域设置。手机的 localhost 指手机自身。");
      let detail = String(error?.message || error);
      for (const key of Object.values(keys)) if (typeof key === "string" && key.length >= 6) detail = detail.split(key).join("[已隐藏]");
      throw new Error(detail);
    } finally { clearTimeout(idleTimer); signal?.removeEventListener("abort", cancel); }
  }
  root.ChorusModelClient = { complete };
})(globalThis);
