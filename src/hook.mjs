import { buildStatusCard } from "./card.mjs";
import { sendCard, updateMessageCard, urgentApp } from "./feishu.mjs";
import {
  getSession,
  rememberMessage,
  readState,
  updateSession,
  upsertSession,
  withState,
} from "./state.mjs";
import { loadConfig, targetFor } from "./config.mjs";

const CARD_EVENTS = new Set(["UserPromptSubmit", "PermissionRequest", "Stop"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(config, message, error = null) {
  const suffix = error ? " " + (error.stack || error.message || error) : "";
  process.stderr.write(config.logPrefix + " " + message + suffix + "\n");
}

function valueText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function responseFor(event) {
  const candidates = {
    Stop: [event.last_assistant_message, event.response, event.output],
    UserPromptSubmit: [event.prompt],
    PermissionRequest: [event.permission, event.request, event.prompt],
  }[event.hook_event_name] || [event.last_assistant_message, event.output, event.response];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && valueText(candidate).trim()) {
      return valueText(candidate);
    }
  }
  return "这一阶段没有捕获到可展示的 Markdown 响应。";
}

function turnKeyFor(event) {
  return String(event.turn_id || event.event_id || event.uuid || "hook-" + Date.now());
}

function pendingTimeout(config) {
  return Math.max(10000, config.commandTimeoutMs + 2000);
}

async function sendStopUrgent(config, messageId, destination) {
  if (!config.stopUrgent) return;
  const targets = [...new Set([
    destination?.userId,
    ...(config.urgentUserIds || []),
  ].filter(Boolean))];
  if (!targets.length) {
    log(config, "Stop card updated but app urgent skipped: no FEISHU_TARGET_USER_ID or FEISHU_URGENT_USER_IDS");
    return;
  }
  try {
    const result = await urgentApp(config, messageId, targets);
    if (result?.skipped) {
      log(config, "Stop card updated but app urgent skipped: " + result.skipped);
    } else {
      log(config, "sent app urgent for Stop card " + messageId);
    }
  } catch (error) {
    log(config, "Stop card updated but app urgent failed", error);
  }
}

async function waitForPendingCard(config, sessionId) {
  const deadline = Date.now() + pendingTimeout(config);
  while (Date.now() < deadline) {
    const state = await readState(config);
    const session = getSession(state, sessionId);
    if (!session?.pendingCardAt) return;
    if (Date.now() - session.pendingCardAt >= pendingTimeout(config)) return;
    await sleep(100);
  }
}

export async function handleHook(event, config = loadConfig(), retry = 0) {
  if (!event?.session_id || !event.hook_event_name) return { skipped: "invalid_event" };
  if (!CARD_EVENTS.has(event.hook_event_name)) {
    return { skipped: "unsupported_event", event: event.hook_event_name };
  }

  const reservation = await withState(config, (state) => {
    const session = upsertSession(state, event, config);
    const enabled = state.enabled !== false;
    if (!enabled) return { skipped: "disabled", sessionId: event.session_id };
    const isPrompt = event.hook_event_name === "UserPromptSubmit";
    const turnKey = turnKeyFor(event);
    const pending = session.pendingCardAt &&
      Date.now() - session.pendingCardAt < pendingTimeout(config);
    if (pending) {
      return { waitForPending: true, sessionId: event.session_id };
    }
    if (isPrompt && session.lastTurnId === turnKey && session.lastMessageId && !pending) {
      return { skipped: "duplicate_prompt", sessionId: event.session_id };
    }
    const stalePending = !isPrompt && session.pendingCardAt && !pending;
    const sameTurn = !event.turn_id || !session.lastTurnId || String(event.turn_id) === String(session.lastTurnId);
    const messageId = isPrompt || stalePending || !sameTurn ? null : session.lastMessageId || null;
    if (isPrompt) {
      updateSession(state, event.session_id, {
        pendingCardAt: Date.now(),
        pendingCardTurnId: turnKey,
        lastEvent: event.hook_event_name,
      });
    } else if (stalePending) {
      updateSession(state, event.session_id, {
        pendingCardAt: null,
        pendingCardTurnId: null,
      });
    }
    return {
      sessionId: event.session_id,
      enabled,
      messageId,
      isPrompt,
      turnKey,
      session: structuredClone(getSession(state, event.session_id)),
    };
  });

  if (reservation.waitForPending) {
    if (retry >= 1) {
      log(config, "hook " + event.hook_event_name + " skipped: pending prompt card did not settle");
      return { skipped: "pending_card_timeout", sessionId: event.session_id };
    }
    await waitForPendingCard(config, event.session_id);
    return handleHook(event, config, retry + 1);
  }

  if (reservation.skipped) {
    log(config, "hook " + event.hook_event_name + " skipped: " + reservation.skipped);
    return reservation;
  }

  const destination = targetFor(config, reservation.session);
  if (!destination) {
    log(config, "Feishu target is empty; set FEISHU_TARGET_USER_ID or FEISHU_CHAT_ID");
    if (reservation.isPrompt) {
      await withState(config, (state) => updateSession(state, event.session_id, {
        pendingCardAt: null,
        pendingCardTurnId: null,
      }));
    }
    return { skipped: "no_target", sessionId: reservation.sessionId };
  }

  const card = buildStatusCard(
    config,
    event,
    reservation.session,
    responseFor(event),
  );
  try {
    let messageId = reservation.messageId;
    if (messageId) {
      await updateMessageCard(config, messageId, card);
      log(config, "updated " + event.hook_event_name + " card for " + event.session_id.slice(0, 12));
    } else {
      const turnKey = event.turn_id || event.event_id || event.uuid || Date.now();
      messageId = await sendCard(
        config,
        destination,
        card,
        event.session_id + ":turn:" + turnKey,
      );
      log(config, "sent " + event.hook_event_name + " card for " + event.session_id.slice(0, 12));
    }
    await withState(config, (state) => {
      rememberMessage(state, messageId, event.session_id);
      updateSession(state, event.session_id, {
        lastMessageId: messageId,
        lastCard: card,
        lastEvent: event.hook_event_name,
        lastTurnId: reservation.turnKey,
        pendingCardAt: null,
        pendingCardTurnId: null,
        chatId: destination.chatId || reservation.session.chatId || null,
      });
    });
    if (event.hook_event_name === "Stop") {
      await sendStopUrgent(config, messageId, destination);
    }
    return { sessionId: event.session_id, messageId };
  } catch (error) {
    if (reservation.isPrompt) {
      await withState(config, (state) => updateSession(state, event.session_id, {
        pendingCardAt: null,
        pendingCardTurnId: null,
      })).catch((stateError) => log(config, "failed to clear pending prompt card", stateError));
    }
    log(config, "failed to send " + event.hook_event_name + " card", error);
    return { error: error.message };
  }
}

export async function runHookFromStdin(config = loadConfig()) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return { skipped: "empty_stdin" };
  let event;
  try {
    event = JSON.parse(input);
  } catch (error) {
    log(config, "hook stdin was not valid JSON", error);
    return { error: "invalid_json" };
  }
  return handleHook(event, config);
}
