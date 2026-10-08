const assert = require("node:assert/strict");
const test = require("node:test");
const { openGoogleAuthorization, validateGoogleAuthorizationUrl } = require("./google-auth");
const shared = require("../../shared/web/relay-auth");

const URL = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=test.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Frelay.example.test%2Fcallback&state=random&nonce=nonce";

test("系统浏览器仅打开 Google 授权码页面", async () => {
  let opened;
  assert.deepEqual(await openGoogleAuthorization(URL, async (url) => { opened = url; }), { opened: true });
  assert.equal(opened, URL);
});

test("桌面与网页对恶意协议、域名、凭据和 token 参数执行一致校验", async () => {
  for (const url of [URL.replace("https:", "file:"), URL.replace("accounts.google.com", "accounts.google.com.evil.test"), URL + "&pollToken=secret", URL + "&access_token=secret", URL + "&password=secret", URL.replace("response_type=code", "response_type=token"), URL + "#fragment", "javascript:alert(1)", "https://accounts.google.com/"]) {
    assert.throws(() => validateGoogleAuthorizationUrl(url), /授权地址/);
    assert.throws(() => shared.validateGoogleAuthorizationUrl(url), /授权地址/);
    await assert.rejects(openGoogleAuthorization(url, () => { throw new Error("危险地址不能打开"); }), /授权地址/);
  }
});

test("系统浏览器打开失败不会被误报为登录完成", async () => {
  await assert.rejects(openGoogleAuthorization(URL, async () => { throw new Error("浏览器不可用"); }), /浏览器不可用/);
});
