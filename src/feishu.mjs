import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  createReactionWithSdk,
  deleteReactionWithSdk,
  replyMarkdownWithSdk,
  sendCardWithSdk,
  updateMessageCardWithSdk,
  urgentAppWithSdk,
} from "./sdk.mjs";

function idempotencyKey(seed) {
  return "cfh-" + crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 40);
}

function commandError(args, result) {
  const detail = (result.stderr || result.stdout || "unknown lark-cli error").trim();
  return new Error("lark-cli " + args.slice(0, 3).join(" ") + ": " + detail.slice(0, 600));
}

export async function runLark(config, args, timeoutMs = config.commandTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.larkCli, args, {
      cwd: config.bridgeHome,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error("lark-cli timeout after " + timeoutMs + "ms"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0) finish(resolve, result);
      else finish(reject, commandError(args, result));
    });
  });
}

function parseJsonOutput(result) {
  const text = result.stdout.trim();
  if (text) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  return null;
}

function destinationArgs(destination) {
  if (destination?.chatId) return ["--chat-id", destination.chatId];
  if (destination?.userId) return ["--user-id", destination.userId];
  throw new Error("Feishu destination is not configured");
}

function useSdk(config) {
  return config.feishuProvider === "sdk";
}

export async function sendCard(config, destination, card, seed) {
  if (config.dryRun) return "dryrun-card-" + idempotencyKey(seed).slice(4, 16);
  if (useSdk(config)) return sendCardWithSdk(config, destination, card);
  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    ...destinationArgs(destination),
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
    "--idempotency-key",
    idempotencyKey(seed),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (!result?.ok || !result.data?.message_id) {
    throw new Error("Feishu card send did not return data.message_id");
  }
  return result.data.message_id;
}

export async function replyMarkdown(config, messageId, markdown, seed) {
  if (config.dryRun) return "dryrun-reply-" + idempotencyKey(seed).slice(4, 16);
  if (useSdk(config)) return replyMarkdownWithSdk(config, messageId, markdown);
  const args = [
    "im",
    "+messages-reply",
    "--as",
    "bot",
    "--message-id",
    messageId,
    "--markdown",
    markdown,
    "--idempotency-key",
    idempotencyKey(seed),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (!result?.ok || !result.data?.message_id) {
    throw new Error("Feishu reply did not return data.message_id");
  }
  return result.data.message_id;
}

export async function createReaction(config, messageId, emojiType) {
  if (!messageId) throw new Error("Feishu reaction requires message_id");
  if (!emojiType) throw new Error("Feishu reaction requires emoji_type");
  if (config.dryRun) {
    return {
      ok: true,
      data: {
        dry_run: true,
        reaction_id: "dryrun-reaction-" + idempotencyKey(messageId + ":" + emojiType).slice(4, 16),
        reaction_type: { emoji_type: emojiType },
      },
    };
  }
  if (useSdk(config)) return createReactionWithSdk(config, messageId, emojiType);
  const args = [
    "im",
    "reactions",
    "create",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ message_id: messageId }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (!result?.ok || !result.data?.reaction_id) {
    throw new Error("Feishu reaction create did not return reaction_id");
  }
  return result;
}

export async function deleteReaction(config, messageId, reactionId) {
  if (!messageId || !reactionId) throw new Error("Feishu reaction delete requires message_id and reaction_id");
  if (config.dryRun) return { ok: true, data: { dry_run: true, message_id: messageId, reaction_id: reactionId } };
  if (useSdk(config)) return deleteReactionWithSdk(config, messageId, reactionId);
  const args = [
    "im",
    "reactions",
    "delete",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (!result?.ok) throw new Error("Feishu reaction delete did not return ok=true");
  return result;
}

export async function updateCard(config, token, card) {
  if (config.dryRun) return { ok: true, data: { dry_run: true } };
  const args = [
    "api",
    "POST",
    "/open-apis/interactive/v1/card/update",
    "--as",
    "bot",
    "--data",
    JSON.stringify({ token, card }),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (result && result.ok === false) {
    throw new Error("Feishu card update failed");
  }
  return result;
}

export async function updateMessageCard(config, messageId, card) {
  if (!messageId) throw new Error("Feishu message card update requires message_id");
  if (config.dryRun) return { ok: true, data: { dry_run: true, message_id: messageId } };
  if (useSdk(config)) return updateMessageCardWithSdk(config, messageId, card);
  const args = [
    "api",
    "PATCH",
    "/open-apis/im/v1/messages/" + encodeURIComponent(messageId),
    "--as",
    "bot",
    "--data",
    JSON.stringify({ content: JSON.stringify(card) }),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (result && (result.ok === false || (result.code !== undefined && result.code !== 0))) {
    throw new Error("Feishu message card update failed");
  }
  return result;
}

export async function urgentApp(config, messageId, userIds) {
  const targets = [...new Set((userIds || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!messageId) throw new Error("Feishu app urgent requires message_id");
  if (!targets.length) return { skipped: "no_urgent_targets" };
  if (config.dryRun) {
    return { ok: true, data: { dry_run: true, message_id: messageId, user_id_list: targets } };
  }
  if (useSdk(config)) return urgentAppWithSdk(config, messageId, targets);
  const args = [
    "im",
    "messages",
    "urgent_app",
    "--as",
    "bot",
    "--message-id",
    messageId,
    "--user-id-type",
    "open_id",
    "--data",
    JSON.stringify({ user_id_list: targets }),
    "--format",
    "json",
  ];
  const result = parseJsonOutput(await runLark(config, args));
  if (!result?.ok) throw new Error("Feishu app urgent did not return ok=true");
  return result;
}
