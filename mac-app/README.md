# Chorus macOS 应用

基于 Electron 打包的可安装 Mac 桌面软件，UI 同步自 `../shared/web`。

## 环境

- macOS 13+
- Node.js 22.12+

## 开发运行

```bash
cd mac-app
npm install
npm run dev
```

## 打包安装包（.dmg / .app）

```bash
cd mac-app
npm install
npm run build
```

产物目录：`mac-app/dist/`

- `Chorus-0.5.8-arm64.dmg`：拖入 Applications 安装
- `mac-arm64/Chorus.app`：可直接运行的应用包

> 当前配置 `identity: "-"`，打出的是 **ad-hoc 签名、未公证** 的本地交付包。本机打开若被拦截：系统设置 → 隐私与安全性 → 仍要打开。

## 目录说明

| 路径 | 说明 |
|------|------|
| `electron/` | 主进程 / preload |
| `renderer/` | 由 `npm run sync-ui` 从 shared 同步 |
| `dist/` | 打包输出 |

## 编程后台与终端

在 Agent 中选择 Codex、Cursor 或 Claude Code 后，工作区无需逐个填写：电脑启动时主动创建公共根 `~/Documents/chorus/agent-teams/workspace`，再按 Agent 名称自动创建独立子目录。没有成员或全部成员已有显式工作区时也会准备公共根；已有显式路径保留，不迁移或删除文件。目录权限异常会记录日志并保留窗口，用户仍可修复配置。普通聊天会直接执行编程任务，并按聊天与成员恢复 CLI 原生会话；团队成员也使用自己的目录。终端入口运行真实 PTY，可交互输入、审批与停止；关闭面板保留会话，关闭会话结束进程。需要已安装并登录对应 CLI，CLI 的模型与账号配置沿用其原生设置。

在「设置 → Mac 与手机」填写自建中转站地址。同一账号的手机通过中转站同步聊天，并把任务交给这台电脑执行。同账号任意 Mac 或 Android 均可管理 Agent、团队及主电脑配置。任务始终由主电脑执行，非主电脑填写的路径属于主电脑；内核检测和密钥保存也在主电脑完成。Google 登录通过系统浏览器授权，消息复制使用 Electron 原生剪贴板。
