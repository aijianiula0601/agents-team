"use strict";

const state = { user: null, csrf: "", tab: "overview", register: false, list: "accounts", page: 1, query: "", status: "", platform: "", overview: null, loading: false, uploading: false, finishing: false, uploadAbort: false, uploadXHR: null, uploadID: "", releaseStorage: null, releasePlaces: {}, request: 0, sessionVersion: 0, rangeDays: 30, startDate: "", endDate: "", chartMode: "tasks", hiddenSeries: new Set() };
const titles = {
  overview: ["运行总览", "WORKSPACE OVERVIEW", "账号、设备与任务的运行情况，一目了然。"],
  accounts: ["账号与设备", "ACCOUNTS & DEVICES", "了解账号的使用情况与设备连接状态。"],
  tasks: ["任务统计", "TASK ACTIVITY", "跟踪任务执行结果，及时发现需要处理的问题。"],
  releases: ["版本发布", "APP RELEASES", "管理 macOS 与 Android 安装包，让客户端及时获得更新。"]
};
const pageSize = 20;
const numberFormat = new Intl.NumberFormat("zh-CN");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
let toastTimer;
let confirmation = null;

/** 获取固定页面元素。参数：id 为元素标识；返回：DOM 元素；注意：仅用于可信的静态模板。 */
function el(id) { return document.getElementById(id); }

/** 安全创建元素。参数：tag、className 和 text 指定内容；返回：元素；注意：文本使用 textContent，禁止解释服务端 HTML。 */
function node(tag, className = "", text = "") {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = String(text);
  return item;
}

/** 格式化真实计数。参数：value 为服务端计数；返回：本地化字符串；注意：缺失或非数字显示破折号。 */
function count(value) { return typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "—"; }

/** 格式化时间戳。参数：value 为 ISO 时间；返回：北京时间字符串；注意：未知时间不显示虚构日期。 */
function date(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
}

/** 格式化安装包体积。参数：value 为字节数；返回：体积文本；注意：缺失数据展示破折号。 */
function size(value) {
  if (typeof value !== "number") return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

/** 翻译平台名称。参数：value 为平台码；返回：平台中文名称；注意：未知平台原样显示为纯文本。 */
function platform(value) { return ({ macos: "macOS", mac: "macOS", darwin: "macOS", android: "Android", windows: "Windows", web: "网页" })[value] || value || "未知平台"; }

/** 创建状态标签。参数：value 为状态码；返回：标签元素；注意：仅使用预定义 CSS 类。 */
function badge(value) {
  const values = { pending: ["待处理", "warning"], running: ["执行中", "warning"], done: ["已完成", "success"], completed: ["已完成", "success"], failed: ["失败", "error"], published: ["已发布", "success"], draft: ["草稿", "warning"], withdrawn: ["已撤回", "neutral"], online: ["在线", "success"], offline: ["离线", "neutral"] };
  const item = values[value] || [value || "未知", "neutral"];
  return node("span", `badge ${item[1]}`, item[0]);
}

/** 显示短暂操作反馈。参数：message 为反馈文字；返回：无；注意：不承载必须持续可见的错误。 */
function toast(message) {
  clearTimeout(toastTimer);
  el("toast").textContent = message;
  el("toast").hidden = false;
  toastTimer = setTimeout(hideToast, 4500);
}

/** 隐藏操作提示。参数：无；返回：无；注意：由提示计时器调用。 */
function hideToast() { el("toast").hidden = true; }

/** 更新错误区域。参数：id 是区域标识、message 是错误文字；返回：无；注意：空文字清空区域。 */
function errorMessage(id, message = "") {
  el(id).textContent = message;
  el(id).hidden = !message;
}

/** 发送管理接口请求。参数：path 为相对路径、options 为 fetch 选项；返回：JSON；注意：会话仅依赖 HttpOnly Cookie，不向浏览器存储令牌。 */
async function api(path, options = {}) {
  const sessionVersion = state.sessionVersion;
  const headers = { Accept: "application/json", ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
  const controller = new AbortController();
  // 超时仅中止等待，不自动重放写请求；用户可刷新列表确认服务端处理结果。
  const timeout = setTimeout(function abortRequest() { controller.abort(); }, 30000);
  try {
    const response = await fetch(`./api/${path}`, { ...options, headers, credentials: "same-origin", cache: "no-store", signal: controller.signal });
    let body;
    try { body = await response.json(); } catch (error) { if (error.name === "AbortError") throw error; body = {}; }
    if (!response.ok) {
      if (response.status === 401 && state.user && sessionVersion === state.sessionVersion) { showAuth(); errorMessage("auth-error", "会话已过期，请重新登录。"); }
      const failure = new Error(body.error?.message || (response.status === 403 ? "没有执行此操作的权限。" : `请求失败（${response.status}），请稍后重试。`));
      if (body.error?.code === "CSRF_REJECTED") failure.message = "页面会话已变更，请重新加载浏览器页面后再执行操作。";
      failure.status = response.status;
      throw failure;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请刷新列表确认结果后重试。");
    if (error instanceof TypeError) throw new Error("无法连接中转站，请检查网络后重试。");
    throw error;
  } finally { clearTimeout(timeout); }
}

/** 切换至登录页面。参数：无；返回：无；注意：清除内存会话与已渲染的账号数据。 */
function showAuth() {
  state.sessionVersion += 1;
  state.user = null;
  state.csrf = "";
  state.overview = null;
  state.request += 1;
  el("console-view").hidden = true;
  el("auth-view").hidden = false;
  el("boot-screen").hidden = true;
  state.uploadAbort = true;
  state.releaseStorage = null;
  state.releasePlaces = {};
  if (state.uploadXHR) state.uploadXHR.abort();
  for (const id of ["overview-panel", "accounts-content", "tasks-content", "task-metrics", "releases-content"]) el(id).replaceChildren();
  if (el("upload-dialog").open) el("upload-dialog").close();
  if (el("confirm-dialog").open) el("confirm-dialog").close();
  if (el("account-dialog").open) el("account-dialog").close();
  el("account-form").reset();
  accountOperation = null;
  for (const id of ["auth-password", "auth-confirm", "account-new-password", "account-confirm-password"]) el(id).value = "";
  errorMessage("auth-error");
}

/** 登录成功后填充工作空间。参数：session 包含 user 与 csrfToken；返回：无；注意：管理员身份仅控制展示，权限必须由后端校验。 */
function showConsole(session) {
  state.sessionVersion += 1;
  state.user = session.user;
  state.csrf = session.csrfToken || "";
  const admin = isAdmin();
  const name = state.user.name || state.user.email;
  el("profile-name").textContent = name;
  el("profile-name").title = state.user.email;
  el("profile-avatar").textContent = name.slice(0, 1).toUpperCase();
  el("profile-role").textContent = isSuperadmin() ? "超级管理员" : admin ? "管理员" : "普通账号";
  el("account-management-notice").hidden = !isSuperadmin();
  el("scope-label").textContent = admin ? "全局管理视图" : "个人工作空间";
  el("scope-description").textContent = admin ? "展示全站账号与运行数据" : "仅展示当前账号数据";
  document.querySelector(".release-notice").textContent = admin ? "上传安装包后先保存为草稿，发布后客户端才会检测到新版本。撤回后停止向客户端提供该版本。" : "查看已发布的 macOS 和 Android 版本，下载与你的设备匹配的安装包。";
  el("auth-view").hidden = true;
  el("boot-screen").hidden = true;
  el("console-view").hidden = false;
  el("auth-password").value = "";
  el("auth-confirm").value = "";
  switchTab("overview");
}

/** 切换注册与登录模式。参数：无；返回：无；注意：清空密码，避免带入上一种操作。 */
function toggleAuth() {
  state.register = !state.register;
  el("auth-title").textContent = state.register ? "创建你的账号" : "登录管理页面";
  el("auth-description").textContent = state.register ? "注册后即可查看自己的账号、设备与任务数据。" : "使用你的账号，查看协作运行情况。";
  el("auth-submit").textContent = state.register ? "注册并登录" : "登录";
  el("auth-switch-label").textContent = state.register ? "已有账号？" : "还没有账号？";
  el("auth-toggle").textContent = state.register ? "返回登录" : "创建账号";
  el("name-field").hidden = !state.register;
  el("confirm-field").hidden = !state.register;
  el("auth-name").required = state.register;
  el("auth-confirm").required = state.register;
  el("auth-password").autocomplete = state.register ? "new-password" : "current-password";
  el("auth-password").value = "";
  el("auth-confirm").value = "";
  errorMessage("auth-error");
}

/** 提交账号认证。参数：event 为提交事件；返回：完成认证的 Promise；注意：密码不写日志和浏览器持久化存储。 */
async function submitAuth(event) {
  event.preventDefault();
  errorMessage("auth-error");
  const password = el("auth-password").value;
  if (state.register && password !== el("auth-confirm").value) { errorMessage("auth-error", "两次输入的密码不一致。"); return; }
  const passwordBytes = new TextEncoder().encode(password).length;
  if (passwordBytes < 8 || passwordBytes > 72) { errorMessage("auth-error", "密码须为 8–72 个 UTF-8 字节（一个中文字符通常占 3 个字节）。"); return; }
  const action = state.register ? "register" : "login";
  el("auth-submit").disabled = true;
  el("auth-toggle").disabled = true;
  el("auth-submit").textContent = state.register ? "正在注册…" : "正在登录…";
  try {
    const credentials = { email: el("auth-email").value.trim(), password };
    if (state.register) credentials.name = el("auth-name").value.trim();
    const session = await api(`auth/${action}`, { method: "POST", body: JSON.stringify(credentials) });
    showConsole(session);
  } catch (error) { errorMessage("auth-error", error.message || "无法连接服务，请检查网络。"); }
  finally {
    el("auth-submit").disabled = false;
    el("auth-toggle").disabled = false;
    el("auth-submit").textContent = state.register ? "注册并登录" : "登录";
  }
}

/** 退出当前管理会话。参数：无；返回：退出 Promise；注意：必须成功撤销服务器会话后再显示登录页。 */
async function logout() {
  el("logout-button").disabled = true;
  try { await api("auth/logout", { method: "POST" }); showAuth(); }
  catch (error) { toast(error.message || "退出失败，请重试。"); }
  finally { el("logout-button").disabled = false; }
}

/** 切换功能页。参数：tab 为预定义页签；返回：无；注意：重置分页和搜索，防止跨页继承筛选。 */
function switchTab(tab) {
  if (!titles[tab]) return;
  state.tab = tab;
  state.page = 1;
  state.query = "";
  el("accounts-search").reset();
  el("tasks-search").reset();
  for (const item of document.querySelectorAll("[data-tab]")) { item.classList.toggle("active", item.dataset.tab === tab); item.setAttribute("aria-current", item.dataset.tab === tab ? "page" : "false"); }
  for (const key of Object.keys(titles)) el(`${key}-panel`).hidden = key !== tab;
  el("breadcrumb-current").textContent = titles[tab][0];
  el("page-title").textContent = titles[tab][0];
  el("page-eyebrow").textContent = titles[tab][1];
  el("page-description").textContent = titles[tab][2];
  el("upload-open").hidden = tab !== "releases" || !isAdmin();
  loadPage();
}

/** 创建包含真实指标的卡片。参数：label、value、note、symbol、featured 为展示配置；返回：卡片；注意：缺失数据由调用方跳过。 */
function metric(label, value, note, symbol = "↗", featured = false) {
  const card = node("article", `metric-card${featured ? " featured" : ""}`);
  const heading = node("div", "metric-label", label);
  heading.append(node("span", "metric-symbol", symbol));
  card.append(heading, node("div", "metric-value", value), node("div", "metric-note", note));
  return card;
}

/** 渲染任务指标。参数：target 为容器、metrics 为统计；返回：无；注意：只有 API 实际给出的数值会出现。 */
function taskMetrics(target, metrics) {
  target.replaceChildren();
  const entries = [["pendingTasks", "待处理", "等待主电脑领取", "◷"], ["runningTasks", "执行中", "已领取、尚未完成", "↻"], ["completedTasks", "已完成", "累计成功完成的任务", "✓"], ["failedTasks", "失败", "累计执行失败的任务", "!"]];
  for (const [key, label, note, symbol] of entries) if (typeof metrics[key] === "number") target.append(metric(label, count(metrics[key]), note, symbol));
}

/** 创建信息面板。参数：title、description 和 tag 为标题信息；返回：面板；注意：数据内容由调用方追加。 */
function panel(title, description, tag = "累计") {
  const result = node("section", "panel");
  const heading = node("div", "panel-title");
  const text = node("div");
  text.append(node("h3", "", title), node("p", "", description));
  heading.append(text, node("span", "period-chip", tag));
  result.append(heading);
  return result;
}

/** 创建空状态。参数：title、description 为说明；返回：占位面板；注意：不以零替代未知服务数据。 */
function empty(title = "暂无数据", description = "产生新数据后，会在这里显示。") {
  const result = node("div", "empty-state");
  result.append(node("div", "empty-symbol", "◇"), node("h3", "", title), node("p", "", description));
  return result;
}

/** 渲染运行总览。参数：data 为 overview 响应；返回：无；注意：明确统计口径，缺失字段不做估算。 */
function renderOverview(data) {
  const container = el("overview-panel");
  container.replaceChildren();
  const m = data.metrics || {};
  const cards = node("div", "metrics-grid");
  if (typeof m.accounts === "number") cards.append(metric(data.scope === "global" ? "注册账号" : "我的账号", count(m.accounts), typeof m.accountsToday === "number" ? `今日新增 ${count(m.accountsToday)} · UTC 自然日` : "已注册的有效账号", "◉", true));
  if (typeof m.activeDevices === "number") cards.append(metric("在线设备", count(m.activeDevices), typeof m.devices === "number" ? `共 ${count(m.devices)} 台设备 · 60 秒心跳` : "最近 60 秒有心跳的设备", "▣"));
  if (typeof m.tasks === "number") cards.append(metric("累计任务", count(m.tasks), typeof m.tasksToday === "number" ? `今日新增 ${count(m.tasksToday)} · UTC 自然日` : "当前数据范围的任务总数", "≡"));
  if (typeof m.successRate === "number") cards.append(metric("任务成功率", (m.completedTasks || m.failedTasks) ? `${m.successRate.toFixed(1)}%` : "—", "已完成 ÷（已完成 + 失败）", "✓"));
  container.append(cards);
  container.append(trendPanel(data));
  const secondary = node("div", "metrics-grid secondary-metrics");
  if (typeof m.activeAccounts7d === "number") secondary.append(metric("近 7 天活跃账号", count(m.activeAccounts7d), "近 7 天有设备心跳的账号", "↗"));
  if (typeof m.primaryDevices === "number" && typeof m.onlinePrimaryDevices === "number") secondary.append(metric("主电脑在线率", m.primaryDevices ? `${Math.round(m.onlinePrimaryDevices / m.primaryDevices * 100)}%` : "—", `${count(m.onlinePrimaryDevices)} / ${count(m.primaryDevices)} 台主设备在线`, "⌁"));
  if (typeof m.downloads === "number") secondary.append(metric("版本下载请求", count(m.downloads), "包含续传请求，不代表安装数", "↓"));
  if (typeof data.releases?.published === "number") secondary.append(metric("已发布版本", count(data.releases.published), isAdmin() && typeof data.releases.drafts === "number" ? `另有 ${count(data.releases.drafts)} 个草稿待发布` : "客户端可检测的正式版本", "↥"));
  container.append(secondary);
  const grid = node("div", "dashboard-grid");
  const taskPanel = panel("任务运行情况", "查看待处理、执行中与已完成任务的分布");
  const bars = node("div", "bar-list");
  const entries = [["pendingTasks", "待处理", "pending"], ["runningTasks", "执行中", "running"], ["completedTasks", "已完成", "completed"], ["failedTasks", "失败", "failed"]];
  for (const [key, label, status] of entries) {
    if (typeof m[key] !== "number") continue;
    const row = node("div");
    const heading = node("div", "bar-label", label);
    heading.append(node("strong", "", count(m[key])));
    const bar = node("meter", `task-meter ${status}`);
    bar.max = Math.max(m.tasks || 0, m[key], 1);
    bar.value = m[key];
    bar.setAttribute("aria-label", `${label} ${count(m[key])}`);
    row.append(heading, bar);
    bars.append(row);
  }
  taskPanel.append(bars.children.length ? bars : empty("暂无任务统计"));
  const devicesPanel = panel("设备平台分布", "当前数据范围内已注册的设备", "设备");
  const platforms = node("div", "platform-list");
  for (const item of data.platforms || []) {
    const row = node("div", "platform-row");
    const text = node("div");
    text.append(node("strong", "", platform(item.platform)), node("p", "", "已注册设备"));
    row.append(node("span", "platform-icon", item.platform === "android" ? "A" : "M"), text, node("span", "platform-number", count(item.count)));
    platforms.append(row);
  }
  devicesPanel.append(platforms.children.length ? platforms : empty("暂无设备", "客户端登录后将显示设备信息。"));
  grid.append(taskPanel, devicesPanel);
  container.append(grid);
  if (data.trend?.length) {
    const trend = node("details", "daily-data");
    trend.append(node("summary", "", "查看每日明细数据"));
    const rows = data.trend.map(trendRow);
    trend.append(table(["日期（UTC）", "新增账号", "新增设备", "任务数", "已完成", "失败"], rows));
    container.append(trend);
  }
  const note = node("p", "metric-definitions");
  note.append(node("strong", "", "统计口径 · "), document.createTextNode("今日与趋势按 UTC 自然日统计；列表时间为北京时间。在线状态取最近 60 秒设备心跳；成功率仅计算已有最终结果的任务。"));
  container.append(note);
}

/** 转换趋势为表格行。参数：item 为单日汇总；返回：单元格数组；注意：日期字段只作纯文本展示。 */
function trendRow(item) { return [item.date, count(item.accountsCreated), count(item.devicesCreated), count(item.total), count(item.completed), count(item.failed)]; }

/** 创建只读表格。参数：headers 为表头、rows 为单元格二维数组；返回：表格容器；注意：仅接受文本或已安全构造的 DOM。 */
function table(headers, rows) {
  const wrap = node("div", "table-wrap");
  const result = node("table", "data-table");
  const head = node("thead");
  const heading = node("tr");
  for (const label of headers) { const cell = node("th", "", label); cell.scope = "col"; heading.append(cell); }
  head.append(heading);
  const body = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    for (const value of row) { const cell = node("td"); if (value instanceof Node) cell.append(value); else cell.textContent = value ?? "—"; tr.append(cell); }
    body.append(tr);
  }
  result.append(head, body);
  wrap.append(result);
  return wrap;
}

/** 创建主副文字单元格。参数：title、subtitle 为文字；返回：容器；注意：完整文字保留在 title 便于查看。 */
function textCell(title, subtitle) {
  const cell = node("div");
  const main = node("span", "cell-title", title || "—");
  main.title = title || "";
  cell.append(main);
  if (subtitle) { const sub = node("span", "cell-subtitle", subtitle); sub.title = subtitle; cell.append(sub); }
  return cell;
}

/** 渲染服务端分页。参数：id 为容器、data 为分页响应；返回：无；注意：不对单页数据进行伪全局搜索。 */
function pagination(id, data) {
  const target = el(id);
  target.replaceChildren();
  if (typeof data.total !== "number" || data.total === 0) return;
  const pages = Math.max(1, Math.ceil(data.total / (data.pageSize || pageSize)));
  target.append(node("span", "", `共 ${count(data.total)} 条 · ${state.page} / ${pages} 页`));
  const previous = node("button", "button subtle", "上一页");
  previous.type = "button";
  previous.disabled = state.page <= 1;
  previous.addEventListener("click", previousPage);
  const next = node("button", "button subtle", "下一页");
  next.type = "button";
  next.disabled = state.page >= pages;
  next.addEventListener("click", nextPage);
  target.append(previous, next);
}

/** 读取上一页。参数：无；返回：无；注意：加载中忽略重复翻页。 */
function previousPage() { if (!state.loading && state.page > 1) { state.page -= 1; loadPage(); } }

/** 读取下一页。参数：无；返回：无；注意：按钮可用性由服务端总量确定。 */
function nextPage() { if (!state.loading) { state.page += 1; loadPage(); } }

/** 渲染账号或设备列表。参数：data 为分页响应；返回：无；注意：只展示接口按身份授权返回的数据。 */
function renderAccounts(data) {
  const target = el("accounts-content");
  const devices = state.list === "devices";
  el("accounts-switch").classList.toggle("active", !devices);
  el("devices-switch").classList.toggle("active", devices);
  const rows = (data.items || []).map(devices ? deviceRow : accountRow);
  const headers = devices ? ["设备", "所属账号", "连接状态", "主电脑", "最近心跳（北京时间）"] : ["账号", "登录方式", "设备数", "任务数", "注册时间（北京时间）"];
  if (!devices && isSuperadmin()) headers.push("账号管理");
  target.replaceChildren(rows.length ? table(headers, rows) : empty(state.query ? "未找到匹配结果" : devices ? "暂无设备" : "暂无账号", state.query ? "尝试调整搜索条件。" : "客户端登录后，会在这里显示对应数据。"));
  pagination("accounts-pagination", data);
}

/** 转换账号表格行。参数：item 为账号；返回：单元格数组；注意：邮箱不包含可执行链接。 */
function accountRow(item) {
  const row = [textCell(item.name || item.email, item.email), ({ email: "邮箱密码", google: "Google" })[item.provider] || item.provider || "—", count(item.deviceCount), count(item.taskCount), date(item.createdAt)];
  if (isSuperadmin()) row.push(accountActions(item));
  return row;
}

/** 转换设备表格行。参数：item 为设备；返回：单元格数组；注意：在线与主设备状态直接采用服务器结果。 */
function deviceRow(item) { return [textCell(item.name, platform(item.platform)), textCell(item.accountEmail || state.user.email, item.accountId), badge(item.online ? "online" : "offline"), item.isPrimary ? "主电脑" : "—", date(item.lastSeenAt)]; }

/** 渲染任务列表。参数：data 为分页响应；返回：无；注意：不显示聊天正文，降低运营页敏感信息暴露。 */
function renderTasks(data) {
  const rows = (data.items || []).map(taskRow);
  el("tasks-content").replaceChildren(rows.length ? table(["任务", "所属账号", "状态", "创建时间（北京时间）", "更新时间（北京时间）"], rows) : empty("暂无符合条件的任务", "调整筛选条件，或等待客户端发起新任务。"));
  pagination("tasks-pagination", data);
}

/** 转换任务表格行。参数：item 为任务；返回：单元格数组；注意：只呈现元数据，不渲染任务内容。 */
function taskRow(item) { return [textCell(item.id, item.mode || "—"), item.accountEmail || state.user.email, badge(item.status), date(item.createdAt), date(item.updatedAt)]; }

/** 校验安装包下载地址。参数：value 为服务端 URL；返回：同源 URL 或空字符串；注意：禁止 javascript 协议与第三方地址。 */
function downloadURL(value) {
  if (!value) return "";
  try { const url = new URL(value, window.location.href); return url.origin === window.location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}

/** 渲染版本列表。参数：data 为分页响应；返回：无；注意：非管理员不显示任何发布写操作。 */
function renderReleases(data) {
  const target = el("releases-content");
  const enabled = data.releaseUploadEnabled !== false;
  el("upload-open").disabled = !enabled;
  el("upload-open").title = enabled ? "" : "服务器尚未配置安装包共享存储";
  state.releaseStorage = isAdmin() ? data.releaseStorage || null : null;
  renderStorageGuide();
  document.querySelector(".release-notice").textContent = !enabled ? "安装包存储尚未配置，当前无法上传或下载安装包。请由运维配置共享存储后启用版本发布。" : isAdmin() ? "上传安装包后先保存为草稿，发布后客户端才会检测到新版本。上传过程中可以中断。撤回后停止向客户端提供该版本。下载请求次数包含续传请求，不代表安装数。" : "查看已发布的 macOS 和 Android 版本，下载与你的设备匹配的安装包。";
  const list = node("div", "release-list");
  for (const item of data.items || []) {
    const card = node("article", "release-card");
    const head = node("div", "release-head");
    const heading = node("div", "release-heading");
    const title = node("div");
    title.append(node("h3", "", `${platform(item.platform)} ${item.version}`), node("p", "muted", `${item.arch} · 构建 ${item.buildNumber}`));
    heading.append(node("span", "platform-icon", item.platform === "android" ? "A" : "M"), title, badge(item.status));
    const actions = node("div", "release-actions");
    const url = downloadURL(item.downloadUrl);
    if (enabled && url && item.status === "published") { const link = node("a", "button subtle", "↓ 下载安装包"); link.href = url; link.setAttribute("download", ""); actions.append(link); }
    if (isAdmin()) {
      const button = node("button", `button ${item.status === "published" ? "danger" : "primary"}`, item.status === "published" ? "撤回版本" : "发布版本");
      button.type = "button";
      button.dataset.id = item.id;
      button.dataset.action = item.status === "published" ? "withdraw" : "publish";
      button.dataset.version = `${platform(item.platform)} ${item.version}（${item.arch}，构建 ${item.buildNumber}）`;
      button.disabled = !enabled && item.status !== "published";
      button.addEventListener("click", confirmRelease);
      actions.append(button);
    }
    head.append(heading, actions);
    const meta = node("div", "release-meta");
    meta.append(node("span", "", item.fileName || "安装包"), node("span", "", size(item.size)), node("span", "", `上传 ${date(item.createdAt)}`));
    if (item.publishedAt) meta.append(node("span", "", `发布 ${date(item.publishedAt)}`));
    if (typeof item.downloadCount === "number") meta.append(node("span", "", `${count(item.downloadCount)} 次下载请求`));
    card.append(head, node("p", "release-notes", item.notes || "暂无更新说明"), meta);
    const known = state.releasePlaces[item.id];
    if (known?.length) card.append(node("div", "checksum", `本次已写入  ${known.map(function placeText(place) { return place.host ? `${place.host}:${place.path}` : place.path; }).join("；")}`));
    else if (isAdmin() && item.storagePath) card.append(node("div", "checksum", `存放路径  ${item.storagePath}`));
    if (item.sha256) card.append(node("div", "checksum", `SHA-256  ${item.sha256}`));
    list.append(card);
  }
  target.replaceChildren(list.children.length ? list : empty("暂无版本", isAdmin() ? "上传 DMG 或 APK 安装包，开始发布第一个版本。" : "管理员发布版本后，可在此下载安装包。"));
  pagination("releases-pagination", data);
}

/** 加载当前功能页。参数：无；返回：加载 Promise；注意：递增请求序号防止较慢旧请求覆盖新筛选结果。 */
async function loadPage() {
  if (!state.user) return;
  const request = ++state.request;
  const tab = state.tab;
  state.loading = true;
  el("refresh-button").disabled = true;
  el("page-loading").hidden = false;
  el(`${tab}-panel`).setAttribute("aria-busy", "true");
  errorMessage("page-error");
  const query = new URLSearchParams({ page: state.page, pageSize });
  if (state.query) query.set("q", state.query);
  try {
    if (tab === "overview") {
      const data = await api(overviewPath());
      if (request !== state.request) return;
      state.overview = data;
      renderOverview(data);
    } else if (tab === "accounts") {
      const data = await api(`${state.list}?${query}`);
      if (request !== state.request) return;
      renderAccounts(data);
    } else if (tab === "tasks") {
      if (state.status) query.set("status", state.status);
      const [data, overview] = await Promise.all([api(`tasks?${query}`), api(overviewPath())]);
      if (request !== state.request) return;
      state.overview = overview;
      taskMetrics(el("task-metrics"), overview.metrics || {});
      renderTasks(data);
    } else {
      if (state.platform) query.set("platform", state.platform);
      const data = await api(`releases?${query}`);
      if (request !== state.request) return;
      renderReleases(data);
    }
    el("last-updated").textContent = `更新于 ${date(new Date().toISOString())}`;
  } catch (error) {
    if (request === state.request && state.user) errorMessage("page-error", error.message || "无法连接中转站，请检查网络后点击刷新。");
  } finally {
    if (request === state.request) { state.loading = false; el("refresh-button").disabled = false; el("page-loading").hidden = true; el(`${tab}-panel`).setAttribute("aria-busy", "false"); }
  }
}

/** 处理页签点击。参数：event 为点击事件；返回：无；注意：仅接收模板中预定义页签。 */
function onTab(event) { switchTab(event.currentTarget.dataset.tab); }

/** 切换账号/设备子页。参数：event 为点击事件；返回：无；注意：清空之前的搜索与分页。 */
function switchAccountList(event) { state.list = event.currentTarget.id === "devices-switch" ? "devices" : "accounts"; state.page = 1; state.query = ""; el("accounts-search").reset(); loadPage(); }

/** 提交列表搜索。参数：event 为表单事件；返回：无；注意：搜索在服务端执行，返回真实匹配总数。 */
function search(event) {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get("q").trim();
  if (new TextEncoder().encode(query).length > 128) { errorMessage("page-error", "搜索内容不能超过 128 个 UTF-8 字节。"); return; }
  state.query = query;
  state.page = 1;
  loadPage();
}

/** 处理任务状态筛选。参数：event 为选择事件；返回：无；注意：服务端成功状态使用 done。 */
function filterStatus(event) { state.status = event.currentTarget.value; state.page = 1; loadPage(); }

/** 处理发布平台筛选。参数：event 为选择事件；返回：无；注意：不改变服务端授权数据范围。 */
function filterPlatform(event) { state.platform = event.currentTarget.value; state.page = 1; loadPage(); }

/** 展示安装包会落到哪些服务器目录。参数：无，读取版本列表里的 releaseStorage；返回：无；注意：只向管理员展示宿主机路径。 */
function renderStorageGuide() {
  const box = el("release-storage");
  const storage = state.releaseStorage;
  if (!isAdmin() || !storage?.directory) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const hosts = storage.nodes || [];
  box.replaceChildren(node("p", "", "上传后的安装包放在每台部署服务器的这个目录："));
  const list = node("ul", "storage-nodes");
  for (const host of hosts) list.append(node("li", "", `${host}:${storage.directory}`));
  if (!hosts.length) list.append(node("li", "", storage.directory));
  box.append(list, node("p", "muted", "网页上传按约 16MB 一段发送，避免入口拒绝上百 MB 的 DMG。上传过程中可以取消，取消后半成品会被删除。安装包较大时，也可以按上传窗口里的步骤手动复制到上述目录再登记。"));
}

/** 生成保存成功的提示。参数：result 为上传或登记响应；返回：提示文字；注意：只列出这次确认写成功的服务器。 */
function savedMessage(result) {
  const places = (result.locations || []).map(function placeText(place) { return place.host ? `${place.host}:${place.path}` : place.path; }).filter(Boolean);
  return places.length ? `安装包已保存为草稿。实际位置：${places.join("；")}` : "安装包已保存为草稿。确认信息后即可发布。";
}

/** 记住本次确认写入的位置。参数：result 为成功响应；返回：无；注意：刷新页面后仍可从版本记录里的目录显示路径。 */
function rememberPlaces(result) {
  if (result.release?.id && result.locations?.length) state.releasePlaces[result.release.id] = result.locations;
}

/** 填写手动复制安装包的步骤。参数：无；返回：无；注意：文件名限制与服务端登记规则一致。 */
function renderManualSteps() {
  const target = el("manual-steps");
  const storage = state.releaseStorage;
  const extension = el("upload-platform").value === "android" ? "apk" : "dmg";
  target.replaceChildren();
  if (!storage?.directory) { target.append(node("li", "", "服务器尚未配置安装包目录，暂时不能手动上传。")); return; }
  target.append(node("li", "", `把安装包改成只含字母、数字、点、下划线和短横线的名字，例如 Chorus-1.2.0.${extension}。`));
  const hosts = storage.nodes || [];
  if (!hosts.length) target.append(node("li", "", `复制到目录 ${storage.directory}，文件名保持不变。`));
  for (const host of hosts) target.append(node("li", "", `scp Chorus-1.2.0.${extension} hjh@${host}:${storage.directory}/`));
  target.append(node("li", "", "每台服务器都放好后，上面的版本号、构建号和更新说明照常填写。在下面输入服务器上的文件名（不要带路径），点击「登记服务器上的文件」。"));
  target.append(node("li", "", "登记成功后，文件会被改成服务生成的名字，版本卡片上会显示实际路径。"));
}

/** 更新上传平台对应架构选项。参数：无；返回：无；注意：切换平台会清空已选文件，防止错传安装包。 */
function uploadPlatform() {
  const android = el("upload-platform").value === "android";
  const options = android ? [["universal", "通用 · universal"]] : [["arm64", "Apple Silicon · arm64"], ["x64", "Intel · x64"], ["universal", "通用 · universal"]];
  el("upload-arch").replaceChildren();
  for (const [value, label] of options) { const option = node("option", "", label); option.value = value; el("upload-arch").append(option); }
  el("upload-file").value = "";
  el("upload-file").accept = android ? ".apk" : ".dmg";
  el("file-description").textContent = `选择对应平台的 ${android ? ".apk" : ".dmg"} 文件`;
  renderManualSteps();
}

/** 打开上传对话框。参数：无；返回：无；注意：仅在管理员已登录时显示入口。 */
function openUpload() { if (!isAdmin()) return; el("upload-form").reset(); uploadPlatform(); errorMessage("upload-error"); el("upload-progress-wrap").hidden = true; el("upload-dialog").showModal(); }

/** 关闭或中断上传。参数：无；返回：无；注意：校验保存阶段不再中断，避免删掉已经写完的安装包。 */
function closeUpload() {
  if (state.finishing) return;
  if (state.uploading) { state.uploadAbort = true; if (state.uploadXHR) state.uploadXHR.abort(); return; }
  el("upload-dialog").close();
}

/** 拦截上传中的 Escape，并改为中断上传。参数：event 为取消事件；返回：无；注意：校验保存阶段只阻止关闭。 */
function cancelUpload(event) {
  if (!state.uploading && !state.finishing) return;
  event.preventDefault();
  closeUpload();
}

/** 展示所选文件信息。参数：无；返回：无；注意：文件名只作为文本展示。 */
function fileSelected() { const file = el("upload-file").files[0]; if (file) el("file-description").textContent = `${file.name} · ${size(file.size)}`; }

/** 锁定上传表单。参数：locked 为是否正在上传；返回：无；注意：取消和关闭保持可用，用来中断上传。 */
function setUploadLocked(locked) {
  for (const control of el("upload-form").elements) {
    if (control.id === "upload-cancel" || control.id === "upload-close") continue;
    control.disabled = locked;
  }
  el("upload-cancel").disabled = false;
  el("upload-close").disabled = false;
  if (!locked) { el("upload-submit").textContent = "上传并保存草稿"; el("import-submit").textContent = "登记服务器上的文件"; }
}

/** 构造用户中断错误。参数：无；返回：带 aborted 标记的错误；注意：不把它显示成网络故障。 */
function abortedUpload() { const error = new Error("aborted"); error.aborted = true; return error; }

/** 更新分段上传进度。参数：loaded/total 为已发送和总字节；返回：无；注意：校验完成前最高显示 99%。 */
function showUploadProgress(loaded, total) {
  const value = total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0;
  el("upload-progress").value = value;
  el("upload-progress-label").textContent = `${value}% · ${size(loaded)} / ${size(total)}`;
}

/** 发送一段原始字节。参数：id/offset/blob/total 为上传标识、起点、分段和总大小；返回：服务端进度；注意：同一段失败会自动再试一次。 */
function putChunk(id, offset, blob, total) {
  const sessionVersion = state.sessionVersion;
  return new Promise(function chunkPromise(resolve, reject) {
    if (state.uploadAbort) { reject(abortedUpload()); return; }
    const xhr = new XMLHttpRequest();
    state.uploadXHR = xhr;
    xhr.open("PUT", `./api/releases/uploads/${encodeURIComponent(id)}?offset=${offset}`);
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("X-CSRF-Token", state.csrf);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = function chunkProgress(event) { if (event.lengthComputable) showUploadProgress(offset + event.loaded, total); };
    xhr.onload = function chunkDone() {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { body = {}; }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(body); return; }
      if (xhr.status === 401 && sessionVersion === state.sessionVersion) { showAuth(); errorMessage("auth-error", "会话已过期，请重新登录。"); }
      const error = new Error(body.error?.message || `上传失败（${xhr.status}），请重试。`);
      error.status = xhr.status;
      reject(error);
    };
    xhr.onabort = function chunkAborted() { reject(abortedUpload()); };
    xhr.onerror = function chunkFailed() { reject(new Error("网络中断，上传未完成。请检查网络并刷新版本列表后重试。")); };
    xhr.ontimeout = function chunkTimedOut() { reject(new Error("这一段上传超时。可以重新选择文件再试，或改用手动上传。")); };
    xhr.send(blob);
  });
}

/** 发送一段并在网络错误时重试一次。参数同 putChunk；返回：进度；注意：用户取消和明确的请求错误不重试。 */
async function sendChunk(id, offset, blob, total) {
  try { return await putChunk(id, offset, blob, total); }
  catch (error) {
    if (error.aborted || (error.status && error.status < 500)) throw error;
    return putChunk(id, offset, blob, total);
  }
}

/** 校验完整安装包并登记草稿。参数：id 为上传标识；返回：草稿和实际路径；注意：此阶段不再响应取消。 */
function finishUpload(id) {
  const sessionVersion = state.sessionVersion;
  return new Promise(function finishPromise(resolve, reject) {
    const xhr = new XMLHttpRequest();
    state.uploadXHR = xhr;
    xhr.open("POST", `./api/releases/uploads/${encodeURIComponent(id)}/finish`);
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("X-CSRF-Token", state.csrf);
    xhr.onload = function finishDone() {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { body = {}; }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(body); return; }
      if (xhr.status === 401 && sessionVersion === state.sessionVersion) { showAuth(); errorMessage("auth-error", "会话已过期，请重新登录。"); }
      reject(new Error(body.error?.message || `保存失败（${xhr.status}），请刷新版本列表后重试。`));
    };
    xhr.onerror = function finishFailed() { reject(new Error("网络中断。请刷新版本列表，确认草稿是否已保存。")); };
    xhr.ontimeout = function finishTimedOut() { reject(new Error("校验保存超时。请刷新版本列表，确认草稿是否已保存。")); };
    xhr.send();
  });
}

/** 按段上传安装包。参数：data 为表单，file 为所选文件；返回：登记结果；注意：入口单次请求大约不能超过 60MB，所以不把整个 DMG 一次提交。 */
async function uploadInChunks(data, file) {
  el("upload-progress-label").textContent = "准备上传…";
  const created = await api("releases/uploads", { method: "POST", body: JSON.stringify({ platform: data.get("platform"), arch: data.get("arch"), version: data.get("version").trim(), buildNumber: Number(data.get("buildNumber")), notes: data.get("notes").trim(), fileName: file.name, size: file.size }) });
  state.uploadID = created.id;
  if (state.uploadAbort) throw abortedUpload();
  const chunkBytes = created.chunkBytes || (16 * 1024 * 1024);
  let offset = 0;
  while (offset < file.size) {
    if (state.uploadAbort) throw abortedUpload();
    const blob = file.slice(offset, Math.min(file.size, offset + chunkBytes));
    const progress = await sendChunk(created.id, offset, blob, file.size);
    if (!(progress.received > offset)) throw new Error("上传进度没有前进，请中断后重试。");
    offset = progress.received;
  }
  state.finishing = true;
  el("upload-cancel").disabled = true;
  el("upload-close").disabled = true;
  el("upload-progress").value = 100;
  el("upload-progress-label").textContent = "校验并保存中…";
  return finishUpload(created.id);
}

/** 删除已中断上传的半成品。参数：无，使用当前上传标识；返回：是否已删除；注意：会话过期时由服务器稍后清理。 */
async function discardUpload() {
  const id = state.uploadID;
  if (!id) return false;
  try { await api(`releases/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }); return true; }
  catch { return false; }
}

/** 提交版本草稿。参数：event 为提交事件；返回：上传 Promise；注意：扩展名预检只改善体验，真正文件校验由后端执行。 */
async function submitUpload(event) {
  event.preventDefault();
  if (state.uploading) return;
  errorMessage("upload-error");
  const data = new FormData(el("upload-form"));
  const file = data.get("file");
  const extension = data.get("platform") === "android" ? ".apk" : ".dmg";
  if (!file?.size || !file.name.toLowerCase().endsWith(extension)) { errorMessage("upload-error", `请选择非空的 ${extension} 安装包。`); return; }
  if (new TextEncoder().encode(data.get("notes").trim()).length > 8192) { errorMessage("upload-error", "更新说明不能超过 8192 个 UTF-8 字节（约 2700 个中文字符）。"); return; }
  if (new TextEncoder().encode(file.name).length > 200) { errorMessage("upload-error", "安装包文件名不能超过 200 个 UTF-8 字节，请缩短文件名。"); return; }
  state.uploading = true;
  state.finishing = false;
  state.uploadAbort = false;
  state.uploadID = "";
  setUploadLocked(true);
  el("upload-progress-wrap").hidden = false;
  el("upload-progress").value = 0;
  el("upload-progress-label").textContent = "0%";
  el("upload-submit").textContent = "正在上传…";
  el("upload-cancel").textContent = "中断上传";
  try {
    const result = await uploadInChunks(data, file);
    rememberPlaces(result);
    el("upload-dialog").close();
    toast(savedMessage(result));
    state.page = 1;
    await loadPage();
  } catch (error) {
    if (error.aborted || state.uploadAbort) {
      const removed = await discardUpload();
      errorMessage("upload-error", removed || !state.uploadID ? "上传已中断，服务器上的半成品已删除。" : "上传已中断。服务器会在 6 小时内删除未完成的文件。");
    } else errorMessage("upload-error", error.message);
  } finally {
    state.uploading = false;
    state.finishing = false;
    state.uploadXHR = null;
    state.uploadID = "";
    state.uploadAbort = false;
    setUploadLocked(false);
    el("upload-cancel").textContent = "取消";
  }
}

/** 登记已经手动放到服务器目录里的安装包。参数：无；返回：登记 Promise；注意：不读取浏览器里的文件，文件名必须与服务器上的文件一致。 */
async function importPackage() {
  if (state.uploading || !isAdmin()) return;
  errorMessage("upload-error");
  const data = new FormData(el("upload-form"));
  const fileName = String(data.get("serverFile") || "").trim();
  const notes = String(data.get("notes") || "").trim();
  const version = String(data.get("version") || "").trim();
  const buildNumber = Number(data.get("buildNumber"));
  const extension = data.get("platform") === "android" ? ".apk" : ".dmg";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(dmg|apk)$/i.test(fileName) || !fileName.toLowerCase().endsWith(extension)) { errorMessage("upload-error", `请填写服务器上的 ${extension} 文件名，只能包含字母、数字、点、下划线和短横线。`); return; }
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version) || !Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2100000000) { errorMessage("upload-error", "请先填写有效的三段版本号和构建号。"); return; }
  if (new TextEncoder().encode(notes).length > 8192) { errorMessage("upload-error", "更新说明不能超过 8192 个 UTF-8 字节（约 2700 个中文字符）。"); return; }
  state.uploading = true;
  el("import-submit").disabled = true;
  el("import-submit").textContent = "正在登记…";
  try {
    const result = await api("releases/import", { method: "POST", body: JSON.stringify({ platform: data.get("platform"), arch: data.get("arch"), version, buildNumber, notes, fileName }) });
    rememberPlaces(result);
    el("upload-dialog").close();
    toast(savedMessage(result));
    state.page = 1;
    await loadPage();
  } catch (error) { errorMessage("upload-error", error.message); }
  finally { state.uploading = false; el("import-submit").disabled = false; el("import-submit").textContent = "登记服务器上的文件"; }
}

/** 准备版本发布或撤回确认。参数：event 为操作按钮事件；返回：无；注意：确认文字包含具体版本，避免误操作。 */
function confirmRelease(event) {
  const { id, action, version } = event.currentTarget.dataset;
  confirmation = { id, action };
  const publishing = action === "publish";
  el("confirm-title").textContent = publishing ? "发布这个版本？" : "撤回这个版本？";
  el("confirm-message").textContent = publishing ? `${version} 发布后，符合平台与架构要求的客户端将可以检测到并下载此更新。` : `${version} 撤回后将停止提供更新与下载。已下载安装的客户端不会自动降级。`;
  el("confirm-action").textContent = publishing ? "确认发布" : "确认撤回";
  el("confirm-action").className = `button ${publishing ? "primary" : "danger"}`;
  el("confirm-dialog").showModal();
}

/** 取消版本操作。参数：无；返回：无；注意：清空未执行操作，避免复用旧版本。 */
function closeConfirmation() { confirmation = null; el("confirm-dialog").close(); }

/** 避免变更提交中误关确认框。参数：event 为取消事件；返回：无；注意：请求完成后允许正常取消。 */
function cancelConfirmation(event) { if (el("confirm-action").disabled) event.preventDefault(); else confirmation = null; }

/** 执行已确认的版本变更。参数：无；返回：操作 Promise；注意：写请求必须携带 CSRF，失败保持版本列表不变。 */
async function applyRelease() {
  if (!confirmation) return;
  const { id, action } = confirmation;
  el("confirm-action").disabled = true;
  el("confirm-cancel").disabled = true;
  try { await api(`releases/${encodeURIComponent(id)}/${action}`, { method: "POST" }); closeConfirmation(); toast(action === "publish" ? "版本已发布，客户端可以检测更新。" : "版本已撤回。"); await loadPage(); }
  catch (error) { el("confirm-message").textContent = error.message || "操作失败，请重试。"; }
  finally { el("confirm-action").disabled = false; el("confirm-cancel").disabled = false; }
}

/** 恢复会话并绑定页面事件。参数：无；返回：启动 Promise；注意：初次认证失败显示登录页，其他连接错误明确提示。 */
async function initialize() {
  // ------------ 绑定静态事件，后续动态内容使用安全 DOM 生成 ---------------
  initializeAccountActions();
  el("auth-form").addEventListener("submit", submitAuth);
  el("auth-toggle").addEventListener("click", toggleAuth);
  el("logout-button").addEventListener("click", logout);
  el("refresh-button").addEventListener("click", loadPage);
  for (const item of document.querySelectorAll("[data-tab]")) item.addEventListener("click", onTab);
  el("accounts-switch").addEventListener("click", switchAccountList);
  el("devices-switch").addEventListener("click", switchAccountList);
  el("accounts-search").addEventListener("submit", search);
  el("tasks-search").addEventListener("submit", search);
  el("task-status").addEventListener("change", filterStatus);
  el("release-platform").addEventListener("change", filterPlatform);
  el("upload-open").addEventListener("click", openUpload);
  el("upload-close").addEventListener("click", closeUpload);
  el("upload-cancel").addEventListener("click", closeUpload);
  el("upload-dialog").addEventListener("cancel", cancelUpload);
  el("upload-platform").addEventListener("change", uploadPlatform);
  el("upload-file").addEventListener("change", fileSelected);
  el("upload-form").addEventListener("submit", submitUpload);
  el("import-submit").addEventListener("click", importPackage);
  el("import-name").addEventListener("keydown", function importOnEnter(event) { if (event.key === "Enter") { event.preventDefault(); importPackage(); } });
  el("confirm-cancel").addEventListener("click", closeConfirmation);
  el("confirm-dialog").addEventListener("cancel", cancelConfirmation);
  el("confirm-action").addEventListener("click", applyRelease);
  try { showConsole(await api("me")); }
  catch (error) { showAuth(); if (error.status !== 401) errorMessage("auth-error", error.message || "无法连接中转站，请检查网络。"); }
}

initialize();
