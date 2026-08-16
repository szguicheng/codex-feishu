import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadConfig } from "./config.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(sourceDir);
const mainPath = path.join(sourceDir, "main.mjs");
const installPath = fileURLToPath(import.meta.url);

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function bridgeCommand() {
  return shellQuote(process.execPath) + " " + shellQuote(mainPath) + " hook";
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function backup(filePath) {
  if (!(await exists(filePath))) return null;
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const backupPath = filePath + ".codex-feishu-backup-" + stamp;
  await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function hookEntry(command, matcher, timeout = 5) {
  const entry = {
    hooks: [{ type: "command", command, async: true, timeout }],
  };
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}

function hasBridgeCommand(entries, command) {
  return entries.some((entry) => entry?.hooks?.some((hook) => hook?.command === command));
}

function addHook(config, hooks, name, matcher) {
  const entries = hooks[name] || [];
  if (!hasBridgeCommand(entries, bridgeCommand())) entries.push(hookEntry(bridgeCommand(), matcher));
  hooks[name] = entries;
}

function removeBridgeHooks(hooks, command) {
  for (const [name, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const nextEntries = entries
      .map((entry) => {
        if (!Array.isArray(entry?.hooks)) return entry;
        const nextHooks = entry.hooks.filter((hook) => hook?.command !== command);
        return nextHooks.length ? { ...entry, hooks: nextHooks } : null;
      })
      .filter(Boolean);
    if (nextEntries.length) hooks[name] = nextEntries;
    else delete hooks[name];
  }
}

async function installHooks(config) {
  const hooksPath = path.join(config.codexHome, "hooks.json");
  const original = await readJson(hooksPath, { hooks: {} });
  const next = {
    ...original,
    hooks: { ...(original.hooks || {}) },
  };
  removeBridgeHooks(next.hooks, bridgeCommand());
  addHook(config, next.hooks, "UserPromptSubmit");
  addHook(config, next.hooks, "PermissionRequest");
  addHook(config, next.hooks, "Stop");
  await fs.mkdir(path.dirname(hooksPath), { recursive: true, mode: 0o700 });
  const backupPath = await backup(hooksPath);
  await fs.writeFile(hooksPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return { hooksPath, backupPath };
}

async function installConfig(config, options) {
  await fs.mkdir(config.bridgeHome, { recursive: true, mode: 0o700 });
  if (await exists(config.envPath) && !options.forceConfig) return false;
  const lines = [
    "# Codex Feishu Hook Bridge; setup writes per-user Feishu app credentials here.",
    "FEISHU_PROVIDER=auto",
    "FEISHU_APP_ID=",
    "FEISHU_APP_SECRET=",
    "FEISHU_DOMAIN=feishu",
    "FEISHU_SETUP_SOURCE=codex-feishu-hook-bridge",
    "",
    "# Set exactly one destination. For a personal chat, use FEISHU_TARGET_USER_ID.",
    "FEISHU_TARGET_USER_ID=" + (options.targetUserId || ""),
    "FEISHU_CHAT_ID=" + (options.chatId || ""),
    "FEISHU_ALLOWED_USER_IDS=" + (options.allowedUserIds || options.targetUserId || ""),
    "FEISHU_URGENT_USER_IDS=" + (options.targetUserId || ""),
    "FEISHU_STOP_URGENT=true",
    "FEISHU_MAX_TEXT=12000",
    "FEISHU_STAGE_MIN_INTERVAL_MS=10000",
    "FEISHU_COMMAND_TIMEOUT_MS=4500",
    "FEISHU_LISTENER_RESTART_MS=3000",
    "CODEX_COMMAND=codex",
    "CODEX_APP_SERVER_MODE=ipc",
    "CODEX_TURN_TIMEOUT_MS=7200000",
    "FEISHU_ALLOW_UNTHREADED_REPLIES=false",
    "FEISHU_DRY_RUN=false",
    "",
  ];
  await fs.writeFile(config.envPath, lines.join("\n"), { mode: 0o600 });
  return true;
}

async function installLaunchAgent(config) {
  const configuredDir = process.env.FEISHU_LAUNCH_AGENT_DIR;
  const externalHome = os.homedir().startsWith("/Volumes/");
  const launchAgents = configuredDir
    ? path.resolve(configuredDir)
    : path.join(os.homedir(), "Library", "LaunchAgents");
  const needsRootCopy = !configuredDir && externalHome;
  const plistPath = path.join(launchAgents, "com.codex.feishu-hook-bridge.plist");
  const logDir = path.join(config.bridgeHome, "logs");
  await fs.mkdir(launchAgents, { recursive: true, mode: 0o755 });
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const uid = String(process.env.SUDO_UID || process.getuid?.() || "");
  const disabled = needsRootCopy ? '  <key>Disabled</key><true/>\n' : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${disabled}  <key>Label</key><string>com.codex.feishu-hook-bridge</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${mainPath}</string><string>listener</string></array>
  <key>WorkingDirectory</key><string>${projectDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FEISHU_BRIDGE_CONFIG</key><string>${config.envPath}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${path.join(logDir, "listener.stdout.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "listener.stderr.log")}</string>
</dict>
</plist>
`;
  await fs.writeFile(plistPath, plist, { mode: 0o644 });
  await fs.chmod(plistPath, 0o644);
  return {
    plistPath,
    domain: uid ? "gui/" + uid : null,
    needsRootCopy,
    rootPlistPath: path.join("/Library", "LaunchAgents", path.basename(plistPath)),
    rootInstallCommand:
      "sudo env FEISHU_LAUNCH_AGENT_DIR=/Library/LaunchAgents FEISHU_BRIDGE_CONFIG=" +
      shellQuote(config.envPath) +
      " " +
      shellQuote(process.execPath) +
      " " +
      shellQuote(installPath) +
      " --launch-agent",
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();
  const options = {
    targetUserId: optionValue(args, "--target-user-id"),
    allowedUserIds: optionValue(args, "--allowed-user-ids"),
    chatId: optionValue(args, "--chat-id"),
    forceConfig: args.includes("--force-config"),
  };
  if (!args.length || args.includes("--help")) {
    process.stdout.write(
      "Usage: node src/install.mjs [--hooks] [--config] [--launch-agent] [--target-user-id ID] [--chat-id ID]\n" +
        "  --hooks         merge bridge hooks into ~/.codex/hooks.json\n" +
        "  --config        create config.env if it does not exist\n" +
        "  --launch-agent  write a macOS LaunchAgent plist for the listener\n" +
        "  --force-config  overwrite the bridge config.env\n",
    );
    return;
  }
  if (args.includes("--config")) {
    const created = await installConfig(config, options);
    process.stdout.write((created ? "created " : "kept ") + config.envPath + "\n");
  }
  if (args.includes("--hooks")) {
    const result = await installHooks(config);
    process.stdout.write("merged hooks into " + result.hooksPath + "\n");
    if (result.backupPath) process.stdout.write("backup: " + result.backupPath + "\n");
  }
  if (args.includes("--launch-agent")) {
    const result = await installLaunchAgent(config);
    process.stdout.write("wrote " + result.plistPath + "\n");
    if (result.needsRootCopy) {
      process.stdout.write("external home detected; this source plist is disabled because the volume is noowners\n");
      process.stdout.write("install enabled copy with: " + result.rootInstallCommand + "\n");
      process.stdout.write("then load with: launchctl bootstrap " + result.domain + " " + result.rootPlistPath + "\n");
    } else if (result.domain) {
      process.stdout.write("load with: launchctl bootstrap " + result.domain + " " + result.plistPath + "\n");
    }
  }
}

await main();
