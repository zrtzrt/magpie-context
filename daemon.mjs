// daemon.mjs - 实时同步与解析 Magpie 上下文透视数据 (直读 usage.jsonl 与各 Agent 真实会话)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "";

const USAGE_JSONL_PATH = path.join(HOME, ".config/magpie/usage.jsonl");
const SESSIONS_JSON_PATH = path.join(HOME, ".cache/magpie/sessions.json");
const APP_LOG_PATH = path.join(HOME, "Library/Logs/magpie/app.log");
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

function formatTime(ts) {
  if (!ts) return "";
  const dt = new Date(ts);
  if (isNaN(dt.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const dt = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now - dt) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const days = Math.floor(diffSec / 86400);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

// 内存中缓存实时拦截的会话转存
const liveGatewaySessions = new Map();

/**
 * 1. 读取 usage.jsonl 并构建请求索引
 */
function readUsageRequests() {
  const reqsBySession = new Map();
  const unlinkedRequests = [];

  if (!fs.existsSync(USAGE_JSONL_PATH)) return { reqsBySession, unlinkedRequests };

  try {
    const content = fs.readFileSync(USAGE_JSONL_PATH, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const sid = row.session || row.native_session;
        if (sid) {
          if (!reqsBySession.has(sid)) reqsBySession.set(sid, []);
          reqsBySession.get(sid).push(row);
        } else {
          unlinkedRequests.push(row);
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error("[Daemon] Error reading usage.jsonl:", e.message);
  }

  return { reqsBySession, unlinkedRequests };
}

/**
 * 2. 解析 Antigravity 真实会话
 */
function parseAntigravitySession(sessionId, cwd, title, start, last, meta, usageReqs = []) {
  const transcriptPath = path.join(HOME, `.gemini/antigravity/brain/${sessionId}/.system_generated/logs/transcript.jsonl`);
  const turns = [];
  let model = meta?.models?.[0]?.model || usageReqs[0]?.model || "gemini-3.8-flash";
  let totalInputTokens = meta?.input || 0;
  let totalOutputTokens = meta?.output || 0;
  let totalCacheRead = meta?.cache_read || 0;
  let cost = meta?.cost || 0;

  // 1. 如果有物理 transcript.jsonl，解析出精确的消息内容与轮次
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
            const sysTokens = 4500;
            const toolsTokens = 3200;

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

            if (curTurn.totalTokens - lastTokens > 15000) {
              curTurn.isBloat = true;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 2. 如果关联到了 usage.jsonl 请求，使用真实网关 tokens 校验并补充
  if (usageReqs.length > 0) {
    if (turns.length === 0) {
      let lastIn = 0;
      usageReqs.forEach((r, idx) => {
        const inTok = r.in || 0;
        const outTok = r.out || 0;
        const isComp = lastIn > 8000 && inTok < lastIn * 0.78;
        const delta = lastIn > 0 ? inTok - lastIn : inTok;

        turns.push({
          turnIdx: idx + 1,
          time: new Date(r.t).getTime(),
          timestamp: formatTime(r.t),
          userText: `网关调用 #${r.route_id || idx + 1}`,
          totalTokens: inTok,
          tokenDelta: delta,
          breakdown: {
            systemTokens: Math.min(inTok, 4500),
            toolsTokens: Math.min(Math.max(0, inTok - 4500), 3200),
            userTokens: Math.round(inTok * 0.15),
            assistantTokens: outTok,
            toolResultTokens: Math.max(0, inTok - 7700 - Math.round(inTok * 0.15))
          },
          isCompaction: isComp,
          isBloat: delta > 15000,
          cacheRead: r.cache_read || 0,
          messages: [
            {
              idx: 0,
              role: "user",
              tokens: inTok,
              chars: inTok * 3,
              snippet: `网关请求 Route #${r.route_id || idx + 1} (${r.model})`,
              fullText: `[网关请求 #${r.route_id}] 耗时: ${r.ms || 0}ms, 状态码: ${r.status || 200}`
            }
          ]
        });
        lastIn = inTok;
      });
    }
  }

  // 兜底轮次
  if (turns.length === 0) {
    const input = meta?.input || 12000;
    turns.push({
      turnIdx: 1,
      time: start ? new Date(start).getTime() : Date.now(),
      timestamp: formatTime(start),
      userText: title || "会话启动",
      totalTokens: input,
      breakdown: {
        systemTokens: 4500,
        toolsTokens: 3200,
        userTokens: Math.round(input * 0.2),
        assistantTokens: meta?.output || 500,
        toolResultTokens: Math.max(0, input - 7700 - Math.round(input * 0.2))
      },
      isCompaction: false,
      isBloat: false,
      messages: [{ idx: 0, role: "user", tokens: input, chars: input * 3, snippet: title, fullText: title }]
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
    model,
    modelLimit: limit,
    watermarkPercent: Math.min(100, Math.round((currentTokens / limit) * 100)),
    peakTokens,
    currentTokens,
    totalInputTokens: totalInputTokens || peakTokens,
    totalOutputTokens,
    totalCacheRead,
    cost: cost || 0,
    startTime: formatTime(start),
    lastTime: formatTime(last),
    timeAgo: timeAgo(last),
    turnsCount: turns.length,
    compactionCount: turns.filter(t => t.isCompaction).length,
    bloatCount: turns.filter(t => t.isBloat).length,
    turns
  };
}

/**
 * 3. 解析 DSH 真实会话
 */
function parseDshSession(filePath, meta, usageReqs = []) {
  const sid = meta?.id || path.basename(path.dirname(filePath));
  const cwd = meta?.cwd || "";
  const title = meta?.title || "DSH 会话";
  const start = meta?.start;
  const last = meta?.last;
  let model = meta?.models?.[0]?.model || meta?.model || usageReqs[0]?.model || "workbuddy/kimi-k3.1-pro";

  const turns = [];
  let compactionCount = 0;
  let bloatCount = 0;

  // 1. 如果有物理 zstd 会话，快速解压提取核心事件
  if (fs.existsSync(filePath)) {
    try {
      const cmd = `zstd -dc "${filePath}" 2>/dev/null | grep -E '"(turn/start|user/message|assistant/message|tool/call|tool/result|request/context|step/end)"' | head -n 300`;
      const out = execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      const lines = out.split("\n").filter(Boolean);

      let curTurn = null;
      let turnIdx = 0;
      let cumTokens = 0;
      let lastTotal = 0;
      const sysTokens = 3800;
      const toolsTokens = 2900;

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
              tokenDelta: lastTotal > 0 ? total - lastTotal : total,
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
    } catch (e) {}
  }

  // 2. 如果缺少物理轮次但有 usage.jsonl 请求，使用 usage.jsonl 构建演进曲线
  if (turns.length === 0 && usageReqs.length > 0) {
    let lastIn = 0;
    usageReqs.forEach((r, idx) => {
      const inTok = r.in || 0;
      const isComp = lastIn > 8000 && inTok < lastIn * 0.75;
      if (isComp) compactionCount++;
      const delta = lastIn > 0 ? inTok - lastIn : inTok;

      turns.push({
        turnIdx: idx + 1,
        time: new Date(r.t).getTime(),
        timestamp: formatTime(r.t),
        userText: `DSH 交互轮次 #${idx + 1}`,
        totalTokens: inTok,
        tokenDelta: delta,
        breakdown: {
          systemTokens: 3800,
          toolsTokens: 2900,
          userTokens: Math.round(inTok * 0.15),
          assistantTokens: r.out || 100,
          toolResultTokens: Math.max(0, inTok - 6700 - Math.round(inTok * 0.15))
        },
        isCompaction: isComp,
        isBloat: delta > 18000,
        messages: [
          {
            idx: 0,
            role: "user",
            tokens: inTok,
            chars: inTok * 3,
            snippet: `DSH 调用 (${r.model}) · ${inTok} tokens`,
            fullText: `[DSH 交互] Route #${r.route_id}, 状态: ${r.status || 200}`
          }
        ]
      });
      lastIn = inTok;
    });
  }

  // 兜底合成
  if (turns.length === 0) {
    const totalEst = meta?.size ? Math.round(meta.size * 0.4) : 8500;
    turns.push({
      turnIdx: 1,
      time: start ? new Date(start).getTime() : Date.now(),
      timestamp: formatTime(start),
      userText: title,
      totalTokens: totalEst,
      tokenDelta: totalEst,
      breakdown: {
        systemTokens: 3800,
        toolsTokens: 2900,
        userTokens: 800,
        assistantTokens: 1000,
        toolResultTokens: Math.max(0, totalEst - 8500)
      },
      isCompaction: false,
      isBloat: false,
      messages: [{ idx: 0, role: "user", tokens: 800, chars: 1200, snippet: title, fullText: title }]
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
    timeAgo: timeAgo(last),
    turnsCount: turns.length,
    compactionCount,
    bloatCount,
    turns
  };
}

/**
 * 4. 构建全量会话大盘数据
 */
export function buildContextDataset() {
  const sessions = [];

  // 读取 usage.jsonl
  const { reqsBySession, unlinkedRequests } = readUsageRequests();

  // 读取 sessions.json 索引
  if (fs.existsSync(SESSIONS_JSON_PATH)) {
    try {
      const raw = fs.readFileSync(SESSIONS_JSON_PATH, "utf8");
      const d = JSON.parse(raw);
      const files = d.files || {};

      for (const [fpath, meta] of Object.entries(files)) {
        const agent = meta.agent;
        const sid = meta.id;
        const matchedUsage = reqsBySession.get(sid) || [];

        if (agent === "antigravity") {
          sessions.push(parseAntigravitySession(meta.id, meta.cwd, meta.title, meta.start, meta.last, meta, matchedUsage));
        } else if (agent === "dsh") {
          // 采样最近 35 个活跃的 DSH 会话
          if (sessions.filter(s => s.agent === "dsh").length < 35) {
            sessions.push(parseDshSession(fpath, meta, matchedUsage));
          }
        }
      }
    } catch (e) {
      console.error("[Daemon] Error parsing sessions.json:", e.message);
    }
  }

  // 聚类 usage.jsonl 中未关联的活跃对话
  if (unlinkedRequests.length > 0) {
    const clusters = [];
    let currentCluster = null;
    let lastTime = 0;

    // 按时间顺序聚类
    for (const r of unlinkedRequests) {
      const t = new Date(r.t).getTime();
      const ag = r.agent || "default";
      const md = r.model || "unknown";

      if (currentCluster && currentCluster.agent === ag && currentCluster.model === md && (t - lastTime < 1800000)) {
        currentCluster.requests.push(r);
        lastTime = t;
      } else {
        if (currentCluster && currentCluster.requests.length >= 3) {
          clusters.push(currentCluster);
        }
        currentCluster = {
          agent: ag,
          model: md,
          start: r.t,
          requests: [r]
        };
        lastTime = t;
      }
    }
    if (currentCluster && currentCluster.requests.length >= 3) {
      clusters.push(currentCluster);
    }

    // 转化为会话对象
    clusters.slice(-15).forEach((c, idx) => {
      const first = c.requests[0];
      const last = c.requests[c.requests.length - 1];
      const sid = `usage-cluster-${idx}-${Date.now()}`;
      let lastIn = 0;
      let compactionCount = 0;
      let bloatCount = 0;

      const turns = c.requests.map((r, tIdx) => {
        const inTok = r.in || 0;
        const isComp = lastIn > 8000 && inTok < lastIn * 0.75;
        if (isComp) compactionCount++;
        const delta = lastIn > 0 ? inTok - lastIn : inTok;
        if (delta > 18000) bloatCount++;

        const turn = {
          turnIdx: tIdx + 1,
          time: new Date(r.t).getTime(),
          timestamp: formatTime(r.t),
          userText: `网关调用 #${r.route_id || tIdx + 1}`,
          totalTokens: inTok,
          tokenDelta: delta,
          breakdown: {
            systemTokens: Math.min(inTok, 3500),
            toolsTokens: Math.min(Math.max(0, inTok - 3500), 2500),
            userTokens: Math.round(inTok * 0.15),
            assistantTokens: r.out || 120,
            toolResultTokens: Math.max(0, inTok - 6000 - Math.round(inTok * 0.15))
          },
          isCompaction: isComp,
          isBloat: delta > 18000,
          cacheRead: r.cache_read || 0,
          messages: [
            {
              idx: 0,
              role: "user",
              tokens: inTok,
              chars: inTok * 3,
              snippet: `网关调用 #${r.route_id || tIdx + 1} (${r.model})`,
              fullText: `[网关调用] 状态: ${r.status || 200}, 耗时: ${r.ms || 0}ms, 出字: ${r.out || 0} tokens`
            }
          ]
        };
        lastIn = inTok;
        return turn;
      });

      const peakTokens = Math.max(...turns.map(t => t.totalTokens), 1000);
      const currentTokens = turns[turns.length - 1]?.totalTokens || peakTokens;
      const limit = getModelLimit(c.model);

      sessions.push({
        id: sid,
        name: `${c.agent.toUpperCase()} 网关交互 (${formatTime(c.start).slice(5, 16)})`,
        agent: c.agent,
        agentName: c.agent === "dsh" ? "DeepSeek Harness" : (c.agent === "antigravity" ? "Antigravity" : c.agent),
        agentIcon: `${c.agent}.svg`,
        cwd: "",
        model: c.model,
        modelLimit: limit,
        watermarkPercent: Math.min(100, Math.round((currentTokens / limit) * 100)),
        peakTokens,
        currentTokens,
        totalInputTokens: currentTokens,
        totalOutputTokens: c.requests.reduce((a, b) => a + (b.out || 0), 0),
        totalCacheRead: c.requests.reduce((a, b) => a + (b.cache_read || 0), 0),
        cost: 0,
        startTime: formatTime(c.start),
        lastTime: formatTime(last.t),
        timeAgo: timeAgo(last.t),
        turnsCount: turns.length,
        compactionCount,
        bloatCount,
        turns
      });
    });
  }

  // 排序
  sessions.sort((a, b) => {
    const ta = new Date(a.lastTime || 0).getTime();
    const tb = new Date(b.lastTime || 0).getTime();
    return tb - ta;
  });

  // 汇总各 Agent 会话数量
  const agentsSummary = {
    all: sessions.length,
    antigravity: sessions.filter(s => s.agent === "antigravity").length,
    dsh: sessions.filter(s => s.agent === "dsh").length,
    codex: sessions.filter(s => s.agent === "codex").length,
    other: sessions.filter(s => !["antigravity", "dsh", "codex"].includes(s.agent)).length
  };

  const totalSessions = sessions.length;
  const totalTurns = sessions.reduce((acc, s) => acc + s.turnsCount, 0);
  const totalCompactions = sessions.reduce((acc, s) => acc + s.compactionCount, 0);
  const maxWatermark = Math.max(...sessions.map(s => s.watermarkPercent), 0);
  const totalCacheRead = sessions.reduce((acc, s) => acc + (s.totalCacheRead || 0), 0);

  const summary = {
    totalSessions,
    totalTurns,
    totalCompactions,
    maxWatermark,
    totalCacheRead,
    agents: agentsSummary,
    updatedAt: formatTime(Date.now())
  };

  return { sessions, summary };
}

export function syncContextData() {
  try {
    const { sessions, summary } = buildContextDataset();
    const jsContent = `// context-data.js - 自动从 usage.jsonl 与真实会话构建\nwindow.CONTEXT_SUMMARY = ${JSON.stringify(summary, null, 2)};\nwindow.CONTEXT_SESSIONS = ${JSON.stringify(sessions, null, 2)};\n`;
    fs.writeFileSync(CONTEXT_DATA_JS_PATH, jsContent, "utf8");
    console.log(`[Daemon] Synced context-data.js: ${sessions.length} sessions, ${summary.totalTurns} turns (Agents: Antigravity=${summary.agents.antigravity}, DSH=${summary.agents.dsh}, Other=${summary.agents.other})`);
  } catch (e) {
    console.error("[Daemon] Error writing context-data.js:", e.message);
  }
}

console.log("[Daemon] Magpie Context Lens Daemon Starting...");
syncContextData();

// 每 3 秒检查一次 usage.jsonl 增量
setInterval(() => {
  syncContextData();
}, 3000);
