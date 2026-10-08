const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeMessages, modelMessages } = require("../shared/web/conversation");

test("聊天恢复与同步保留完整历史，模型上下文仍按独立窗口读取", () => {
  const thread = Array.from({ length: 350 }, (_, index) => ({
    id: `history-${index}`, from: index % 2 ? "coder" : "you", text: `第${index}条完整消息`,
  }));
  const restored = normalizeMessages(thread, ["coder"]);
  assert.equal(restored.length, 350);
  assert.equal(restored[0].id, "history-0");
  assert.equal(restored.at(-1).text, "第349条完整消息");
  const context = modelMessages(restored, { id: "coder" }, [], "新的任务");
  assert.equal(context.length, 21);
  assert.equal(restored.length, 350);
});
