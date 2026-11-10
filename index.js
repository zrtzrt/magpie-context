// index.js - Magpie Gateway Middleware: 会话内容透视与上下文演进追踪 (对标 dsh-context)

/**
 * 估算字符串的 Token 数量（兼顾中英文与代码）
 */
export function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(text);
    } catch (e) {
      return 0;
    }
  }

  // 统计 CJK 汉字与非 CJK 字符
  let cjkCount = 0;
  let asciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjkCount++;
    } else {
      asciiCount++;
    }
  }
  // 经验公式：中文约 1.2 token/字，英文代码约 0.28 token/char (约 3.5 char/token)
  const est = Math.ceil(cjkCount * 1.25 + asciiCount * 0.28);
  return est || 1;
}

/**
 * 提取纯文本内容
 */
function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "tool_result" || part.type === "tool-result") {
          return extractText(part.content || part.text || "");
        }
        if (part.text) return String(part.text);
        if (part.content) return extractText(part.content);
        return "";
      })
      .join("\n");
  }
  if (typeof content === "object") {
    return content.text || content.content || JSON.stringify(content);
  }
  return String(content);
}

/**
 * 识别请求所属的客户端
 */
function identifyClient(ctx, body) {
  if (ctx && ctx.agent) return ctx.agent.toLowerCase();

  // 从 system 或 messages 中特征嗅探
  let sysText = "";
  if (typeof body?.system === "string") sysText = body.system;
  else if (Array.isArray(body?.system)) sysText = body.system.map(s => s.text || "").join(" ");
  else if (Array.isArray(body?.messages)) {
    const s = body.messages.find(m => m && m.role === "system");
    if (s) sysText = typeof s.content === "string" ? s.content : JSON.stringify(s.content);
  }

  const lower = (sysText || "").toLowerCase();
  if (lower.includes("deepseek harness") || lower.includes("dsh-oswyn") || lower.includes("我是dsh")) return "dsh";
  if (lower.includes("antigravity") || lower.includes("google deepmind")) return "antigravity";
  if (lower.includes("claude code") || lower.includes("claude-code")) return "claude";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("workbuddy")) return "workbuddy-ai";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("cline")) return "cline";

  return "default";
}

/**
 * 提取或生成稳定的会话标识
 */
function extractSessionId(ctx, body, client) {
  // 1. 请求头显式透传
  const headers = ctx?.headers || {};
  const headerId = headers["x-session-id"] || headers["x-conversation-id"] || headers["session-id"];
  if (headerId) return String(headerId);

  // 2. Body 内的元数据
  if (body?.metadata?.session_id) return String(body.metadata.session_id);
  if (body?.session_id) return String(body.session_id);

  // 3. 基于首条用户消息内容生成会话特征哈希
  let firstUserMsg = "";
  if (Array.isArray(body?.messages)) {
    const u = body.messages.find(m => m && m.role === "user");
    if (u) firstUserMsg = extractText(u.content).slice(0, 100);
  }
  if (firstUserMsg) {
    let hash = 0;
    const str = client + ":" + firstUserMsg.trim();
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return `sess-${client}-${Math.abs(hash).toString(36)}`;
  }

  return `sess-${client}-live`;
}

// 缓存上一次各会话的 Token 数量，用于检测压缩（Compaction）
const lastSessionTokens = new Map();

/**
 * 分析当前请求的上下文构成 (Composition Breakdown)
 */
export function analyzeContext(body, ctx) {
  const result = {
    system: { chars: 0, tokens: 0, count: 0, preview: "" },
    tools: { chars: 0, tokens: 0, count: 0, names: [] },
    user: { chars: 0, tokens: 0, count: 0, preview: "" },
    assistant: { chars: 0, tokens: 0, count: 0, preview: "" },
    toolResults: { chars: 0, tokens: 0, count: 0, topTools: [] },
    totalChars: 0,
    totalTokens: 0,
    messagesCount: 0,
    messagesList: []
  };

  if (!body) return result;

  // 1. 系统提示词 (System Prompt)
  let sysText = "";
  if (typeof body.system === "string") {
    sysText = body.system;
    result.system.count = 1;
  } else if (Array.isArray(body.system)) {
    sysText = body.system.map(p => (p && p.text) || "").join("\n");
    result.system.count = body.system.length;
  }

  // 2. 工具定义 (Tools Schemas)
  if (Array.isArray(body.tools)) {
    result.tools.count = body.tools.length;
    result.tools.names = body.tools.map(t => t.function?.name || t.name || "unnamed").slice(0, 20);
    const toolsStr = JSON.stringify(body.tools);
    result.tools.chars = toolsStr.length;
    result.tools.tokens = estimateTokens(toolsStr);
  }

  // 3. 逐条消息分析 (Messages)
  if (Array.isArray(body.messages)) {
    result.messagesCount = body.messages.length;

    body.messages.forEach((msg, idx) => {
      if (!msg) return;
      const role = msg.role || "unknown";
      const rawText = extractText(msg.content);
      const chars = rawText.length;
      const tokens = estimateTokens(rawText);

      // 提取 tool_calls 声明
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.map(tc => tc.function?.name || tc.name).filter(Boolean)
        : [];

      // 记录消息摘要项供前端透视
      result.messagesList.push({
        idx,
        role,
        chars,
        tokens,
        toolCalls,
        name: msg.name || "",
        snippet: rawText.slice(0, 160) + (rawText.length > 160 ? "..." : ""),
        fullText: rawText
      });

      if (role === "system") {
        sysText += (sysText ? "\n\n" : "") + rawText;
        result.system.count++;
      } else if (role === "user") {
        result.user.chars += chars;
        result.user.tokens += tokens;
        result.user.count++;
        if (!result.user.preview) result.user.preview = rawText.slice(0, 100);
      } else if (role === "assistant") {
        result.assistant.chars += chars;
        result.assistant.tokens += tokens;
        result.assistant.count++;
        if (!result.assistant.preview) result.assistant.preview = rawText.slice(0, 100);
      } else if (role === "tool" || role === "tool_result") {
        result.toolResults.chars += chars;
        result.toolResults.tokens += tokens;
        result.toolResults.count++;
        if (msg.name && !result.toolResults.topTools.includes(msg.name)) {
          result.toolResults.topTools.push(msg.name);
        }
      }
    });
  }

  if (sysText) {
    result.system.chars = sysText.length;
    result.system.tokens = estimateTokens(sysText);
    result.system.preview = sysText.slice(0, 120);
  }

  result.totalChars = result.system.chars + result.tools.chars + result.user.chars + result.assistant.chars + result.toolResults.chars;
  result.totalTokens = result.system.tokens + result.tools.tokens + result.user.tokens + result.assistant.tokens + result.toolResults.tokens;

  return result;
}

/**
 * Magpie Gateway Request Hook
 */
export function onRequest(body, ctx) {
  if (!body || (!body.messages && !body.system)) return body;

  try {
    const client = identifyClient(ctx, body);
    const sessionId = extractSessionId(ctx, body, client);
    const model = (ctx && ctx.model) || (body && body.model) || "unknown";
    const provider = (ctx && ctx.provider) || "default";

    const analysis = analyzeContext(body, ctx);
    const currentTokens = analysis.totalTokens;

    // 压缩事件（Compaction）检测：如果 token 比上一轮显著减少 > 20% 且上一轮基数较大
    const lastTokens = lastSessionTokens.get(sessionId) || 0;
    const isCompaction = lastTokens > 8000 && currentTokens < lastTokens * 0.78;
    const tokenDelta = currentTokens - lastTokens;
    lastSessionTokens.set(sessionId, currentTokens);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const formattedTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const turnRecord = {
      id: "ctx-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sessionId,
      client,
      model,
      provider,
      timestamp: formattedTime,
      time: Date.now(),
      totalTokens: currentTokens,
      totalChars: analysis.totalChars,
      tokenDelta: lastTokens > 0 ? tokenDelta : 0,
      isCompaction,
      breakdown: {
        systemTokens: analysis.system.tokens,
        toolsTokens: analysis.tools.tokens,
        userTokens: analysis.user.tokens,
        assistantTokens: analysis.assistant.tokens,
        toolResultTokens: analysis.toolResults.tokens
      },
      compositionPercent: {
        system: currentTokens ? Math.round((analysis.system.tokens / currentTokens) * 100) : 0,
        tools: currentTokens ? Math.round((analysis.tools.tokens / currentTokens) * 100) : 0,
        user: currentTokens ? Math.round((analysis.user.tokens / currentTokens) * 100) : 0,
        assistant: currentTokens ? Math.round((analysis.assistant.tokens / currentTokens) * 100) : 0,
        toolResults: currentTokens ? Math.round((analysis.toolResults.tokens / currentTokens) * 100) : 0
      },
      messagesCount: analysis.messagesCount,
      messages: analysis.messagesList
    };

    // 1. 控制台输出标准日志，供 daemon 实时捕获并同步至页面
    if (typeof console !== "undefined" && console.error) {
      console.error("[CONTEXT_RECORD]:" + JSON.stringify(turnRecord));
    }
  } catch (err) {
    if (typeof console !== "undefined" && console.error) {
      console.error("[Context Lens Middleware Error]:", err?.message || String(err));
    }
  }

  return body;
}

export default {
  id: "context",
  server: () => ({})
};
