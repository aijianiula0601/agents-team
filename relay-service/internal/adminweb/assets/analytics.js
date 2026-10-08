"use strict";

const trendDimensions = {
  tasks: { label: "任务运行", title: "任务运行趋势", description: "按任务创建日期，观察任务规模与执行结果。", series: [["total", "任务总量"], ["completed", "已完成"], ["failed", "失败"]] },
  growth: { label: "账号与设备增长", title: "账号与设备增长", description: "观察每天新增的账号与设备，了解使用规模的变化。", series: [["accountsCreated", "新增账号"], ["devicesCreated", "新增设备"]] }
};

/** 判断当前身份是否具备管理员能力。参数：无；返回：布尔值；注意：仅影响页面，实际权限由服务器判定。 */
function isAdmin() { return ["admin", "superadmin"].includes(state.user?.role); }

/** 判断是否为后端认证的唯一超级管理员。参数：无；返回：布尔值；注意：不通过邮箱或前端填写的员工号提升权限。 */
function isSuperadmin() { return state.user?.role === "superadmin"; }

/** 生成 UTC 日期字符串。参数：value 为日期或时间戳；返回：YYYY-MM-DD；注意：不使用浏览器本地时区计算统计边界。 */
function utcDate(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }

/** 设置以今天为结束日的日期范围。参数：days 为包含今天的天数；返回：无；注意：始终按 UTC 自然日计算。 */
function setDatePreset(days) {
  const end = new Date(`${utcDate()}T00:00:00Z`);
  state.endDate = utcDate(end);
  state.startDate = utcDate(end.getTime() - (days - 1) * 86400000);
  state.rangeDays = days;
}

/** 构建统计查询地址。参数：无；返回：附有日期范围的相对 API；注意：首次进入默认查询最近 30 个 UTC 日。 */
function overviewPath() {
  if (!state.startDate || !state.endDate) setDatePreset(30);
  return `overview?${new URLSearchParams({ startDate: state.startDate, endDate: state.endDate })}`;
}

/** 创建受控 SVG 元素。参数：tag、attributes、text 为图形配置；返回：SVG 元素；注意：不接收服务端 HTML 或样式字符串。 */
function svgNode(tag, attributes = {}, text = "") {
  const item = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  item.textContent = text;
  return item;
}

/** 计算易读的纵轴上限。参数：maximum 为实际最大值；返回：可分成 4 段的上限；注意：全零数据保留有效坐标轴。 */
function chartMaximum(maximum) {
  if (maximum <= 4) return 4;
  const unit = 10 ** Math.floor(Math.log10(maximum / 4));
  return Math.ceil(maximum / 4 / unit) * unit * 4;
}

/** 创建日期范围选择器。参数：range 为服务端确认范围；返回：工具栏；注意：自定义日期使用浏览器原生日历并校验最大 366 天。 */
function rangeControls(range) {
  const toolbar = node("div", "range-controls");
  const presets = node("div", "range-presets", "");
  presets.setAttribute("aria-label", "常用日期范围");
  for (const days of [7, 30, 90]) {
    const button = node("button", state.rangeDays === days ? "active" : "", `${days} 天`);
    button.type = "button";
    button.dataset.days = String(days);
    button.setAttribute("aria-pressed", String(state.rangeDays === days));
    button.addEventListener("click", selectDatePreset);
    presets.append(button);
  }
  const picker = node("details", "date-picker");
  const summary = node("summary", "", `▦  ${range.startDate.replaceAll("-", "/")} — ${range.endDate.replaceAll("-", "/")}`);
  summary.setAttribute("aria-label", "打开日期范围日历");
  const form = node("form", "date-popover");
  const heading = node("div", "date-popover-heading", "自定义日期范围");
  heading.append(node("span", "", "UTC"));
  form.append(heading);
  for (const [name, text, value] of [["startDate", "开始日期", range.startDate], ["endDate", "结束日期", range.endDate]]) {
    const label = node("label", "", text);
    const input = node("input");
    input.type = "date";
    input.name = name;
    input.value = value;
    input.max = utcDate();
    input.required = true;
    label.append(input);
    form.append(label);
  }
  const error = node("p", "form-error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const submit = node("button", "button primary full", "应用日期范围");
  submit.type = "submit";
  form.append(node("p", "privacy-note", "包含开始与结束日，最多可选择 366 天。"), error, submit);
  form.addEventListener("submit", applyDateRange);
  picker.append(summary, form);
  toolbar.append(presets, picker);
  return toolbar;
}

/** 应用常用范围。参数：event 为点击事件；返回：无；注意：范围变化从服务端重新获取真实数据。 */
function selectDatePreset(event) { setDatePreset(Number(event.currentTarget.dataset.days)); loadPage(); }

/** 校验并应用自定义日期。参数：event 为提交事件；返回：无；注意：阻止倒置、未来日期及超长范围，不静默截断。 */
function applyDateRange(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const startDate = data.get("startDate");
  const endDate = data.get("endDate");
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 + 1;
  const error = event.currentTarget.querySelector(".form-error");
  if (!Number.isInteger(days) || days < 1 || days > 366 || endDate > utcDate()) {
    error.textContent = "请选择不晚于今天、开始不晚于结束且不超过 366 天的日期范围。";
    error.hidden = false;
    return;
  }
  state.startDate = startDate;
  state.endDate = endDate;
  state.rangeDays = 0;
  event.currentTarget.closest("details").open = false;
  loadPage();
}

/** 切换趋势维度。参数：event 为按钮事件；返回：无；注意：同一响应已包含全部序列，不重复请求接口。 */
function selectTrendDimension(event) { state.chartMode = event.currentTarget.dataset.dimension; state.hiddenSeries.clear(); renderOverview(state.overview); }

/** 切换单条曲线的显示。参数：event 为图例事件；返回：无；注意：至少保留一条曲线，纵轴随可见数据自动调整。 */
function toggleTrendSeries(event) {
  const key = event.currentTarget.dataset.series;
  const available = trendDimensions[state.chartMode].series.filter(hasTrendSeries);
  if (state.hiddenSeries.has(key)) state.hiddenSeries.delete(key);
  else if (available.filter(isVisibleSeries).length > 1) state.hiddenSeries.add(key);
  else { toast("至少保留一条趋势曲线。"); return; }
  renderOverview(state.overview);
}

/** 判断响应是否提供完整曲线。参数：series 为字段与名称；返回：布尔值；注意：缺失字段不解释为零。 */
function hasTrendSeries(series) { return state.overview?.trend?.length > 0 && state.overview.trend.every(function validPoint(point) { return typeof point[series[0]] === "number" && Number.isFinite(point[series[0]]); }); }

/** 判断曲线是否被用户隐藏。参数：series 为字段与名称；返回：布尔值；注意：隐藏配置仅存于当前页面内存。 */
function isVisibleSeries(series) { return !state.hiddenSeries.has(series[0]); }

/** 创建趋势分析面板。参数：data 为带有每日趋势的响应；返回：面板；注意：累计指标与日期范围趋势分开展示。 */
function trendPanel(data) {
  const section = node("section", "panel trend-panel");
  const dimension = trendDimensions[state.chartMode];
  const range = data.range || { startDate: state.startDate, endDate: state.endDate, days: data.trend?.length || 0 };
  const heading = node("div", "trend-heading");
  const text = node("div");
  text.append(node("div", "eyebrow", "ACTIVITY ANALYTICS"), node("h2", "", "运行趋势"), node("p", "muted", "比较每日任务结果与账号、设备增长。"));
  heading.append(text, rangeControls(range));
  const dimensions = node("div", "trend-dimensions");
  dimensions.setAttribute("aria-label", "趋势维度");
  for (const [key, value] of Object.entries(trendDimensions)) {
    const button = node("button", key === state.chartMode ? "active" : "", value.label);
    button.type = "button";
    button.dataset.dimension = key;
    button.setAttribute("aria-pressed", String(key === state.chartMode));
    button.addEventListener("click", selectTrendDimension);
    dimensions.append(button);
  }
  section.append(heading, dimensions);
  const series = dimension.series.filter(hasTrendSeries);
  if (!series.length) { section.append(empty("暂无可展示的趋势", "服务返回趋势数据后，将按实际值绘制。")); return section; }
  const legend = node("div", "trend-legend");
  for (const [index, item] of series.entries()) {
    const visible = isVisibleSeries(item);
    const button = node("button", `legend-item series-${index}${visible ? "" : " muted-series"}`);
    button.type = "button";
    button.dataset.series = item[0];
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}${item[1]}曲线`);
    const total = data.trend.reduce(function sumSeries(sum, point) { return sum + point[item[0]]; }, 0);
    const label = node("span", "legend-description", item[1]);
    label.prepend(node("span", "legend-dot"));
    button.append(label, node("strong", "", count(total)), node("small", "", "区间合计"));
    legend.append(button);
  }
  section.append(legend, trendChart(data.trend, series));
  const note = state.chartMode === "tasks" ? "任务按创建日分组，完成与失败表示这些任务的当前状态，不代表当天完成或失败的次数。" : "新增设备包括后来被撤销的设备。此趋势反映创建量，不代表历史在线量或活跃人数。";
  section.append(node("p", "chart-note", `${range.startDate} 至 ${range.endDate} · ${range.days} 天 · UTC 自然日。日期范围仅作用于趋势，上方指标保持累计、今日与实时口径。${note}统计依据现存记录，删除账号后相关历史点会减少。`));
  return section;
}

/** 绘制可交互的多系列折线图。参数：points 为每日数据、series 为曲线；返回：图形容器；注意：保留零值、未知字段不造数，支持左右键查看每日值。 */
function trendChart(points, series) {
  const visible = series.filter(isVisibleSeries);
  const width = 960, height = 274, left = 48, right = 14, top = 18, bottom = 36;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = chartMaximum(Math.max(0, ...points.flatMap(function seriesValues(point) { return visible.map(function pointValue(item) { return point[item[0]]; }); })));
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, class: "trend-svg", role: "img", tabindex: "0", "aria-label": `${trendDimensions[state.chartMode].title}，使用左右方向键查看每日数值` });
  svg.append(svgNode("title", {}, trendDimensions[state.chartMode].title));
  // ------------ 横纵轴与所有曲线共享比例，避免独立缩放夸大变化 ---------------
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = top + plotHeight * tick / 4;
    svg.append(svgNode("line", { x1: left, y1: y, x2: width - right, y2: y, class: "chart-grid-line" }), svgNode("text", { x: left - 12, y: y + 4, "text-anchor": "end", class: "chart-axis-label" }, count(maximum * (4 - tick) / 4)));
  }
  const ticks = Math.min(7, points.length);
  for (let tick = 0; tick < ticks; tick += 1) {
    const index = ticks === 1 ? 0 : Math.round((points.length - 1) * tick / (ticks - 1));
    const x = left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
    svg.append(svgNode("text", { x, y: height - 9, "text-anchor": "middle", class: "chart-axis-label" }, points[index].date.slice(5).replace("-", "/")));
  }
  for (const [index, item] of series.entries()) {
    if (!isVisibleSeries(item)) continue;
    const coordinates = points.map(function pointCoordinates(point, position) { return [left + (points.length === 1 ? plotWidth / 2 : position * plotWidth / (points.length - 1)), top + plotHeight * (1 - point[item[0]] / maximum)]; });
    const path = coordinates.map(function pathSegment(value, position) { return `${position ? "L" : "M"}${value[0]},${value[1]}`; }).join(" ");
    svg.append(svgNode("path", { d: path, class: `chart-line series-${index}` }));
    if (points.length === 1) svg.append(svgNode("circle", { cx: coordinates[0][0], cy: coordinates[0][1], r: 4, class: `chart-point series-${index}` }));
  }
  const crosshair = svgNode("line", { y1: top, y2: top + plotHeight, class: "chart-crosshair" });
  svg.append(crosshair);
  const dots = visible.map(function seriesDot(item) { const index = series.indexOf(item); const dot = svgNode("circle", { r: 4.5, class: `chart-point series-${index}` }); svg.append(dot); return dot; });
  const inspector = node("div", "chart-inspector");
  const wrap = node("div", "chart-wrap");
  wrap.append(svg, inspector);
  let selected = points.length - 1;
  /** 展示某一天的所有可见曲线。参数：index 为每日索引；返回：无；注意：只修改 SVG 属性与安全文本。 */
  function inspect(index) {
    selected = Math.max(0, Math.min(points.length - 1, index));
    const point = points[selected];
    const x = left + (points.length === 1 ? plotWidth / 2 : selected * plotWidth / (points.length - 1));
    crosshair.setAttribute("x1", x); crosshair.setAttribute("x2", x);
    inspector.replaceChildren(node("strong", "inspector-date", `${point.date} · UTC`));
    for (const [index, item] of visible.entries()) {
      dots[index].setAttribute("cx", x); dots[index].setAttribute("cy", top + plotHeight * (1 - point[item[0]] / maximum));
      const value = node("span", `inspector-value series-${series.indexOf(item)}`);
      value.append(node("span", "legend-dot"), document.createTextNode(`${item[1]} `), node("strong", "", count(point[item[0]])));
      inspector.append(value);
    }
  }
  /** 将指针位置映射为最近日期。参数：event 为指针事件；返回：无；注意：按 viewBox 与实际宽度转换坐标。 */
  function inspectPointer(event) { const rect = svg.getBoundingClientRect(); inspect(Math.round(((event.clientX - rect.left) / rect.width * width - left) / plotWidth * (points.length - 1))); }
  /** 支持键盘按天查看。参数：event 为键盘事件；返回：无；注意：不拦截其他页面导航按键。 */
  function inspectKey(event) { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); inspect(selected + (event.key === "ArrowLeft" ? -1 : 1)); } }
  svg.addEventListener("pointermove", inspectPointer);
  svg.addEventListener("keydown", inspectKey);
  inspect(selected);
  return wrap;
}
