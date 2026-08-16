import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { registerFeishuApp } from "./sdk.mjs";

const TENANT_SCOPES = [
  "im:message:send_as_bot",
  "im:message:update",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.reactions:write_only",
  "im:message.urgent",
];

const TENANT_EVENTS = [
  "im.message.receive_v1",
  "application.bot.menu_v6",
];

function envValue(value) {
  return JSON.stringify(String(value ?? ""));
}

function updateEnvText(text, values) {
  const lines = text ? text.split(/\r?\n/) : [];
  const written = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !(match[1] in values)) return line;
    written.add(match[1]);
    return match[1] + "=" + envValue(values[match[1]]);
  });
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key)) next.push(key + "=" + envValue(value));
  }
  return next.filter((line, index, all) => !(index === all.length - 1 && !line)).join("\n") + "\n";
}

async function writeConfig(config, values) {
  await fs.mkdir(path.dirname(config.envPath), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = await fs.readFile(config.envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tempPath = config.envPath + ".tmp-" + process.pid;
  await fs.writeFile(tempPath, updateEnvText(current, values), { mode: 0o600 });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, config.envPath);
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function promptForTarget(options, fallback) {
  if (options.targetUserId || options.chatId || fallback) return fallback || options.targetUserId || "";
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "";
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question("输入接收 Codex 卡片的飞书 open_id（直接回车跳过，之后可手动配置）： ")).trim();
  } finally {
    readline.close();
  }
}

export async function setupFeishu(config, options = {}) {
  process.stdout.write("正在创建/授权你自己的飞书机器人应用。请在飞书页面确认权限；不会把凭据发送到第三方服务器。\n");
  let verificationUrl = "";
  const result = await registerFeishuApp({
    source: config.setupSource,
    createOnly: true,
    appPreset: {
      name: options.appName || "Codex Feishu Bridge",
      desc: "将 Codex 任务状态发送到飞书，并支持从飞书继续发送指令。",
    },
    addons: {
      scopes: { tenant: TENANT_SCOPES },
      events: { items: { tenant: TENANT_EVENTS } },
    },
    onQRCodeReady(info) {
      verificationUrl = info.url;
      process.stdout.write("\n请打开这个飞书授权页面（也可以用飞书扫码）：\n" + info.url + "\n");
      process.stdout.write("链接有效期约 " + info.expireIn + " 秒。\n\n");
      if (!options.noOpen) openUrl(info.url);
    },
    onStatusChange(info) {
      if (info.status === "slow_down") process.stdout.write("授权轮询被限速，正在延长检查间隔……\n");
    },
  });

  const targetUserId = await promptForTarget(options, result.user_info?.open_id || "");
  await writeConfig(config, {
    FEISHU_PROVIDER: "sdk",
    FEISHU_APP_ID: result.client_id,
    FEISHU_APP_SECRET: result.client_secret,
    FEISHU_TARGET_USER_ID: options.targetUserId || targetUserId,
    FEISHU_CHAT_ID: options.chatId || "",
    FEISHU_ALLOWED_USER_IDS: options.allowedUserIds || options.targetUserId || targetUserId,
    FEISHU_URGENT_USER_IDS: options.targetUserId || targetUserId,
    FEISHU_STOP_URGENT: "true",
  });

  process.stdout.write("\n飞书应用已创建并写入本地配置：" + config.envPath + "\n");
  process.stdout.write("App ID：" + result.client_id + "\n");
  if (!targetUserId && !options.targetUserId && !options.chatId) {
    process.stdout.write("注意：没有检测到目标 open_id；请在配置文件中填写 FEISHU_TARGET_USER_ID 或 FEISHU_CHAT_ID。\n");
  }
  process.stdout.write("下一步运行：npx codex-feishu-hook-bridge install\n");
  return { appId: result.client_id, targetUserId: options.targetUserId || targetUserId, verificationUrl };
}
