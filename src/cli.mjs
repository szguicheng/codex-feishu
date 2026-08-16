#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { setupFeishu } from "./setup.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const command = args[0] || "help";

function valueOf(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function has(name) {
  return args.includes(name);
}

function usage() {
  process.stdout.write(
    "Codex Feishu Hook Bridge\n\n" +
      "用法：\n" +
      "  npx codex-feishu-hook-bridge setup [选项]\n" +
      "  npx codex-feishu-hook-bridge install\n" +
      "  npx codex-feishu-hook-bridge doctor\n" +
      "  npx codex-feishu-hook-bridge hook\n" +
      "  npx codex-feishu-hook-bridge listener\n\n" +
      "setup 选项：\n" +
      "  --target-user-id ID   将卡片发给指定飞书 open_id\n" +
      "  --chat-id ID          将卡片发到指定群聊\n" +
      "  --allowed-user-ids X  允许从飞书向 Codex 发追加指令的 open_id，逗号分隔\n" +
      "  --app-name NAME       新建飞书应用名称\n" +
      "  --no-open             只打印授权链接，不自动打开浏览器\n",
  );
}

function runInstall() {
  const script = path.join(sourceDir, "install.mjs");
  const result = spawnSync(process.execPath, [script, "--config", "--hooks", "--launch-agent"], {
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
}

async function doctor() {
  const config = loadConfig();
  const hooksPath = path.join(config.codexHome, "hooks.json");
  const launchAgent = path.join(os.homedir(), "Library", "LaunchAgents", "com.codex.feishu-hook-bridge.plist");
  const checks = [];
  checks.push(["Feishu provider", config.feishuProvider]);
  checks.push(["Feishu app credentials", config.feishuAppId && config.feishuAppSecret ? "configured" : "missing"]);
  checks.push(["Card destination", config.targetChatId || config.targetUserId || "missing"]);
  checks.push(["Allowed reply users", config.allowedUserIds.length ? config.allowedUserIds.join(",") : "missing"]);
  checks.push(["Codex hooks file", await exists(hooksPath) ? hooksPath : "missing"]);
  checks.push(["LaunchAgent plist", await exists(launchAgent) ? launchAgent : "not generated in user LaunchAgents"]);
  for (const [key, value] of checks) process.stdout.write(key + ": " + value + "\n");
  if (config.feishuProvider === "sdk" && (!config.feishuAppId || !config.feishuAppSecret)) process.exitCode = 1;
  if (!config.targetChatId && !config.targetUserId) process.exitCode = 1;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (command === "help" || has("--help")) {
  usage();
} else if (command === "setup") {
  await setupFeishu(loadConfig(), {
    targetUserId: valueOf("--target-user-id"),
    chatId: valueOf("--chat-id"),
    allowedUserIds: valueOf("--allowed-user-ids"),
    appName: valueOf("--app-name"),
    noOpen: has("--no-open"),
  });
} else if (command === "install") {
  runInstall();
} else if (command === "doctor" || command === "check") {
  await doctor();
} else if (command === "hook" || command === "listener") {
  const mainPath = path.join(sourceDir, "main.mjs");
  const result = spawnSync(process.execPath, [mainPath, command], { stdio: "inherit", env: process.env });
  process.exitCode = result.status ?? 1;
} else {
  usage();
  process.exitCode = 2;
}
