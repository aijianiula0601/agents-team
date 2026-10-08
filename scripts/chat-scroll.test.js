const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const APP_SOURCE = fs.readFileSync(path.join(__dirname, "../shared/web/app.js"), "utf8");
const FIRST_KEY = JSON.stringify(["account-a", "agent:engineer"]);
const INITIAL_MESSAGES = [["a", 120], ["b", 100], ["c", 100], ["d", 150], ["e", 150]];

/**
 * 功能：独立加载实际聊天视口更新函数，隔离各测试的容器状态。
 * 参数：无。
 * 返回：实际 updateMessageViewport 函数。
 * 注意事项：直接执行应用源码，避免测试复刻实现；保留应用调试日志。
 */
function loadViewport() {
  const match = APP_SOURCE.match(/function updateMessageViewport\([\s\S]*?\n    \}/);
  assert.ok(match, "聊天视口更新函数必须存在");
  const context = { messageViews: new WeakMap(), console };
  vm.runInNewContext(`${match[0]}; this.update = updateMessageViewport;`, context, { filename: "app.js" });
  return context.update;
}

/**
 * 功能：模拟浏览器滚动容器及消息几何信息，用固定高度验证阅读位置。
 * 参数：构造时无需参数，消息内容通过 innerHTML 写入测试 JSON。
 * 返回：提供滚动位置、DOM 重建次数和消息节点的容器实例。
 * 注意事项：采用浏览器的滚动边界约束；本测试不验证 HTML 解析或 CSS 排版。
 */
class MessageBox {
  /**
   * 功能：初始化有固定屏幕偏移和可见高度的消息容器。
   * 参数：无。
   * 返回：新的 MessageBox 实例。
   * 注意事项：非零 top 用于发现错误混用文档坐标与容器坐标的问题。
   */
  constructor() {
    this.clientHeight = 200;
    this.scrollHeight = 0;
    this.top = 32;
    this.position = 0;
    this.html = "";
    this.nodes = [];
    this.replacements = 0;
    this.scrollWrites = 0;
  }

  /**
   * 功能：读取当前滚动位置。
   * 参数：无。
   * 返回：相对内容顶部的像素距离。
   * 注意事项：读取不会记录滚动写入。
   */
  get scrollTop() { return this.position; }

  /**
   * 功能：设置滚动位置并记录写入次数。
   * 参数：value 为目标像素距离。
   * 返回：无。
   * 注意事项：模拟浏览器，将目标限制在实际可滚动范围内。
   */
  set scrollTop(value) {
    this.position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    this.scrollWrites++;
  }

  /**
   * 功能：读取上次设置的容器内容。
   * 参数：无。
   * 返回：消息描述的 JSON 字符串。
   * 注意事项：同内容刷新测试依赖节点身份和写入次数，不依赖此访问器。
   */
  get innerHTML() { return this.html; }

  /**
   * 功能：根据消息标识和高度重建容器中的几何节点。
   * 参数：value 为由消息标识、高度二元组组成的 JSON 字符串。
   * 返回：无。
   * 注意事项：模拟内容替换时可能发生的滚动边界收缩，不模拟滚动锚定。
   */
  set innerHTML(value) {
    this.html = value;
    this.replacements++;
    this.nodes = [];
    let offset = 0;
    for (const [id, height] of JSON.parse(value)) {
      this.nodes.push(new MessageNode(this, id, offset, height));
      offset += height;
    }
    this.scrollHeight = offset;
    this.position = Math.max(0, Math.min(this.position, this.scrollHeight - this.clientHeight));
  }

  /**
   * 功能：提供消息容器的屏幕坐标。
   * 参数：无。
   * 返回：包含顶部与底部坐标的对象。
   * 注意事项：消息与容器必须使用相同坐标系。
   */
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.clientHeight }; }

  /**
   * 功能：查询可用作阅读锚点的消息节点。
   * 参数：selector 为消息标识选择器。
   * 返回：当前消息节点数组。
   * 注意事项：拒绝未经建模的选择器，避免静默产生错误的测试结果。
   */
  querySelectorAll(selector) {
    assert.equal(selector, "[data-message-id]");
    return this.nodes;
  }
}

/**
 * 功能：模拟随容器滚动而改变屏幕位置的消息节点。
 * 参数：构造时指定容器、消息标识、内容偏移和消息高度。
 * 返回：具有消息标识与动态几何信息的节点实例。
 * 注意事项：节点重建会产生新对象，以便检查不必要的 DOM 替换。
 */
class MessageNode {
  /**
   * 功能：保存消息节点的固定内容几何信息。
   * 参数：box 为容器，id 为消息标识，offset 为内容偏移，height 为高度。
   * 返回：新的 MessageNode 实例。
   * 注意事项：节点屏幕位置随容器滚动即时计算。
   */
  constructor(box, id, offset, height) {
    this.box = box;
    this.dataset = { messageId: id };
    this.offset = offset;
    this.height = height;
  }

  /**
   * 功能：计算当前消息在屏幕上的可见位置。
   * 参数：无。
   * 返回：消息的顶部与底部屏幕坐标。
   * 注意事项：部分被遮挡的消息允许顶部坐标小于容器顶部。
   */
  getBoundingClientRect() {
    const top = this.box.top + this.offset - this.box.scrollTop;
    return { top, bottom: top + this.height };
  }
}

/**
 * 功能：初始化已经打开的聊天及其独立更新函数。
 * 参数：无。
 * 返回：包含容器、更新函数和初始消息内容的对象。
 * 注意事项：初次打开默认显示底部，测试通过显式滚动模拟用户阅读历史。
 */
function openConversation() {
  const update = loadViewport();
  const box = new MessageBox();
  const html = JSON.stringify(INITIAL_MESSAGES);
  update(box, html, FIRST_KEY);
  return { update, box, html };
}

/** 功能：验证初次进入及切换会话、账号显示最新消息；参数：无；返回：无；注意事项：切换优先于旧会话的位置保护。 */
test("初次打开、切换会话和切换账号均显示消息底部", () => {
  const { update, box, html } = openConversation();
  assert.equal(box.scrollTop, 420);
  box.scrollTop = 150;
  update(box, html, JSON.stringify(["account-a", "room:team"]), false);
  assert.equal(box.scrollTop, 420);
  box.scrollTop = 150;
  update(box, html, JSON.stringify(["account-b", "room:team"]));
  assert.equal(box.scrollTop, 420);
});

/** 功能：验证周期性同内容刷新不干扰阅读；参数：无；返回：无；注意事项：同时检查 DOM 节点和滚动写入。 */
test("同内容轮询不替换 DOM，也不改写上滑后的滚动位置", () => {
  const { update, box, html } = openConversation();
  box.scrollTop = 150;
  const nodes = box.nodes;
  const writes = box.scrollWrites;
  for (let index = 0; index < 5; index++) update(box, html, FIRST_KEY);
  assert.equal(box.scrollTop, 150);
  assert.equal(box.nodes, nodes);
  assert.equal(box.replacements, 1);
  assert.equal(box.scrollWrites, writes);
});

/** 功能：验证多次新回复保留用户阅读位置；参数：无；返回：无；注意事项：连续更新覆盖多成员异步回复。 */
test("上滑阅读时，新消息和多成员连续回复均不拉到底部", () => {
  const { update, box } = openConversation();
  box.scrollTop = 150;
  const messages = [...INITIAL_MESSAGES];
  for (const id of ["designer-reply", "engineer-reply", "reviewer-reply"]) {
    messages.push([id, 160]);
    update(box, JSON.stringify(messages), FIRST_KEY);
    assert.equal(box.scrollTop, 150);
    assert.equal(box.nodes[1].getBoundingClientRect().top - box.top, -30);
  }
});

/** 功能：验证底部用户跟随新回复；参数：无；返回：无；注意事项：跟随判定必须在内容增长前完成。 */
test("已经位于底部时自动跟随新增消息", () => {
  const { update, box } = openConversation();
  update(box, JSON.stringify([...INITIAL_MESSAGES, ["reply", 180]]), FIRST_KEY);
  assert.equal(box.scrollTop, 600);
  assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
});

/** 功能：验证小数滚动容差不会扩大到明显上滑；参数：无；返回：无；注意事项：使用真实像素距离边界。 */
test("底部两像素内允许跟随，超出范围则保留阅读位置", () => {
  for (const gap of [1, 2, 3]) {
    const { update, box } = openConversation();
    box.scrollTop = 420 - gap;
    update(box, JSON.stringify([...INITIAL_MESSAGES, ["reply", 180]]), FIRST_KEY);
    assert.equal(box.scrollTop, gap <= 2 ? 600 : 420 - gap);
  }
});

/** 功能：验证显式位置保护可阻止底部跟随；参数：无；返回：无；注意事项：旧内容恰好贴底仍应保持。 */
test("pin:false 在同一会话中保护位置，包括原来位于底部的情况", () => {
  const { update, box } = openConversation();
  update(box, JSON.stringify([...INITIAL_MESSAGES, ["reply", 180]]), FIRST_KEY, false);
  assert.equal(box.scrollTop, 420);
  assert.notEqual(box.scrollTop, box.scrollHeight - box.clientHeight);
});

/** 功能：验证主动发送可跳到最新消息；参数：无；返回：无；注意事项：相同内容也应执行主动跳转但不重建 DOM。 */
test("pin:true 主动发送跳到底部，相同内容不额外替换 DOM", () => {
  const { update, box, html } = openConversation();
  box.scrollTop = 150;
  update(box, html, FIRST_KEY, true);
  assert.equal(box.scrollTop, 420);
  assert.equal(box.replacements, 1);
  box.scrollTop = 150;
  update(box, JSON.stringify([...INITIAL_MESSAGES, ["user-send", 180]]), FIRST_KEY, true);
  assert.equal(box.scrollTop, 600);
});

/** 功能：验证上方消息变长和历史补齐保持可见锚点；参数：无；返回：无；注意事项：首条可见消息仅部分可见。 */
test("上方消息变长和补入历史消息时，当前可见消息保持原屏幕位置", () => {
  const { update, box } = openConversation();
  box.scrollTop = 150;
  const expanded = [["a", 210], ...INITIAL_MESSAGES.slice(1)];
  update(box, JSON.stringify(expanded), FIRST_KEY);
  assert.equal(box.scrollTop, 240);
  assert.equal(box.nodes[1].dataset.messageId, "b");
  assert.equal(box.nodes[1].getBoundingClientRect().top - box.top, -30);
  update(box, JSON.stringify([["older-1", 80], ["older-2", 60], ...expanded]), FIRST_KEY);
  assert.equal(box.scrollTop, 380);
  assert.equal(box.nodes[3].dataset.messageId, "b");
  assert.equal(box.nodes[3].getBoundingClientRect().top - box.top, -30);
});

/** 功能：验证锚点被删除后的稳定回退；参数：无；返回：无；注意事项：剩余内容足够高，不因浏览器边界限制改变位置。 */
test("当前可见锚点被删除时回退到更新前的 scrollTop", () => {
  const { update, box } = openConversation();
  box.scrollTop = 150;
  update(box, JSON.stringify([INITIAL_MESSAGES[0], ...INITIAL_MESSAGES.slice(2)]), FIRST_KEY);
  assert.equal(box.scrollTop, 150);
});
