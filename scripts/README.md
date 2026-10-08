# scripts

构建辅助脚本。

| 脚本 | 说明 |
|------|------|
| `sync-ui.js` | 把 `shared/web` 复制到 `mac-app/renderer` 和 `android-app/www`，保证两端界面一致 |
| `build-mac.sh` | 一键编译 macOS，生成 `mac-app/dist/Chorus-*.dmg` |
| `build-apk.sh` | 从锁文件安装依赖，构建和 lint Android Release APK，再验证交付包 |
| `verify-apk.js` | 检查真实 APK 的版本、调试标志、权限、签名与对齐，保存哈希及检查报告 |
| `relay-e2e.js` | 自建中转站节点间同步、鉴权、队列与可选 Codex 执行验收 |
| `shared-config-e2e.js` | 自建节点间共享配置增删改、历史保护、主机加密配置通道和换主失效验收 |

## 一键编译

在仓库根目录执行：

```bash
./scripts/build-mac.sh
./scripts/build-apk.sh
```

Android 每次通过 `npm ci` 使用锁定依赖，需要本机已装 JDK 17 与 Android SDK，并按 `android-app/README.md` 配置正式签名。产物为 `dist/Chorus-<version>-android-build<versionCode>.apk`，旁边保存 `-validation.json`；脚本不会安装到手机，也不会上传 APK。

## 中转站验收

自建服务发布后，设置 `RELAY_TEST_NODE_A` / `RELAY_TEST_NODE_B` 为自己的两个节点，再执行 `node scripts/relay-e2e.js --run-live --with-codex`。脚本仅生成随机测试账号和临时工作区，结束时退出所有测试设备并清理临时文件；不使用现有账号。真实 CLI 验收需要本机已登录 Codex。

共享配置协议部署后，使用相同的两个自建节点地址执行 `node scripts/shared-config-e2e.js --run-live`。未提供 `--run-live` 时只显示运行说明，不发送网络请求。脚本仅注册随机测试账号及主 Mac、非主 Mac、Android、外账号设备，验证非主设备创建/修改/删除 Agent 与群、共享设置、旧快照防覆盖、自动目录回填和聊天历史保留。主机通道使用真实 WebCrypto 客户端与原生解密器，配置保存处理器仅使用内存合成数据，路径仅验证新建的临时目录；不写入用户系统密钥库、不修改真实账号、不执行模型 CLI。还检查跨节点独占领取、结果来源隔离、回执幂等、换主失效与明文隔离。结束时注销所有登记会话并删除临时目录；注销失败会使脚本失败。

`chat-scroll.test.js` 验证聊天刷新、追加回复、重试与历史补齐时的阅读位置保护，以及首次打开、账号隔离和主动发送时的定位行为。使用 `node --test scripts/chat-scroll.test.js` 单独运行，完整测试由 Mac 的 `npm test` 包含。

## 发布版本

`node scripts/set-version.js 0.5.8 [Android构建号]` 校验并统一两端 package / lock 文件、Gradle、共享页面资源版本及应用显示版本。默认将 Android 构建号递增 1，拒绝相同或更旧的版本号和构建号。随后运行两端构建脚本，在中转站管理页上传草稿并发布。`updates.test.js` 验证版本比较、清单安全、并发检查/下载和切换站点后的旧响应隔离。

## 并行与流式回归

完整客户端回归由 `cd mac-app && npm test` 运行，覆盖并行成员、共享工作区排队、流式分片、取消、快照合并和长任务时钟。`relay-client.test.js` 使用可控时钟验证持续续租超过 35 分钟且失联后按安全期限取消。`relay-e2e.js --run-live` 在随机测试账号上验证两个真实节点之间的逐段正文、`streaming` 状态、最终快照确认与结果去重。

`shared-config.test.js` 与 `settings-config.test.js` 使用真实页面函数验证非主 Mac/Android 创建与配置、账号/主设备切换、表单草稿与异步晚到保护、主电脑设置读写和配置回执重试。与 `relay-client.test.js` 一起运行可覆盖共享配置合并、已删除项不复活、本机偏好与密钥隔离。
