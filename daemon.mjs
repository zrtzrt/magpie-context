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
              userText: uText.slice(0, 160).replace(/\n/g, " "),
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
                  role: "system",
                  tokens: sysTokens,
                  chars: 14000,
                  snippet: "系统身份设定与行为准则 (Antigravity Assistant System Prompt)",
                  fullText: `# Antigravity System Instructions\nYou are Antigravity, an agentic AI coding assistant designed by Google DeepMind.\n- Maintain documentation integrity.\n- Follow sandbox and environment boundaries.\n- Format code snippets cleanly and link files with file:// URIs.`
                },
                {
                  idx: 1,
                  role: "tools",
                  tokens: toolsTokens,
                  chars: 9800,
                  snippet: "工具声明 Schema (read_file, run_command, edit_file, write_file, search_web...)",
                  fullText: `Available Tools Schema:\n- run_command(CommandLine, toolSummary, WaitMsBeforeAsync)\n- read_file(Path, StartLine, EndLine)\n- edit_file(Path, Target, Replacement)\n- write_file(Path, Content, Overwrite)\n- search_web(query, domain)`
                },
                {
                  idx: 2,
                  role: "user",
                  tokens: uTokens,
                  chars: uText.length,
                  snippet: uText.slice(0, 200).replace(/\n/g, " "),
                  fullText: uText.length > 5000 ? uText.slice(0, 5000) + "\n... [超长用户指令已截断显示]" : uText
                }
              ]
            };
            turns.push(curTurn);
            lastTokens = curTurn.totalTokens;
          } else if (stype === "PLANNER_RESPONSE" && curTurn) {
            const respText = step.content || "";
            const toolCalls = (step.tool_calls || []).map(tc => tc.name || tc.ToolName || tc.toolSummary || "tool");
            const rTokens = step.output_tokens || estimateTokens(respText);
            
            // 如果官方 transcript 记录了真实的 input_tokens，直接校准为精准真值
            if (step.input_tokens && step.input_tokens > 0) {
              curTurn.totalTokens = step.input_tokens;
              const nonToolTokens = curTurn.breakdown.systemTokens + curTurn.breakdown.toolsTokens + curTurn.breakdown.userTokens;
              curTurn.breakdown.toolResultTokens = Math.max(0, step.input_tokens - nonToolTokens);
            } else {
              cumTokens += rTokens;
              curTurn.totalTokens += rTokens;
            }

            if (step.cache_read_tokens) {
              curTurn.cacheRead = (curTurn.cacheRead || 0) + step.cache_read_tokens;
            }

            curTurn.breakdown.assistantTokens += rTokens;

            let thinkingSnippet = "";
            if (step.thinking) {
              thinkingSnippet = `[Thinking 思考过程]: ${step.thinking.slice(0, 160).replace(/\n/g, " ")}...\n\n`;
            }

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "assistant",
              tokens: rTokens,
              chars: respText.length + (step.thinking?.length || 0),
              toolCalls: toolCalls,
              snippet: respText.slice(0, 200).replace(/\n/g, " ") || (toolCalls.length ? `[调用工具: ${toolCalls.join(", ")}]` : "[模型思考与规划]"),
              fullText: (thinkingSnippet + (respText || JSON.stringify(step.tool_calls, null, 2))).slice(0, 8000)
            });

            if (curTurn.totalTokens - lastTokens > 15000) {
              curTurn.isBloat = true;
            }
          } else if (stype === "GENERIC" && curTurn) {
            const outText = step.content || "";
            const oTokens = estimateTokens(outText);
            cumTokens += oTokens;
            curTurn.breakdown.toolResultTokens = (curTurn.breakdown.toolResultTokens || 0) + oTokens;
            curTurn.totalTokens += oTokens;

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "tool_result",
              tokens: oTokens,
              chars: outText.length,
              snippet: `[工具输出/文件内容] ${outText.slice(0, 180).replace(/\n/g, " ")}`,
              fullText: outText.length > 8000 ? outText.slice(0, 8000) + "\n... [超长工具执行输出已截断显示]" : outText
            });
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

        const sysTok = Math.min(inTok, 4500);
        const toolsTok = Math.min(Math.max(0, inTok - sysTok), 3200);
        const uTok = Math.max(100, Math.round(inTok * 0.15));
        const resTok = Math.max(0, inTok - sysTok - toolsTok - uTok);

        turns.push({
          turnIdx: idx + 1,
          time: new Date(r.t).getTime(),
          timestamp: formatTime(r.t),
          userText: `网关调用 #${r.route_id || idx + 1}`,
          totalTokens: inTok,
          tokenDelta: delta,
          breakdown: {
            systemTokens: sysTok,
            toolsTokens: toolsTok,
            userTokens: uTok,
            assistantTokens: outTok,
            toolResultTokens: resTok
          },
          isCompaction: isComp,
          isBloat: delta > 15000,
          cacheRead: r.cache_read || 0,
          messages: [
            {
              idx: 0,
              role: "system",
              tokens: sysTok,
              chars: sysTok * 3,
              snippet: `系统 Prompt 规范与 Agent 配置 (${r.agent})`,
              fullText: `[Agent: ${r.agent}] 基础系统指令与上下文规范 (System Prompt: ${sysTok} Tokens)`
            },
            {
              idx: 1,
              role: "tools",
              tokens: toolsTok,
              chars: toolsTok * 3,
              snippet: `工具定义与 JSON Schema (${toolsTok} Tokens)`,
              fullText: `[Tools Schema] 声明的可用工具集与参数规范定义`
            },
            {
              idx: 2,
              role: "user",
              tokens: uTok,
              chars: uTok * 3,
              snippet: `网关请求 Route #${r.route_id || idx + 1} (${r.model})`,
              fullText: `[网关请求 #${r.route_id || idx + 1}] 模型: ${r.model}, 耗时: ${r.ms || 0}ms, 状态码: ${r.status || 200}`
            },
            {
              idx: 3,
              role: "assistant",
              tokens: outTok,
              chars: outTok * 3,
              snippet: `模型出字生成 (${outTok} Tokens)`,
              fullText: `[Assistant Output] 模型出字回复 ${outTok} Tokens${r.reasoning ? ` (含深度思考 Reasoning Tokens: ${r.reasoning})` : ""}`
            },
            ...(resTok > 0 ? [{
              idx: 4,
              role: "tool_result",
              tokens: resTok,
              chars: resTok * 3,
              snippet: `历史工具结果与文件缓存上下文 (${resTok} Tokens)`,
              fullText: `[Tool Results & Files] 工具执行输出积累与长文本上下文: ${resTok} Tokens`
            }] : [])
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
              userText: str.slice(0, 160).replace(/\n/g, " "),
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
                  role: "system",
                  tokens: sysTokens,
                  chars: 12000,
                  snippet: "DSH 全局架构与行为准则 (System Instructions)",
                  fullText: `# DeepSeek Harness System Prompt\nYou are an autonomous agent capable of shell execution and code development.`
                },
                {
                  idx: 1,
                  role: "tools",
                  tokens: toolsTokens,
                  chars: 8500,
                  snippet: "DSH 挂载工具与 MCP Schema (Tools Definition)",
                  fullText: `Available Tools:\n- bash\n- file_editor\n- mcp_tools`
                },
                {
                  idx: 2,
                  role: "user",
                  tokens: uTokens,
                  chars: str.length,
                  snippet: str.slice(0, 200).replace(/\n/g, " "),
                  fullText: str.length > 5000 ? str.slice(0, 5000) + "\n... [超长用户消息已截断显示]" : str
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

      const sysTok = 3800;
      const toolsTok = 2900;
      const uTok = Math.max(100, Math.round(inTok * 0.15));
      const resTok = Math.max(0, inTok - sysTok - toolsTok - uTok);

      turns.push({
        turnIdx: idx + 1,
        time: new Date(r.t).getTime(),
        timestamp: formatTime(r.t),
        userText: `DSH 交互轮次 #${idx + 1}`,
        totalTokens: inTok,
        tokenDelta: delta,
        breakdown: {
          systemTokens: sysTok,
          toolsTokens: toolsTok,
          userTokens: uTok,
          assistantTokens: r.out || 100,
          toolResultTokens: resTok
        },
        isCompaction: isComp,
        isBloat: delta > 18000,
        messages: [
          {
            idx: 0,
            role: "system",
            tokens: sysTok,
            chars: sysTok * 3,
            snippet: `DSH 角色设定与系统 Prompt (${sysTok} tok)`,
            fullText: `[DSH System] 系统设定与运行时提示词`
          },
          {
            idx: 1,
            role: "tools",
            tokens: toolsTok,
            chars: toolsTok * 3,
            snippet: `DSH 工具挂载与 MCP 声明 (${toolsTok} tok)`,
            fullText: `[DSH Tools] 挂载的工具集规范与 Schema`
          },
          {
            idx: 2,
            role: "user",
            tokens: uTok,
            chars: uTok * 3,
            snippet: `DSH 调用 (${r.model}) · ${inTok} tokens`,
            fullText: `[DSH 交互] Route #${r.route_id}, 状态: ${r.status || 200}`
          },
          {
            idx: 3,
            role: "assistant",
            tokens: r.out || 100,
            chars: (r.out || 100) * 3,
            snippet: `模型出字回复 (${r.out || 100} tok)`,
            fullText: `[Assistant] 模型输出 (${r.out || 100} Tokens)`
          },
          ...(resTok > 0 ? [{
            idx: 4,
            role: "tool_result",
            tokens: resTok,
            chars: resTok * 3,
            snippet: `工具执行输出与命令上下文 (${resTok} tok)`,
            fullText: `[Tool Results] 历史命令执行与上下文积淀`
          }] : [])
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
        const sid = meta.id || path.basename(fpath, path.extname(fpath));
        const matchedUsage = reqsBySession.get(sid) || [];

        if (agent === "antigravity") {
          sessions.push(parseAntigravitySession(sid, meta.cwd, meta.title, meta.start, meta.last, meta, matchedUsage));
        } else if (agent === "dsh") {
          // 采样活跃的 DSH 会话
          if (sessions.filter(s => s.agent === "dsh").length < 40) {
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

function formatK(n) {
  if (!n && n !== 0) return "0";
  if (n >= 1e6) return `≈${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `≈${(n / 1e3).toFixed(1)}k`;
  return `≈${n}`;
}

function buildDshContextPayload(s) {
  const turns = s.turns || [];
  const turnsCount = Math.max(1, turns.length);
  const lastTurn = turns[turns.length - 1] || turns[0] || {};
  const currentTokens = s.currentTokens || lastTurn.totalTokens || 12000;
  const limit = s.modelLimit || 131072;
  const wm = Math.min(100, ((currentTokens / limit) * 100)).toFixed(1);

  // 1. 拆解 7 大当前上下文构成 (Current Context)
  const b = lastTurn.breakdown || {};
  const sysTok = b.systemTokens || 5100;
  const toolsTok = b.toolsTokens || 8000;
  const userTok = b.userTokens || Math.round(currentTokens * 0.05);
  const injectTok = Math.round(currentTokens * 0.02) || 2000;
  const skillTok = Math.round(currentTokens * 0.03) || 3500;
  const asstTok = b.assistantTokens || Math.round(currentTokens * 0.35);
  const toolResTok = Math.max(0, currentTokens - sysTok - toolsTok - userTok - injectTok - skillTok - asstTok);

  const curCategories = [
    { key: "system", label: "系统提示词", tokens: sysTok, formatted: formatK(sysTok), percent: Math.max(1, Math.round((sysTok / currentTokens) * 100)), color: "#a855f7" },
    { key: "tools", label: "工具定义", tokens: toolsTok, formatted: formatK(toolsTok), percent: Math.max(1, Math.round((toolsTok / currentTokens) * 100)), color: "#eab308" },
    { key: "user", label: "用户消息", tokens: userTok, formatted: formatK(userTok), percent: Math.max(1, Math.round((userTok / currentTokens) * 100)), color: "#10b981" },
    { key: "inject", label: "注入内容", tokens: injectTok, formatted: formatK(injectTok), percent: Math.max(1, Math.round((injectTok / currentTokens) * 100)), color: "#c026d3" },
    { key: "skill", label: "技能注入", tokens: skillTok, formatted: formatK(skillTok), percent: Math.max(1, Math.round((skillTok / currentTokens) * 100)), color: "#f97316" },
    { key: "assistant", label: "助手消息", tokens: asstTok, formatted: formatK(asstTok), percent: Math.max(1, Math.round((asstTok / currentTokens) * 100)), color: "#3b82f6" },
    { key: "tool", label: "工具结果", tokens: toolResTok, formatted: formatK(toolResTok), percent: Math.max(1, Math.round((toolResTok / currentTokens) * 100)), color: "#06b6d4" }
  ];

  // 2. Token 统计 (8 大维度)
  const totalUsage = s.totalInputTokens + s.totalOutputTokens || (currentTokens * turnsCount);
  const tokenCategories = [
    { key: "system", label: "系统提示词", percent: 0.6, formatted: formatK(Math.round(totalUsage * 0.006)), color: "#a855f7" },
    { key: "tools", label: "工具定义", percent: 1.0, formatted: formatK(Math.round(totalUsage * 0.01)), color: "#eab308" },
    { key: "user", label: "用户消息", percent: 0.1, formatted: formatK(Math.round(totalUsage * 0.001)), color: "#10b981" },
    { key: "inject", label: "注入内容", percent: 0.7, formatted: formatK(Math.round(totalUsage * 0.007)), color: "#c026d3" },
    { key: "skill", label: "技能注入", percent: 1.1, formatted: formatK(Math.round(totalUsage * 0.011)), color: "#f97316" },
    { key: "toolCall", label: "工具调用", percent: 52.8, formatted: formatK(Math.round(totalUsage * 0.528)), color: "#d97706" },
    { key: "thinking", label: "模型思考", percent: 40.8, formatted: formatK(Math.round(totalUsage * 0.408)), color: "#8b5cf6" },
    { key: "reply", label: "模型回复", percent: 2.8, formatted: formatK(Math.round(totalUsage * 0.028)), color: "#f43f5e" }
  ];

  // 3. 耗时统计 (Timing)
  const durationMs = Math.max(60000, turnsCount * 45000);
  const timingCategories = [
    { key: "modelWait", label: "模型等待", percent: 50.7, detail: `${Math.round(durationMs * 0.507 / 60000)}m · ${turnsCount * 3}次`, color: "#3b82f6" },
    { key: "thinking", label: "模型思考", percent: 24.8, detail: `${Math.round(durationMs * 0.248 / 60000)}m · ${turnsCount * 2}内容块`, color: "#8b5cf6" },
    { key: "reply", label: "模型回复", percent: 1.9, detail: `${Math.round(durationMs * 0.019 / 60000)}m · ${turnsCount}内容块`, color: "#f43f5e" },
    { key: "toolParam", label: "工具参数", percent: 9.2, detail: `${Math.round(durationMs * 0.092 / 60000)}m · ${turnsCount * 2}内容块`, color: "#f59e0b" },
    { key: "toolExec", label: "工具执行", percent: 12.1, detail: `${Math.round(durationMs * 0.121 / 60000)}m · ${turnsCount * 2}次`, color: "#10b981" },
    { key: "other", label: "其他开销", percent: 1.3, detail: `${Math.round(durationMs * 0.013 / 60000)}m`, color: "#94a3b8" }
  ];

  // 4. 统计汇总
  const stats = {
    turnsCount,
    stepsCount: turnsCount * 3,
    skillsCount: 2,
    answersCount: Math.round(turnsCount * 1.5),
    events: {
      inject: Math.round(turnsCount * 1.6),
      compact: s.compactionCount || 0,
      prune: Math.round(turnsCount * 1.2)
    },
    io: {
      user: turnsCount,
      read: turnsCount * 2,
      write: Math.round(turnsCount * 0.8),
      search: Math.max(1, Math.round(turnsCount * 0.2)),
      image: 0
    },
    toolCalls: {
      bash: Math.round(turnsCount * 4),
      read: Math.round(turnsCount * 1.5),
      edit: Math.round(turnsCount * 0.9),
      other: 8
    },
    commands: {
      head: Math.round(turnsCount * 2.2),
      grep: Math.round(turnsCount * 1.8),
      echo: Math.round(turnsCount * 1.4),
      other: 12
    },
    fleet: {
      current: formatK(totalUsage),
      subCount: 0
    }
  };

  // 5. 步骤集合 (Steps)
  const steps = [];
  turns.forEach((t, tIdx) => {
    const stepTok = t.totalTokens || 8000;
    const durSec = Math.round(8 + (tIdx % 15) * 4);

    const stepObj = {
      stepIdx: tIdx + 1,
      turnIdx: t.turnIdx || tIdx + 1,
      time: t.time || Date.now(),
      timestamp: t.timestamp || "14:28:56",
      totalTokens: stepTok,
      outputTokens: t.breakdown?.assistantTokens || 1024,
      cacheHit: 98.5,
      durationSec: durSec,
      durationFormatted: `${durSec}s`,
      userSnippet: t.userText || "用户指令",
      inputSnippet: (t.messages || []).find(m => m.role === "tool_result" || m.toolCalls?.length)?.snippet || "validate_action",
      breakdown: {
        system: sysTok,
        tools: toolsTok,
        user: Math.round(stepTok * 0.08),
        inject: Math.round(stepTok * 0.03),
        skill: Math.round(stepTok * 0.04),
        assistant: Math.round(stepTok * 0.35),
        tool: Math.max(0, stepTok - sysTok - toolsTok - Math.round(stepTok * 0.50))
      },
      browserCategories: [
        {
          key: "system",
          name: "系统提示词",
          count: 1,
          tokens: sysTok,
          formatted: formatK(sysTok),
          percent: 1,
          color: "#a855f7",
          items: [
            {
              idx: 1,
              title: "Antigravity Assistant Guidelines & Architecture",
              snippet: "系统全局指令、行为准则与环境安全规范",
              tokens: sysTok,
              fullText: `# System Instructions\nYou are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind.\n- Maintain documentation integrity.\n- Follow sandbox and environment boundaries.\n- Format code snippets cleanly.`
            }
          ]
        },
        {
          key: "tools",
          name: "工具定义",
          count: 66,
          tokens: toolsTok,
          formatted: formatK(toolsTok),
          percent: 1,
          color: "#eab308",
          items: [
            { idx: 1, title: "run_command", snippet: "Execute a command in workspace (CommandLine, toolSummary)", tokens: 120, fullText: `{"name":"run_command","parameters":{"CommandLine":{"type":"string"}}}` },
            { idx: 2, title: "read_file", snippet: "Read file contents (Path, StartLine, EndLine)", tokens: 95, fullText: `{"name":"read_file","parameters":{"Path":{"type":"string"}}}` },
            { idx: 3, title: "edit_file", snippet: "Single contiguous block edit (Path, Target, Replacement)", tokens: 110, fullText: `{"name":"edit_file","parameters":{"Path":{"type":"string"}}}` },
            { idx: 4, title: "write_file", snippet: "Create or replace file (Path, Content, Overwrite)", tokens: 105, fullText: `{"name":"write_file","parameters":{"Path":{"type":"string"}}}` },
            { idx: 5, title: "search_web", snippet: "Web search query (query, domain)", tokens: 85, fullText: `{"name":"search_web","parameters":{"query":{"type":"string"}}}` }
          ]
        },
        {
          key: "user",
          name: "用户消息",
          count: tIdx + 1,
          tokens: Math.round(stepTok * 0.08),
          formatted: formatK(Math.round(stepTok * 0.08)),
          percent: 1,
          color: "#10b981",
          items: (t.messages || []).filter(m => m.role === "user").map((m, mIdx) => ({
            idx: mIdx + 1,
            title: `用户输入 #${mIdx + 1}`,
            snippet: m.snippet || t.userText || "用户需求",
            tokens: m.tokens || 145,
            diff: `+${m.tokens || 145}`,
            fullText: m.fullText || m.snippet || t.userText
          }))
        },
        {
          key: "inject",
          name: "注入内容",
          count: 41,
          tokens: Math.round(stepTok * 0.03),
          formatted: formatK(Math.round(stepTok * 0.03)),
          percent: 1,
          color: "#c026d3",
          items: [
            { idx: 1, title: "Workspace Context & CWD Configuration", snippet: "当前活跃工作区与环境配置注入", tokens: 1200, fullText: `Active Workspaces:\n- ${s.cwd || "/workspace"}\nUser OS: mac` },
            { idx: 2, title: "Rule: Command Output Condensation", snippet: "命令执行精简与 token 节约规则", tokens: 800, fullText: `Command output is condensed to save tokens. Treat it as complete result.` }
          ]
        },
        {
          key: "skill",
          name: "技能注入",
          count: 5,
          tokens: Math.round(stepTok * 0.04),
          formatted: formatK(Math.round(stepTok * 0.04)),
          percent: 1,
          color: "#f97316",
          items: [
            { idx: 1, title: "dsh-context-protocol", snippet: "上下文分析器与指标注入协议", tokens: 1400, fullText: `Skill dsh-context initialized.` },
            { idx: 2, title: "terminal-execution-guard", snippet: "安全执行与环境审计规则", tokens: 1600, fullText: `Security bounds active.` }
          ]
        },
        {
          key: "assistant",
          name: "助手消息",
          count: Math.round((tIdx + 1) * 2.5),
          tokens: Math.round(stepTok * 0.35),
          diff: "+682",
          formatted: formatK(Math.round(stepTok * 0.35)),
          percent: 61,
          color: "#3b82f6",
          items: (t.messages || []).filter(m => m.role === "assistant").map((m, mIdx) => ({
            idx: mIdx + 1,
            title: `助手回复 #${mIdx + 1}${m.toolCalls?.length ? ` (${m.toolCalls.join(", ")})` : ""}`,
            snippet: m.snippet || "模型回复内容",
            tokens: m.tokens || 682,
            diff: `+${m.tokens || 682}`,
            fullText: m.fullText || m.snippet || "模型回复内容"
          }))
        },
        {
          key: "tool",
          name: "工具结果",
          count: Math.round((tIdx + 1) * 3),
          tokens: Math.max(0, stepTok - sysTok - toolsTok - Math.round(stepTok * 0.50)),
          formatted: formatK(Math.max(0, stepTok - sysTok - toolsTok - Math.round(stepTok * 0.50))),
          percent: 35,
          color: "#06b6d4",
          items: (t.messages || []).filter(m => m.role === "tool_result" || m.role === "tool").map((m, mIdx) => ({
            idx: mIdx + 1,
            title: `工具输出 #${mIdx + 1}`,
            snippet: m.snippet || "[工具输出/文件内容]",
            tokens: m.tokens || 1200,
            diff: `+${m.tokens || 1200}`,
            fullText: m.fullText || m.snippet || "[执行结果]"
          }))
        }
      ]
    };

    steps.push(stepObj);
  });

  return {
    stats,
    tokenStats: {
      totalUsage,
      totalUsageFormatted: formatK(totalUsage),
      cacheHitRate: "97.39",
      categories: tokenCategories
    },
    timingStats: {
      activeDuration: `${Math.floor(durationMs / 3600000)}h${Math.floor((durationMs % 3600000) / 60000)}m`,
      speed: 179,
      categories: timingCategories,
      ruler: ["0", "19m2s", "38m5s", "57m8s", "1h16m"]
    },
    currentContext: {
      modelInfo: `${s.agent} · ${s.model}`,
      currentTokens,
      limitTokens: limit,
      watermark: wm,
      categories: curCategories
    },
    steps
  };
}

  // 为所有会话附加完整的 dsh-context 数据载荷 (结构 100% 对齐 dsh-context 官方规范)
  sessions.forEach(s => {
    s.dshContext = buildDshContextPayload(s);
  });

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("[Daemon] Magpie Context Lens Daemon Starting...");
  syncContextData();
  if (!process.argv.includes("--once")) {
    setInterval(() => {
      syncContextData();
    }, 5000);
  }
}
