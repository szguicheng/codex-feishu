import { spawn } from "node:child_process";

import { buildNotifyStateCard } from "./card.mjs";
import { loadConfig, isAllowedUser } from "./config.mjs";
import { runCodexTurn } from "./codex.mjs";
import { createReaction, deleteReaction, sendCard } from "./feishu.mjs";
import { startSdkConsumers } from "./sdk.mjs";
import {
  getSessionByMessage,
  rememberProcessed,
  readState,
  updateSession,
  withState,
} from "./state.mjs";

const MENU_ACTIONS = new Set(["open_notify", "close_notify"]);

function log(config, message, error = null) {
  const suffix = error ? " " + (error.stack || error.message || error) : "";
  process.stderr.write(config.logPrefix + " " + message + suffix + "\n");
}

function idValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return String(
      value.open_id ||
        value.user_id ||
        value.union_id ||
        value.operator_id ||
        value.message_id ||
        value.id ||
        "",
    );
  }
  return String(value);
}

function senderId(event) {
  return idValue(event.sender_id || event.sender?.sender_id || event.sender);
}

function operatorId(event) {
  return idValue(
    event.operator_open_id ||
      event.operator_id ||
      event.operator?.operator_id ||
      event.operator,
  );
}

function messageId(event) {
  return idValue(event.message_id || event.id);
}

function relatedMessageIds(event) {
  const ids = [];
  for (const value of [event.reply_to, event.root_id, event.parent_id, event.thread_id]) {
    const id = idValue(value);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function decodeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function messageText(event) {
  const value = decodeJson(event.content);
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "content", "title", "body"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function menuDestination(event, config, actor) {
  if (event.chat_id) return { chatId: event.chat_id };
  if (config.targetChatId) return { chatId: config.targetChatId };
  if (actor) return { userId: actor };
  if (config.targetUserId) return { userId: config.targetUserId };
  return null;
}

async function processNotifyMenu(event, config) {
  const actor = operatorId(event);
  if (!isAllowedUser(config, actor)) {
    log(config, "ignored notify menu from unauthorized operator " + (actor || "unknown"));
    return { skipped: "unauthorized" };
  }

  const action = typeof event.event_key === "string" ? event.event_key : "";
  if (!MENU_ACTIONS.has(action)) {
    log(config, "ignored unknown notify menu event " + (action || "empty"));
    return { skipped: "unknown_action" };
  }
  const eventId = event.event_id || action + ":" + actor + ":" + (event.timestamp || Date.now());
  const enabled = action === "open_notify";
  const accepted = await withState(config, (state) => {
    if (!rememberProcessed(state, "processedMenuEventIds", eventId)) return false;
    state.enabled = enabled;
    state.lastNotifyEvent = action;
    state.lastNotifyOperatorId = actor;
    state.lastNotifyAt = Date.now();
    return true;
  });
  if (!accepted) return { skipped: "duplicate" };

  const destination = menuDestination(event, config, actor);
  if (!destination) {
    log(config, "notify menu event has no reply destination");
    return { error: "no_target" };
  }
  try {
    const messageId = await sendCard(
      config,
      destination,
      buildNotifyStateCard(enabled, event.operator_name),
      "notify-menu:" + eventId,
    );
    log(config, "sent notify menu confirmation: " + action);
    return { enabled, messageId };
  } catch (error) {
    log(config, "failed to send notify menu confirmation", error);
    return { error: error.message };
  }
}

async function findReplySession(event, config) {
  const ids = relatedMessageIds(event);
  const state = await readState(config);
  for (const id of ids) {
    const session = getSessionByMessage(state, id);
    if (session) return { session, messageId: id };
  }
  if (!config.allowUnthreadedReplies) return null;
  const actor = senderId(event);
  const candidates = Object.values(state.sessions).filter((session) => {
    if (session.operatorId && actor && session.operatorId !== actor) return false;
    if (event.chat_id && session.chatId && session.chatId !== event.chat_id) return false;
    return true;
  });
  return candidates.length === 1
    ? { session: candidates[0], messageId: candidates[0].lastMessageId || null }
    : null;
}

const turnQueues = new Map();

function enqueueTurn(sessionId, task) {
  const previous = turnQueues.get(sessionId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  turnQueues.set(sessionId, next);
  next.finally(() => {
    if (turnQueues.get(sessionId) === next) turnQueues.delete(sessionId);
  }).catch(() => {});
  return next;
}

async function markReceived(config, targetMessageId) {
  if (!targetMessageId) return null;
  try {
    const result = await createReaction(config, targetMessageId, "Get");
    const reactionId = result?.data?.reaction_id;
    if (!reactionId) throw new Error("Feishu received reaction did not return reaction_id");
    log(config, "marked user message as received: " + targetMessageId);
    return { messageId: targetMessageId, reactionId };
  } catch (error) {
    log(config, "failed to add received reaction", error);
    return null;
  }
}

async function markForwarded(config, reaction) {
  if (!reaction) return;
  try {
    await deleteReaction(config, reaction.messageId, reaction.reactionId);
  } catch (error) {
    log(config, "failed to remove received reaction", error);
  }
  try {
    await createReaction(config, reaction.messageId, "DONE");
    log(config, "marked user message as forwarded: " + reaction.messageId);
  } catch (error) {
    log(config, "failed to add forwarded reaction", error);
  }
}

async function processMessage(event, config) {
  const actor = senderId(event);
  if (event.sender_type && event.sender_type !== "user") return { skipped: "non_user_sender" };
  if (!isAllowedUser(config, actor)) {
    log(config, "ignored message from unauthorized sender " + (actor || "unknown"));
    return { skipped: "unauthorized" };
  }
  const incomingMessageId = messageId(event);
  if (!incomingMessageId) return { skipped: "missing_message_id" };
  const text = messageText(event);
  if (!text) return { skipped: "empty_message" };

  const mapping = await findReplySession(event, config);
  if (!mapping) {
    log(config, "ignored reply without a mapped bridge card: " + incomingMessageId);
    return { skipped: "unmapped_reply" };
  }
  const { session } = mapping;

  const accepted = await withState(config, (state) => {
    if (!rememberProcessed(state, "processedMessageIds", incomingMessageId)) return false;
    updateSession(state, session.sessionId, {
      chatId: event.chat_id || session.chatId || null,
      operatorId: actor,
      lastIncomingMessageId: incomingMessageId,
      lastIncomingText: text,
    });
    return true;
  });
  if (!accepted) return { skipped: "duplicate" };

  const receivedReaction = await markReceived(config, incomingMessageId);
  return enqueueTurn(session.sessionId, async () => {
    try {
      const result = await runCodexTurn(config, session.sessionId, text);
      await markForwarded(config, receivedReaction);
      log(config, "Codex accepted Feishu reply for " + session.sessionId.slice(0, 12));
      return result;
    } catch (error) {
      log(config, "Codex could not continue session " + session.sessionId.slice(0, 12), error);
      return { error: error.message };
    }
  });
}

async function handleEvent(event, eventKey, config) {
  try {
    if (eventKey === "application.bot.menu_v6") return await processNotifyMenu(event, config);
    if (eventKey === "im.message.receive_v1") return await processMessage(event, config);
    return { skipped: "unknown_event_key" };
  } catch (error) {
    log(config, "event handler failed for " + eventKey, error);
    return { error: error.message };
  }
}

function startConsumer(config, eventKey, onEvent, children, stopping) {
  const child = spawn(config.larkCli, ["event", "consume", eventKey, "--as", "bot", "--quiet"], {
    cwd: config.bridgeHome,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let buffer = "";
  let queue = Promise.resolve();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        log(config, eventKey + " emitted invalid JSON", error);
        continue;
      }
      queue = queue.then(() => onEvent(event)).catch((error) => log(config, eventKey + " handler rejected", error));
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text && !text.includes("[event] ready")) log(config, eventKey + ": " + text.slice(-1000));
  });
  child.on("error", (error) => log(config, eventKey + " process error", error));
  child.on("close", (code, signal) => {
    children.delete(child);
    if (!stopping.value) {
      log(config, eventKey + " exited; restarting", new Error("code=" + code + " signal=" + signal));
      setTimeout(() => startConsumer(config, eventKey, onEvent, children, stopping), config.listenerRestartMs).unref();
    }
  });
  return child;
}

export async function runListener(config = loadConfig()) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(config.bridgeHome, { recursive: true, mode: 0o700 }));
  const children = new Set();
  const stopping = { value: false };
  const onSignal = () => {
    if (stopping.value) return;
    stopping.value = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (config.feishuProvider === "sdk") {
    await startSdkConsumers(
      config,
      {
        "im.message.receive_v1": (event) => handleEvent(event, "im.message.receive_v1", config),
        "application.bot.menu_v6": (event) => handleEvent(event, "application.bot.menu_v6", config),
      },
      children,
      stopping,
      (message, error = null) => log(config, message, error),
    );
  } else {
    startConsumer(
      config,
      "im.message.receive_v1",
      (event) => handleEvent(event, "im.message.receive_v1", config),
      children,
      stopping,
    );
    startConsumer(
      config,
      "application.bot.menu_v6",
      (event) => handleEvent(event, "application.bot.menu_v6", config),
      children,
      stopping,
    );
  }
  log(config, "listener started for message and notify menu events");
  await new Promise((resolve) => {
    const check = () => {
      if (stopping.value && children.size === 0) resolve();
      else setTimeout(check, 200).unref();
    };
    check();
  });
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

export { handleEvent, processNotifyMenu, processMessage };
