# Chorus

> Think together. Build together.

Chorus 让不同职责的 AI Agent 在同一个团队里讨论、接力，并在你的 Mac 上把任务落实到代码和文档中。

![Chorus 团队工作台](docs/chorus-team-room-overview.png)

## 为什么用 Chorus

- **像团队一样协作**：Agent 共享对话上下文，按职责决定是否参与；用 `@成员名` 指派任务或请求下一位成员接手，也可以切换为仅回应点名。
- **让讨论进入真实工作区**：连接 Codex、Claude Code 或 Cursor CLI，在本机项目中执行任务；每个 Agent 可以使用独立工作区，也可以绑定已有项目。
- **自由选择模型**：支持 OpenAI、Anthropic、Ollama 和自定义 OpenAI 兼容接口，使用你自己的模型配置。
- **随时查看进度**：可选自建中转站，让 Android 发送任务、同步对话与查看回复；模型和 CLI 仍由 Mac 执行。

## 在 Mac 上运行

需要 macOS 13+（Apple Silicon）和 Node.js 22.12+。从仓库根目录运行：

```bash
cd mac-app
npm ci
npm run dev
```

打开“设置 → 模型与密钥”配置自己的 API Key 或 Ollama 地址，或先安装并登录 Codex、Claude Code、Cursor CLI，然后为 Agent 选择对应后台。创建团队、加入成员，就可以发送第一条任务。Mac 上的本地对话无需中转站账号。

在 `mac-app/` 运行 `npm run build` 可生成本地 DMG。当前构建使用 ad-hoc 签名，未做 Apple 公证；详见 [macOS 说明](mac-app/README.md)。

## 可选：连接 Android

跨设备同步需要自建 [Go 中转站](relay-service/README.md)，并准备 MySQL、Redis 和 Go 1.22+。从仓库根目录运行：

```bash
cd relay-service
cp .env.dev.example .env.dev
# 在 .env.dev 中填写本机数据库、Redis 等配置
go run ./cmd/server
```

在 Mac 和 Android 中填写同一个中转站地址、登录同一账号。手机发送的任务由 Mac 领取并执行；Mac 离线时任务保留，重新上线后继续处理。[Android 构建说明](android-app/README.md)

```text
Android ⇄ 自建中转站（Go · MySQL · Redis）⇄ Mac（模型 · CLI · 本机工作区）
```

## 仓库结构

| 目录 | 内容 |
|---|---|
| [mac-app](mac-app/README.md) | Electron 桌面端、模型与 CLI 执行 |
| [android-app](android-app/README.md) | Capacitor 移动端 |
| [shared/web](shared/web/README.md) | 两端共用的界面与协作逻辑 |
| [relay-service](relay-service/README.md) | 账号、任务队列与实时同步 |
| [docs](docs/README.md) | 截图和使用说明 |

界面以 `shared/web/` 为唯一源，修改后运行 `node scripts/sync-ui.js` 同步到两端。

## 验证

从仓库根目录运行：

```bash
cd mac-app && npm test
cd ../relay-service && go test ./... && go vet ./...
```
