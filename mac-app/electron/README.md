# Electron 原生能力

该目录负责电脑端的可信 IPC、模型与 CLI 执行、原生终端、系统剪贴板和本机设置。页面不直接访问文件系统；同账号设备可以编辑共享配置，目录解析和 CLI 执行始终由主电脑处理。

`agent-workspaces.js` 统一准备 Agent 默认工作区：根目录为 `~/Documents/chorus/agent-teams/workspace`，ASCII `~` 对应当前用户的 `homedir`，主进程保存绝对路径。主进程启动时先用空成员列表主动创建公共根，即使无成员或全部成员已有显式目录也会准备；权限异常记录日志并继续打开窗口。安全的 Agent 名称直接作为子目录名，中文保留；路径字符、空名、大小写或规范化重名使用稳定编号摘要区分。新默认目录避开已有显式目录，不接受符号链接。显式项目路径保留，不迁移或删除项目文件。

`chat-backend.js` 与界面共用该规则。团队成员和私聊都使用成员自己的目录；CLI 会话和目录写锁继续按聊天、成员与真实路径隔离。默认目录由主电脑创建后同步给其他设备；跨设备提交的项目路径也只在主电脑执行时校验。

运行针对性检查：`node --test electron/agent-workspaces.test.js electron/chat-backend.test.js ../scripts/web-core.test.js`。

## 自动目录与模型选择

`workspaceMode: "auto"` 表示让实际执行电脑管理成员目录。即使同步配置中有另一台电脑的 `workspace` 绝对路径，聊天、编码执行和原生终端也会在主电脑重新解析。`workspaceMode: "project"` 才表示绑定现有项目，目录必须在主电脑存在且可写；旧版非空路径按项目保留，空路径自动管理。纯模型聊天不校验或创建文件目录。基础路径校验位于 `workspace-paths.js`，避免执行模块与目录管理相互依赖。

`harnessModel` 专用于 CLI，`model` 继续用于直连模型 API，空的 `harnessModel` 沿用内核默认值。三种内核的聊天、编码与终端启动均传入 `--model`；运行中的终端更换模型需要先关闭再打开，避免页面配置与实际进程不一致。

`harness-models.js` 通过 `chorusDesktop.listHarnessModels(harness)` 返回 `{ models: [{ id, label, description? }], source, error? }`。目录只从当前安装的 CLI 读取，不写死模型名称：

- Codex：使用 [官方 app-server 的 `initialize` 与分页 `model/list`](https://learn.chatgpt.com/docs/app-server)，复用 CLI 登录与配置。
- Cursor：执行 [官方 `--list-models`](https://cursor.com/cn/changelog/cli-jan-08-2026)，解析文本或 JSON 目录。
- Claude Code：复用 [官方 Agent SDK 的初始化控制协议](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)，读取 `initialize` 结果中的 `models`；不发送用户提示，并禁用目录查询进程的 hooks 和 MCP。

发现流程有 15 秒超时、输出上限、并发请求合并及进程回收。未安装、未登录或不支持目录接口时返回错误与空列表，页面可以保留默认模型。目录只表示 CLI 公开的可选项，账号额度及实际调用结果仍以 CLI 执行为准。

完整原生回归：`node --test mac-app/electron/*.test.js`（在仓库根目录运行）。

## DMG 在线更新

`app-updates.js` 暴露 `chorusDesktop.getUpdateInfo()`、`downloadUpdate({ relayUrl, release })`、`onUpdateProgress(listener)`。主进程重新请求最新清单，核对发布编号、mac 平台、当前 CPU 或 universal 架构、严格增加的正式版本，忽略页面提供的安装包地址及摘要。进度事件包含 status（downloading、verifying、ready、installing、error）、received、total、percent、message。

在线更新可信源须在应用运行环境中通过 `CHORUS_UPDATE_RELAY_URL` 设置为自建中转站地址；未配置时不启用下载，网页不能修改该信任配置。生产包必须 HTTPS；未打包开发环境可使用回环 HTTP。所有清单和安装包重定向保持同源，禁止 URL 凭据。下载上限 2 GiB、无数据超时 30 秒、总时长上限 30 分钟；只允许单任务。

DMG 流式保存到应用私有数据目录，严格校验大小与 SHA-256，完成后原子替换固定更新文件，失败清理临时文件。用户点击后使用 [Electron shell.openPath](https://www.electronjs.org/docs/latest/api/shell) 打开已验证 DMG，仍由用户拖入应用程序目录完成覆盖安装。本流程不自动重启或静默替换运行中的应用。

针对性安全测试：`node --test mac-app/electron/app-updates.test.js`。

## 模型、桌面与手机流式通道

`llm.js` 为 OpenAI 兼容、Anthropic 和 Ollama 请求启用真实 `stream: true`。`model-stream.js` 分别解析 SSE 和 NDJSON，跨网络分包解码 UTF-8，只交付回复正文；错误事件、缺失结束标记、超过 5 MiB 的响应或 200,000 字符的正文均明确失败。兼容返回普通 JSON 的模型接口。模型网络超时衡量连续 120 秒无数据，收到片段或心跳续期，持续生成没有总时长上限。取消与错误消息的密钥遮蔽仍生效。

`chorusDesktop.completeChat(payload, onText)` 与 `runHarness(payload, onText)` 的可选回调收到累计正文，最终返回值保持原样。preload 创建独立流式请求编号，多个成员共用一个受控 IPC 监听器；成功、异常和取消都移除对应订阅。主进程每 50 毫秒最多推送一次最新正文，结束时刷新最后片段，避免长回复逐 token 复制全文。每次发送都重新验证原始页面，导航后不再投递。取消任务仍使用独立的 `runId`。

手机网关移除默认 10 分钟总执行时限。为兼容 Android `CapacitorHttp`，`POST /chat` 添加 `stream: true` 后立即返回 `202 { runId, status: "running", text: "" }`，手机每 250 毫秒通过携带 Bearer 的 `GET /chat/<runId>` 读取累计正文。状态为 `running`、`complete` 或 `error`；完成包含原有 `via`/`ok` 字段，错误包含安全的 `error`。旧版未声明流式的请求继续返回最终 JSON。

网关最多同时执行 8 个任务，缓存最多 64 份累计回复，每份限制 2 MiB；连续 60 秒未收到轮询会取消后台，完成结果保留 60 秒后删除。停止网关清理任务、缓存和计时器；取消后忽略迟到内容。流式路由继续执行令牌、成员、团队和本机执行开关验证，手机不能提供后台或工作区覆盖参数。

针对性回归：`node --test mac-app/electron/llm.test.js mac-app/electron/chat-backend.test.js mac-app/electron/preload-stream.test.js mac-app/electron/main-execution.test.js mac-app/electron/desktop-gateway.test.js`。覆盖真实本地 HTTP 提前输出、跨包中文、多模型事件、空闲续期、取消、IPC 并发隔离/合并/清理，以及虚拟时钟推进 31 分钟后网关任务仍可运行并显式取消。

## 远程配置主电脑

`host-config.js` 为当前登录账号的主电脑维护仅驻内存的 RSA 公私钥。页面确认主设备后调用 `chorusDesktop.setHostConfigContext({ accountId, deviceId, primary })`，每 30 秒将返回的公开身份刷新到中转站；退出账号或失去主设备身份传入 `primary: false`，立即清除私钥与去重缓存。`executeHostCommand(command)` 只执行中转站领取的固定配置动作，检查账号、目标设备、会话公钥、任务编号和三分钟到期时间。模型密钥采用 RSA-OAEP/SHA-256 包裹 AES-256-GCM 密钥，解密后沿用系统钥匙串保存；公开结果始终只有密钥存在状态。内核路径校验、检测、模型目录与项目目录规范化都在主电脑进行。原生登录仍需主电脑上的交互授权。

`shared/web/host-config.js` 同时供非主 DMG 与 Android 使用，提供 `ChorusHostConfig.createClient({ request, current })`：`command(action, payload)` 自动获取目标公钥、加密 `model.save` 并轮询最终状态；主电脑使用 `publishKey`、`claim`、`complete` 接收任务。配置轮询独立于聊天运行，不能等长任务结束才处理。调用方必须用 `current` 绑定账号、设备令牌和主设备身份，身份改变后废弃旧客户端。配置正文不能进入聊天快照、localStorage 或日志。

针对性回归：`node --test mac-app/electron/host-config.test.js`。测试覆盖 WebCrypto 与 Node 解密互通、大密钥、明文拒绝、密文篡改、错误身份、过期、重复命令和账号切换后的晚到结果。

主电脑设置检测由 `harness-probe.js` 在 Worker 中复用已有 CLI 探测，避免检测期间阻塞聊天流式事件；相同路径的并发检测合并，35 秒上限后返回明确状态并回收线程。远程路径保存先同步完成校验与写盘，再异步检测，检测超时不会误报配置未保存。`createClient` 的 `expectedTargetDeviceId` 绑定界面所见主电脑，后台已换主但通知尚未送达时也禁止把旧表单交给新主电脑。
