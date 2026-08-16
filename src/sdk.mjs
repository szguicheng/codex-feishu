let sdkPromise;
const clients = new WeakMap();

async function loadSdk() {
  sdkPromise ||= import("@larksuiteoapi/node-sdk");
  return sdkPromise;
}

export function sdkConfigured(config) {
  return Boolean(config?.feishuAppId && config?.feishuAppSecret);
}

function domainFor(sdk, config) {
  if (config.feishuDomain === "lark") return sdk.Domain.Lark;
  return sdk.Domain.Feishu;
}

async function clientFor(config) {
  if (!sdkConfigured(config)) throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for SDK mode");
  if (clients.has(config)) return clients.get(config);
  const sdk = await loadSdk();
  const client = new sdk.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    appType: sdk.AppType.SelfBuild,
    domain: domainFor(sdk, config),
    loggerLevel: sdk.LoggerLevel.error,
  });
  const value = { sdk, client };
  clients.set(config, value);
  return value;
}

function assertResponse(result, label) {
  if (!result || (result.code !== undefined && result.code !== 0)) {
    throw new Error("Feishu " + label + " failed: " + (result?.msg || "unknown API error"));
  }
  return result;
}

function normalizeMessageEvent(payload, eventKey) {
  const root = payload?.event || payload || {};
  if (eventKey !== "im.message.receive_v1") {
    const operator = root.operator || root.operator_info || {};
    const action = root.event_key || root.action_key || root.action?.value?.event_key || root.action?.value?.key || "";
    return {
      ...root,
      event_id: payload?.header?.event_id || root.event_id || null,
      event_key: action,
      operator_open_id: root.operator_open_id || root.open_id || operator.open_id || operator.operator_id || null,
      operator_name: root.operator_name || operator.name || null,
      chat_id: root.chat_id || root.chat?.chat_id || null,
    };
  }

  const message = root.message || {};
  const sender = root.sender || {};
  return {
    ...root,
    event_id: payload?.header?.event_id || root.event_id || null,
    sender_type: root.sender_type || sender.sender_type || null,
    sender_id: root.sender_id || sender.sender_id || sender,
    message_id: root.message_id || message.message_id || message.id || null,
    content: root.content ?? message.content ?? "",
    chat_id: root.chat_id || message.chat_id || null,
    root_id: root.root_id || message.root_id || null,
    parent_id: root.parent_id || message.parent_id || null,
    thread_id: root.thread_id || message.thread_id || null,
    reply_to: root.reply_to || message.parent_id || null,
  };
}

export async function sendCardWithSdk(config, destination, card) {
  const { client } = await clientFor(config);
  const receiveIdType = destination?.chatId ? "chat_id" : "open_id";
  const receiveId = destination?.chatId || destination?.userId;
  if (!receiveId) throw new Error("Feishu destination is not configured");
  const result = assertResponse(
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    }),
    "card send",
  );
  if (!result.data?.message_id) throw new Error("Feishu card send did not return data.message_id");
  return result.data.message_id;
}

export async function replyMarkdownWithSdk(config, messageId, markdown) {
  const { client } = await clientFor(config);
  const result = assertResponse(
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: markdown }),
      },
    }),
    "message reply",
  );
  if (!result.data?.message_id) throw new Error("Feishu reply did not return data.message_id");
  return result.data.message_id;
}

export async function createReactionWithSdk(config, messageId, emojiType) {
  const { client } = await clientFor(config);
  return assertResponse(
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    }),
    "reaction create",
  );
}

export async function deleteReactionWithSdk(config, messageId, reactionId) {
  const { client } = await clientFor(config);
  return assertResponse(
    await client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }),
    "reaction delete",
  );
}

export async function updateMessageCardWithSdk(config, messageId, card) {
  const { client } = await clientFor(config);
  return assertResponse(
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }),
    "message card update",
  );
}

export async function urgentAppWithSdk(config, messageId, userIds) {
  const { client } = await clientFor(config);
  return assertResponse(
    await client.im.message.urgentApp({
      path: { message_id: messageId },
      params: { user_id_type: "open_id" },
      data: { user_id_list: userIds },
    }),
    "app urgent",
  );
}

export async function startSdkConsumers(config, handlers, children, stopping, log) {
  const sdk = await loadSdk();
  let closed = false;
  let ws;
  const handle = {
    close() {
      if (closed) return;
      closed = true;
      children.delete(handle);
      ws?.close({ force: true });
    },
  };
  children.add(handle);

  const restart = (error) => {
    if (closed || stopping.value) return;
    closed = true;
    children.delete(handle);
    ws?.close({ force: true });
    log("Feishu SDK event stream failed; restarting", error);
    setTimeout(() => {
      startSdkConsumers(config, handlers, children, stopping, log).catch((restartError) => {
        log("Feishu SDK event stream restart failed", restartError);
      });
    }, config.listenerRestartMs).unref();
  };

  const dispatcher = new sdk.EventDispatcher({
    loggerLevel: sdk.LoggerLevel.error,
  }).register(
    Object.fromEntries(
      Object.entries(handlers).map(([eventKey, onEvent]) => [
        eventKey,
        async (payload) => onEvent(normalizeMessageEvent(payload, eventKey)),
      ]),
    ),
  );
  ws = new sdk.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain: domainFor(sdk, config),
    loggerLevel: sdk.LoggerLevel.error,
    onError: restart,
  });
  ws.start({ eventDispatcher: dispatcher })
    .then(() => log("Feishu SDK event stream connected"))
    .catch(restart);
}

export async function registerFeishuApp(options) {
  const sdk = await loadSdk();
  return sdk.registerApp(options);
}
