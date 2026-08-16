import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emptyState() {
  return {
    version: 1,
    enabled: true,
    sessions: {},
    messages: {},
    processedMessageIds: [],
    processedActionIds: [],
    processedMenuEventIds: [],
  };
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function readStateFile(statePath) {
  try {
    const text = await fs.readFile(statePath, "utf8");
    const value = JSON.parse(text);
    return {
      ...emptyState(),
      ...value,
      sessions: value.sessions || {},
      messages: value.messages || {},
      processedMessageIds: value.processedMessageIds || [],
      processedActionIds: value.processedActionIds || [],
      processedMenuEventIds: value.processedMenuEventIds || [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function acquireLock(lockPath) {
  await ensureParent(lockPath);
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close();
        await fs.unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30000) {
          await fs.unlink(lockPath).catch(() => {});
        }
      } catch {}
      await sleep(25);
    }
  }
  throw new Error("state lock timeout");
}

async function writeStateFile(statePath, state) {
  await ensureParent(statePath);
  const tempPath = statePath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tempPath, statePath);
}

function pruneState(state) {
  const sessionEntries = Object.entries(state.sessions);
  for (const [sessionId, session] of sessionEntries) {
    if (session.updatedAt && Date.now() - session.updatedAt > 14 * 24 * 60 * 60 * 1000) {
      delete state.sessions[sessionId];
    }
  }
  const messageEntries = Object.entries(state.messages);
  if (messageEntries.length > 800) {
    for (const [messageId] of messageEntries.slice(0, messageEntries.length - 800)) {
      delete state.messages[messageId];
    }
  }
  state.processedMessageIds = state.processedMessageIds.slice(-1000);
  state.processedActionIds = state.processedActionIds.slice(-1000);
  state.processedMenuEventIds = state.processedMenuEventIds.slice(-1000);
}

export async function withState(config, mutator) {
  const lockPath = config.statePath + ".lock";
  const release = await acquireLock(lockPath);
  try {
    const state = await readStateFile(config.statePath);
    const result = await mutator(state);
    pruneState(state);
    await writeStateFile(config.statePath, state);
    return result;
  } finally {
    await release();
  }
}

export async function readState(config) {
  return readStateFile(config.statePath);
}

export function getSession(state, sessionId) {
  return sessionId ? state.sessions[sessionId] || null : null;
}

export function getSessionByMessage(state, messageId) {
  const sessionId = messageId ? state.messages[messageId] : null;
  return sessionId ? state.sessions[sessionId] || null : null;
}

export function rememberMessage(state, messageId, sessionId) {
  if (messageId && sessionId) state.messages[messageId] = sessionId;
}

export function rememberProcessed(state, listName, id) {
  if (!id) return false;
  const list = state[listName];
  if (list.includes(id)) return false;
  list.push(id);
  return true;
}

export function upsertSession(state, event, config) {
  const sessionId = event.session_id;
  if (!sessionId) return null;
  const previous = state.sessions[sessionId] || {};
  const session = {
    ...previous,
    sessionId,
    cwd: event.cwd || previous.cwd || null,
    transcriptPath: event.transcript_path || previous.transcriptPath || null,
    operatorId: previous.operatorId || config.targetUserId || null,
    updatedAt: Date.now(),
    lastEvent: event.hook_event_name || previous.lastEvent || null,
  };
  state.sessions[sessionId] = session;
  return session;
}

export function updateSession(state, sessionId, patch) {
  if (!sessionId) return null;
  const previous = state.sessions[sessionId] || { sessionId };
  const session = {
    ...previous,
    ...patch,
    sessionId,
    updatedAt: Date.now(),
  };
  state.sessions[sessionId] = session;
  return session;
}
