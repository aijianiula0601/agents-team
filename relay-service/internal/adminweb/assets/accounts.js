"use strict";

let accountOperation = null;
let accountOperationBusy = false;

/** 创建超级管理员的账号操作列。参数：account 为账号记录；返回：操作单元格；注意：受保护账号不提供变更入口。 */
function accountActions(account) {
  const actions = node("div", "account-actions");
  if (account.protected) { const protectedLabel = node("span", "protected-account", "◈ 受保护账号"); protectedLabel.title = "预置管理员或配置的超级管理员不可在此修改、重置或删除"; actions.append(protectedLabel); return actions; }
  for (const [action, text] of [["edit", "编辑"], ["password", "重置密码"], ["delete", "删除"]]) {
    if (action === "password" && account.provider !== "email") continue;
    const button = node("button", `account-action${action === "delete" ? " delete-action" : ""}`, text);
    button.type = "button";
    button.setAttribute("aria-label", `${text} ${account.email}`);
    /** 打开当前行操作。参数：无；返回：无；注意：仅捕获对应账号元数据，不存储密码。 */
    function openRowAction() { openAccountOperation(account, action); }
    button.addEventListener("click", openRowAction);
    actions.append(button);
  }
  return actions;
}

/** 配置并打开账号操作对话框。参数：account 为目标账号、action 为操作；返回：无；注意：权限与保护状态需由后端再次校验。 */
function openAccountOperation(account, action) {
  if (!isSuperadmin() || account.protected) return;
  accountOperation = { account, action };
  const titles = { edit: ["编辑账号", "更新显示名称或邮箱。修改邮箱后，该账号的所有浏览器与设备会话将退出。", "保存修改"], password: ["重置账号密码", "为此邮箱账号设置新密码。重置后，所有浏览器与设备会话将退出，需要使用新密码重新登录。", "确认重置密码"], delete: ["删除这个账号？", "请核对目标账号及影响范围，输入完整邮箱后才能删除。", "永久删除账号"] };
  const content = titles[action];
  el("account-form").reset();
  errorMessage("account-action-error");
  el("account-dialog-title").textContent = content[0];
  el("account-dialog-description").textContent = content[1];
  el("account-dialog-submit").textContent = content[2];
  el("account-dialog-submit").className = `button ${action === "delete" ? "danger-solid" : "primary"}`;
  el("account-target-avatar").textContent = (account.name || account.email).slice(0, 1);
  el("account-target-name").textContent = account.name || account.email;
  el("account-target-email").textContent = account.email;
  el("account-edit-fields").hidden = action !== "edit";
  el("account-password-fields").hidden = action !== "password";
  el("account-delete-fields").hidden = action !== "delete";
  el("account-edit-name").value = account.name || "";
  el("account-edit-email").value = account.email;
  el("account-edit-email").readOnly = account.provider !== "email";
  el("account-provider-note").textContent = account.provider === "email" ? "邮箱修改后，请使用新邮箱登录；既有数据仍归属于此账号。" : "第三方身份的登录邮箱由身份提供方管理，此处仅可修改显示名称。";
  el("account-edit-name").required = action === "edit";
  el("account-edit-email").required = action === "edit";
  el("account-new-password").required = action === "password";
  el("account-confirm-password").required = action === "password";
  el("account-delete-email").required = action === "delete";
  el("account-dialog").showModal();
}

/** 清空并关闭账号操作。参数：无；返回：无；注意：提交中禁止关闭，其他情况立即抹除密码。 */
function closeAccountOperation() { if (accountOperationBusy) return; accountOperation = null; el("account-form").reset(); el("account-dialog").close(); }

/** 处理 Escape 关闭。参数：event 为取消事件；返回：无；注意：提交中阻止关闭，完成后清空敏感输入。 */
function cancelAccountOperation(event) { if (accountOperationBusy) event.preventDefault(); else { accountOperation = null; el("account-form").reset(); } }

/** 提交账号变更。参数：event 为表单事件；返回：处理 Promise；注意：密码不写日志、不缓存，不自动重试可能已经生效的写请求。 */
async function submitAccountOperation(event) {
  event.preventDefault();
  if (!accountOperation || accountOperationBusy || !isSuperadmin()) return;
  errorMessage("account-action-error");
  const { account, action } = accountOperation;
  let path = `accounts/${encodeURIComponent(account.id)}`;
  let method = "PATCH";
  let body;
  if (action === "edit") {
    const name = el("account-edit-name").value.trim();
    if (!name) { errorMessage("account-action-error", "请输入有效的账号名称。"); return; }
    body = { name };
    if (account.provider === "email") body.email = el("account-edit-email").value.trim();
  } else if (action === "password") {
    const password = el("account-new-password").value;
    const bytes = new TextEncoder().encode(password).length;
    if (bytes < 8 || bytes > 72) { errorMessage("account-action-error", "密码须为 8–72 个 UTF-8 字节（一个中文字符通常占 3 个字节）。"); return; }
    if (password !== el("account-confirm-password").value) { errorMessage("account-action-error", "两次输入的新密码不一致。"); return; }
    path += "/reset-password";
    method = "POST";
    body = { password };
  } else {
    const confirmEmail = el("account-delete-email").value.trim();
    if (confirmEmail !== account.email) { errorMessage("account-action-error", "邮箱与目标账号不一致，请输入上方完整邮箱。"); return; }
    method = "DELETE";
    body = { confirmEmail };
  }
  // ------------ 禁止重复提交，完成后刷新当前账号范围 ---------------
  accountOperationBusy = true;
  for (const control of el("account-form").elements) control.disabled = true;
  try {
    const result = await api(path, { method, body: JSON.stringify(body) });
    accountOperationBusy = false;
    closeAccountOperation();
    toast(action === "delete" ? "账号及其关联数据已删除。" : result.sessionsRevoked ? "修改已保存，该账号的所有会话已退出。" : "账号资料已更新。");
    if (action === "delete") state.page = 1;
    await loadPage();
  } catch (error) { errorMessage("account-action-error", error.message || "操作失败，请刷新列表确认状态后重试。"); }
  finally { accountOperationBusy = false; for (const control of el("account-form").elements) control.disabled = false; el("account-new-password").value = ""; el("account-confirm-password").value = ""; }
}

/** 绑定账号操作对话框事件。参数：无；返回：无；注意：只在页面初始化时调用一次。 */
function initializeAccountActions() {
  el("account-dialog-close").addEventListener("click", closeAccountOperation);
  el("account-dialog-cancel").addEventListener("click", closeAccountOperation);
  el("account-dialog").addEventListener("cancel", cancelAccountOperation);
  el("account-form").addEventListener("submit", submitAccountOperation);
}
