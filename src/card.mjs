import path from "node:path";

const STATUS = {
  UserPromptSubmit: {
    label: "收到指令",
    template: "blue",
    icon: "myai_colorful",
  },
  PermissionRequest: {
    label: "等待授权",
    template: "yellow",
    icon: "warning_colorful",
  },
  Stop: {
    label: "本轮完成",
    template: "green",
    icon: "notice_colorful",
  },
};

function textValue(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function normalizeMarkdown(value, maxText) {
  let text = textValue(value, "这一阶段没有捕获到可展示的 Markdown 响应。").replace(
    /\r\n/g,
    "\n",
  );
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "**<font color='blue'>$1</font>**");
  text = text.replace(/^\s*---+\s*$/gm, "<hr>");
  if (text.length > maxText) {
    text = text.slice(0, Math.max(0, maxText - 80)) + "\n\n<font color='grey'>…内容已截断</font>";
  }
  return text.trim();
}

function projectName(cwd) {
  return cwd ? path.basename(cwd) || cwd : "未命名工作区";
}

export function buildStatusCard(config, event, session, response) {
  const info = STATUS[event.hook_event_name] || STATUS.UserPromptSubmit;
  const sessionId = textValue(event.session_id || session?.sessionId, "unknown");
  const title = projectName(event.cwd || session?.cwd) + " · " + info.label;
  const context = "Session：`" + sessionId.slice(0, 12) + "`";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: true,
    },
    header: {
      title: { tag: "plain_text", content: title.slice(0, 120) },
      template: info.template,
      icon: { tag: "standard_icon", token: info.icon },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "medium",
      elements: [
        {
          tag: "div",
          element_id: "context",
          fields: [
            {
              is_short: true,
              text: { tag: "lark_md", content: "**阶段**\n" + info.label },
            },
            {
              is_short: true,
              text: { tag: "lark_md", content: "**上下文**\n" + context },
            },
          ],
        },
        {
          tag: "markdown",
          element_id: "response",
          content: normalizeMarkdown(response, config.maxText),
        },
        {
          tag: "div",
          element_id: "hint",
          text: {
            tag: "lark_md",
            content:
              "<font color='grey'>可直接回复这张卡片，把追加指令发送回当前 Codex session。</font>",
          },
        },
      ],
    },
  };
}

export function buildNotifyStateCard(enabled, operatorName = "") {
  const label = enabled ? "通知已打开" : "通知已关闭";
  const operator = operatorName ? "\n\n操作者：`" + operatorName + "`" : "";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
    },
    header: {
      title: { tag: "plain_text", content: label },
      template: enabled ? "green" : "grey",
      icon: { tag: "standard_icon", token: "notice_colorful" },
    },
    body: {
      direction: "vertical",
      padding: "8px 12px 12px 12px",
      elements: [
        {
          tag: "markdown",
          content: "**" + label + "**" + operator,
        },
      ],
    },
  };
}
