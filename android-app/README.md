# Chorus Android 0.5.8 · 构建 14

基于 Capacitor 的 Android 应用，与 Mac 使用 `../shared/web` 中的同一套工作台。

Android 可管理共享配置并同步聊天：在设置中填写自建中转站地址，使用同一登录账号实时查看团队和私聊记录。发送的消息经中转站交给电脑执行，结果同步回手机。手机可新建和管理 Agent、团队、主电脑内核路径、模型密钥、默认 Provider 和执行开关。项目路径及 localhost 指主电脑；密钥加密提交并保存在主电脑系统密钥库，手机不执行本机 CLI。

## 手机要求与安装

- Android 7.0+（API 24）。
- 系统 WebView 或作为 WebView 提供器的 Chrome 109+；建议更新到手机应用商店可提供的最新版本。旧 WebView 会显示更新提示。
- 交互终端使用 xterm.js 6。项目不再支持 WebView 92 和 Android 5.1/6.0。

在项目根目录运行构建脚本后，侧载包位于 `dist/Chorus-0.5.8-android-build14.apk`：

```bash
adb install -r dist/Chorus-0.5.8-android-build14.apk
```

也可以将 APK 复制到手机，在系统文件管理器中打开。发布包应使用 Release 构建、正式签名，并关闭应用调试和 WebView 调试。

## 连接电脑

1. 在电脑上配置并登录所需后台，为 Agent 选择模型或 CLI；电脑启动时主动创建 `~/Documents/chorus/agent-teams/workspace`，随后按 Agent 名称创建独立子目录，已有显式路径保留。保持 Chorus 运行。
2. 在电脑和手机填写同一个自建中转站地址并登录同一账号；无需配置局域网地址、连接令牌或开放电脑端口。
3. 可直接在手机新建 Agent 和团队，编辑成员与规则；在「主电脑与内核」或「模型与密钥」修改主电脑实际配置。主电脑需同步更新到 0.5.8 并保持在线。
4. 在手机发送团队消息或私聊。中转站持久化并通知电脑领取任务，电脑的回复与本地聊天实时同步到手机。

Google 登录打开系统浏览器；服务端须配置有效的 Google Web OAuth 客户端。邮箱账号使用密码登录。手机断线后自动重新连接并补拉历史；电脑离线时消息显示等待执行。


## 构建环境

- Node.js 22.12+。
- JDK 17，可通过 `JAVA_HOME` 指定，也可使用 `PATH` 中的 JDK。
- Android SDK，已安装 Platform 34、Build Tools 34.0.0，并已接受 SDK 许可。

macOS 常见配置：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

仓库已包含原生工程，不需重复执行 `cap add android`。首次安装依赖与同步：

```bash
cd android-app
npm ci
npm run cap:sync
```

配置自己的正式签名后，在仓库根目录构建 Release 包：

```bash
./scripts/build-apk.sh
```

脚本执行 `npm ci`、Release 构建与 lint，再检查真实 APK 的调试标志、版本、权限、签名和对齐。APK 文件名包含构建号，旁边保存 `-validation.json`。

构建前通过环境变量配置以下信息。缺失签名时构建失败，不自动回退为 Debug 包；密码不得写入仓库或提交日志。

如需在线更新，还须在原生资源 `android/app/src/main/res/values/strings.xml` 中把 `update_relay_url` 设置为自建中转站的 HTTPS 地址。留空时安装包拒绝更新下载；网页中的中转站地址不能改变该可信更新源。

| 环境变量 | 用途 |
|---|---|
| `CHORUS_ANDROID_KEYSTORE` | 现有正式签名密钥库的绝对路径 |
| `CHORUS_ANDROID_STORE_PASSWORD` | 密钥库密码 |
| `CHORUS_ANDROID_KEY_ALIAS` | 签名密钥别名 |
| `CHORUS_ANDROID_KEY_PASSWORD` | 签名密钥密码 |
| `CHORUS_ANDROID_EXPECTED_CERT_SHA256` | 对应发布渠道的证书 SHA-256，64 位十六进制，无冒号 |

更换证书不能直接覆盖已安装的旧签名版本，须另行规划数据与签名迁移。原始 Release APK 位于 `android-app/android/app/build/outputs/apk/release/app-release.apk`。`npm run build:apk` 和 `npm run build:apk:release` 均调用同一构建脚本。仅本地开发调试时执行：

```bash
cd android-app
npm run build:apk:debug
```

## 安全检查

`REQUEST_INSTALL_PACKAGES` 仅用于用户主动确认的本应用更新；下载前会验证可信源、大小、SHA-256、包名、版本及签名。正式发布前应对生成的 APK 完成签名、权限和安装验证。

用 Android Studio 打开工程：

```bash
cd android-app
npm run open
```

## 目录

| 路径 | 用途 |
|---|---|
| `www/` | 从 `shared/web` 同步的工作台与终端资源 |
| `android/` | 已纳入仓库的原生工程 |
| `capacitor.config.json` | 原生 HTTP、最低 WebView 与系统栏配置 |
| `scripts/patch-capacitor-cli.js` | Capacitor CLI 6 与安全版本 tar 的构建兼容修复 |

## 文件共享范围

照片 FileProvider 仅共享应用专属的 `Pictures/` 目录，保留附件拍照能力；普通缓存和更新缓存不在该 provider 的范围内。应用更新继续使用独立的 `updates.fileprovider` 共享私有 `updates/` 缓存，安装流程仅向系统安装器授予读取权限。

连接测试设备或启动模拟器后，可单独验证实际安装包的共享路径配置；测试不创建照片或安装包，也不会启动相机或安装器：

```bash
cd android-app/android
./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.chorus.app.ChorusFileProviderInstrumentedTest
```
