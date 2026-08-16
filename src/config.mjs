import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function numberValue(values, key, fallback) {
  const value = Number(values[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig() {
  const codexHome = expandHome(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const bridgeHome = expandHome(
    process.env.FEISHU_BRIDGE_HOME || path.join(codexHome, "feishu-bridge"),
  );
  const envPath = expandHome(
    process.env.FEISHU_BRIDGE_CONFIG || path.join(bridgeHome, "config.env"),
  );
  const values = { ...parseEnvFile(envPath), ...process.env };
  const statePath = expandHome(
    values.FEISHU_BRIDGE_STATE || path.join(bridgeHome, "state.json"),
  );
  const targetUserId = (values.FEISHU_TARGET_USER_ID || "").trim();
  const targetChatId = (values.FEISHU_CHAT_ID || "").trim();
  const feishuAppId = (values.FEISHU_APP_ID || "").trim();
  const feishuAppSecret = (values.FEISHU_APP_SECRET || "").trim();
  const requestedProvider = (values.FEISHU_PROVIDER || "auto").trim().toLowerCase();
  const feishuProvider = requestedProvider === "auto"
    ? (feishuAppId && feishuAppSecret ? "sdk" : "cli")
    : requestedProvider;
  const allowedUserIds = (values.FEISHU_ALLOWED_USER_IDS || targetUserId)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const urgentUserIds = (values.FEISHU_URGENT_USER_IDS || targetUserId)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    codexHome,
    bridgeHome,
    envPath,
    statePath,
    larkCli: values.LARK_CLI || "lark-cli",
    feishuProvider,
    feishuAppId,
    feishuAppSecret,
    feishuDomain: (values.FEISHU_DOMAIN || "feishu").trim().toLowerCase(),
    setupSource: (values.FEISHU_SETUP_SOURCE || "codex-feishu-hook-bridge").trim(),
    codexCommand: expandHome(values.CODEX_COMMAND || "codex"),
    appServerMode: values.CODEX_APP_SERVER_MODE || "ipc",
    appServerSocket: expandHome(
      values.CODEX_APP_SERVER_SOCKET || path.join(codexHome, "ipc", "ipc.sock"),
    ),
    targetUserId,
    targetChatId,
    allowedUserIds,
    urgentUserIds,
    stopUrgent: values.FEISHU_STOP_URGENT !== "false",
    maxText: numberValue(values, "FEISHU_MAX_TEXT", 12000),
    stageMinIntervalMs: numberValue(
      values,
      "FEISHU_STAGE_MIN_INTERVAL_MS",
      10000,
    ),
    commandTimeoutMs: numberValue(values, "FEISHU_COMMAND_TIMEOUT_MS", 4500),
    turnTimeoutMs: numberValue(
      values,
      "CODEX_TURN_TIMEOUT_MS",
      2 * 60 * 60 * 1000,
    ),
    listenerRestartMs: numberValue(values, "FEISHU_LISTENER_RESTART_MS", 3000),
    dryRun: values.FEISHU_DRY_RUN === "true",
    allowUnthreadedReplies: values.FEISHU_ALLOW_UNTHREADED_REPLIES === "true",
    logPrefix: "[codex-feishu]",
  };
}

export function targetFor(config, session = null) {
  if (session?.chatId) return { chatId: session.chatId };
  if (config.targetChatId) return { chatId: config.targetChatId };
  if (config.targetUserId) return { userId: config.targetUserId };
  return null;
}

export function isAllowedUser(config, userId) {
  return Boolean(userId) && config.allowedUserIds.includes(userId);
}
