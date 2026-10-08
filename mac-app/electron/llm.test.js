const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { completeChat, fetchJson, normalizeBaseUrl, normalizeMessages } = require("./llm");

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("自定义本机兼容接口无需密钥，且不会收到 OpenAI 密钥", async (t) => {
  let received;
  const base = await serverFor(t, (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "真实本机回复" } }] }));
    });
  });
  const text = await completeChat({ provider: "custom", endpoint: `${base}/v1`, model: "test-local" }, [{ role: "user", content: "测试" }], { openai: "openai-must-not-leak" });
  assert.equal(text, "真实本机回复");
  assert.equal(received.authorization, undefined);
  assert.equal(received.path, "/v1/chat/completions");
  assert.equal(received.body.model, "test-local");
  assert.equal(received.body.messages.at(-1).content, "测试");
});

test("兼容网关仅使用独立 custom 密钥", async (t) => {
  let authorization;
  const base = await serverFor(t, (req, res) => {
    authorization = req.headers.authorization;
    req.resume();
    res.end(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "ok" }] } }] }));
  });
  assert.equal(await completeChat({ provider: "custom", endpoint: base }, [{ content: "测试" }], { openai: "other-key", custom: "gateway-key" }), "ok");
  assert.equal(authorization, "Bearer gateway-key");
});

test("超时包括已收到 headers 但一直未完成的响应正文", async (t) => {
  const base = await serverFor(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"choices":');
  });
  await assert.rejects(fetchJson(base, { label: "测试模型", headers: {}, body: {}, timeoutMs: 80 }), /请求超时/);
});

test("取消会终止正在读取的响应正文", async (t) => {
  const controller = new AbortController();
  const base = await serverFor(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"choices":');
    controller.abort();
  });
  await assert.rejects(fetchJson(base, { label: "测试模型", headers: {}, body: {}, signal: controller.signal }), /任务已停止/);
});

test("失败保留 HTTP 状态和实际原因，同时遮蔽返回的密钥", async (t) => {
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid secret-gateway-key" } }));
  });
  await assert.rejects(fetchJson(base, { label: "测试模型", headers: { Authorization: "Bearer secret-gateway-key" }, body: {} }), (error) => {
    assert.match(error.message, /401.*invalid/);
    assert.equal(error.message.includes("secret-gateway-key"), false);
    return true;
  });
});

test("非 JSON 和错误数据结构不能被当成成功回复", async (t) => {
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.end(req.url === "/array" ? "[]" : "this is not json");
  });
  await assert.rejects(fetchJson(base, { label: "测试模型", headers: {}, body: {} }), /无法解析/);
  await assert.rejects(fetchJson(`${base}/array`, { label: "测试模型", headers: {}, body: {} }), /格式无效/);
});

test("响应体按实际字节限量，即使服务端省略 content-length", async (t) => {
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("x".repeat(5 * 1024 * 1024));
    res.end("x");
  });
  await assert.rejects(fetchJson(base, { label: "测试模型", headers: {}, body: {} }), /内容过大/);
});

test("模型配置拒绝把凭据放进 URL 或发送到远程 HTTP", () => {
  assert.throws(() => normalizeBaseUrl("https://user:secret@example.com/v1", { label: "Endpoint" }), /凭据/);
  assert.throws(() => normalizeBaseUrl("http://example.com/v1", { label: "Endpoint" }), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://example.com", { label: "Ollama", localOnly: true }), /本机/);
});

test("Ollama 空白回复不能被交付为成功消息", async (t) => {
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.end(JSON.stringify({ message: { content: "   " } }));
  });
  await assert.rejects(completeChat({ provider: "local", model: "synthetic" }, [{ content: "本地测试" }], { ollamaBase: base }), /Ollama 没有返回内容/);
});

test("桌面推理模型省略 temperature，普通模型保留用户设置", async (t) => {
  const received = [];
  const base = await serverFor(t, (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push(JSON.parse(raw));
      res.end(JSON.stringify({ choices: [{ message: { content: "参数检查成功" } }] }));
    });
  });
  const models = ["gpt-5", "gpt-5.1", "o1", "o3-mini", "o4-mini", "gpt-4.1", "synthetic-model"];
  for (const model of models) {
    await completeChat({ provider: "custom", endpoint: base, model, temperature: 0.4 }, [{ content: "本地合成参数测试" }]);
  }
  for (const body of received.slice(0, 5)) assert.equal(Object.hasOwn(body, "temperature"), false);
  for (const body of received.slice(5)) assert.equal(body.temperature, 0.4);
  assert.deepEqual(received.map((body) => body.model), models);
});

test("桌面模型完整收到两个 256KB 附件及历史末尾标记", async (t) => {
  let received;
  const base = await serverFor(t, (req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received = JSON.parse(raw);
      res.end(JSON.stringify({ choices: [{ message: { content: "附件已完整接收" } }] }));
    });
  });
  const first = "a".repeat(256 * 1024 - 8) + "TAIL_ONE";
  const second = "b".repeat(256 * 1024 - 8) + "TAIL_TWO";
  const messages = [
    { role: "user", content: "历史：" + "中".repeat(50000) + "HISTORY_TAIL" },
    { role: "assistant", content: "继续检查附件" },
    { role: "user", content: `附件一：\n${first}\n附件二：\n${second}\nQUESTION_TAIL` },
  ];
  assert.equal(await completeChat({ provider: "custom", endpoint: base, model: "synthetic" }, messages), "附件已完整接收");
  assert.deepEqual(received.messages.slice(1), messages);
  assert.equal(received.messages[1].content.endsWith("HISTORY_TAIL"), true);
  assert.equal(received.messages.at(-1).content.endsWith("QUESTION_TAIL"), true);
});

test("对话总量按 UTF-8 字节检查，超过 1MB 明确拒绝且不截断", async () => {
  const limit = 1024 * 1024;
  const atLimit = [{ content: "x".repeat(limit - 4) + "TAIL" }];
  assert.equal(normalizeMessages(atLimit)[0].content, atLimit[0].content);
  assert.throws(() => normalizeMessages([{ content: "x".repeat(limit + 1) }]), /不能超过 1 MB/);
  assert.throws(() => normalizeMessages([{ content: "中".repeat(400000) }]), /不能超过 1 MB/);
  assert.throws(() => normalizeMessages([{ content: "x".repeat(limit) }, { content: "y" }]), /不能超过 1 MB/);
  await assert.rejects(completeChat({ provider: "custom", endpoint: "http://127.0.0.1:1" }, [{ content: "x".repeat(limit + 1) }]), /不能超过 1 MB/);
});

/** 创建可由测试主动结束的 Promise；无参数；返回 promise/resolve；不调用外部模型。 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("OpenAI 真实 SSE 在完成前提供增量，并正确解码跨包中文和空格", async (t) => {
  const firstText = deferred();
  const finish = deferred();
  const updates = [];
  let sentBody;
  const base = await serverFor(t, (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      sentBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const first = Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"你好 "}}]}\r\n\r\n');
      const middle = first.indexOf(Buffer.from("你")) + 1;
      res.write(first.subarray(0, middle));
      setImmediate(() => res.write(first.subarray(middle)));
      await finish.promise;
      res.end('data: {"choices":[{"index":0,"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  const pending = completeChat({ provider: "custom", endpoint: base }, [{ content: "测试" }], {}, { onText: (text) => { updates.push(text); firstText.resolve(); } });
  await firstText.promise;
  assert.equal(sentBody.stream, true);
  assert.deepEqual(updates, ["你好 "]);
  finish.resolve();
  assert.equal(await pending, "你好 世界");
  assert.deepEqual(updates, ["你好 ", "你好 世界"]);
});

test("Anthropic 只增量输出正文，不显示 thinking，Ollama 使用 NDJSON", async (t) => {
  const responses = {
    "/anthropic": ["text/event-stream", 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"PRIVATE"}}\n\ndata: {"type":"content_block_start","content_block":{"type":"text","text":"第一"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"阶段"}}\n\ndata: {"type":"message_stop"}\n\n'],
    "/api/chat": ["application/x-ndjson", '{"message":{"content":"本地"},"done":false}\n{"message":{"content":"回复"},"done":true}\n'],
  };
  const base = await serverFor(t, (req, res) => {
    req.resume();
    const [type, body] = responses[req.url];
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  });
  const anthropic = [];
  const result = await fetchJson(`${base}/anthropic`, { label: "Anthropic", headers: {}, body: {}, streamProvider: "anthropic", onText: (text) => anthropic.push(text) });
  assert.equal(result.streamedText, "第一阶段");
  assert.deepEqual(anthropic, ["第一", "第一阶段"]);
  const local = [];
  assert.equal(await completeChat({ provider: "local" }, [{ content: "测试" }], { ollamaBase: base }, { onText: (text) => local.push(text) }), "本地回复");
  assert.deepEqual(local, ["本地", "本地回复"]);
});

test("模型流式请求按空闲续期，持续输出超过单次超时仍完成", async (t) => {
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let count = 0;
    const timer = setInterval(() => {
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      if (++count === 8) { clearInterval(timer); res.end("data: [DONE]\n\n"); }
    }, 30);
    res.once("close", () => clearInterval(timer));
  });
  const result = await fetchJson(base, { label: "模型", headers: {}, body: {}, streamProvider: "openai", timeoutMs: 100 });
  assert.equal(result.streamedText, "aaaaaaaa");
});

test("流式中断、错误事件、空回复和过量输出不会返回成功，凭据保持隐藏", async (t) => {
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url === "/error") res.end('data: {"error":{"message":"bad secret-model-key"}}\n\n');
    else if (req.url === "/large") res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(200001) } }] })}\n\n`);
    else if (req.url.startsWith("/empty")) res.end('data: {"choices":[{"delta":{"content":"  "}}]}\n\ndata: [DONE]\n\n');
    else res.end('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n');
  });
  const options = { label: "模型", headers: { Authorization: "Bearer secret-model-key" }, body: {}, streamProvider: "openai" };
  await assert.rejects(fetchJson(base, options), /响应中断/);
  await assert.rejects(fetchJson(`${base}/error`, options), (error) => error.message.includes("bad [已隐藏]") && !error.message.includes("secret-model-key"));
  await assert.rejects(fetchJson(`${base}/large`, options), /内容过长/);
  await assert.rejects(completeChat({ provider: "custom", endpoint: `${base}/empty` }, [{ content: "测试" }]), /没有返回内容/);
});

test("取消流式请求会保留已收到的片段并停止后续读取", async (t) => {
  const controller = new AbortController();
  const received = [];
  const base = await serverFor(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"已收到"}}]}\n\n');
  });
  await assert.rejects(completeChat({ provider: "custom", endpoint: base }, [{ content: "测试" }], {}, {
    signal: controller.signal,
    onText: (text) => { received.push(text); controller.abort(); },
  }), /任务已停止/);
  assert.deepEqual(received, ["已收到"]);
});
