// daemon.mjs - 实时同步与解析 Magpie 上下文透视数据 (支持 Antigravity, DSH, Codex 与实时网关流量)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "";

const APP_LOG_PATH = path.join(HOME, "Library/Logs/magpie/app.log");
const USAGE_JSONL_PATH = path.join(HOME, ".config/magpie/usage.jsonl");
const SESSIONS_JSON_PATH = path.join(HOME, ".cache/magpie/sessions.json");
const CONTEXT_RECORDS_DIR = path.join(HOME, ".cache/magpie/context-records");

const CONTEXT_DATA_JS_PATH = path.join(__dirname, "page/context-data.js");

// 常用模型的默认上下文窗口大小 (Tokens)
const MODEL_LIMITS = {
  "gemini-3.8-flash": 1048576,
  "gemini-3.8-pro": 2097152,
  "gemini-2.5-flash": 1048576,
  "gemini-2.5-pro": 2097152,
  "deepseek-chat": 131072,
  "deepseek-v4": 131072,
  "deepseek-v4.1-flash": 131072,
  "claude-3-7-sonnet": 200000,
  "claude-3-5-sonnet": 200000,
  "gpt-5": 200000,
  "gpt-5.5": 200000,
  "default": 131072
};

function getModelLimit(model) {
  if (!model) return MODEL_LIMITS.default;
  const lower = model.toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
    if (lower.includes(key)) return limit;
  }
  if (lower.includes("gemini")) return 1048576;
  if (lower.includes("claude")) return 200000;
  if (lower.includes("deepseek")) return 131072;
  return MODEL_LIMITS.default;
}

/**
 * 估算文本 Token
 */
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== "string") text = JSON.stringify(text);
  let cjk = 0, ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.ceil(cjk * 1.25 + ascii * 0.28) || 1;
}

/**
 * 格式化时间戳
 */
function formatTime(ts) {
  if (!ts) return "";
  const dt = new Date(ts);
  if (isNaN(dt.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

// 内存中缓存实时拦截的会话转存
const liveGatewaySessions = new Map();

/**
 * 从 app.log 读取实时拦截的上下文记录
 */
let appLogLastSize = 0;
try {
  if (fs.existsSync(APP_LOG_PATH)) {
    appLogLastSize = fs.statSync(APP_LOG_PATH).size;
  }
} catch (e) {}

function checkAppLogRecords() {
  try {
    if (!fs.existsSync(APP_LOG_PATH)) return false;
    const stat = fs.statSync(APP_LOG_PATH);
    if (stat.size <= appLogLastSize) {
      if (stat.size < appLogLastSize) appLogLastSize = stat.size;
      return false;
    }

    const diff = stat.size - appLogLastSize;
    const fd = fs.openSync(APP_LOG_PATH, "r");
    const buf = Buffer.alloc(diff);
    fs.readSync(fd, buf, 0, diff, appLogLastSize);
    fs.closeSync(fd);
    appLogLastSize = stat.size;

    const lines = buf.toString("utf8").split("\n");
    let changed = false;

    for (const line of lines) {
      const tag = "[CONTEXT_RECORD]:";
      const idx = line.indexOf(tag);
      if (idx !== -1) {
        try {
          const item = JSON.parse(line.slice(idx + tag.length).trim());
          const sid = item.sessionId || "default";
          if (!liveGatewaySessions.has(sid)) {
            liveGatewaySessions.set(sid, []);
          }
          liveGatewaySessions.get(sid).push(item);
          changed = true;
        } catch (e) {}
      }
    }
    return changed;
  } catch (e) {
    return false;
  }
}

/**
 * 解析 Antigravity 会话详情与轮次
 */
function parseAntigravitySession(sessionId, cwd, title, start, last, meta) {
  const transcriptPath = path.join(HOME, `.gemini/antigravity/brain/${sessionId}/.system_generated/logs/transcript.jsonl`);
  const turns = [];
  let model = meta?.models?.[0]?.model || "gemini-3.8-flash";
  let totalInputTokens = meta?.input || 0;
  let totalOutputTokens = meta?.output || 0;
  let totalCacheRead = meta?.cache_read || 0;

  if (fs.existsSync(transcriptPath)) {
    try {
      const raw = fs.readFileSync(transcriptPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      let curTurn = null;
      let turnIdx = 0;
      let cumTokens = 0;
      let lastTokens = 0;

      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          const stype = step.type;

          if (stype === "USER_INPUT") {
            turnIdx++;
            const uText = step.content || "";
            const uTokens = estimateTokens(uText);
            const sysTokens = 4500; // Antigravity 预估系统提示词基数
            const toolsTokens = 3200; // 预置工具定义基数

            cumTokens += uTokens;
            curTurn = {
              turnIdx,
              time: step.created_at ? new Date(step.created_at).getTime() : Date.now(),
              timestamp: formatTime(step.created_at),
              userText: uText.slice(0, 160),
              totalTokens: sysTokens + toolsTokens + cumTokens,
              breakdown: {
                systemTokens: sysTokens,
                toolsTokens: toolsTokens,
                userTokens: uTokens,
                assistantTokens: 0,
                toolResultTokens: Math.max(0, cumTokens - uTokens)
              },
              isCompaction: false,
              isBloat: false,
              messages: [
                {
                  idx: 0,
                  role: "user",
                  tokens: uTokens,
                  chars: uText.length,
                  snippet: uText.slice(0, 200),
                  fullText: uText.length > 4000 ? uText.slice(0, 4000) + "\n... [超长文本已截断显示]" : uText
                }
              ]
            };
            turns.push(curTurn);
            lastTokens = curTurn.totalTokens;
          } else if (stype === "PLANNER_RESPONSE" && curTurn) {
            const respText = step.content || "";
            const toolCalls = (step.tool_calls || []).map(tc => tc.ToolName || tc.toolSummary || "tool");
            const rTokens = estimateTokens(respText);
            cumTokens += rTokens;

            curTurn.breakdown.assistantTokens += rTokens;
            curTurn.totalTokens += rTokens;

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "assistant",
              tokens: rTokens,
              chars: respText.length,
              toolCalls: toolCalls,
              snippet: respText.slice(0, 200) || (toolCalls.length ? `[调用工具: ${toolCalls.join(", ")}]` : ""),
              fullText: respText.length > 4000 ? respText.slice(0, 4000) + "\n... [超长文本已截断显示]" : respText
            });

            // 检查是否有大体量输出导致的膨胀
            if (curTurn.totalTokens - lastTokens > 15000) {
              curTurn.isBloat = true;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 若无转储文件，根据元数据生成合成演进点
  if (turns.length === 0) {
    const input = meta?.input || 12000;
    const sys = 5000;
    const tools = 3500;
    const hist = Math.max(0, input - sys - tools);
    turns.push({
      turnIdx: 1,
      time: start ? new Date(start).getTime() : Date.now(),
      timestamp: formatTime(start),
      userText: title || "会话启动",
      totalTokens: input,
      breakdown: {
        systemTokens: sys,
        toolsTokens: tools,
        userTokens: Math.round(hist * 0.3),
        assistantTokens: meta?.output || 500,
        toolResultTokens: Math.round(hist * 0.7)
      },
      isCompaction: false,
      isBloat: false,
      messages: [
        {
          idx: 0,
          role: "user",
          tokens: Math.round(hist * 0.3),
          chars: Math.round(hist * 1.2),
          snippet: title || "用户对话",
          fullText: title || "用户对话"
        }
      ]
    });
  }

  const peakTokens = Math.max(...turns.map(t => t.totalTokens), meta?.input || 0);
  const currentTokens = turns[turns.length - 1]?.totalTokens || peakTokens;
  const limit = getModelLimit(model);

  return {
    id: sessionId,
    name: title || `Antigravity 会话 ${sessionId.slice(0, 8)}`,
    agent: "antigravity",
    agentName: "Antigravity",
    agentIcon: "antigravity.svg",
    cwd: cwd || "",
    model: model,
    modelLimit: limit,
    watermarkPercent: Math.min(100, Math.round((currentTokens / limit) * 100)),
    peakTokens,
    currentTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    cost: meta?.cost || 0,
    startTime: formatTime(start),
    lastTime: formatTime(last),
    turnsCount: turns.length,
    compactionCount: turns.filter(t => t.isCompaction).length,
    bloatCount: turns.filter(t => t.isBloat).length,
    turns
  };
}

/**
 * 解析 DSH (DeepSeek Harness) 会话文件
 */
function parseDshSession(filePath, meta) {
  const sid = meta?.id || path.basename(path.dirname(filePath));
  const cwd = meta?.cwd || "";
  const title = meta?.title || "DSH 会话";
  const start = meta?.start;
  const last = meta?.last;
  let model = meta?.models?.[0]?.model || meta?.model || "workbuddy/kimi-k3.1-pro";

  const turns = [];
  let compactionCount = 0;
  let bloatCount = 0;

  try {
    if (fs.existsSync(filePath)) {
      // 通过 zstd 快速解压并按行提取核心事件
      const cmd = `zstd -dc "${filePath}" 2>/dev/null | grep -E '"(turn/start|user/message|assistant/message|tool/call|tool/result|request/context|step/end)"' | head -n 300`;
      const out = execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      const lines = out.split("\n").filter(Boolean);

      let curTurn = null;
      let turnIdx = 0;
      let cumTokens = 0;
      let lastTotal = 0;
      const sysTokens = 3800; // DSH OSWYN 系统提示词基数
      const toolsTokens = 2900; // DSH 内置 tools 定义基数

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          const type = ev.type;

          if (type === "request/context" && ev.data?.model) {
            model = ev.data.model;
          }

          if (type === "user/message") {
            turnIdx++;
            const uText = ev.data?.content || ev.data?.message?.content || "";
            const str = typeof uText === "string" ? uText : JSON.stringify(uText);
            const uTokens = estimateTokens(str);
            cumTokens += uTokens;

            const total = sysTokens + toolsTokens + cumTokens;
            const isCompaction = lastTotal > 10000 && total < lastTotal * 0.75;
            if (isCompaction) compactionCount++;

            curTurn = {
              turnIdx,
              time: ev.time || Date.now(),
              timestamp: formatTime(ev.time),
              userText: str.slice(0, 160),
              totalTokens: total,
              breakdown: {
                systemTokens: sysTokens,
                toolsTokens: toolsTokens,
                userTokens: uTokens,
                assistantTokens: 0,
                toolResultTokens: Math.max(0, cumTokens - uTokens)
              },
              isCompaction,
              isBloat: false,
              messages: [
                {
                  idx: 0,
                  role: "user",
                  tokens: uTokens,
                  chars: str.length,
                  snippet: str.slice(0, 200),
                  fullText: str.length > 4000 ? str.slice(0, 4000) + "\n... [超长文本已截断显示]" : str
                }
              ]
            };

            if (lastTotal > 0 && total - lastTotal > 18000) {
              curTurn.isBloat = true;
              bloatCount++;
            }

            turns.push(curTurn);
            lastTotal = total;
          } else if (type === "assistant/message" && curTurn) {
            const msg = ev.data?.message || {};
            let aText = "";
            let toolCalls = [];

            if (typeof msg.content === "string") {
              aText = msg.content;
            } else if (Array.isArray(msg.content)) {
              for (const p of msg.content) {
                if (p.type === "text") aText += (aText ? "\n" : "") + p.text;
                if (p.type === "tool-call") toolCalls.push(p.name || "tool");
              }
            }

            const aTokens = estimateTokens(aText);
            cumTokens += aTokens;
            curTurn.breakdown.assistantTokens += aTokens;
            curTurn.totalTokens += aTokens;

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "assistant",
              tokens: aTokens,
              chars: aText.length,
              toolCalls,
              snippet: aText.slice(0, 200) || (toolCalls.length ? `[工具调用: ${toolCalls.join(", ")}]` : ""),
              fullText: aText.length > 4000 ? aText.slice(0, 4000) + "\n... [超长文本已截断显示]" : aText
            });
          } else if (type === "tool/result" && curTurn) {
            const res = ev.data?.message?.content || "";
            const str = typeof res === "string" ? res : JSON.stringify(res);
            const rTokens = estimateTokens(str);
            cumTokens += rTokens;
            curTurn.breakdown.toolResultTokens += rTokens;
            curTurn.totalTokens += rTokens;

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "tool",
              tokens: rTokens,
              chars: str.length,
              snippet: str.slice(0, 200),
              fullText: str.length > 4000 ? str.slice(0, 4000) + "\n... [超长文本已截断显示]" : str
            });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  // 兜底合成
  if (turns.length === 0) {
    const totalEst = meta?.size ? Math.round(meta.size * 0.4) : 8500;
    turns.push({
      turnIdx: 1,
      time: start ? new Date(start).getTime() : Date.now(),
      timestamp: formatTime(start),
      userText: title,
      totalTokens: totalEst,
      breakdown: {
        systemTokens: 3800,
        toolsTokens: 2900,
        userTokens: 800,
        assistantTokens: 1000,
        toolResultTokens: Math.max(0, totalEst - 8500)
      },
      isCompaction: false,
      isBloat: false,
      messages: [
        {
          idx: 0,
          role: "user",
          tokens: 800,
          chars: 1200,
          snippet: title,
          fullText: title
        }
      ]
    });
  }

  const peakTokens = Math.max(...turns.map(t => t.totalTokens));
  const currentTokens = turns[turns.length - 1]?.totalTokens || peakTokens;
  const limit = getModelLimit(model);

  return {
    id: sid,
    name: title || `DSH 会话 ${sid.slice(0, 8)}`,
    agent: "dsh",
    agentName: "DeepSeek Harness",
    agentIcon: "deepseek.svg",
    cwd,
    model,
    modelLimit: limit,
    watermarkPercent: Math.min(100, Math.round((currentTokens / limit) * 100)),
    peakTokens,
    currentTokens,
    totalInputTokens: meta?.msg_use?.input || peakTokens,
    totalOutputTokens: meta?.msg_use?.output || 1200,
    totalCacheRead: meta?.msg_use?.cache_read || 0,
    cost: meta?.cost || 0,
    startTime: formatTime(start),
    lastTime: formatTime(last),
    turnsCount: turns.length,
    compactionCount,
    bloatCount,
    turns
  };
}

/**
 * 解析 Codex 会话文件
 */
function parseCodexSession(filePath, meta) {
  const sid = meta?.id || path.basename(filePath, ".jsonl");
  const cwd = meta?.cwd || "";
  const title = meta?.title || "Codex 会话";
  const start = meta?.start;
  const last = meta?.last;
  const model = meta?.models?.[0]?.model || meta?.model || "gpt-5.5";

  const turns = [];
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      let turnIdx = 0;
      let cumTokens = 0;

      for (const line of lines.slice(0, 100)) {
        try {
          const item = JSON.parse(line);
          if (item.role === "user" || item.type === "user") {
            turnIdx++;
            const txt = item.content || item.text || "";
            const str = typeof txt === "string" ? txt : JSON.stringify(txt);
            const uTokens = estimateTokens(str);
            cumTokens += uTokens;

            turns.push({
              turnIdx,
              time: item.timestamp || Date.now(),
              timestamp: formatTime(item.timestamp),
              userText: str.slice(0, 160),
              totalTokens: 6000 + cumTokens,
              breakdown: {
                systemTokens: 3500,
                toolsTokens: 2500,
                userTokens: uTokens,
                assistantTokens: 0,
                toolResultTokens: Math.max(0, cumTokens - uTokens)
              },
              isCompaction: false,
              isBloat: false,
              messages: [
                {
                  idx: 0,
                  role: "user",
                  tokens: uTokens,
                  chars: str.length,
                  snippet: str.slice(0, 200),
                  fullText: str.length > 4000 ? str.slice(0, 4000) + "\n... [超长文本已截断显示]" : str
                }
              ]
            });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  if (turns.length === 0) {
    turns.push({
      turnIdx: 1,
      time: start ? new Date(start).getTime() : Date.now(),
      timestamp: formatTime(start),
      userText: title,
      totalTokens: 14500,
      breakdown: { systemTokens: 3500, toolsTokens: 2500, userTokens: 1500, assistantTokens: 2000, toolResultTokens: 5000 },
      isCompaction: false,
      isBloat: false,
      messages: [{ idx: 0, role: "user", tokens: 1500, chars: 2000, snippet: title, fullText: title }]
    });
  }

  const peakTokens = Math.max(...turns.map(t => t.totalTokens));
  const currentTokens = turns[turns.length - 1]?.totalTokens || peakTokens;
  const limit = getModelLimit(model);

  return {
    id: sid,
    name: title || `Codex 会话 ${sid.slice(0, 8)}`,
    agent: "codex",
    agentName: "Codex",
    agentIcon: "codex.svg",
    cwd,
    model,
    modelLimit: limit,
    watermarkPercent: Math.min(100, Math.round((currentTokens / limit) * 100)),
    peakTokens,
    currentTokens,
    totalInputTokens: peakTokens,
    totalOutputTokens: 1500,
    totalCacheRead: 0,
    cost: meta?.cost || 0,
    startTime: formatTime(start),
    lastTime: formatTime(last),
    turnsCount: turns.length,
    compactionCount: 0,
    bloatCount: 0,
    turns
  };
}

/**
 * 整合所有会话并构建全局视图
 */
export function buildContextDataset() {
  const sessions = [];

  // 1. 读取 Magpie 官方维护的 sessions.json 索引
  if (fs.existsSync(SESSIONS_JSON_PATH)) {
    try {
      const raw = fs.readFileSync(SESSIONS_JSON_PATH, "utf8");
      const d = JSON.parse(raw);
      const files = d.files || {};

      for (const [fpath, meta] of Object.entries(files)) {
        const agent = meta.agent;
        if (agent === "antigravity") {
          sessions.push(parseAntigravitySession(meta.id, meta.cwd, meta.title, meta.start, meta.last, meta));
        } else if (agent === "dsh") {
          // 仅采样最近 20 个活跃的 DSH 会话，防止数据集过大卡顿
          if (sessions.filter(s => s.agent === "dsh").length < 20) {
            sessions.push(parseDshSession(fpath, meta));
          }
        } else if (agent === "codex") {
          sessions.push(parseCodexSession(fpath, meta));
        }
      }
    } catch (e) {
      console.error("[Daemon] Error parsing sessions.json:", e.message);
    }
  }

  // 2. 合并通过 Gateway 中间件拦截到的实时活跃会话
  for (const [sid, records] of liveGatewaySessions.entries()) {
    if (!records || records.length === 0) continue;
    const latest = records[records.length - 1];
    const client = latest.client || "default";
    const model = latest.model || "unknown";
    const limit = getModelLimit(model);

    const turns = records.map((r, idx) => ({
      turnIdx: idx + 1,
      time: r.time,
      timestamp: r.timestamp,
      userText: r.messages?.find(m => m.role === "user")?.snippet || "用户请求",
      totalTokens: r.totalTokens,
      breakdown: r.breakdown,
      isCompaction: !!r.isCompaction,
      isBloat: r.tokenDelta > 18000,
      messages: r.messages || []
    }));

    const peakTokens = Math.max(...turns.map(t => t.totalTokens));
    const currentTokens = turns[turns.length - 1]?.totalTokens || peakTokens;

    // 检查是否已有同 ID 会话，有则合并升级
    const existingIdx = sessions.findIndex(s => s.id === sid);
    const item = {
      id: sid,
      name: `[实时] ${client.toUpperCase()} 会话 (${latest.timestamp})`,
      agent: client,
      agentName: client === "antigravity" ? "Antigravity" : (client === "dsh" ? "DeepSeek Harness" : client),
      agentIcon: `${client}.svg`,
      cwd: "",
      model,
      modelLimit: limit,
      watermarkPercent: Math.min(100, Math.round((currentTokens / limit) * 100)),
      peakTokens,
      currentTokens,
      totalInputTokens: currentTokens,
      totalOutputTokens: 2000,
      totalCacheRead: 0,
      cost: 0,
      startTime: records[0].timestamp,
      lastTime: latest.timestamp,
      turnsCount: turns.length,
      compactionCount: turns.filter(t => t.isCompaction).length,
      bloatCount: turns.filter(t => t.isBloat).length,
      turns
    };

    if (existingIdx !== -1) {
      sessions[existingIdx] = item;
    } else {
      sessions.unshift(item);
    }
  }

  // 按最后更新时间降序排列
  sessions.sort((a, b) => {
    const ta = new Date(a.lastTime || 0).getTime();
    const tb = new Date(b.lastTime || 0).getTime();
    return tb - ta;
  });

  // 全局汇总统计 (KPI Summary)
  const totalSessions = sessions.length;
  const totalTurns = sessions.reduce((acc, s) => acc + s.turnsCount, 0);
  const totalCompactions = sessions.reduce((acc, s) => acc + s.compactionCount, 0);
  const maxWatermark = Math.max(...sessions.map(s => s.watermarkPercent), 0);
  const totalCost = sessions.reduce((acc, s) => acc + (s.cost || 0), 0);

  const summary = {
    totalSessions,
    totalTurns,
    totalCompactions,
    maxWatermark,
    totalCost: totalCost.toFixed(4),
    updatedAt: formatTime(Date.now())
  };

  return { sessions, summary };
}

/**
 * 将数据写入静态 context-data.js 供插件页面直读
 */
export function syncContextData() {
  try {
    const { sessions, summary } = buildContextDataset();
    const jsContent = `// context-data.js - 自动生成的上下文监控数据 (最新 ${sessions.length} 个会话)\nwindow.CONTEXT_SUMMARY = ${JSON.stringify(summary, null, 2)};\nwindow.CONTEXT_SESSIONS = ${JSON.stringify(sessions, null, 2)};\n`;
    fs.writeFileSync(CONTEXT_DATA_JS_PATH, jsContent, "utf8");
    console.log(`[Daemon] Updated context-data.js with ${sessions.length} sessions, ${summary.totalTurns} turns.`);
  } catch (e) {
    console.error("[Daemon] Error writing context-data.js:", e.message);
  }
}

console.log("[Daemon] Magpie Context Lens Daemon Starting...");
checkAppLogRecords();
syncContextData();

// 每 2 秒检查一次实时日志与网关调用
setInterval(() => {
  const updated = checkAppLogRecords();
  if (updated) {
    syncContextData();
  }
}, 2000);

// 每 30 秒全量刷新一次本地历史会话
setInterval(() => {
  syncContextData();
}, 30_000);
