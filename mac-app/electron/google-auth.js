/** 只把 Google 授权码登录页面交给系统浏览器，禁止将会话或轮询凭据放入浏览器 URL。 */
function validateGoogleAuthorizationUrl(value) {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Google 授权地址无效");
  let url;
  try { url = new URL(value); } catch (_error) { throw new Error("Google 授权地址无效"); }
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.port
      || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash
      || url.searchParams.get("response_type") !== "code" || !url.searchParams.get("state")
      || !url.searchParams.get("client_id") || !url.searchParams.get("redirect_uri")) {
    throw new Error("Google 授权地址无效");
  }
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password/i.test(key)) throw new Error("Google 授权地址包含不允许的凭据");
  }
  return url.toString();
}

/** 中转站持有 OAuth 配置和回调；桌面只负责打开经过校验的授权页面。 */
async function openGoogleAuthorization(value, openExternal) {
  const url = validateGoogleAuthorizationUrl(value);
  if (typeof openExternal !== "function") throw new Error("无法打开系统浏览器");
  await openExternal(url);
  return { opened: true };
}

module.exports = { openGoogleAuthorization, validateGoogleAuthorizationUrl };
