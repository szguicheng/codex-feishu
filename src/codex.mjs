import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timeout after " + timeoutMs + "ms")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write("[codex-app-server] " + text.slice(-2000) + "\n");
    });
    child.on("error", (error) => this.#close(error));
    child.on("close", (code, signal) => {
      this.#close(new Error("codex app-server exited (code=" + code + ", signal=" + signal + ")"));
    });
  }

  #consume(chunk) {
    this.buffer += String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write("[codex-app-server] invalid JSON: " + line.slice(0, 500) + "\n");
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message || "Codex app-server RPC error");
          error.code = message.error.code;
          error.data = message.error.data;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      for (const listener of this.listeners) listener(message);
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "__closed", params: { error } });
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return withTimeout(promise, timeoutMs, method);
  }

  notify(method, params = {}) {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      let timer;
      const remove = this.onNotification((message) => {
        try {
          if (!predicate(message)) return;
          remove();
          clearTimeout(timer);
          resolve(message);
        } catch (error) {
          remove();
          clearTimeout(timer);
          reject(error);
        }
      });
      timer = setTimeout(() => {
        remove();
        reject(new Error(label + " timeout after " + timeoutMs + "ms"));
      }, timeoutMs);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    setTimeout(() => this.child.kill("SIGTERM"), 500).unref();
  }
}

const IPC_VERSION_BY_METHOD = {
  "thread-follower-start-turn": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-submit-user-input": 1,
};

function encodeIpcMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class IpcClient {
  constructor(socketPath, timeoutMs) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.clientId = "initializing-client";
    this.closed = false;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error("Codex IPC connection timeout after " + this.timeoutMs + "ms")),
        this.timeoutMs,
      );
      socket.on("connect", () => finish(resolve));
      socket.on("error", (error) => finish(reject, error));
      socket.on("data", (chunk) => this.#consume(chunk));
      socket.on("close", () => this.#close(new Error("Codex IPC socket closed")));
      this.socket = socket;
    });
    const response = await this.request("initialize", { clientType: "codex-feishu-hook-bridge" }, {
      includeVersion: false,
      sourceClientId: "initializing-client",
    });
    if (response.resultType !== "success" || !response.result?.clientId) {
      throw new Error(response.error || "Codex IPC initialize failed");
    }
    this.clientId = response.result.clientId;
    return response;
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > 256 * 1024 * 1024) {
        this.#close(new Error("invalid Codex IPC frame length " + length));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        this.#close(error);
        return;
      }
      const pending = message.requestId ? this.pending.get(message.requestId) : null;
      if (pending) {
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}, options = {}) {
    if (!this.socket?.writable || this.closed) return Promise.reject(new Error("Codex IPC is not connected"));
    const requestId = crypto.randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: options.sourceClientId || this.clientId,
      method,
      params,
    };
    if (options.targetClientId) message.targetClientId = options.targetClientId;
    if (options.includeVersion !== false) message.version = IPC_VERSION_BY_METHOD[method] || 0;
    if (options.timeoutMs) message.timeoutMs = options.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Codex IPC " + method + " timeout after " + (options.timeoutMs || this.timeoutMs) + "ms"));
      }, options.timeoutMs || this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeIpcMessage(message));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex IPC client closed"));
    }
    this.pending.clear();
    this.socket?.end();
  }
}

function threadIdOf(message) {
  return message?.params?.threadId || message?.params?.thread?.id || message?.params?.turn?.threadId;
}

function turnIdOf(message) {
  return message?.params?.turnId || message?.params?.turn?.id;
}

function isCompleted(message, sessionId, turnId) {
  if (message?.method === "__closed") return true;
  if (message?.method !== "turn/completed" && message?.method !== "turn/failed" && message?.method !== "error") {
    return false;
  }
  const threadId = threadIdOf(message);
  const eventTurnId = turnIdOf(message);
  if (threadId && threadId !== sessionId) return false;
  if (turnId && eventTurnId && eventTurnId !== turnId) return false;
  return true;
}

function completedError(message) {
  if (message.method === "turn/completed") return null;
  const detail = message.params?.error?.message || message.params?.message || message.method;
  return new Error("Codex turn failed: " + detail);
}

export async function runCodexTurn(config, sessionId, text) {
  if (!sessionId) throw new Error("Codex session_id is required");
  if (!text?.trim()) throw new Error("Codex turn text is empty");
  if (config.dryRun) {
    return { dryRun: true, sessionId, text };
  }
  if (config.appServerMode === "ipc") return runIpcTurn(config, sessionId, text);
  if (config.appServerMode !== "spawn") {
    throw new Error("Unsupported CODEX_APP_SERVER_MODE: " + config.appServerMode);
  }

  const child = spawn(config.codexCommand, ["app-server", "--listen", "stdio://"], {
    cwd: config.bridgeHome,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new RpcClient(child);
  try {
    await rpc.call("initialize", {
      clientInfo: {
        name: "codex-feishu-hook-bridge",
        title: "Codex Feishu Hook Bridge",
        version: "0.1.0",
      },
    });
    rpc.notify("initialized", {});
    await rpc.call("thread/resume", { threadId: sessionId });

    let turnId = null;
    const completed = rpc.waitFor(
      (message) => isCompleted(message, sessionId, turnId),
      config.turnTimeoutMs,
      "Codex turn completion",
    );
    const started = await rpc.call("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text }],
    });
    turnId = started?.turn?.id || started?.turnId || started?.id || null;
    const event = await completed;
    const error = completedError(event);
    if (error) throw error;
    return { sessionId, turnId, started, completed: event.params };
  } finally {
    rpc.close();
  }
}

async function runIpcTurn(config, sessionId, text) {
  const client = new IpcClient(config.appServerSocket, config.commandTimeoutMs);
  try {
    await client.connect();
    const response = await client.request(
      "thread-follower-start-turn",
      {
        conversationId: sessionId,
        turnStartParams: {
          input: [{ type: "text", text, text_elements: [] }],
          attachments: [],
        },
      },
      { timeoutMs: config.commandTimeoutMs },
    );
    if (response.resultType !== "success") {
      throw new Error(response.error || "Codex desktop rejected the Feishu reply");
    }
    return { sessionId, mode: "ipc", response };
  } finally {
    client.close();
  }
}
