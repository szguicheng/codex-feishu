# Codex Feishu Hook Bridge

把 Codex Desktop/CLI 的任务状态同步到飞书，并允许用户直接回复飞书消息，把追加指令送回原来的 Codex session。

这个项目现在是一个可发布的 npm CLI。它的目标是让用户完成一次授权和安装后，就能在本机运行完整桥接，不要求用户额外安装 `lark-cli`。

## 一次性安装

要求：macOS、Node.js 20 或更高版本，以及已经安装并能运行的 Codex CLI/Desktop。

```bash
npx codex-feishu-hook-bridge setup
npx codex-feishu-hook-bridge install
npx codex-feishu-hook-bridge doctor
```

`setup` 会调用飞书官方 Node SDK 的应用注册流程，打印并自动打开一个飞书授权页面。用户在飞书页面确认后，飞书会为用户自己的租户创建应用并返回该应用的 App ID/Secret；凭据只写入本机 `~/.codex/feishu-bridge/config.env`，文件权限为 `0600`。

如果当前环境不能自动打开浏览器，可以使用：

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

- 在 `~/.codex/hooks.json` 中保留原有 hook，并追加 `UserPromptSubmit`、`PermissionRequest`、`Stop` 三类 bridge hook。
- 写入 macOS LaunchAgent，使 listener 在登录后自动启动。
- 在现有外置 `noowners` home 场景下，生成禁用源 plist，并输出把启用副本安装到 `/Library/LaunchAgents` 的命令。
- 保留当前已经验证过的 `lark-cli` 后端兼容模式。如果没有 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`，`FEISHU_PROVIDER=auto` 会回退到已有的 `lark-cli` 配置；完成 `setup` 后则使用官方 SDK。

## 功能

- 一轮 Codex 只保留一张飞书 Card 2.0 卡片：`收到指令` → `等待授权` → `本轮完成`。
- 卡片标题直接显示“项目名 · 阶段”，避免手机通知出现冗余的“Codex 状态”。
- 完成卡片原地更新后使用飞书应用内加急，不额外创建第二张完成卡片。
- 用户回复自己的 prompt 消息时，机器人在该用户消息上添加 `Get`；成功送入 Codex 后移除 `Get` 并添加 `DONE`，不发送额外确认消息。
- `open_notify` / `close_notify` 由飞书机器人菜单事件触发，不在每张状态卡片中重复显示开关。
- 追加指令严格映射到原来的 `session_id`，不会因为飞书回复而创建一个新的 Codex session。
- hook 和 listener 共享原子状态文件，并对重复飞书事件做幂等处理。

## 飞书授权与权限

`setup` 会把下面的应用身份权限和事件订阅预填到飞书确认页，最终以用户在飞书页面确认的结果为准：

应用身份权限：

- `im:message:send_as_bot`：发送状态卡片。
- `im:message:update`：原地更新状态卡片。
- `im:message.p2p_msg:readonly`：接收个人对话消息。
- `im:message.group_at_msg:readonly`：接收群内 @ 机器人消息。
- `im:message.reactions:write_only`：在用户 prompt 上添加/删除 `Get` 和 `DONE`。
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

不要把 `config.env`、App Secret、state 文件或日志提交到 GitHub。`.gitignore` 已覆盖这些本地文件名。

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
- `src/hook.mjs`：Codex hook 生命周期到 Card 2.0 的映射。
- `src/listener.mjs`：飞书消息、reaction 和机器人菜单事件处理。
- `src/install.mjs`：hooks.json 和 macOS LaunchAgent 安装。

## 发布到 GitHub 和 npm

GitHub 仓库地址为 [szguicheng/codex-feishu](https://github.com/szguicheng/codex-feishu)。如果你是从源码继续开发，可以执行：

```bash
git init
git add .
git commit -m "feat: publish Codex Feishu hook bridge"
git branch -M main
git remote add origin https://github.com/szguicheng/codex-feishu.git
git push -u origin main
```

npm 发布建议使用版本 tag 触发 GitHub Actions：

当前 `codex-feishu-hook-bridge` 还没有发布到 npm registry，因此暂时不能直接使用 `npm install codex-feishu-hook-bridge`；从 GitHub 安装仍然可用。

首次发布当前的 `0.1.0` 版本，需要先在 npm 创建一个对该包具有 `read and write` 权限的 granular access token；如果账号或包要求发布时进行 2FA，需要在创建 token 时启用用于自动化发布的 `bypass 2FA` 选项。然后在 GitHub 仓库的 `Settings` → `Secrets and variables` → `Actions` 中添加名为 `NPM_TOKEN` 的 repository secret，再执行：

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/publish.yml` 会在 `v*` tag 上运行 `npm publish --access public --provenance`。发布成功后，用户即可执行 `npm install codex-feishu-hook-bridge`。后续版本使用：

```bash
npm version patch
git push --follow-tags
```

不要把 npm token 写进仓库文件或提交记录。GitHub Pages workflow 会把 `website/` 发布为一个公开安装说明页；真正的飞书授权链接仍由用户运行 `setup` 时动态生成。

首次发布成功后，也可以把 `publish.yml` 迁移到 npm Trusted Publishing，用 GitHub Actions 的 OIDC 短期凭据替代长期 `NPM_TOKEN`。npm 的 Trusted Publisher 配置需要包已经存在，并且要精确填写 GitHub 用户名、仓库名和 `publish.yml` workflow 文件名。

## 产品化边界

当前实现是“每个用户在自己的租户创建自己的应用，并在本机保存自己的凭据”的本地优先模式，不需要我们集中保存租户 token，也不需要为每个用户维护后端长连接。

如果后续要做成 SaaS/飞书应用商店产品，则需要单独增加 ISV/商店应用模式：由我方维护已发布的多租户应用，用户通过应用安装授权，云端保存租户绑定和事件路由，本地 CLI 只保存一次性设备授权结果或短期配对凭据。这一模式涉及飞书应用商店审核、管理员安装和云端密钥管理，不应和当前的本地自建应用模式混在同一条安装命令里。

## 当前限制

- `ipc` 模式依赖当前 Codex Desktop 的本机 IPC 协议；Codex 升级后需要重新验证 `thread-follower-start-turn`。
- 当前 LaunchAgent 安装器优先支持 macOS；Linux systemd 和 Windows 任务计划程序可以作为后续适配。
- 飞书应用权限、机器人可用范围和正式版发布仍受飞书租户管理员策略影响；`setup` 能自动创建/预填配置，但最终授权由用户确认。
