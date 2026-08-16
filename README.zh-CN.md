<p align="center">
  <img src="assets/codex-feishu-hook-bridge-banner.png" alt="Codex Feishu Hook Bridge 横幅" width="100%">
</p>

# Codex Feishu Hook Bridge

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

将 Codex Desktop/CLI 的任务生命周期状态同步到飞书，并允许你直接在飞书中回复消息，把追加指令发送回原来的 Codex session。

这是一个可以发布到 npm 的 CLI 项目。用户完成一次配置和安装后，桥接程序即可在本机运行，不需要额外安装 `lark-cli`。

## 功能

- 每轮 Codex 只保留一张飞书 Card 2.0 卡片：`收到指令` → `等待授权` → `本轮完成`。
- 卡片标题使用“项目名 · 阶段”，让手机通知可以直接显示当前所处阶段。
- 完成阶段原地更新卡片，并使用飞书应用内加急发送完成提醒，不额外创建第二张卡片。
- 用户回复自己的 prompt 消息时，在该消息上添加 `Get`；指令成功送入 Codex 后移除 `Get` 并添加 `DONE`，不发送额外确认消息。
- 通过飞书机器人菜单处理 `open_notify` 和 `close_notify`，不在每张状态卡片中重复显示通知开关。
- 将追加指令映射回原来的 `session_id`，不会因为飞书回复而创建新的 Codex session。
- hook 和 listener 共享原子状态文件，并对重复的飞书事件进行幂等处理。

## 一次性安装

要求：macOS、Node.js 20 或更高版本，以及已经安装并能运行的 Codex CLI/Desktop。

```bash
npx codex-feishu-hook-bridge setup
npx codex-feishu-hook-bridge install
npx codex-feishu-hook-bridge doctor
```

`setup` 使用飞书官方 Node SDK 的应用注册流程，打印并自动打开飞书授权页面。用户确认后，飞书会在用户自己的租户中创建应用并返回 App ID 和 App Secret。凭据只写入本机的 `~/.codex/feishu-bridge/config.env`，文件权限为 `0600`。

如果当前环境不能自动打开浏览器：

```bash
npx codex-feishu-hook-bridge setup --no-open
```

个人对话可以显式指定目标用户：

```bash
npx codex-feishu-hook-bridge setup --target-user-id ou_xxx
```

群聊则使用：

```bash
npx codex-feishu-hook-bridge setup --chat-id oc_xxx --allowed-user-ids ou_xxx
```

`install` 会：

- 保留 `~/.codex/hooks.json` 中的原有 hook，并追加 `UserPromptSubmit`、`PermissionRequest` 和 `Stop` 三类 bridge hook。
- 写入 macOS LaunchAgent，使 listener 在登录后自动启动。
- 在当前外置 `noowners` home 场景下生成禁用源 plist，并输出将启用副本安装到 `/Library/LaunchAgents` 的命令。
- 保留已经验证过的 `lark-cli` 兼容模式。如果没有 `FEISHU_APP_ID` 或 `FEISHU_APP_SECRET`，`FEISHU_PROVIDER=auto` 会回退到已有的 `lark-cli` 配置；完成 `setup` 后则使用官方 SDK。

## 飞书授权与权限

`setup` 会把下面的应用权限和事件订阅预填到飞书确认页，最终结果以用户在飞书页面确认的内容为准。

应用身份权限：

- `im:message:send_as_bot`：发送状态卡片。
- `im:message:update`：原地更新状态卡片。
- `im:message.p2p_msg:readonly`：接收个人对话消息。
- `im:message.group_at_msg:readonly`：接收群内 @ 机器人消息。
- `im:message.reactions:write_only`：在用户 prompt 上添加和删除 `Get`、`DONE`。
- `im:message.urgent`：发送完成提醒。

事件：

- `im.message.receive_v1`：接收飞书追加指令。
- `application.bot.menu_v6`：接收 `open_notify` 和 `close_notify` 菜单事件。

飞书官方文档：

- [应用身份与消息权限](https://open.feishu.cn/document/server-docs/application-scope/scope-list)
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)
- [自建应用与商店应用](https://open.feishu.cn/document/home/app-types-introduction/self-built-apps-and-store-apps)

## 配置文件

模板见 [`config.example.env`](./config.example.env)。常用配置：

```dotenv
FEISHU_PROVIDER=auto
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=只保存在本机
FEISHU_TARGET_USER_ID=ou_xxx
FEISHU_ALLOWED_USER_IDS=ou_xxx
FEISHU_STOP_URGENT=true
CODEX_APP_SERVER_MODE=ipc
```

不要把 `config.env`、App Secret、state 文件或日志提交到 GitHub。`.gitignore` 已覆盖这些本地文件。

## 开发

```bash
npm install
npm run check
npm run pack:check
```

`npm run check` 是面向本机安装的诊断命令，会检查飞书目标和 Codex 配置；GitHub Actions 不会运行它。CI 现在只通过 GitHub Actions 页面手动触发：打开 `Actions` → `CI` → `Run workflow`。它不会因为 push 或 Pull Request 自动运行。

核心入口：

- `src/cli.mjs`：npm 命令行入口。
- `src/setup.mjs`：飞书应用授权/创建和本地凭据写入。
- `src/sdk.mjs`：官方 SDK API 与 WebSocket 事件适配。
- `src/hook.mjs`：Codex hook 生命周期到 Card 2.0 状态的映射。
- `src/listener.mjs`：飞书消息、reaction 和机器人菜单事件处理。
- `src/install.mjs`：`hooks.json` 和 macOS LaunchAgent 安装。

## 发布到 GitHub 和 npm

GitHub 仓库：[szguicheng/codex-feishu](https://github.com/szguicheng/codex-feishu)

当前 npm 包已经发布为 `codex-feishu-hook-bridge@0.1.0`：

```bash
npm install codex-feishu-hook-bridge
```

npm 发布 workflow 只会在推送 `v*` tag 时运行。普通 push 到 `main` 不会发布新的 npm 版本。发布后续版本：

```bash
npm version patch
git push --follow-tags
```

仓库还包含手动 CI workflow 和用于发布安装说明页的 GitHub Pages workflow。不要提交 npm token 或飞书凭据。长期发布自动化更适合使用 GitHub Actions OIDC 的 npm Trusted Publishing，而不是长期有效的发布 token；参见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 产品化边界

当前实现是“本地优先”模式：每个用户在自己的租户创建应用，并在本机保存自己的凭据。我们不集中保存租户 token，也不为每个用户维护云端长连接。

如果后续做成 SaaS 或飞书应用商店产品，则需要单独增加 ISV/商店应用模式：由维护方运营多租户应用，用户通过安装流程授权，云端保存租户绑定和事件路由，本地 CLI 只保存短期设备配对凭据。该模式涉及飞书应用商店审核、管理员安装和云端密钥管理，不应与当前的本地自建应用流程混在一起。

## 当前限制

- `ipc` 模式依赖当前 Codex Desktop 的本机 IPC 协议；Codex 升级后需要重新验证 `thread-follower-start-turn`。
- 当前安装器主要支持 macOS；Linux systemd 和 Windows 任务计划程序可以作为后续适配。
- 飞书应用权限、机器人可用范围和正式版发布仍受飞书租户管理员策略影响。`setup` 能自动创建并预填应用配置，但最终授权仍需用户确认。

## 许可证

MIT
