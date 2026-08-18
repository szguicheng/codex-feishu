<p align="center">
  <img src="assets/codex-feishu-hook-bridge-banner.png" alt="Codex Feishu Hook Bridge 橫幅" width="100%">
</p>

# Codex Feishu Hook Bridge

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

將 Codex Desktop/CLI 的任務生命週期狀態同步到飛書，並允許你直接在飛書中回覆訊息，把追加指令傳回原來的 Codex session。

這是一個可以發佈到 npm 的 CLI 專案。使用者完成一次設定與安裝後，橋接程式即可在本機執行，不需要額外安裝 `lark-cli`。

## 功能

- 每輪 Codex 只保留一張飛書 Card 2.0 卡片：`收到指令` → `等待授權` → `本輪完成`。
- 卡片標題使用「專案名稱 · 階段」，讓手機通知可以直接顯示目前所處階段。
- 完成階段原地更新卡片，並使用飛書應用內加急發送完成提醒，不額外建立第二張卡片。
- 使用者回覆自己的 prompt 訊息時，在該訊息上新增 `Get`；指令成功送入 Codex 後移除 `Get` 並新增 `DONE`，不發送額外確認訊息。
- 透過飛書機器人選單處理 `open_notify` 和 `close_notify`，不在每張狀態卡片中重複顯示通知開關。
- 將追加指令映射回原來的 `session_id`，不會因為飛書回覆而建立新的 Codex session。
- hook 和 listener 共用原子狀態檔案，並對重複的飛書事件進行冪等處理。

### 飛書中的狀態卡片

橋接程式每一輪 Codex 只保留一張卡片。同一張卡片會從藍色的開始狀態原地更新為綠色的完成狀態：

<p align='center'>
  <img src='assets/readme-card-start.jpg' alt='飛書藍色開始卡片' width='660'>
</p>
<p align='center'><em>藍色 — <code>UserPromptSubmit</code>：Codex 已收到新的指令。</em></p>

<p align='center'>
  <img src='assets/readme-card-complete.jpg' alt='飛書綠色完成卡片' width='660'>
</p>
<p align='center'><em>綠色 — <code>Stop</code>：本輪任務結束後，原卡片被更新為完成狀態。</em></p>

### 從飛書回覆 Codex

直接回覆狀態卡片並發送追加指令，例如：<code>請把 README 的安裝步驟再精簡一些。</code> listener 會依序完成：

1. 檢查發送者是否屬於允許回覆的飛書使用者；
2. 根據被回覆的卡片找到原來的 <code>session_id</code>；
3. 將追加指令轉發到原來的 Codex session，而不是建立新的 session；
4. 收到使用者訊息時，在使用者自己發送的訊息上新增 <code>Get</code>；成功送入 Codex 後移除它並新增 <code>DONE</code>。

整個過程不會額外發送「已轉發」等確認訊息。reaction 會新增到使用者發出的訊息上，而不是橋接卡片上。

## 一次性安裝

要求：macOS、Node.js 20 或更高版本，以及已安裝並能正常執行的 Codex CLI/Desktop。

```bash
npx codex-feishu-hook-bridge setup
npx codex-feishu-hook-bridge install
npx codex-feishu-hook-bridge doctor
```

`setup` 使用飛書官方 Node SDK 的應用程式註冊流程，列印並自動開啟飛書授權頁面。使用者確認後，飛書會在使用者自己的租戶中建立應用程式並返回 App ID 和 App Secret。憑證只會寫入本機的 `~/.codex/feishu-bridge/config.env`，檔案權限為 `0600`。

如果目前環境無法自動開啟瀏覽器：

```bash
npx codex-feishu-hook-bridge setup --no-open
```

個人對話可以明確指定目標使用者：

```bash
npx codex-feishu-hook-bridge setup --target-user-id ou_xxx
```

群組聊天則使用：

```bash
npx codex-feishu-hook-bridge setup --chat-id oc_xxx --allowed-user-ids ou_xxx
```

`install` 會：

- 保留 `~/.codex/hooks.json` 中的原有 hook，並追加 `UserPromptSubmit`、`PermissionRequest` 和 `Stop` 三類 bridge hook。
- 寫入 macOS LaunchAgent，使 listener 在登入後自動啟動。
- 在目前外置 `noowners` home 情境下產生停用的來源 plist，並輸出將啟用副本安裝到 `/Library/LaunchAgents` 的指令。
- 保留已驗證的 `lark-cli` 相容模式。如果沒有 `FEISHU_APP_ID` 或 `FEISHU_APP_SECRET`，`FEISHU_PROVIDER=auto` 會回退到既有的 `lark-cli` 設定；完成 `setup` 後則使用官方 SDK。

## 飛書授權與權限

`setup` 會把下面的應用程式權限和事件訂閱預填到飛書確認頁面，最終結果以使用者在飛書頁面確認的內容為準。

應用程式身份權限：

- `im:message:send_as_bot`：發送狀態卡片。
- `im:message:update`：原地更新狀態卡片。
- `im:message.p2p_msg:readonly`：接收個人對話訊息。
- `im:message.group_at_msg:readonly`：接收群組內 @ 機器人的訊息。
- `im:message.reactions:write_only`：在使用者 prompt 上新增和刪除 `Get`、`DONE`。
- `im:message.urgent`：發送完成提醒。

事件：

- `im.message.receive_v1`：接收飛書追加指令。
- `application.bot.menu_v6`：接收 `open_notify` 和 `close_notify` 選單事件。

飛書官方文件：

- [應用程式身份與訊息權限](https://open.feishu.cn/document/server-docs/application-scope/scope-list)
- [接收訊息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [發送訊息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)
- [自建應用程式與商店應用程式](https://open.feishu.cn/document/home/app-types-introduction/self-built-apps-and-store-apps)

## 設定檔

範本見 [`config.example.env`](./config.example.env)。常用設定：

```dotenv
FEISHU_PROVIDER=auto
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=只保存在本機
FEISHU_TARGET_USER_ID=ou_xxx
FEISHU_ALLOWED_USER_IDS=ou_xxx
FEISHU_STOP_URGENT=true
CODEX_APP_SERVER_MODE=ipc
```

不要將 `config.env`、App Secret、state 檔案或日誌提交到 GitHub。`.gitignore` 已涵蓋這些本機檔案。

## 開發

```bash
npm install
npm run check
npm run pack:check
```

`npm run check` 是面向本機安裝的診斷指令，會檢查飛書目標和 Codex 設定；GitHub Actions 不會執行它。CI 目前只透過 GitHub Actions 頁面手動觸發：開啟 `Actions` → `CI` → `Run workflow`。它不會因為 push 或 Pull Request 自動執行。

核心入口：

- `src/cli.mjs`：npm 命令列入口。
- `src/setup.mjs`：飛書應用程式授權/建立和本機憑證寫入。
- `src/sdk.mjs`：官方 SDK API 與 WebSocket 事件適配。
- `src/hook.mjs`：Codex hook 生命週期到 Card 2.0 狀態的映射。
- `src/listener.mjs`：飛書訊息、reaction 和機器人選單事件處理。
- `src/install.mjs`：`hooks.json` 和 macOS LaunchAgent 安裝。

## 發佈到 GitHub 和 npm

GitHub 儲存庫：[szguicheng/codex-feishu](https://github.com/szguicheng/codex-feishu)

目前 npm 套件已發佈為 `codex-feishu-hook-bridge@0.1.1`：

```bash
npm install codex-feishu-hook-bridge
```

npm 發佈 workflow 只會在推送 `v*` tag 時執行。普通 push 到 `main` 不會發佈新的 npm 版本。發佈後續版本：

```bash
npm version patch
git push --follow-tags
```

儲存庫還包含手動 CI workflow 和用於發佈安裝說明頁的 GitHub Pages workflow。不要提交 npm token 或飛書憑證。長期發佈自動化更適合使用 GitHub Actions OIDC 的 npm Trusted Publishing，而不是長期有效的發佈 token；參見 [npm Trusted Publishing 文件](https://docs.npmjs.com/trusted-publishers/)。

## 產品化邊界

目前實作是「本機優先」模式：每個使用者在自己的租戶建立應用程式，並在本機保存自己的憑證。我們不集中保存租戶 token，也不為每個使用者維護雲端長連線。

如果後續做成 SaaS 或飛書應用程式商店產品，則需要單獨增加 ISV/商店應用程式模式：由維護方營運多租戶應用程式，使用者透過安裝流程授權，雲端保存租戶繫結和事件路由，本機 CLI 只保存短期裝置配對憑證。這種模式涉及飛書應用程式商店審核、管理員安裝和雲端金鑰管理，不應與目前的本地自建應用程式流程混在一起。

## 目前限制

- `ipc` 模式依賴目前 Codex Desktop 的本機 IPC 協定；Codex 升級後需要重新驗證 `thread-follower-start-turn`。
- 目前安裝器主要支援 macOS；Linux systemd 和 Windows 工作排程器可以作為後續適配。
- 飛書應用程式權限、機器人可用範圍和正式版發佈仍受飛書租戶管理員策略影響。`setup` 可以自動建立並預填應用程式設定，但最終授權仍需使用者確認。

## 授權條款

MIT
