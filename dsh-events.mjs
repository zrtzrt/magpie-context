/**
 * dsh-events.mjs — DSH 会话事件流折叠器 (真实数据源, 零伪造)
 * ============================================================================
 * 唯一数据来源: ~/.dsh/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd
 * (zstd 压缩的 JSONL 事件流, node:zlib 的 zstdDecompressSync 直接解压, 无外部命令)
 *
 * 设计原则
 * ---------
 * 1. **全部指标来自事件流**, 不含任何常量/比例/随机/时间兜底; 缺数据就返回 0 或空数组。
 * 2. 口径对齐官方 dsh-context v0.84.0 (见 lib/index.d.ts 与 /tmp/parity/off-index.pretty.mjs):
 *    - token 估算器 = ceil(len/4)+4 (官方 ne/re/E/fe/me, off-index.pretty.mjs:49-90),
 *      不是 daemon.mjs 原来的 cjk*1.25+ascii*0.28 —— 换成官方口径才能与 dsh-context 同量纲。
 *    - steps = 每条 assistant/message 计 1 步 (官方 un() :1232-1234, 调用点 :2033)
 *      → 因此本模块保证 stats.stepsCount === steps.length (唯一真源)。
 *    - turns = 按 data.turn 变号计数 (官方 pn() :1241-1245 / tn() :1187-1190 / Rn() :1524-1531)
 *    - injects = 注入事件条数 (官方 dn() :1235-1237), skills = 去重技能名集合 (mn()/Ln() :1246-1253,1518-1523)
 *    - answers = 含 text 块的 assistant 消息数 (官方 :2055)
 *    - current 7 分类 = systemTokens + toolsTokens + sums{user,inject,skill,assistant,tool}
 *      (官方 Nn() :1436-1437) → 因此 sum(curCategories.tokens) === currentTokens。
 *    - timing 全部来自 step/start|end、assistant/message.stream 的 dt 数组、tool 调用与结果的真实时间差
 *      (官方 :1879-1919, :2016-2062), 不做百分比摊派。
 * 3. 文件活动 / 命令执行 的**聚合**由 dsh-fileops.mjs (agent-6) 负责; 本模块只把事件流归一化成
 *    契约要求的 toolEvents / jobEvents (见 /tmp/dshctx-ref/FILEOPS-CONTRACT.md) 再调用它。
 *    若 dsh-fileops.mjs 尚未就绪, 明确降级为空数组并在 sessionMeta.fileOpsPending 标注, 绝不造假。
 * 4. 确定性: 不使用 Date.now()/Math.random(); 同一文件多次 fold 结果完全一致。
 *
 * 事件 → 指标 映射表 (全部实测于 279 个真实会话)
 * ----------------------------------------------
 * turn/start              → turns 边界 (data.turn)
 * turn/end                → turn 时长 (data.reason.kind)
 * step/start              → step 起点, TTFT 基准, wallMs 基准
 * step/end                → wallMs += end-start, 步骤耗时
 * user/message            → surface(user), humanInputs; source.kind!=='user' → inject 事件
 * developer/message       → inject 事件 (tool-addition 等)
 * agent/inbox/spliced     → inject 事件 (运行时插入的消息)
 * assistant/message       → steps++/turns/answers, usage(input/output/cacheRead/cacheWrite),
 *                           stream dt → reasoning/text/toolArg 耗时, 首块时间 → TTFT
 * tool/call               → 工具调用开始 (name/arguments/turn/step)
 * tool/result             → 工具结果 (content/isError/meta), 工具耗时, fileOps 输入
 * tool/ptc-dispatch-start → PTC 程序内嵌套调用开始 (rootCallId/parentCallId/subCallId)
 * tool/ptc-dispatch       → 嵌套调用结果 (content/isError/meta/arguments)
 * job/registered|settled  → bash 真实墙钟 startedAt/finishedAt/status/detail
 * request/header          → toolsTokens (tools schema 真实估算), provider/model/maxOutputTokens
 * request/context         → contextWindow (真实窗口), model, provider
 * system/message          → systemTokens (系统提示词真实估算)
 * compaction/summary|prune→ compaction / prune 事件 (shadowedTokenCount/shadowedSeqs)
 * plan/mode               → mode 事件
 * model/selection|request/header(reason=change|resume) → model 事件
 * permission/preset|sandbox/mode|approval/policy|team/mode → mode 事件
 * subagent/catalog        → 子 Agent 目录
 * session/title           → 会话标题
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// 文件活动 / 命令执行 聚合 (agent-6, 纯函数无依赖): 见 /tmp/dshctx-ref/FILEOPS-CONTRACT.md
import * as dshFileOpsModule from "./dsh-fileops.mjs";

export const DSH_EVENTS_VERSION = 1;

/** 官方 bounds (lib/index.d.ts:492-505 DEFAULT_BOUNDS) */
export const DSH_EVENT_BOUNDS = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxFileOps: 400,
  maxCommands: 400,
  maxCommandChars: 4096,
  maxBrowserItems: 40,
  maxStepToolNames: 24
};

// 7 大当前上下文分类 (顺序/配色与官方 Context 卡片一致)
export const CONTEXT_CATEGORY_META = [
  { key: "system", label: "系统提示词", color: "#a855f7" },
  { key: "tools", label: "工具定义", color: "#eab308" },
  { key: "user", label: "用户消息", color: "#10b981" },
  { key: "inject", label: "注入内容", color: "#c026d3" },
  { key: "skill", label: "技能注入", color: "#f97316" },
  { key: "assistant", label: "助手消息", color: "#3b82f6" },
  { key: "tool", label: "工具结果", color: "#06b6d4" }
];

// 8 大 Token 统计分类 (官方 Token Stats 卡片)
export const TOKEN_CATEGORY_META = [
  { key: "system", label: "系统提示词", color: "#a855f7" },
  { key: "tools", label: "工具定义", color: "#eab308" },
  { key: "user", label: "用户消息", color: "#10b981" },
  { key: "inject", label: "注入内容", color: "#c026d3" },
  { key: "skill", label: "技能注入", color: "#f97316" },
  { key: "toolCall", label: "工具调用", color: "#d97706" },
  { key: "thinking", label: "模型思考", color: "#8b5cf6" },
  { key: "reply", label: "模型回复", color: "#f43f5e" }
];

// 6 大耗时统计分类 (官方 Timing Stats 卡片; 官方 TimingSpan.kind = ttft|reasoning|text|toolarg|tools|other)
export const TIMING_CATEGORY_META = [
  { key: "modelWait", label: "模型等待", color: "#3b82f6" },
  { key: "thinking", label: "模型思考", color: "#8b5cf6" },
  { key: "reply", label: "模型回复", color: "#f43f5e" },
  { key: "toolParam", label: "工具参数", color: "#f59e0b" },
  { key: "toolExec", label: "工具执行", color: "#10b981" },
  { key: "other", label: "其他开销", color: "#94a3b8" }
];

// ============================================================================
// 0. 官方口径的 token 估算器 (off-index.pretty.mjs:49-90)
//    官方: ne(s)=ceil(len/4)+4; E(blocks)=ceil(sum(len)/4)+4; fe(tools)=ceil(JSON/4)+4;
//          me(toolCall)=ceil(name/4)+ceil(args/4)+4; pe(block)=re(block.text||'')
//    说明: 这是 DSH 内置 Token 计量器的固定密度启发式 (README 注意事项: "各类别数值采用 dsh 自身的
//    固定密度启发式算法"), 服务商只回报聚合 usage, 无法拆到分类, 因此分类必须估算。
// ============================================================================

/** 官方 ne/re: 文本 → token 估算 (空串为 0) */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4) + 4;
}

/** 官方 E: 内容块数组 → token 估算 (逐块累加字符数后 ceil/4+4) */
export function estimateBlocksTokens(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  let chars = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      chars += 4;
      continue;
    }
    switch (block.type) {
      case "text":
      case "reasoning":
        chars += typeof block.text === "string" ? block.text.length : 0;
        break;
      case "tool-call":
        chars += (block.name || "").length + (block.arguments || "").length;
        break;
      case "image":
        chars += JSON.stringify(block).length;
        break;
      default:
        try {
          chars += JSON.stringify(block).length;
        } catch {
          chars += 0;
        }
    }
  }
  return Math.ceil(chars / 4) + 4;
}

/** 官方 ge(): 单个内容块 → token 估算 (逐块 ceil/4+4) */
export function estimateBlockTokens(block) {
  if (!block || typeof block !== "object") return 4;
  switch (block.type) {
    case "text":
    case "reasoning":
      return estimateTextTokens(typeof block.text === "string" ? block.text : "");
    case "tool-call":
      return Math.ceil((block.name || "").length / 4) + Math.ceil((block.arguments || "").length / 4) + 4;
    case "image":
      try {
        return Math.ceil(JSON.stringify(block).length / 4) + 4;
      } catch {
        return 4;
      }
    default:
      try {
        return 4 + Math.ceil(JSON.stringify(block).length / 4);
      } catch {
        return 4;
      }
  }
}

/**
 * 官方 be(): 一条消息 → surface 节点 token (逐块估算后 +4)
 * @param {object} message 消息对象
 * @param {boolean} emptyWhenEmpty 内容为空时返回 0 (官方对 assistant/developer 消息的特殊处理)
 */
export function estimateMessageSurfaceTokens(message, emptyWhenEmpty = false) {
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (emptyWhenEmpty && (content === null || content.length === 0)) return 0;
  let total = 0;
  for (const block of content || []) total += estimateBlockTokens(block);
  return total + 4;
}

/** 官方 fe: 工具 schema 数组 → token 估算 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    return Math.ceil(JSON.stringify(tools).length / 4) + 4;
  } catch {
    return 0;
  }
}

/** 官方 me: 单个 tool-call → token 估算 */
export function estimateToolCallTokens(name, argsText) {
  return Math.ceil((name || "").length / 4) + Math.ceil((argsText || "").length / 4) + 4;
}

/** 官方 pe: 单个文本块 → token 估算 */
export function estimateTextBlockTokens(block) {
  return estimateTextTokens(block && typeof block.text === "string" ? block.text : "");
}

/** 官方 Ve: 行数 (结尾有 \n 不额外 +1) */
export function countTextLines(text) {
  if (typeof text !== "string" || text === "") return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) newlines += 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

// ============================================================================
// 1. 格式化工具 (与 page/app.js 的消费口径一致)
// ============================================================================

export function formatK(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0";
  if (num >= 1e6) return "≈" + (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return "≈" + (num / 1e3).toFixed(1) + "k";
  return "≈" + Math.round(num);
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 毫秒时间戳 → "HH:MM:SS" (本地时区, 与 page 的 time 字段一致) */
export function formatClock(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

/** 毫秒时间戳 → "YYYY-MM-DD HH:MM:SS" */
export function formatDateTime(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + formatClock(ms)
  );
}

/** 毫秒 → "1h2m" / "12m" (timingStats.activeDuration 口径) */
export function formatDurationHm(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  return h + "h" + m + "m";
}

/** 秒 → "12s" / "1m2s" (steps[].durationFormatted 口径) */
export function formatDurationSeconds(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  if (total < 60) return total + "s";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + "m" + s + "s";
}

// ============================================================================
// 2. 参数解析 / 归一化
// ============================================================================

/** tool/call 的 arguments 是 JSON 字符串, ptc-dispatch 的 arguments 是对象 */
export function parseToolArguments(raw) {
  if (raw === null || raw === undefined) return { args: {}, argText: "" };
  if (typeof raw === "string") {
    const text = raw;
    try {
      const parsed = JSON.parse(text);
      return { args: parsed && typeof parsed === "object" ? parsed : {}, argText: text };
    } catch {
      return { args: {}, argText: text };
    }
  }
  if (typeof raw === "object") {
    try {
      return { args: raw, argText: JSON.stringify(raw) };
    } catch {
      return { args: raw, argText: "" };
    }
  }
  return { args: {}, argText: "" };
}

/** 取内容块数组的纯文本 (工具结果正文) */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") out += (out ? "\n" : "") + block.text;
  }
  return out;
}

/** 取内容块数组里第一段非空 text (step brief / snippet 用) */
function firstTextBlock(blocks, maxLen = 160) {
  if (!Array.isArray(blocks)) return "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      return block.text.replace(/\s+/g, " ").trim().slice(0, maxLen);
    }
  }
  return "";
}

/** 从 source 里提取可读名称 (官方 Te, :152-159 的简化版) */
function sourceName(source) {
  if (!source || typeof source !== "object") return "";
  if (typeof source.name === "string" && source.name !== "") return source.name;
  if (source.kind === "agent-instructions" && Array.isArray(source.changes)) {
    const paths = [];
    for (const change of source.changes) {
      const p = change && change.path;
      if (typeof p === "string" && p !== "" && !paths.includes(p)) paths.push(p);
    }
    if (paths.length > 0) return paths.join(", ");
  }
  if (typeof source.plugin === "string" && source.plugin !== "") return source.plugin;
  if (typeof source.tool === "string" && source.tool !== "") return source.tool;
  return typeof source.kind === "string" ? source.kind : "";
}

/** 官方 Ee(source): 是否属于"注入"来源 (非用户手动输入) */
function isInjectSource(source) {
  if (!source || typeof source !== "object") return false;
  const kind = source.kind;
  if (typeof kind !== "string" || kind === "") return false;
  return kind !== "user";
}

// ============================================================================
// 3. 事件分类常量
// ============================================================================

/** 官方 Un() (:1557-1562): 消息 → surface 分类 */
function messageCategory(eventType, message) {
  if (eventType === "assistant/message") return "assistant";
  if (eventType === "tool/result") return "tool";
  if (eventType === "developer/message") return "inject";
  const kind = message && message.source && message.source.kind;
  if (kind === "skill-invocation" || kind === "skill-catalog") return "skill";
  if (isInjectSource(message && message.source)) return "inject";
  return "user";
}

/** 官方 Xe(): 会产生 CommandRecord 的工具 → 命令工具名 */
function commandToolOf(name) {
  if (name === "bash") return "bash";
  if (name === "pwsh") return "pwsh";
  if (name === "run_code") return "run_code";
  return null;
}

/** 官方 Fe/Le (:238-244): 工具 → 文件操作类别 */
const FILE_OP_KIND = {
  read: "read",
  read_image: "read",
  write: "write",
  edit: "write",
  grep: "search",
  glob: "search"
};

// 包装器命令 (官方 it, :437): 程序名解析时跳过
const SHELL_WRAPPERS = new Set([
  "env", "sudo", "doas", "command", "exec", "time", "nohup", "nice", "stdbuf", "timeout", "caffeinate",
  "noglob", "nocorrect"
]);
// shell 关键字 (官方 st, :439)
const SHELL_KEYWORDS = new Set([
  "[", "[[", "for", "if", "while", "until", "case", "do", "then", "else", "elif", "function", "select",
  "coproc", "done", "fi", "esac"
]);
// 声明类 (官方 ct, :439)
const SHELL_DECLARATIONS = new Set(["export", "local", "declare", "readonly", "typeset"]);

/**
 * 命令 → 程序名 (官方 jt/Mt/Ot :880-911 的等价实现)
 * 规则: 按 && / ; / || / 换行 切子命令; 跳过 cd 子命令; 剥离 env/sudo/timeout 等包装器与变量赋值;
 *       取首个词的文件名部分。run_code 直接返回 "run_code"。
 */
export function deriveProgram(cmd, tool) {
  if (tool === "run_code") return "run_code";
  const raw = typeof cmd === "string" ? cmd : "";
  if (raw.trim() === "") return tool === "pwsh" ? "pwsh" : "shell";
  const segments = raw.split(/&&|\|\||;|\n/);
  const programs = [];
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    let skipNext = false;
    while (index < tokens.length) {
      const token = tokens[index];
      if (skipNext) {
        skipNext = false;
        index += 1;
        continue;
      }
      // 变量赋值 PREFIX=value
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      // 声明类: export FOO=1 -> 跳过
      if (SHELL_DECLARATIONS.has(token)) {
        index += 1;
        continue;
      }
      // shell 关键字: 跳过自身, 继续找下一个可执行
      if (SHELL_KEYWORDS.has(token)) {
        index += 1;
        continue;
      }
      // 包装器: 跳到它之后
      if (SHELL_WRAPPERS.has(token)) {
        index += 1;
        skipNext = true;
        continue;
      }
      const word = token.replace(/^["']|["']$/g, "");
      const base = word.split("/").pop();
      if (base === "" ) {
        index += 1;
        continue;
      }
      if (base === "cd") break; // 官方: cd 子命令不计入
      programs.push(base);
      break;
    }
  }
  if (programs.length === 0) return tool === "pwsh" ? "pwsh" : "shell";
  return programs[0];
}

/** 从工具输出尾部解析退出码/信号/超时/拒绝等标记 (官方 et :408-418) */
export function parseCommandMarkers(text) {
  const out = {};
  const body = typeof text === "string" ? text : "";
  if (/(?:^|\n)started background job \S+\s*$/.test(body) ||
      /(?:^|\n)\[still running after \d+ms; moved to background job [^\]\n]+\]/.test(body)) {
    out.backgroundAck = true;
    return out;
  }
  const signal = /(?:^|\n)\[killed by signal: ([^\]\n]+)\]\s*$/.exec(body) ||
    /(?:^|\n)\[shell killed by signal: ([^\]\n]+)\](?=\n|$)/.exec(body);
  if (signal && signal[1] !== undefined) {
    out.signal = signal[1];
  } else {
    const exit = /(?:^|\n)\[exit code: (\d+)\]\s*$/.exec(body) ||
      /(?:^|\n)\[Command finished with exit code (\d+)\]\s*$/.exec(body) ||
      /(?:^|\n)\[shell exited: code (\d+)\](?=\n|$)/.exec(body);
    if (exit && exit[1] !== undefined) out.exit = Number(exit[1]);
    else if (/(?:^|\n)\[shell exited\](?=\n|$)/.test(body)) out.stopped = true;
  }
  if (/(?:^|\n)\[timed out after \d+ms\](?=\n|$)/.test(body)) out.timedOut = true;
  if (/(?:^|\n)\[Command timed out or OOM\](?=\n|$)/.test(body)) out.timedOut = true;
  if (/(?:^|\n)\[stopped: [^\]\n]+\](?=\n|$)/.test(body)) out.stopped = true;
  if (/(?:^|\n)\[sandbox: file access denied under [^\]\n]+\](?=\n|$)/.test(body)) out.denied = true;
  if (/(?:^|\n)\[output truncated; /.test(body)) out.truncated = true;
  if (/(?:^|\n)\[stderr\]\n/.test(body)) out.stderr = true;
  return out;
}

/** 官方 rt (:425-436): 由标记推导命令终态 */
export function resolveCommandStatus(markers, isError) {
  if (!markers || typeof markers !== "object") markers = {};
  if (markers.signal !== undefined || markers.stopped === true) return { status: "killed" };
  if (markers.exit === undefined) {
    if (markers.denied === true || markers.timedOut === true || isError) return { status: "failed" };
    return { status: "completed", exit: 0, exitInferred: true };
  }
  if (markers.exit === 0) return { status: "completed", exit: 0 };
  return { status: "failed", exit: markers.exit };
}

// ============================================================================
// 4. 折叠器
// ============================================================================

function emptySums() {
  return { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 };
}

function emptyTiming() {
  return {
    wallMs: 0,
    ttftMs: 0,
    genMs: 0,
    reasoningMs: 0,
    reasoningBlocks: 0,
    textMs: 0,
    textBlocks: 0,
    toolArgMs: 0,
    toolArgBlocks: 0,
    calls: 0,
    toolsMs: 0,
    toolCalls: 0,
    tools: {}
  };
}

/**
 * DshSessionFolder — 单会话事件流折叠器
 * 用法: const f = new DshSessionFolder(meta); for (line of lines) f.feedLine(line); const out = f.finish();
 */
export class DshSessionFolder {
  constructor(meta = {}) {
    this.meta = meta && typeof meta === "object" ? meta : {};
    this.byType = new Map();
    this.eventCount = 0;
    this.firstTime = 0;
    this.lastTime = 0;

    this.sums = emptySums();
    this.catCounts = { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 };
    this.surface = new Map(); // seq -> { seq, cat, tokens, tool }
    this.systems = [];
    this.systemMessageCount = 0;
    this.inboxSplices = [];
    this.humanMessages = [];
    this.systemTokens = 0;
    this.toolsTokens = 0;
    this.headerTools = [];

    this.counts = { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 };
    this.skills = new Map(); // name -> { count, lastTime }
    this.answers = 0;
    this.humanInputs = 0;
    this.lastUser = "";
    this.generated = { reasoning: 0, answer: 0, call: 0 };
    this.usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reportedTotal: 0, calls: 0 };

    this.turns = []; // 轮次记录 (由 turn/start|end 建立)
    this.turnIndex = new Map(); // turn 号 -> 记录
    this.steps = []; // 每 assistant/message 一条
    this.requests = []; // 与 steps 同构的精简请求记录
    this.events = [];

    this.callNames = new Map(); // callId -> { name, start, args, argText, turn, step, nested, rootCallId }
    this.pendingPtc = new Map(); // subCallId -> 调用信息
    this.stepStart = null; // { time, firstToken }
    this.curStep = null;
    // 上一次 assistant/message 之后新进入上下文的节点 (= 官方 step brief 的 "In" 行)
    this.pendingInputNodes = [];
    this.curStepTools = [];
    this.stepToolSpans = []; // 当前步骤窗口内的工具 span (step/end 时按窗口裁剪)
    this.curStepError = false;
    this.curStepExit = null;

    this.jobs = new Map(); // jobId -> 记录
    this.jobEvents = [];

    this.toolEvents = []; // 契约: /tmp/dshctx-ref/FILEOPS-CONTRACT.md
    this.toolTally = new Map(); // 含 PTC 嵌套 (官方 toolTally)
    this.topLevelTally = new Map(); // 仅顶层 tool/call (官方 Snapshot.toolCalls 口径)
    this.rawToolTally = new Map(); // 不去重的原始结果计数 (口径透明)
    this.programTally = new Map();
    this.commandCalls = [];
    this.commandsRaw = []; // 兜底用 (dsh-fileops 未就绪时仍能给出真实命令列表)
    this.seenResultKeys = new Set(); // 重放去重 (同 callId + seq 的结果只计一次)
    this.completedCallIds = new Set(); // 已完成调用的 callId (官方结果到达即删 callNames)
    this.transportParents = new Set(); // 有 ptc 嵌套子调用的父 callId (官方 transport 标记)
    this.commandStatsRaw = { runs: 0, failed: 0, ms: 0, bg: 0 };

    this.timing = emptyTiming();
    this.toolSpans = [];

    this.provider = "";
    this.model = "";
    this.lastModel = "";
    this.reasoningEffort = "";
    this.contextWindow = 0;
    this.maxOutputTokens = 0;
    this.title = "";
    this.subagents = []; // 兼容字段: 与 subagentMap 同源 (按 childId 去重, 不再依赖 name)
    // ---- 编队 / 子 Agent (供 page 的"编队"面板聚合, 见 dshContext.fleet) ----
    // subagent/catalog: 父会话里登记的子 Agent 目录 (childId 唯一)
    this.subagentMap = new Map(); // childId -> { childId, name, label, mode, parentId? }
    // team/member: 编队成员 (member.id 与 subagent/catalog.childId 同源)
    this.teamMembers = new Map(); // id -> { id, name, description, provider, context, phase }
    // team/task: 任务板任务 (同 id 多条, 取 revision 最大的最新态)
    this.teamTasks = new Map(); // id -> { id, revision, subject, description, status, ownerId, blockedBy, writeScopes }
    this.teamMode = null; // team/mode { enabled }
    this.subagentDescriptor = null; // 子会话自身的 subagent/descriptor (child 会话 seq 0)
    this.models = new Map(); // model -> count
    this.toolNames = new Map(); // header tool name -> tokens

    // compaction/prune 记下的待剪枝 seq (官方 pendingShadowedSeqs / pendingShadowEventSeq)
    // 各分类当前上下文里的真实节点 (供浏览器逐项展开, 最多保留最近 60 条)
    this.catNodes = { user: [], inject: [], skill: [], assistant: [], tool: [] };
    // 文本池: steps[].browserCategories[].items[] 的全文/摘要只存一份, item 里存下标 tx/sx
    this.textPool = [];
    this.textPoolIndex = new Map();
    this.systemSummary = ""; // 系统提示词正文 (上限 DSH_TEXT_LIMITS.systemSummary)
    this.systemSummaryTruncated = false;
    this.systemSummaryChars = 0; // 原文长度 (截断前)

    this.pendingShadowedSeqs = null;
    this.pendingShadowEventIndex = -1;

    // 逐请求累计的分类 token (Token Stats 卡: "计费 Token 用在了哪里")
    this.cumulativeCategories = {
      system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0
    };

    this.prevStepTotal = 0;
    this.lastTurnNo = undefined;
    this.sawStepStart = false;
    this.stepGapMs = 0;
  }

  // ---- 事件入口 ----------------------------------------------------------
  feedLine(line) {
    if (typeof line !== "string") return;
    const trimmed = line.trim();
    if (trimmed === "") return;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return;
    }
    this.feedEvent(ev);
  }

  feedEvent(ev) {
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
    const time = Number(ev.time);
    this.eventCount += 1;
    this.byType.set(ev.type, (this.byType.get(ev.type) || 0) + 1);
    if (Number.isFinite(time) && time > 0) {
      if (!this.firstTime || time < this.firstTime) this.firstTime = time;
      if (time > this.lastTime) this.lastTime = time;
    }
    const data = ev.data && typeof ev.data === "object" ? ev.data : {};
    const seq = Number(ev.seq) || 0;
    const ts = Number.isFinite(time) ? time : 0;

    switch (ev.type) {
      case "turn/start":
        this.onTurnStart(data, seq, ts);
        break;
      case "turn/end":
        this.onTurnEnd(data, seq, ts);
        break;
      case "step/start":
        this.onStepStart(data, seq, ts);
        break;
      case "step/end":
        this.onStepEnd(data, seq, ts);
        break;
      case "user/message":
        this.onUserMessage(data, seq, ts, ev.type, ev.surfaceOp);
        break;
      case "developer/message":
        this.onUserMessage(data, seq, ts, ev.type, ev.surfaceOp);
        break;
      case "agent/inbox/spliced":
        this.onInboxSpliced(data, seq, ts);
        break;
      case "assistant/message":
        this.onAssistantMessage(data, seq, ts, ev.surfaceOp);
        break;
      case "assistant/attempt":
        this.onAssistantAttempt(data, seq, ts);
        break;
      case "tool/call":
        this.onToolCall(data, seq, ts);
        break;
      case "tool/result":
        this.onToolResult(data, seq, ts, ev.surfaceOp);
        break;
      case "tool/ptc-dispatch-start":
        this.onPtcStart(data, seq, ts);
        break;
      case "tool/ptc-dispatch":
        this.onPtcDispatch(data, seq, ts, ev.surfaceOp);
        break;
      case "job/registered":
        this.onJobRegistered(data, seq, ts);
        break;
      case "job/settled":
        this.onJobSettled(data, seq, ts);
        break;
      case "request/header":
        this.onRequestHeader(data, seq, ts);
        break;
      case "request/context":
        this.onRequestContext(data);
        break;
      case "system/message":
        this.onSystemMessage(data, seq, ts, ev.surfaceOp);
        break;
      case "compaction/summary":
      case "compaction/prune":
        this.onCompaction(data, seq, ts, ev.type);
        break;
      case "plan/mode":
        if (data && typeof data.active === "boolean") {
          this.events.push({
            kind: "mode",
            seq,
            time: ts,
            name: data.active ? "plan.on" : "plan.off",
            desc: data.active ? "计划模式开启" : "计划模式关闭"
          });
        }
        break;
      case "permission/preset":
        if (data && typeof data.preset === "string" && data.preset !== "") {
          this.events.push({
            kind: "mode",
            seq,
            time: ts,
            name: "permission.preset",
            desc: "权限预设: " + data.preset
          });
        }
        break;
      case "sandbox/mode":
        if (data && typeof data.mode === "string" && data.mode !== "") {
          this.events.push({
            kind: "mode",
            seq,
            time: ts,
            name: "sandbox.mode",
            desc: "沙箱模式: " + data.mode
          });
        }
        break;
      case "approval/policy":
        if (data && typeof data.policy === "string" && data.policy !== "") {
          this.events.push({
            kind: "mode",
            seq,
            time: ts,
            name: "approval.policy",
            desc: "审批策略: " + data.policy
          });
        }
        break;
      case "model/selection":
        if (data && typeof data.model === "string" && data.model !== "" && data.model !== this.model) {
          const from = this.model;
          this.model = data.model;
          this.bumpModel(data.model);
          if (from !== "" && from !== data.model) {
            this.events.push({
              kind: "model",
              seq,
              time: ts,
              from,
              to: data.model,
              name: "模型切换: " + data.model,
              desc: "模型切换: " + from + " → " + data.model
            });
          }
          this.lastModel = data.model;
        }
        break;
      case "session/title":
        if (data && typeof data.title === "string" && data.title !== "") this.title = data.title;
        break;
      case "subagent/catalog": {
        // 真实字段: { version, childId, childCreatedAt, mode, label, name? }
        // 注意 name 是可选的 (大多数 catalog 事件没有 name), 所以必须按 childId 去重,
        // 旧实现按 name 去重 + 要求 name 非空 → stats.fleet.subCount 恒为 0。
        const childId = typeof data.childId === "string" ? data.childId : "";
        if (childId === "") break;
        const record = this.subagentMap.get(childId) || { childId };
        if (typeof data.name === "string" && data.name !== "") record.name = data.name;
        if (typeof data.label === "string" && data.label !== "") record.label = data.label;
        if (typeof data.mode === "string" && data.mode !== "") record.mode = data.mode;
        // catalog 出现在本会话事件流里 → 本会话就是它的父 Agent
        const parentId = this.meta.id || this.meta.sessionId || "";
        if (parentId !== "") record.parentId = parentId;
        this.subagentMap.set(childId, record);
        if (!this.subagents.some((item) => item.childId === childId)) this.subagents.push(record);
        break;
      }
      case "subagent/descriptor": {
        // 子会话 seq 0: 描述"本会话自身"是哪个子 Agent (真实字段见下, 无 childId;
        // childId 由父会话的 subagent/catalog 提供)
        this.subagentDescriptor = {
          mode: typeof data.mode === "string" ? data.mode : "",
          provider: typeof data.provider === "string" ? data.provider : "",
          label: typeof data.label === "string" ? data.label : "",
          agentProvider: typeof data.agentProvider === "string" ? data.agentProvider : "",
          agentModel: typeof data.agentModel === "string" ? data.agentModel : "",
          agentReasoningEffort: typeof data.agentReasoningEffort === "string" ? data.agentReasoningEffort : ""
        };
        break;
      }
      case "team/member": {
        // 真实字段: { version, teamId, member: { id, name, description, provider, context, phase } }
        const member = data.member && typeof data.member === "object" ? data.member : null;
        if (!member || typeof member.id !== "string" || member.id === "") break;
        const record = this.teamMembers.get(member.id) || { id: member.id };
        if (typeof member.name === "string" && member.name !== "") record.name = member.name;
        if (typeof member.description === "string") record.description = member.description.slice(0, 400);
        if (typeof member.provider === "string" && member.provider !== "") record.provider = member.provider;
        if (typeof member.context === "string" && member.context !== "") record.context = member.context;
        if (typeof member.phase === "string" && member.phase !== "") record.phase = member.phase;
        if (typeof data.teamId === "string" && data.teamId !== "") record.teamId = data.teamId;
        this.teamMembers.set(member.id, record);
        break;
      }
      case "team/task": {
        // 真实字段: { version, teamId, task: { id, revision, subject, description, status,
        //           ownerId, blockedBy, writeScopes } }; 同一 id 会随状态变化产生多条
        const task = data.task && typeof data.task === "object" ? data.task : null;
        if (!task || typeof task.id !== "string" || task.id === "") break;
        const revision = Number.isFinite(Number(task.revision)) ? Number(task.revision) : 0;
        const previous = this.teamTasks.get(task.id);
        if (previous && previous.revision > revision) break; // 只保留 revision 最大的最新态
        const record = {
          id: task.id,
          revision,
          subject: typeof task.subject === "string" ? task.subject : (previous ? previous.subject : ""),
          description: typeof task.description === "string"
            ? task.description.slice(0, 2000)
            : (previous ? previous.description : ""),
          status: typeof task.status === "string" && task.status !== "" ? task.status : (previous ? previous.status : ""),
          ownerId: typeof task.ownerId === "string" ? task.ownerId : (previous ? previous.ownerId : ""),
          blockedBy: Array.isArray(task.blockedBy)
            ? task.blockedBy.filter((value) => typeof value === "string")
            : (previous ? previous.blockedBy : []),
          writeScopes: Array.isArray(task.writeScopes)
            ? task.writeScopes.filter((value) => typeof value === "string")
            : (previous ? previous.writeScopes : [])
        };
        if (typeof data.teamId === "string" && data.teamId !== "") record.teamId = data.teamId;
        this.teamTasks.set(task.id, record);
        break;
      }
      case "team/mode": {
        // 真实字段: { enabled }
        this.teamMode = data.enabled === true;
        break;
      }
      default:
        break;
    }
  }

  bumpModel(model) {
    if (typeof model !== "string" || model === "") return;
    this.models.set(model, (this.models.get(model) || 0) + 1);
  }

  // ---- 轮次 --------------------------------------------------------------
  onTurnStart(data, seq, ts) {
    const turnNo = Number.isFinite(Number(data.turn)) ? Number(data.turn) : this.turns.length + 1;
    let record = this.turnIndex.get(turnNo);
    if (!record) {
      record = {
        turnIdx: turnNo,
        startTime: ts,
        endTime: 0,
        reason: "",
        stepsCount: 0,
        userSnippet: "",
        stepIds: []
      };
      this.turnIndex.set(turnNo, record);
      this.turns.push(record);
    } else if (!record.startTime && ts) {
      record.startTime = ts;
    }
  }

  onTurnEnd(data, seq, ts) {
    const turnNo = Number.isFinite(Number(data.turn)) ? Number(data.turn) : this.turns.length;
    const record = this.turnIndex.get(turnNo);
    if (record) {
      record.endTime = ts;
      record.reason = data && data.reason && typeof data.reason.kind === "string" ? data.reason.kind : "";
    }
  }

  ensureTurn(turnNo) {
    const n = Number.isFinite(Number(turnNo)) ? Number(turnNo) : 1;
    let record = this.turnIndex.get(n);
    if (!record) {
      record = {
        turnIdx: n,
        startTime: 0,
        endTime: 0,
        reason: "",
        stepsCount: 0,
        userSnippet: "",
        stepIds: []
      };
      this.turnIndex.set(n, record);
      this.turns.push(record);
    }
    return record;
  }

  // ---- 步骤 --------------------------------------------------------------
  onStepStart(data, seq, ts) {
    this.sawStepStart = true;
    this.stepStart = { time: ts, firstToken: undefined };
    this.curStep = null;
    this.curStepNodes = [];
    this.curStepTools = [];
    this.curStepError = false;
    this.curStepExit = null;
  }

  onStepEnd(data, seq, ts) {
    const start = this.stepStart;
    if (!start || !Number.isFinite(start.time) || start.time <= 0 || !Number.isFinite(ts) || ts <= 0) return;
    const wall = Math.max(0, ts - start.time);
    this.timing.wallMs += wall;
    // 工具耗时归因到本步窗口: 交集裁剪 + 并集去重 (官方 stepSpans/toolBusyMs 口径)
    if (this.stepToolSpans.length > 0) {
      const clipped = [];
      for (const span of this.stepToolSpans) {
        const from = Math.max(start.time, span.start);
        const to = Math.min(ts, span.end);
        if (to > from) {
          clipped.push({ start: from, end: to, name: span.name });
          const bucket = this.timing.tools[span.name] || { calls: 0, ms: 0 };
          bucket.ms += to - from;
          this.timing.tools[span.name] = bucket;
        }
      }
      clipped.sort((a, b) => a.start - b.start || a.end - b.end);
      let covered = 0;
      let cursor = 0;
      for (const span of clipped) {
        const from = Math.max(cursor, span.start);
        if (span.end > from) {
          covered += span.end - from;
          cursor = span.end;
        }
      }
      this.timing.toolsMs += covered;
      this.stepToolSpans = [];
    }
    if (this.curStep) {
      this.curStep.endTime = ts;
      this.curStep.durationMs = wall;
      this.curStep.durationSec = Math.round(wall / 1000);
      this.curStep.durationFormatted = formatDurationSeconds(this.curStep.durationSec);
    }
    this.stepStart = null;
  }

  onAssistantAttempt(data, seq, ts) {
    if (!this.stepStart || this.stepStart.firstToken !== undefined) return;
    const first = firstStreamTime(data && data.stream);
    if (first === undefined) return;
    this.stepStart.firstToken = first;
  }

  // ---- 消息 --------------------------------------------------------------
  onUserMessage(data, seq, ts, eventType, surfaceOp) {
    const message = eventType === "developer/message" ? data.message || data : data;
    const content = message && Array.isArray(message.content) ? message.content : null;
    const blocks = content || [];
    const tokens = estimateMessageSurfaceTokens(message, eventType === "developer/message");
    const category = messageCategory(eventType, message);
    const source = message && message.source ? message.source : null;
    const inject = eventType === "developer/message" || isInjectSource(source);

    this.addSurfaceNode(
      seq,
      category,
      tokens,
      message && message.tool ? message.tool : undefined,
      {
        toolName: inject ? "inject" : "user",
        title: (inject ? "注入: " : "用户消息: ") + (sourceName(source) || firstTextBlock(blocks, 60) || "消息"),
        snippet: firstTextBlock(blocks, 160),
        // 明细正文: 旧实现只存 160 字符 snippet (fullText 恒空), 页面展开后看不到内容
        fullText: blocksToText(blocks),
        turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : undefined,
        step: Number.isFinite(Number(data.step)) ? Number(data.step) : undefined
      },
      surfaceOp
    );

    if (inject) {
      const name = sourceName(source);
      const event = {
        kind: "inject",
        seq,
        time: ts,
        form: source && typeof source.form === "string" && source.form !== "" ? source.form : "context",
        name: name || "注入内容",
        tokens,
        desc: name || "注入内容",
        turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : undefined,
        step: Number.isFinite(Number(data.step)) ? Number(data.step) : undefined
      };
      if (source && source.kind === "skill-invocation") {
        event.sub = "skill";
        event.name = typeof source.name === "string" && source.name !== "" ? source.name : "?";
        event.desc = "技能注入: " + event.name;
        this.countSkill(event.name, ts);
      }
      if (source && source.form === "notice" && typeof source.summary === "string" && source.summary !== "") {
        event.detail = source.summary;
        event.desc = source.summary;
      }
      this.events.push(event);
      this.counts.injects += 1;
    } else {
      this.humanInputs += 1;
      const text = firstTextBlock(blocks, 200);
      if (text !== "") this.lastUser = text;
      // user/message 事件本身不带 turn/step (位于 turn/start 之前), 因此按 seq 位置归属轮次
      this.humanMessages.push({ seq, time: ts, text });
      if (this.humanMessages.length > 1000) this.humanMessages.shift();
      const turnNo = Number.isFinite(Number(data.turn)) ? Number(data.turn) : undefined;
      if (turnNo !== undefined && text !== "") {
        const record = this.ensureTurn(turnNo);
        if (!record.userSnippet) record.userSnippet = text;
      }
    }
  }

  onInboxSpliced(data, seq, ts) {
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    if (inserted.length === 0) return;
    let tokens = 0;
    for (const item of inserted) tokens += estimateBlocksTokens(item && Array.isArray(item.content) ? item.content : []);
    const source = (inserted[0] && inserted[0].source) || null;
    const name = sourceName(source) || "运行时消息";
    // 说明: agent/inbox/spliced 是 DSH 运行时插入的消息。官方 fold 的 switch 不处理该事件类型,
    // 为了让 stats.events.inject 与 dsh-context 完全对齐, 这里只把它计入上下文构成 (surface),
    // 不产生 inject 事件、不累加 injects; 明细记录在 sessionMeta.inboxSplices。
    this.addSurfaceNode(seq, "inject", tokens, "inbox", {
      toolName: "inbox",
      title: "运行时注入: " + name,
      snippet: firstTextBlock(inserted[0] && inserted[0].content, 160),
      fullText: blocksToText(inserted[0] && inserted[0].content),
      turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : undefined
    });
    this.inboxSplices.push({
      seq,
      time: ts,
      name,
      tokens,
      count: inserted.length,
      turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : undefined
    });
  }

  onAssistantMessage(data, seq, ts, surfaceOp) {
    const message = data.message && typeof data.message === "object" ? data.message : {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const turnNo = Number.isFinite(Number(data.turn)) ? Number(data.turn) : 1;
    const stepNo = Number.isFinite(Number(data.step)) ? Number(data.step) : 1;

    // 模型来源
    const source = message.source && typeof message.source === "object" ? message.source : null;
    if (source) {
      if (typeof source.provider === "string" && source.provider !== "") this.provider = source.provider;
      if (typeof source.model === "string" && source.model !== "") {
        if (this.model !== source.model) this.lastModel = this.model;
        this.model = source.model;
        this.bumpModel(source.model);
      }
    }

    // 内容分类统计
    let reasoningTokens = 0;
    let answerTokens = 0;
    let callTokens = 0;
    let reasoningText = "";
    let hasText = false;
    const toolNames = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "reasoning") {
        reasoningTokens += estimateTextBlockTokens(block);
        if (!reasoningText && typeof block.text === "string") reasoningText = block.text;
      } else if (block.type === "text") {
        answerTokens += estimateTextBlockTokens(block);
        if (typeof block.text === "string" && block.text.trim() !== "") hasText = true;
      } else if (block.type === "tool-call") {
        callTokens += estimateToolCallTokens(block.name, block.arguments);
        if (typeof block.name === "string" && block.name !== "") toolNames.push(block.name);
      }
    }

    this.generated.reasoning += reasoningTokens;
    this.generated.answer += answerTokens;
    this.generated.call += callTokens;
    if (hasText) this.answers += 1;

    // usage (真值来源)
    const usage = data.usage && typeof data.usage === "object" ? data.usage : null;
    let promptTokens = null;
    let outputTokens = null;
    let cacheRead = null;
    if (usage) {
      const uncached = toFiniteNumber(usage.inputTokens);
      const cacheR = toFiniteNumber(usage.cacheReadTokens);
      const cacheW = toFiniteNumber(usage.cacheWriteTokens);
      const out = toFiniteNumber(usage.outputTokens);
      const reported = toFiniteNumber(usage.totalTokens);
      if (uncached !== null) this.usage.uncached += uncached;
      if (cacheR !== null) this.usage.cacheRead += cacheR;
      if (cacheW !== null) this.usage.cacheWrite += cacheW;
      if (out !== null) this.usage.output += out;
      if (reported !== null) this.usage.reportedTotal += reported;
      if (uncached !== null || cacheR !== null || cacheW !== null || out !== null) {
        promptTokens = (uncached || 0) + (cacheR || 0) + (cacheW || 0);
        outputTokens = out || 0;
        cacheRead = cacheR;
        this.usage.calls += 1;
      }
    }

    // 上下文构成 (官方 :2019-2022): system+tools+sums
    const compositionTotal =
      this.systemTokens + this.toolsTokens + this.sums.user + this.sums.inject +
      this.sums.skill + this.sums.assistant + this.sums.tool;

    const stepRecord = {
      stepIdx: this.steps.length + 1,
      turnIdx: turnNo,
      stepInTurn: stepNo,
      totalStepsInTurn: 0,
      time: this.stepStart && this.stepStart.time ? this.stepStart.time : ts,
      timestamp: formatClock(this.stepStart && this.stepStart.time ? this.stepStart.time : ts),
      totalTokens: compositionTotal,
      tokenDelta: this.steps.length === 0 ? compositionTotal : compositionTotal - this.prevStepTotal,
      promptTokens: promptTokens === null ? 0 : promptTokens,
      outputTokens: outputTokens === null ? 0 : outputTokens,
      cacheHit: cacheRatePercent(usage),
      durationSec: 0,
      durationFormatted: "0s",
      durationMs: 0,
      userSnippet: "",
      inputSnippet: "",
      breakdown: {
        system: this.systemTokens,
        tools: this.toolsTokens,
        user: this.sums.user,
        inject: this.sums.inject,
        skill: this.sums.skill,
        assistant: this.sums.assistant,
        tool: this.sums.tool
      },
      browserCategories: [],
      dnaBands: [],
      thinking: reasoningText.slice(0, 200),
      toolCalls: [],
      isError: false,
      exitCode: null,
      seq
    };
    this.prevStepTotal = compositionTotal;
    // 逐请求累计 (供 Token Stats 卡使用)
    this.cumulativeCategories.system += this.systemTokens;
    this.cumulativeCategories.tools += this.toolsTokens;
    this.cumulativeCategories.user += this.sums.user;
    this.cumulativeCategories.inject += this.sums.inject;
    this.cumulativeCategories.skill += this.sums.skill;
    this.cumulativeCategories.assistant += this.sums.assistant;
    this.cumulativeCategories.tool += this.sums.tool;

    // 步骤所属轮次
    const turnRecord = this.ensureTurn(turnNo);
    turnRecord.stepsCount += 1;
    turnRecord.stepIds.push(stepRecord.stepIdx);

    // 计时 (官方 :2034-2053)
    this.timing.calls += 1;
    const streamSpans = streamSpansOf(data.stream, ts);
    const start = this.stepStart;
    if (start && Number.isFinite(start.time) && start.time > 0) {
      const firstToken = start.firstToken !== undefined ? start.firstToken : streamSpans.firstToken;
      if (firstToken !== undefined && Number.isFinite(firstToken) && firstToken > 0) {
        const ttft = Math.max(0, firstToken - start.time);
        this.timing.ttftMs += ttft;
        this.timing.genMs += Math.max(0, ts - firstToken);
        this.timing.reasoningMs += streamSpans.reasoningMs;
        this.timing.reasoningBlocks += streamSpans.reasoningBlocks;
        this.timing.textMs += streamSpans.textMs;
        this.timing.textBlocks += streamSpans.textBlocks;
        this.timing.toolArgMs += streamSpans.toolArgMs;
        this.timing.toolArgBlocks += streamSpans.toolArgBlocks;
        stepRecord.ttftMs = ttft;
        stepRecord.genMs = Math.max(0, ts - firstToken);
      }
    }
    if (toolNames.length > 0) stepRecord.toolCalls = toolNames.slice(0, DSH_EVENT_BOUNDS.maxStepToolNames);

    // step brief 的 "In" 行 = 上一次请求之后新进入上下文的节点 (官方 brief.input, off-client.pretty.mjs:1542)
    stepRecord.inputSnippet = buildInputSnippet(this.pendingInputNodes);
    stepRecord.browserCategories = this.buildStepBrowserCategories()
      .map((cat) => packBrowserCategoryItems(cat, this.textPool, this.textPoolIndex));
    this.pendingInputNodes = [];

    this.curStep = stepRecord;
    this.steps.push(stepRecord);
    this.requests.push({
      seq,
      time: ts,
      turn: turnNo,
      step: stepNo,
      total: compositionTotal,
      prompt: promptTokens === null ? undefined : promptTokens,
      output: outputTokens === null ? undefined : outputTokens,
      cacheRead: cacheRead === null ? undefined : cacheRead
    });

    // counts: steps / turns (官方 un/pn)
    this.counts.steps += 1;
    if (this.lastTurnNo !== turnNo) {
      this.counts.turns += 1;
      this.lastTurnNo = turnNo;
    }

    // 助手消息本身进入 surface (官方 :2054); 必须在 compositionTotal 之后记账,
    // 否则会把本次回复算进本次请求的提示词里。
    this.addSurfaceNode(seq, "assistant", estimateMessageSurfaceTokens(message, true), "assistant", {
      toolName: "assistant",
      title: "助手回复" + (toolNames.length > 0 ? " [" + toolNames.join(", ") + "]" : ""),
      snippet: firstTextBlock(blocks, 160),
      fullText: blocksToText(blocks),
      turn: turnNo,
      step: stepNo
    }, surfaceOp);
  }

  /**
   * 该步的上下文浏览器 7 分类明细 (供 page/app.js renderContextBrowser 消费)
   * 结构与官方 client 一致: { key, label, tokens, items[] }, items 带展开所需字段。
   * items 取该分类当前在上下文中的真实节点 (最近的 N 条), 不是摊派出来的假条目。
   */
  buildStepBrowserCategories() {
    const limit = DSH_EVENT_BOUNDS.maxBrowserItems;
    const sum = this.systemTokens + this.toolsTokens + this.sums.user + this.sums.inject +
      this.sums.skill + this.sums.assistant + this.sums.tool;
    return CONTEXT_CATEGORY_META.map((meta) => {
      const tokens =
        meta.key === "system" ? this.systemTokens :
        meta.key === "tools" ? this.toolsTokens :
        this.sums[meta.key] || 0;
      let items;
      if (meta.key === "system") {
        if (this.systemTokens > 0) {
          const systemItem = {
            id: "system:prompt",
            idx: 1,
            title: "系统提示词",
            snippet: (this.systemSummary || "系统提示词").slice(0, 160),
            tokens: Math.round(this.systemTokens),
            diff: "+" + Math.round(this.systemTokens),
            fullText: this.systemSummary || "",
            toolName: "system"
          };
          // 系统提示词超过 DSH_TEXT_LIMITS.systemSummary 才标 truncated
          if (this.systemSummaryTruncated) systemItem.truncated = true;
          items = [systemItem];
        } else {
          items = [];
        }
      } else if (meta.key === "tools") {
        items = this.headerTools.slice(0, limit).map((tool, index) => {
          const item = {
            id: "tool:" + tool.name,
            idx: index + 1,
            title: tool.name,
            snippet: tool.name + " · " + tool.tokens + " tok",
            tokens: tool.tokens,
            diff: "0",
            fullText: tool.schemaText || "",
            toolName: tool.name
          };
          if (tool.schemaTruncated) item.truncated = true;
          return item;
        });
      } else {
        const nodes = this.catNodes[meta.key] || [];
        items = nodes.slice(-limit).map((node, index) => {
          const item = {
            id: meta.key + ":" + node.seq,
            idx: index + 1,
            title: node.title,
            snippet: node.snippet || node.title,
            tokens: node.tokens,
            diff: "0",
            fullText: node.fullText || node.snippet || node.title,
            toolName: node.toolName
          };
          if (node.fullTextTruncated) item.truncated = true;
          return item;
        });
      }
      return {
        key: meta.key,
        label: meta.label,
        name: meta.label,
        count: items.length > 0 ? items.length : (this.catCounts[meta.key] || 0),
        tokens: Math.round(tokens),
        formatted: formatK(tokens),
        percent: sum > 0 ? Math.round((tokens / sum) * 100) : 0,
        color: meta.color,
        items
      };
    });
  }

  // ---- 工具 --------------------------------------------------------------
  onToolCall(data, seq, ts) {
    const callId = typeof data.callId === "string" ? data.callId : "";
    const name = typeof data.name === "string" ? data.name : "";
    if (callId === "" || name === "") return;
    const parsed = parseToolArguments(data.arguments);
    const record = {
      callId,
      name,
      start: ts,
      args: parsed.args,
      argText: parsed.argText,
      turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : undefined,
      step: Number.isFinite(Number(data.step)) ? Number(data.step) : undefined,
      nested: false,
      rootCallId: callId
    };
    this.callNames.set(callId, record);
    // 顶层工具调用计数 (官方 Snapshot.toolCalls = 顶层 tool/result 的 surface 节点数;
    // PTC 程序内的嵌套调用只计入文件活动 / 命令执行, 不计入"工具调用"总数)
    this.topLevelTally.set(name, (this.topLevelTally.get(name) || 0) + 1);
    if (this.curStep) {
      if (this.curStep.toolCalls.length < DSH_EVENT_BOUNDS.maxStepToolNames) this.curStep.toolCalls.push(name);
      this.curStepTools.push(name);
    }
    this.recordCommandStart(record, seq, ts);
  }

  onPtcStart(data, seq, ts) {
    const subCallId = typeof data.subCallId === "string" ? data.subCallId : "";
    const name = typeof data.name === "string" ? data.name : "";
    if (subCallId === "" || name === "") return;
    const rootCallId = typeof data.rootCallId === "string" ? data.rootCallId : "";
    const parentCallId = typeof data.parentCallId === "string" ? data.parentCallId : "";
    const root = this.callNames.get(rootCallId);
    const parsed = parseToolArguments(data.arguments);
    const record = {
      callId: subCallId,
      name,
      start: ts,
      args: parsed.args,
      argText: parsed.argText,
      turn: root ? root.turn : undefined,
      step: root ? root.step : undefined,
      nested: true,
      rootCallId,
      parentCallId
    };
    if (parentCallId !== "") this.transportParents.add(parentCallId);
    if (rootCallId !== "") this.transportParents.add(rootCallId);
    this.pendingPtc.set(subCallId, record);
    this.callNames.set(subCallId, record);
    if (this.curStep) {
      if (this.curStep.toolCalls.length < DSH_EVENT_BOUNDS.maxStepToolNames) this.curStep.toolCalls.push(name);
      this.curStepTools.push(name);
    }
    this.recordCommandStart(record, seq, ts);
  }

  onToolResult(data, seq, ts, surfaceOp) {
    const message = data.message && typeof data.message === "object" ? data.message : {};
    const source = message.source && typeof message.source === "object" ? message.source : null;
    const callId = (source && typeof source.callId === "string" && source.callId) ||
      (typeof message.toolCallId === "string" ? message.toolCallId : "");
    const call = callId !== "" ? this.callNames.get(callId) : undefined;
    const name = call ? call.name : "";
    const text = blocksToText(message.content);
    const isError = message.isError === true;
    const tokens = estimateMessageSurfaceTokens(message, false);
    // surface 节点: 每条 tool/result **事件**都记一个 (官方 Snapshot.toolCalls 的口径,
    // 重放产生的重复结果也计入 —— 这正是 S31/M114/L879 的来源)
    this.addSurfaceNode(seq, "tool", tokens, name || undefined, {
      toolName: name || "tool",
      title: "工具结果: " + (name || "tool"),
      snippet: firstTextBlock(message.content, 160),
      fullText: text, // 工具结果正文 (旧实现只有 160 字符 snippet, 详情看不到输出)
      turn: call && call.turn !== undefined ? call.turn : this.curStep ? this.curStep.turnIdx : undefined,
      step: call && call.step !== undefined ? call.step : this.curStep ? this.curStep.stepInTurn : undefined
    }, surfaceOp);
    // 重放去重: 同一 callId + seq 的结果只计一次统计 (surface 已计)
    if (callId !== "") {
      const dedupeKey = "r:" + callId + ":" + seq;
      if (this.seenResultKeys.has(dedupeKey)) return;
      this.seenResultKeys.add(dedupeKey);
    }
    this.completeTool({
      callId,
      call,
      name,
      text,
      isError,
      meta: data.meta,
      seq,
      ts,
      eventType: "tool/result",
      content: message.content
    });
  }

  onPtcDispatch(data, seq, ts, surfaceOp) {
    const subCallId = typeof data.subCallId === "string" ? data.subCallId : "";
    const call = this.pendingPtc.get(subCallId) || this.callNames.get(subCallId);
    const name = typeof data.name === "string" ? data.name : call ? call.name : "";
    const text = blocksToText(data.content);
    const isError = data.isError === true;
    const tokens = estimateMessageSurfaceTokens({ content: data.content }, false);
    this.addSurfaceNode(seq, "tool", tokens, name || undefined, {
      toolName: name || "tool",
      title: "工具结果: " + (name || "tool"),
      snippet: firstTextBlock(data.content, 160),
      fullText: text, // PTC 子调用输出正文
      turn: call && call.turn !== undefined ? call.turn : this.curStep ? this.curStep.turnIdx : undefined,
      step: call && call.step !== undefined ? call.step : this.curStep ? this.curStep.stepInTurn : undefined
    }, surfaceOp);
    if (subCallId !== "") {
      const dedupeKey = "p:" + subCallId + ":" + seq;
      if (this.seenResultKeys.has(dedupeKey)) return;
      this.seenResultKeys.add(dedupeKey);
    }
    this.completeTool({
      callId: subCallId,
      call,
      name,
      text,
      isError,
      meta: data.meta,
      seq,
      ts,
      eventType: "tool/ptc-dispatch",
      content: data.content
    });
    this.pendingPtc.delete(subCallId);
  }

  completeTool({ callId, call, name, text, isError, meta, seq, ts, eventType, content }) {
    // 不去重的原始计数 (口径透明用): 每条 tool result 事件都记一次
    if (name !== "") this.rawToolTally.set(name, (this.rawToolTally.get(name) || 0) + 1);
    // 官方 :1670-1675: 结果落地后立即删除 callNames[callId] → 同一次调用的重放结果
    // 不会再被计入 toolTally / timing / fileOps。这里用 completedCallIds 做同样的去重。
    if (callId !== "") {
      if (this.completedCallIds.has(callId)) return;
      this.completedCallIds.add(callId);
      this.callNames.delete(callId);
    }
    const turn = call && call.turn !== undefined ? call.turn : this.curStep ? this.curStep.turnIdx : undefined;
    const step = call && call.step !== undefined ? call.step : this.curStep ? this.curStep.stepInTurn : undefined;
    const start = call && Number.isFinite(call.start) && call.start > 0 ? call.start : ts;
    const durationMs = Number.isFinite(ts) && ts > 0 ? Math.max(0, ts - start) : 0;

    // 工具耗时 (官方 :1661-1669 / :1885-1918)
    // 关键: 不能把 tool/call→tool/result 的整段墙钟直接累加 —— 后台任务 (run_in_background)
    // 的跨度可以横跨数小时空闲, 直接累加会让 toolsMs 远超会话 wallMs。
    // 因此这里只登记 span, 在 step/end 时按 [step/start, step/end] 做**交集裁剪 + 区间并集**,
    // 保证 toolsMs ⊆ wallMs (与官方 stepSpans + toolBusyMs 口径一致)。
    // run_code 是 code-mode 包装器, 其内部嵌套调用已各自计时, 故不计入 (避免双计)。
    // 官方 :1661-1669 + :1830-1831: 父调用一旦有 ptc-dispatch-start 子调用, 就被标记
    // transport=true, 其结果**不再计入 toolsMs** (避免与嵌套调用双计);
    // 没有嵌套子调用的 run_code (纯代码执行) 则与普通工具一样计入。
    const hasNestedChildren = this.transportParents.has(callId);
    if (durationMs > 0 && !hasNestedChildren) {
      this.timing.toolCalls += 1;
      const key = name || "tool";
      const bucket = this.timing.tools[key] || { calls: 0, ms: 0 };
      bucket.calls += 1;
      this.timing.tools[key] = bucket;
      const span = { start, end: ts, name: key };
      this.toolSpans.push(span);
      if (this.stepStart) this.stepToolSpans.push(span);
    }

    // 工具调用计数 (官方 Xn: toolTally)
    if (name !== "") this.toolTally.set(name, (this.toolTally.get(name) || 0) + 1);

    // 归一化工具事件 (契约 /tmp/dshctx-ref/FILEOPS-CONTRACT.md)
    if (name !== "") {
      this.toolEvents.push({
        callId,
        rootCallId: call ? call.rootCallId || callId : callId,
        parentCallId: call ? call.parentCallId : undefined,
        nested: !!(call && call.nested),
        name,
        args: (call && call.args) || {},
        argText: (call && call.argText) || "",
        resultText: text,
        meta: meta || null,
        isError,
        turn: turn === undefined ? 1 : turn,
        step: step === undefined ? 1 : step,
        time: ts,
        startTime: start,
        durationMs
      });
    }

    // 命令终态 (bash / run_code)
    this.recordCommandEnd({ callId, call, name, text, isError, meta, seq, ts, eventType, content });

    // 技能加载 (官方 :2006-2010)
    if (name === "skill" && !isError) {
      const skillName = skillNameOf(text);
      if (skillName !== "") {
        this.countSkill(skillName, ts);
        // 技能内容在 surface 里属于 skill 分类
        const node = this.surface.get(seq);
        if (node && node.cat === "tool") {
          this.sums.tool -= node.tokens;
          this.catCounts.tool = Math.max(0, this.catCounts.tool - 1);
          node.cat = "skill";
          this.sums.skill += node.tokens;
          this.catCounts.skill += 1;
          // catNodes 同步迁移: 只改 surface.cat 会让 skill 分类只有 count/tokens 而没有条目明细,
          // 页面于是显示「该分类在此步骤有 1 项，但未保留独立条目明细」。
          const toolRecords = this.catNodes.tool;
          if (Array.isArray(toolRecords)) {
            const recordIndex = toolRecords.findIndex((record) => record && record.seq === seq);
            if (recordIndex >= 0) {
              const [record] = toolRecords.splice(recordIndex, 1);
              record.cat = "skill";
              if (Array.isArray(this.catNodes.skill)) {
                this.catNodes.skill.push(record);
                if (this.catNodes.skill.length > 60) this.catNodes.skill.shift();
              }
            }
          }
        }
        this.events.push({
          kind: "inject",
          seq,
          time: ts,
          form: "instructions",
          sub: "skill",
          name: skillName,
          tokens: node ? node.tokens : 0,
          desc: "技能注入: " + skillName,
          turn: turn === undefined ? undefined : turn,
          step: step === undefined ? undefined : step
        });
        this.counts.injects += 1;
      }
    }

    // 步骤级错误标记
    if (this.curStep) {
      if (isError) this.curStep.isError = true;
      const markers = parseCommandMarkers(text);
      if (markers.exit !== undefined) this.curStep.exitCode = markers.exit;
    }
  }

  countSkill(name, ts) {
    if (typeof name !== "string" || name === "" || name === "__proto__") return;
    const record = this.skills.get(name) || { name, count: 0, lastTime: 0 };
    record.count += 1;
    record.lastTime = ts || record.lastTime;
    this.skills.set(name, record);
  }

  // ---- 命令 (真实墙钟: job/registered|settled) ---------------------------
  recordCommandStart(call, seq, ts) {
    const tool = commandToolOf(call.name);
    if (tool === null) return;
    const args = call.args || {};
    const cmdRaw = tool === "run_code" ? (typeof args.code === "string" ? args.code : "") :
      typeof args.command === "string" ? args.command : typeof args.commandLine === "string" ? args.commandLine : "";
    if (cmdRaw === "") return;
    const truncated = cmdRaw.length > DSH_EVENT_BOUNDS.maxCommandChars;
    const record = {
      seq,
      callId: call.callId,
      tool,
      cmd: truncated ? cmdRaw.slice(0, DSH_EVENT_BOUNDS.maxCommandChars) : cmdRaw,
      cmdTruncated: truncated || undefined,
      description: typeof args.description === "string" ? args.description : undefined,
      cwd: typeof args.workdir === "string" ? args.workdir : undefined,
      timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : undefined,
      background: args.run_in_background === true ? true : undefined,
      nested: call.nested === true,
      turn: call.turn,
      step: call.step,
      start: ts,
      end: undefined,
      status: "running",
      err: false,
      program: deriveProgram(cmdRaw, tool)
    };
    this.commandsRaw.push(record);
    const key = record.program;
    if (key) this.programTally.set(key, (this.programTally.get(key) || 0) + 1);
    if (record.background) this.commandStatsRaw.bg += 1;
    if (cmdRaw !== "" && !this.commandCalls.includes(cmdRaw)) {
      this.commandCalls.push(cmdRaw);
      if (this.commandCalls.length > 1024) this.commandCalls.splice(0, this.commandCalls.length - 1024);
    }
  }

  recordCommandEnd({ callId, call, name, text, isError, meta, seq, ts, eventType, content }) {
    const tool = commandToolOf(name);
    if (tool === null) return;
    const index = findLastIndex(this.commandsRaw, (item) => item.callId === callId);
    if (index < 0) return;
    const record = this.commandsRaw[index];
    if (record.status !== "running") return;
    const markers = parseCommandMarkers(text);
    const cwd = meta && typeof meta.cwd === "string" && meta.cwd !== "" ? meta.cwd : undefined;
    const updated = Object.assign({}, record);
    if (markers.backgroundAck === true) {
      updated.background = true;
      updated.status = "running";
    } else {
      const resolved = resolveCommandStatus(markers, isError);
      updated.status = resolved.status;
      if (resolved.exit !== undefined) updated.exit = resolved.exit;
      if (resolved.exitInferred === true) updated.exitInferred = true;
      updated.end = ts;
      updated.derived = true;
    }
    if (cwd) updated.cwd = cwd;
    updated.err = isError;
    updated.resultSeq = seq;
    if (text !== "") updated.outChars = text.length;
    if (markers.truncated === true) updated.outTruncated = true;
    if (markers.stderr === true) updated.stderr = true;
    if (markers.timedOut === true) updated.timedOut = true;
    if (markers.denied === true) updated.denied = true;
    if (markers.stopped === true) updated.stopped = true;
    if (markers.signal !== undefined) updated.signal = markers.signal;
    this.commandsRaw[index] = updated;
    if (updated.status !== "running") this.accumulateCommandStats(updated);
  }

  accumulateCommandStats(record) {
    this.commandStatsRaw.runs += 1;
    if (record.status === "failed" || record.status === "killed") this.commandStatsRaw.failed += 1;
    if (Number.isFinite(record.end) && Number.isFinite(record.start)) {
      this.commandStatsRaw.ms += Math.max(0, record.end - record.start);
    }
  }

  onJobRegistered(data, seq, ts) {
    const jobId = typeof data.jobId === "string" ? data.jobId : "";
    if (jobId === "") return;
    const callId = data.toolCall && typeof data.toolCall.callId === "string" ? data.toolCall.callId : "";
    const record = {
      id: jobId,
      kind: typeof data.kind === "string" ? data.kind : "bash",
      label: typeof data.label === "string" ? data.label : "",
      startedAt: toFiniteNumber(data.startedAt),
      finishedAt: null,
      status: "running",
      detail: "",
      callId
    };
    this.jobs.set(jobId, record);
    if (callId !== "") {
      const index = findLastIndex(this.commandsRaw, (item) => item.callId === callId);
      if (index >= 0 && record.startedAt !== null) {
        this.commandsRaw[index] = Object.assign({}, this.commandsRaw[index], { start: record.startedAt });
      }
    }
  }

  onJobSettled(data, seq, ts) {
    const jobId = typeof data.jobId === "string" ? data.jobId : "";
    if (jobId === "") return;
    const existing = this.jobs.get(jobId) || {
      id: jobId,
      kind: typeof data.kind === "string" ? data.kind : "bash",
      label: typeof data.label === "string" ? data.label : "",
      startedAt: toFiniteNumber(data.startedAt),
      callId: data.toolCall && typeof data.toolCall.callId === "string" ? data.toolCall.callId : ""
    };
    const finishedAt = toFiniteNumber(data.finishedAt);
    const status = typeof data.status === "string" ? data.status : "completed";
    const detail = typeof data.detail === "string" ? data.detail : "";
    const record = Object.assign({}, existing, {
      finishedAt,
      status,
      detail,
      settledAt: ts
    });
    this.jobs.set(jobId, record);

    const callId = record.callId || "";
    if (callId !== "") {
      const index = findLastIndex(this.commandsRaw, (item) => item.callId === callId);
      if (index >= 0) {
        const command = this.commandsRaw[index];
        const exitCode = parseExitFromDetail(detail);
        const next = Object.assign({}, command, {
          status: status === "completed" ? "completed" : status === "killed" ? "killed" : "failed",
          end: finishedAt === null ? command.end : finishedAt,
          start: record.startedAt === null ? command.start : record.startedAt,
          derived: true
        });
        if (exitCode !== null) {
          next.exit = exitCode;
          delete next.exitInferred;
          if (exitCode !== 0 && next.status === "completed") next.status = "failed";
        }
        this.commandsRaw[index] = next;
        if (command.status === "running") this.accumulateCommandStats(next);
      }
    }

    this.jobEvents.push({
      id: jobId,
      label: record.label,
      kind: record.kind,
      status,
      ms: record.startedAt !== null && finishedAt !== null ? Math.max(0, finishedAt - record.startedAt) : 0,
      exitCode: parseExitFromDetail(detail),
      detail,
      time: finishedAt === null ? ts : finishedAt,
      callId,
      turn: undefined,
      step: undefined
    });
  }

  // ---- 请求头 / 系统提示词 ----------------------------------------------
  onRequestHeader(data, seq, ts) {
    const header = data.header && typeof data.header === "object" ? data.header : {};
    const tools = Array.isArray(header.tools) ? header.tools : [];
    this.toolsTokens = estimateToolsTokens(tools);
    this.headerTools = tools.map((tool) => {
      const tokens = estimateToolsTokens([tool]);
      const name = tool && typeof tool.name === "string" ? tool.name : "";
      if (name !== "") this.toolNames.set(name, tokens);
      let schemaText = "";
      try {
        schemaText = JSON.stringify(tool);
      } catch {
        schemaText = "";
      }
      // 工具 schema 上限 12,000 字符 (旧实现 800: 复杂工具的参数说明根本读不到)
      const clippedSchema = clipText(schemaText, DSH_TEXT_LIMITS.schemaText);
      return {
        name,
        tokens,
        schemaText: clippedSchema.text,
        schemaTruncated: clippedSchema.truncated,
        schemaChars: clippedSchema.originalChars
      };
    });
    const config = header.config && typeof header.config === "object" ? header.config : {};
    if (typeof config.provider === "string" && config.provider !== "") this.provider = config.provider;
    if (typeof config.model === "string" && config.model !== "") {
      if (this.model !== config.model) this.lastModel = this.model;
      this.model = config.model;
      this.bumpModel(config.model);
    }
    if (typeof config.reasoningEffort === "string" && config.reasoningEffort !== "") {
      this.reasoningEffort = config.reasoningEffort;
    }
    const maxTokens = toFiniteNumber(config.maxTokens);
    if (maxTokens !== null && maxTokens > 0) this.maxOutputTokens = maxTokens;
    if ((data.reason === "change" || data.reason === "resume") &&
        this.model && this.lastModel && this.model !== this.lastModel) {
      this.events.push({
        kind: "model",
        seq,
        time: ts,
        from: this.lastModel,
        to: this.model,
        name: "模型切换: " + this.model,
        desc: "模型切换: " + this.lastModel + " → " + this.model
      });
    }
    if (this.model) this.lastModel = this.model;
  }

  onRequestContext(data) {
    const contextWindow = toFiniteNumber(data.contextWindow);
    if (contextWindow !== null && contextWindow > 0) this.contextWindow = contextWindow;
    if (typeof data.model === "string" && data.model !== "") {
      this.model = data.model;
      this.bumpModel(data.model);
    }
    if (typeof data.provider === "string" && data.provider !== "") this.provider = data.provider;
  }

  /**
   * 系统提示词 (官方 :1760-1772): 记入 systems[] + systemTokens, 不产生 inject 事件
   * (官方把系统提示词放在独立的 systems 里, counts.injects 不统计它 —— 因此本模块也保持一致)
   */
  onSystemMessage(data, seq, ts, surfaceOp) {
    const message = data.message && typeof data.message === "object" ? data.message : data;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const tokens = estimateBlocksTokens(blocks);
    // 系统提示词全文上限 20,000 字符 (旧实现 400: 9,919 tok 的系统提示词只留得下开头一句)
    const systemText = blocksToText(blocks).replace(/\s+/g, " ").trim();
    const clippedSystem = clipText(systemText, DSH_TEXT_LIMITS.systemSummary);
    this.systemSummary = clippedSystem.text;
    this.systemSummaryTruncated = clippedSystem.truncated;
    this.systemSummaryChars = clippedSystem.originalChars;
    this.systemMessageCount += 1;
    // surfaceOp 替换: 该区间内的旧 surface 节点与旧系统提示词一并作废
    const range = parseSurfaceOp(surfaceOp);
    if (range) {
      const drop = new Set();
      for (const key of this.surface.keys()) if (key >= range.start && key <= range.end) drop.add(key);
      if (drop.size > 0) this.dropSurfaceSeqs(drop);
      this.systems = this.systems.filter((item) => item.seq < range.start || item.seq > range.end);
    }
    this.systems.push({ seq, time: ts, tokens });
    if (this.systems.length > 8) this.systems = this.systems.slice(-8);
    // 官方 Wn (:1565-1569): 取最后一个 tokens>0 的系统提示词
    let systemTokens = 0;
    for (let i = this.systems.length - 1; i >= 0; i -= 1) {
      if (this.systems[i].tokens > 0) {
        systemTokens = this.systems[i].tokens;
        break;
      }
    }
    this.systemTokens = systemTokens;
  }

  // ---- 压缩 / 剪枝 -------------------------------------------------------
  onCompaction(data, seq, ts, eventType) {
    const isCompaction = eventType === "compaction/summary";
    const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.filter((n) => typeof n === "number") : [];
    const shadowedTokens = toFiniteNumber(data.shadowedTokenCount);
    // 被替换节点的 token 总和 (官方 grossTokens)
    let grossTokens = 0;
    for (const shadowed of shadowedSeqs) {
      const node = this.surface.get(shadowed);
      if (!node) continue;
      grossTokens += node.tokens;
      if (this.sums[node.cat] !== undefined) this.sums[node.cat] -= node.tokens;
      if (this.catCounts[node.cat] !== undefined) this.catCounts[node.cat] = Math.max(0, this.catCounts[node.cat] - 1);
      this.surface.delete(shadowed);
    }
    const event = {
      kind: isCompaction ? "compaction" : "prune",
      seq,
      time: ts,
      tokens: shadowedTokens === null ? 0 : shadowedTokens,
      formattedTokens: (shadowedTokens === null ? 0 : shadowedTokens) + " tok",
      name: isCompaction ? "上下文自动压缩" : "上下文剪枝",
      desc: isCompaction
        ? "压缩摘要替换历史 (" + shadowedSeqs.length + " 条消息)"
        : "剪枝移除 " + shadowedSeqs.length + " 条历史消息"
    };
    if (isCompaction && shadowedSeqs.length > 0) event.count = shadowedSeqs.length;
    if (grossTokens > 0) event.grossTokens = grossTokens;
    this.events.push(event);
    if (isCompaction) this.counts.compactions += 1;
    else this.counts.prunes += 1;
  }

  // ---- surface 记账 ------------------------------------------------------
  addSurfaceNode(seq, cat, tokens, tool, info, surfaceOp) {
    const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
    // 1. 上一轮 compaction/prune 记下的待剪枝 seq (官方 pendingShadowedSeqs, :1688-1705)
    if (Array.isArray(this.pendingShadowedSeqs) && this.pendingShadowedSeqs.length > 0) {
      const dropped = this.dropSurfaceSeqs(this.pendingShadowedSeqs);
      const index = this.pendingShadowEventIndex;
      if (index >= 0 && this.events[index] && dropped.removedTokens > 0) {
        this.events[index] = {
          ...this.events[index],
          tokens: Math.max(0, dropped.removedTokens - value),
          grossTokens: dropped.removedTokens
        };
      }
      this.pendingShadowedSeqs = null;
      this.pendingShadowEventIndex = -1;
    }
    // 2. surfaceOp: { op:'replace', startSeq, endSeq } → 该区间旧节点被本节点替换 (官方 :1706-1717)
    const range = parseSurfaceOp(surfaceOp);
    if (range) {
      const drop = new Set();
      for (const key of this.surface.keys()) if (key >= range.start && key <= range.end) drop.add(key);
      this.dropSurfaceSeqs(drop);
    }
    const node = { seq, cat, tokens: value, tool: tool || undefined };
    this.surface.set(seq, node);
    if (this.sums[cat] !== undefined) this.sums[cat] += value;
    if (this.catCounts[cat] !== undefined) this.catCounts[cat] += 1;
    const detail = info && typeof info === "object" ? info : {};
    // 明细正文上限 24,000 字符 (旧实现 800): 超限才截断, 并在文本尾部标注原文长度
    const clippedFull = clipText(typeof detail.fullText === "string" ? detail.fullText : "", DSH_TEXT_LIMITS.itemFullText);
    const nodeRecord = {
      seq,
      cat,
      tokens: value,
      toolName: detail.toolName || (tool || cat),
      title: detail.title || cat,
      snippet: typeof detail.snippet === "string" ? detail.snippet.slice(0, 400) : "",
      fullText: clippedFull.text,
      fullTextTruncated: clippedFull.truncated,
      fullTextChars: clippedFull.originalChars,
      turn: detail.turn,
      step: detail.step
    };
    if (this.catNodes[cat]) {
      this.catNodes[cat].push(nodeRecord);
      if (this.catNodes[cat].length > 60) this.catNodes[cat].shift();
    }
    this.pendingInputNodes.push({
      seq,
      cat,
      tokens: value,
      toolName: detail.toolName || (tool || cat),
      title: detail.title || cat,
      snippet: typeof detail.snippet === "string" ? detail.snippet.slice(0, 160) : "",
      turn: detail.turn,
      step: detail.step
    });
    if (this.pendingInputNodes.length > 400) this.pendingInputNodes.shift();
    return node;
  }

  /** 移除指定 seq 的 surface 节点并回退 sums (官方 nr, :1618-1626) */
  dropSurfaceSeqs(seqSet) {
    const removed = [];
    let removedTokens = 0;
    for (const key of seqSet) {
      const node = this.surface.get(key);
      if (!node) continue;
      removed.push(node);
      removedTokens += node.tokens;
      if (this.sums[node.cat] !== undefined) this.sums[node.cat] -= node.tokens;
      if (this.catCounts[node.cat] !== undefined) {
        this.catCounts[node.cat] = Math.max(0, this.catCounts[node.cat] - 1);
      }
      this.surface.delete(key);
    }
    return { removed, removedTokens };
  }

  // ---- 收尾 --------------------------------------------------------------
  finish() {
    // 没有 step/start 的会话: 用会话首末时间裁剪工具 span 并做并集, 保证 toolsMs ⊆ wallMs
    if (!this.sawStepStart && this.toolSpans.length > 0) {
      const from = this.firstTime > 0 ? this.firstTime : 0;
      const to = this.lastTime > 0 ? this.lastTime : 0;
      const clipped = [];
      for (const span of this.toolSpans) {
        const start = Math.max(from, span.start);
        const end = Math.min(to, span.end);
        if (end > start) clipped.push({ start, end, name: span.name });
      }
      clipped.sort((a, b) => a.start - b.start || a.end - b.end);
      let covered = 0;
      let cursor = 0;
      for (const span of clipped) {
        const start = Math.max(cursor, span.start);
        if (span.end > start) {
          covered += span.end - start;
          cursor = span.end;
        }
      }
      this.timing.toolsMs = covered;
    }
    return buildResult(this);
  }
}

// ============================================================================
// 5. 辅助
// ============================================================================

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 把"按真实内容估算的相对占比"校准到"服务商回报的精确总量"。
 * 官方 README「估算值与实际值」即此口径: ≈ 估算占比 + 精确总量。
 * 余量按四舍五入补给最大项, 保证 sum(result) === target。
 */
export function calibrateBreakdown(raw, target) {
  const source = raw && typeof raw === "object" ? raw : {};
  const keys = Object.keys(source);
  const out = {};
  let rawSum = 0;
  let largestKey = keys[0];
  let largestRaw = -1;
  for (const key of keys) {
    const value = Math.max(0, Number(source[key]) || 0);
    out[key] = 0;
    rawSum += value;
    if (value > largestRaw) {
      largestRaw = value;
      largestKey = key;
    }
  }
  const goal = Math.max(0, Math.round(Number(target) || 0));
  if (rawSum <= 0 || goal <= 0 || keys.length === 0) return out;
  let assigned = 0;
  for (const key of keys) {
    const value = Math.max(0, Number(source[key]) || 0);
    const scaled = Math.round((value / rawSum) * goal);
    out[key] = scaled;
    assigned += scaled;
  }
  const remainder = goal - assigned;
  if (remainder !== 0) out[largestKey] = Math.max(0, out[largestKey] + remainder);
  return out;
}

/** 该轮次/步骤对应的用户输入 (user/message 事件不带 turn/step, 按 seq 位置归属) */
function resolveTurnUserSnippet(folder, step) {
  if (!folder || !step || !Array.isArray(folder.humanMessages)) return "";
  const list = folder.humanMessages;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].seq < step.seq) return list[i].text;
  }
  return "";
}

/** 官方 Me(): surfaceOp → {start,end} (只有 replace 才有区间) */
function parseSurfaceOp(surfaceOp) {
  if (!surfaceOp || typeof surfaceOp !== "object") return null;
  if (surfaceOp.op !== "replace") return null;
  const start = Number(surfaceOp.startSeq);
  const end = Number(surfaceOp.endSeq);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function findLastIndex(array, predicate) {
  for (let i = array.length - 1; i >= 0; i -= 1) if (predicate(array[i])) return i;
  return -1;
}

function parseExitFromDetail(detail) {
  if (typeof detail !== "string") return null;
  const match = /(?:^|;\s*)exit code: (\d+)\b/.exec(detail);
  if (match && match[1] !== undefined) return Number(match[1]);
  return null;
}

/** 官方 Ae/je (:1869-1878, :2034-2053): 从 stream 取首 token 时间与各段生成耗时 */
function firstStreamTime(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (const item of stream) {
    if (!item || typeof item !== "object") continue;
    const t = Number(item.time);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return undefined;
}

function sumDeltas(list) {
  if (!Array.isArray(list)) return 0;
  let total = 0;
  for (const value of list) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

/**
 * stream → { firstToken, reasoningMs, reasoningBlocks, textMs, textBlocks, toolArgMs, toolArgBlocks }
 * 官方 stream 里 text-chunks / reasoning-chunks / tool-call-chunks 的 dt[] 是逐 chunk 的毫秒增量,
 * 求和即该段真实生成耗时 (不用百分比摊派)。
 */
function streamSpansOf(stream, fallbackTime) {
  const out = {
    firstToken: undefined,
    reasoningMs: 0,
    reasoningBlocks: 0,
    textMs: 0,
    textBlocks: 0,
    toolArgMs: 0,
    toolArgBlocks: 0
  };
  if (!Array.isArray(stream)) {
    out.firstToken = Number.isFinite(fallbackTime) ? fallbackTime : undefined;
    return out;
  }
  for (const item of stream) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "chunk") {
      const t = Number(item.time);
      if (Number.isFinite(t) && t > 0 && out.firstToken === undefined) out.firstToken = t;
      continue;
    }
    const t0 = Number(item.time0);
    if (out.firstToken === undefined && Number.isFinite(t0) && t0 > 0) out.firstToken = t0;
    const total = sumDeltas(item.dt);
    if (item.type === "reasoning-chunks") {
      out.reasoningMs += total;
      out.reasoningBlocks += 1;
    } else if (item.type === "text-chunks") {
      out.textMs += total;
      out.textBlocks += 1;
    } else if (item.type === "tool-call-chunks") {
      out.toolArgMs += total;
      out.toolArgBlocks += 1;
    }
  }
  if (out.firstToken === undefined && Number.isFinite(fallbackTime)) out.firstToken = fallbackTime;
  return out;
}

/** 官方 qn/ar: 从 skill 工具结果里取技能名 */
function skillNameOf(text) {
  if (typeof text !== "string" || text === "") return "";
  const loaded = /Skill "([^"]+)" loaded/i.exec(text) || /skill:\s*([A-Za-z0-9._-]+)/i.exec(text);
  if (loaded && loaded[1]) return loaded[1].slice(0, 80);
  const head = text.split("\n")[0].trim();
  if (head.length > 0 && head.length <= 80) return head;
  return "";
}

/** 单条 usage → 缓存命中率 (百分比, 两位小数) */
function cacheRatePercent(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cacheRead = toFiniteNumber(usage.cacheReadTokens);
  const uncached = toFiniteNumber(usage.inputTokens);
  const cacheWrite = toFiniteNumber(usage.cacheWriteTokens);
  if (cacheRead === null) return null;
  const prompt = (uncached || 0) + cacheRead + (cacheWrite || 0);
  if (prompt <= 0) return null;
  return Number(((cacheRead / prompt) * 100).toFixed(2));
}

// ============================================================================
// 6. 结果组装
// ============================================================================

// ============================================================================
// 6a. 文本池 + 明细体积硬上限 (WKWebView 单会话分片 60MB 打爆 WebContent 进程)
// ============================================================================

/**
 * 文本保留上限 —— 修复"看不到消息详情"。
 *
 * 旧实现把明细正文硬截到 400/160/800 三种长度 (池里最多 800 字符), 系统提示词
 * (实测 9,919 tok ≈ 2.4 万字符) 只留得下 400 字符, 页面自然看不到详情。
 * 现在按"够读全文"的上限保留, 只有超过上限才截断, 并在文本尾部标注原文长度:
 *   itemFullText  24,000 字符 —— items[].fullText / 池内全文 (≈1.2 万 token)
 *   systemSummary 20,000 字符 —— 系统提示词全文
 *   schemaText    12,000 字符 —— 单个工具 schema 的 JSON
 * 截断时条目会带 truncated: true, 文本末尾追加 "…(已截断, 原文 N 字符)"。
 * 体积仍由 textPool 去重 + 分片预算 (DSH_PAYLOAD_LIMITS) 守住, 不是靠砍正文。
 */
export const DSH_TEXT_LIMITS = {
  itemFullText: 24000,
  systemSummary: 20000,
  schemaText: 12000
};

/**
 * 超限截断 + 末尾标注。不修改入参, 返回 { text, truncated, originalChars }。
 * 未超限时原样返回 (truncated=false), 因此短文本行为与旧实现完全一致。
 */
export function clipText(text, limit) {
  if (typeof text !== "string") return { text: "", truncated: false, originalChars: 0 };
  if (text === "" || !Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return { text, truncated: false, originalChars: text.length };
  }
  return {
    text: text.slice(0, limit) + "…(已截断, 原文 " + text.length + " 字符)",
    truncated: true,
    originalChars: text.length
  };
}

/**
 * 文本池 + 体积硬上限的可调参数 (导出便于运维调参与测试对照)。
 * poolMinFullText: 全文入池阈值, 更短的留在 items.fullText 里, 省掉池下标开销
 * poolMinSnippet: snippet 入池阈值 (snippet 上限 160/400, 跨步重复度极高)
 * budgetBytes: steps[].browserCategories (含 textPool 中被引用的全文) 体积预算
 * keepSteps: 折叠时保留最近多少步的完整 items (与 daemon 的 120 步降采样对齐)
 */
export const DSH_BROWSER_LIMITS = {
  poolMinFullText: 200,
  poolMinSnippet: 96,
  snippetPreviewChars: 60,
  budgetBytes: 12 * 1024 * 1024,
  keepSteps: 120
};

/**
 * 单会话详情分片预算。daemon 侧 DETAIL_PAYLOAD_SOFT_LIMIT = 12MB (WKWebView 承受上限),
 * 数据层自己先守住, 并预留 headroom 给 daemon 的包装文本/索引开销:
 *   shardBytes 分片硬上限 12MB;  budgetBytes = shardBytes - headroomBytes (11.5MB)
 *   keepStepsLadder: 超预算时按阶梯减少"保留明细的最近步数"(120→100→80→60→40→20),
 *     统计口径 (stats/turns/commands/fileOps) 一律不动。
 *     **最后一档不再是 0**: 全清 items 会让 1500 步会话每一步 7 个分类都显示
 *     「未保留独立条目明细」; 这里只负责把 dshContext 压到合理范围, 剩余体积由
 *     daemon 的 trimDetailPayloadInPlace 兜底 (它能看到 s.turns, 裁正文比清条目更有效)。
 */
export const DSH_PAYLOAD_LIMITS = {
  shardBytes: 12 * 1024 * 1024,
  headroomBytes: 512 * 1024,
  get budgetBytes() {
    return this.shardBytes - this.headroomBytes;
  },
  keepStepsLadder: [120, 100, 80, 60, 40, 20],
  // 估算体积小于这个值时不必真跑 JSON.stringify (小会话零开销)
  probeBytes: 2 * 1024 * 1024
};

const strLen = (v) => (typeof v === 'string' ? v.length : 0);

/**
 * 把文本放进池里, 返回池下标 (同一字符串只入池一次)。
 * 调用方负责判断是否值得池化。
 */
function poolText(text, pool, poolIndex) {
  const hit = poolIndex.get(text);
  if (hit !== undefined) return hit;
  const idx = pool.length;
  pool.push(text);
  poolIndex.set(text, idx);
  return idx;
}

/**
 * 把一组分类里的 items 做池化: fullText -> tx, snippet -> sx。
 * 向后兼容: 任何消费方用 item.fullText || textPool[item.tx] 都能拿到全文。
 */
function packBrowserCategoryItems(cat, pool, poolIndex) {
  const items = cat && cat.items;
  if (!Array.isArray(items) || items.length === 0) return cat;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.fullText === 'string' && item.fullText.length >= DSH_BROWSER_LIMITS.poolMinFullText) {
      item.tx = poolText(item.fullText, pool, poolIndex);
      delete item.fullText;
    }
    if (typeof item.snippet === 'string' && item.snippet.length >= DSH_BROWSER_LIMITS.poolMinSnippet) {
      const fullSnippet = item.snippet;
      item.sx = poolText(fullSnippet, pool, poolIndex);
      // 留一小段内联预览: page 侧的摘要位 (item.snippet) 不用同步改造也能显示
      item.snippet = fullSnippet.slice(0, DSH_BROWSER_LIMITS.snippetPreviewChars);
    }
  }
  return cat;
}

/**
 * 估算 steps[].browserCategories 的 JSON 体积。
 * 不真正 JSON.stringify (会临时造出 46MB 字符串), 用字段长度 + 骨架开销近似。
 */
export function estimateCategoriesBytes(steps, pool = null) {
  if (!Array.isArray(steps)) return 0;
  let bytes = 0;
  // 池引用去重: items[].tx/sx 指向 textPool, 同一段文本被 N 步引用也只算一份体积。
  // 不传 pool 时行为与旧版一致 (只算内联 fullText/snippet), 供老测试/调用方兼容。
  const referenced = Array.isArray(pool) ? new Set() : null;
  for (const step of steps) {
    const cats = step && step.browserCategories;
    if (!Array.isArray(cats)) continue;
    for (const cat of cats) {
      if (!cat) continue;
      bytes += 120; // {key,label,name,count,tokens,formatted,percent,color,items} 骨架
      const items = cat.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item) continue;
        bytes += 88; // 字段名 + 标点 + idx/tokens 等数字
        bytes += strLen(item.id) + strLen(item.title) + strLen(item.toolName) + strLen(item.diff);
        bytes += strLen(item.snippet) + strLen(item.fullText);
        if (referenced) {
          for (const field of ["tx", "sx"]) {
            const index = item[field];
            if (typeof index !== "number" || referenced.has(index)) continue;
            referenced.add(index);
            bytes += strLen(pool[index]);
          }
        }
      }
    }
  }
  return bytes;
}

/**
 * 体积硬上限: browserCategories 总量超预算时, 只折叠较早步骤的 items 明细
 * (保留 {key,label,count,tokens,...}), 最近 keepSteps 步保持完整。
 * 只动 UI 明细, 绝不改 stats/steps.length/commands/fileOps 等真实统计。
 */
export function applyBrowserCategoriesBudget(steps, limitBytes, keepSteps, pool = null) {
  const report = { bytesBefore: 0, bytesAfter: 0, trimmedSteps: 0, trimmed: false, keepSteps };
  if (!Array.isArray(steps) || steps.length === 0) return report;
  report.bytesBefore = estimateCategoriesBytes(steps, pool);
  if (report.bytesBefore <= limitBytes) {
    report.bytesAfter = report.bytesBefore;
    return report;
  }
  report.trimmedSteps = foldItemsOlderThan(steps, keepSteps);
  report.trimmed = report.trimmedSteps > 0;
  report.bytesAfter = estimateCategoriesBytes(steps, pool);
  return report;
}

/**
 * 把较早步骤的 items 折叠成**紧凑条目**(只留 id/idx/title/toolName/tokens, 去掉正文)。
 * 目的: 大会话在 12MB 预算下原本会把 items 整个清空, 导致整片『暂无独立明细条目』;
 * 紧凑化后列表仍能看到"这一步的上下文里有什么", 只是正文需要回源查看。
 * 幂等: 已是紧凑条目(compact:1)的跳过。
 */
export function foldItemsToCompact(steps, keepSteps) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const keep = Math.max(0, Number.isFinite(keepSteps) ? keepSteps : 0);
  const cut = Math.max(0, steps.length - keep);
  let folded = 0;
  for (let i = 0; i < cut; i += 1) {
    const cats = steps[i] && steps[i].browserCategories;
    if (!Array.isArray(cats)) continue;
    let touched = false;
    for (const cat of cats) {
      if (!cat || !Array.isArray(cat.items) || cat.items.length === 0) continue;
      if (cat.items.every((it) => it && it.compact === 1)) continue;
      cat.items = cat.items.map((it) => {
        const compactItem = {
          id: it && it.id,
          idx: it && it.idx,
          title: it && it.title,
          toolName: it && it.toolName,
          tokens: it && it.tokens,
          compact: 1
        };
        // 池引用必须随条目保留: 正文已移到 textPool, 折叠若丢掉 tx/sx,
        // compactTextPool 会视为「无人引用」而把整个池清空, 详情就再也取不回。
        if (it && typeof it.tx === "number") compactItem.tx = it.tx;
        if (it && typeof it.sx === "number") compactItem.sx = it.sx;
        // 短文本没有入池 (tx/sx 不存在) → 正文/摘要仍要原样保留, 不能因紧凑化丢掉
        if (it && typeof it.tx !== "number" && typeof it.fullText === "string") compactItem.fullText = it.fullText;
        // 截断标记必须随条目保留: 正文在 clipText 阶段已截断并带「…(已截断, 原文 N 字符)」标注,
        // 但紧凑化若丢掉 truncated, 消费方会把「已截断」误当成「完整正文」——
        // 真实数据抽检 (dsh_events_fleet_payload) 就是靠这条断言抓到的。
        if (it && it.truncated === true) compactItem.truncated = true;
        // page 摘要位直接用 item.snippet: 池化后保留内联预览 (池内摘要的前缀), 否则列表变空白
        if (it && typeof it.snippet === "string" && it.snippet !== "") compactItem.snippet = it.snippet;
        return compactItem;
      });
      cat.itemsCompactOnly = true;
      touched = true;
    }
    if (touched) folded += 1;
  }
  return folded;
}

/**
 * 折叠较早步骤的 items 明细 (只留最近 keepSteps 步), 返回被折叠的步数。
 * 幂等: 重复调用/更小的 keepSteps 都会继续折叠更早的步骤; 分类骨架与 count/tokens 不动。
 */
export function foldItemsOlderThan(steps, keepSteps) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const keep = Math.max(0, Number.isFinite(keepSteps) ? keepSteps : 0);
  const cut = Math.max(0, steps.length - keep);
  let trimmedSteps = 0;
  for (let i = 0; i < cut; i += 1) {
    const cats = steps[i] && steps[i].browserCategories;
    if (!Array.isArray(cats)) continue;
    let touched = false;
    for (const cat of cats) {
      if (!cat || !Array.isArray(cat.items) || cat.items.length === 0) continue;
      cat.items = [];
      cat.itemsTrimmed = true;
      touched = true;
    }
    if (touched) trimmedSteps += 1;
  }
  return trimmedSteps;
}

/**
 * 池压缩: 裁剪后扔掉已无引用的池条目, 并就地重映射 tx/sx。
 * 顺带保证池里同一字符串只出现一次。
 */
function compactTextPool(pool, steps) {
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const remap = new Map();
  const next = [];
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const field of ['tx', 'sx']) {
      const idx = item[field];
      if (typeof idx !== 'number') continue;
      let to = remap.get(idx);
      if (to === undefined) {
        to = next.length;
        next.push(pool[idx]);
        remap.set(idx, to);
      }
      item[field] = to;
    }
  };
  for (const step of steps || []) {
    const cats = step && step.browserCategories;
    if (!Array.isArray(cats)) continue;
    for (const cat of cats) {
      const items = cat && cat.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) visit(item);
    }
  }
  return next;
}

/** 兼容读法: item.fullText || resolvePooledText(session, item.tx) */
function resolvePooledText(session, idx) {
  if (typeof idx !== 'number') return '';
  const pool = (session && session.dshContext && session.dshContext.textPool)
    || (session && session.textPool)
    || [];
  const text = pool[idx];
  return typeof text === 'string' ? text : '';
}

/** 取浏览器条目全文 (旧数据走 fullText, 新数据走池下标 tx) */
export function resolveItemFullText(session, item) {
  if (!item) return '';
  if (typeof item.fullText === 'string' && item.fullText.length > 0) return item.fullText;
  return resolvePooledText(session, item.tx);
}

/** 取浏览器条目摘要 (旧数据走 snippet, 新数据走池下标 sx) */
export function resolveItemSnippet(session, item) {
  if (!item) return '';
  const pooled = resolvePooledText(session, item.sx);
  if (pooled.length > 0) return pooled;
  if (typeof item.snippet === 'string' && item.snippet.length > 0) return item.snippet;
  return typeof item.title === 'string' ? item.title : '';
}
// ---------------------------------------------------------------------------
// 分片预算: 数据层自己守住"单分片 ≤ 12MB"
// (daemon 侧 DETAIL_PAYLOAD_SOFT_LIMIT 只是兜底; 这里先按真实字节收敛)
// ---------------------------------------------------------------------------

/** 真实 JSON 体积 (UTF-8 字节) */
export function measureJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

/** steps[] 里"非 browserCategories"字段的体积估算 (字符串/数组骨架, 不 stringify) */
export function estimateStepsBytes(steps) {
  if (!Array.isArray(steps)) return 0;
  let bytes = 0;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    bytes += 200; // {idx,turnIdx,stepInTurn,tokens,time,...} 骨架
    for (const key of Object.keys(step)) {
      if (key === "browserCategories") continue; // 单独按分类明细口径算
      const value = step[key];
      if (typeof value === "string") bytes += value.length;
      else if (Array.isArray(value)) {
        bytes += 8;
        for (const entry of value) bytes += typeof entry === "string" ? entry.length + 4 : 24;
      } else if (value && typeof value === "object") bytes += 96;
    }
  }
  return bytes;
}

/** turns[].messages[] 正文体积估算 (只数文本字段, 不 stringify) */
export function estimateTurnsBytes(turns) {
  if (!Array.isArray(turns)) return 0;
  let bytes = 0;
  for (const turn of turns) {
    bytes += 200; // 轮次骨架
    const messages = turn && Array.isArray(turn.messages) ? turn.messages : [];
    for (const message of messages) {
      if (!message) continue;
      bytes += 160 + strLen(message.fullText) + strLen(message.thinking) + strLen(message.text);
      bytes += strLen(message.snippet) + strLen(message.content);
    }
  }
  return bytes;
}

/**
 * 分片预算守卫 (纯 UI 明细降采样, 绝不改统计口径)。
 * 1) 便宜估算: browserCategories(含池引用) + turns 正文 + 步骤骨架, 小于 probeBytes 直接放过;
 * 2) 否则真测 JSON 字节, 超预算就按 keepStepsLadder 阶梯折叠更早步骤的 items,
 *    每次折叠后压缩文本池再重测, 直到落回预算或阶梯用尽。
 */
export function applyPayloadBudget(result, keepSteps = DSH_BROWSER_LIMITS.keepSteps) {
  const report = {
    limitBytes: DSH_PAYLOAD_LIMITS.shardBytes,
    budgetBytes: DSH_PAYLOAD_LIMITS.budgetBytes,
    bytes: 0,
    measured: false,
    keepSteps: keepSteps,
    keepStepsUsed: keepSteps,
    trimRounds: 0,
    trimmedSteps: 0,
    trimmed: false,
    skipped: false
  };
  if (!result || typeof result !== "object") return report;
  // 显式放开明细预算 (测试对照/运维调试把 budgetBytes 调到远超分片上限) 时,
  // 分片守卫一并让位 —— 否则"关掉降采样"的对照实验测不出真实体积。
  const categoryBudget = DSH_BROWSER_LIMITS.budgetBytes;
  if (!Number.isFinite(categoryBudget) || categoryBudget > DSH_PAYLOAD_LIMITS.shardBytes * 8) {
    report.skipped = true;
    return report;
  }
  const steps = Array.isArray(result.steps) ? result.steps : [];
  let pool = Array.isArray(result.textPool) ? result.textPool : [];

  // 便宜估算 (含 steps 非分类字段/命令/文件操作/事件骨架): 远低于 probeBytes 的会话
  // 不可能触到 12MB, 直接放过, 不白跑 JSON.stringify
  const estimate = estimateCategoriesBytes(steps, pool)
    + estimateStepsBytes(steps)
    + estimateTurnsBytes(result.turns)
    + (Array.isArray(result.commands) ? result.commands.length : 0) * 96
    + (Array.isArray(result.fileOps) ? result.fileOps.length : 0) * 96
    + (Array.isArray(result.events) ? result.events.length : 0) * 96;
  if (estimate <= DSH_PAYLOAD_LIMITS.probeBytes) {
    report.bytes = estimate;
    return report;
  }

  report.measured = true;
  let bytes = measureJsonBytes(result);
  if (bytes <= DSH_PAYLOAD_LIMITS.budgetBytes) {
    report.bytes = bytes;
    return report;
  }
  // 阶段一: 先把所有步骤的 items 折叠成**紧凑条目**(只去正文, 保留标题/tokens)。
  // 体积通常骤降; 达标就不再走下面"清空 items"的阶梯 —— 这样大会话也不会整片『暂无独立明细条目』。
  const compactedSteps = foldItemsToCompact(steps, 0);
  if (compactedSteps > 0) {
    report.compactedSteps = compactedSteps;
    report.trimRounds += 1;
    report.trimmed = true;
    pool = compactTextPool(pool, steps);
    result.textPool = pool;
    bytes = measureJsonBytes(result);
    if (bytes <= DSH_PAYLOAD_LIMITS.budgetBytes) {
      report.bytes = bytes;
      report.keepStepsUsed = 0;
      return report;
    }
  }

  const ladder = [keepSteps].concat(DSH_PAYLOAD_LIMITS.keepStepsLadder.filter((n) => n < keepSteps));
  for (const keep of ladder) {
    if (keep !== keepSteps) {
      const folded = foldItemsOlderThan(steps, keep);
      if (folded > 0) {
        report.trimmedSteps += folded;
        report.trimRounds += 1;
        report.keepStepsUsed = keep;
      }
      // 折叠后池里可能有没人引用的全文, 立刻压缩再测 (否则预算永远下不来)
      pool = compactTextPool(pool, steps);
      result.textPool = pool;
      bytes = measureJsonBytes(result);
    }
    if (bytes <= DSH_PAYLOAD_LIMITS.budgetBytes) break;
  }
  // 阶梯用尽仍超 12MB 硬上限: 命令记录瘦身 + 丢旧步 DNA 条带 + 清 commandCalls。
  // 这三项页面都不读原文 (命令卡只用 cmd/program/status/ms/background/time/turn/step),
  // 比继续清空 items 更划算 —— 明细条目必须留住, 否则每步每类都会显示「未保留独立条目明细」。
  if (bytes > DSH_PAYLOAD_LIMITS.shardBytes) {
    let changed = 0;
    const KEEP_COMMAND_FIELDS = new Set(["cmd", "program", "status", "ms", "background", "time", "turn", "step", "tag", "tool", "isError", "exitCode", "killed"]);
    for (const command of Array.isArray(result.commands) ? result.commands : []) {
      if (!command || typeof command !== "object") continue;
      for (const key of Object.keys(command)) {
        if (KEEP_COMMAND_FIELDS.has(key)) continue;
        delete command[key];
        changed += 1;
      }
      if (typeof command.cmd === "string" && command.cmd.length > 300) {
        command.cmd = command.cmd.slice(0, 300) + "…";
      }
    }
    if (steps.length > 60) {
      for (let i = 0; i < steps.length - 60; i += 1) {
        if (steps[i] && Array.isArray(steps[i].dnaBands) && steps[i].dnaBands.length > 0) {
          steps[i].dnaBands = [];
          changed += 1;
        }
      }
    }
    const meta = result.sessionMeta;
    if (meta && Array.isArray(meta.commandCalls) && meta.commandCalls.length > 0) {
      meta.commandCalls = [];
      changed += 1;
    }
    if (changed > 0) {
      report.trimRounds += 1;
      report.trimmed = true;
      bytes = measureJsonBytes(result);
    }
  }

  report.bytes = bytes;
  report.trimmed = report.trimRounds > 0;
  return report;
}

function buildResult(folder) {
  const bounds = DSH_EVENT_BOUNDS;
  const sums = folder.sums;
  const systemTokens = folder.systemTokens;
  const toolsTokens = folder.toolsTokens;
  const compositionTotal =
    systemTokens + toolsTokens + sums.user + sums.inject + sums.skill + sums.assistant + sums.tool;

  // ---- 7 大当前上下文分类 (官方 Nn :1436-1437) ----
  // 校准口径: 分类的**相对占比**由真实内容长度估算得出 (官方估算器), **总量**校准到服务商
  // 精确回报的末次 prompt (usage.input+cacheRead+cacheWrite) —— 与官方 README「估算值与实际值」
  // 一致 (≈ 估算占比 + 精确总量)。这样 sum(curCategories.tokens) === currentTokens 恒成立。
  const lastRequest = folder.requests.length > 0 ? folder.requests[folder.requests.length - 1] : null;
  const lastPrompt = lastRequest && Number(lastRequest.prompt) > 0 ? Number(lastRequest.prompt) : 0;
  const rawCategoryTokens = {
    system: systemTokens,
    tools: toolsTokens,
    user: sums.user,
    inject: sums.inject,
    skill: sums.skill,
    assistant: sums.assistant,
    tool: sums.tool
  };
  let rawCategorySum = 0;
  for (const key of Object.keys(rawCategoryTokens)) rawCategorySum += rawCategoryTokens[key] || 0;
  const currentTokens = lastPrompt > 0 ? lastPrompt : Math.round(rawCategorySum);
  const calibratedCategories = calibrateBreakdown(rawCategoryTokens, currentTokens);
  const curCategories = normalizePercents(CONTEXT_CATEGORY_META.map((meta) => {
    const raw = Math.round(rawCategoryTokens[meta.key] || 0);
    const tokens = calibratedCategories[meta.key];
    return {
      key: meta.key,
      label: meta.label,
      name: meta.label,
      count: folder.catCounts[meta.key] || 0,
      tokens,
      rawTokens: raw,
      formatted: formatK(tokens),
      percent: rawCategorySum > 0 ? Number(((raw / rawCategorySum) * 100).toFixed(1)) : 0,
      color: meta.color
    };
  }), 1);

  // ---- steps: 每 assistant/message 一条 (官方 un) ----
  // totalTokens = 该次请求的真实 prompt (usage), breakdown 按真实占比校准后求和等于 totalTokens
  const steps = folder.steps.slice(-bounds.maxRequestSteps);
  const stepsTrimmed = folder.steps.length - steps.length;
  let previousStepTotal = 0;
  steps.forEach((step, index) => {
    const turnRecord = folder.turnIndex.get(step.turnIdx);
    step.totalStepsInTurn = turnRecord ? turnRecord.stepsCount : 1;
    step.userSnippet = resolveTurnUserSnippet(folder, step);
    const rawBreakdown = step.breakdown && typeof step.breakdown === "object"
      ? step.breakdown
      : { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 };
    let rawStepSum = 0;
    for (const key of Object.keys(rawBreakdown)) rawStepSum += rawBreakdown[key] || 0;
    const stepTotal = Number(step.promptTokens) > 0 ? Number(step.promptTokens) : Math.round(rawStepSum);
    step.composedTokens = Math.round(rawStepSum);
    step.breakdown = calibrateBreakdown(rawBreakdown, stepTotal);
    step.totalTokens = stepTotal;
    step.tokenDelta = index === 0 ? stepTotal : stepTotal - previousStepTotal;
    previousStepTotal = stepTotal;
    step.dnaBands = buildDnaBands(step.breakdown, step.turnIdx, step.stepInTurn, step.timestamp);
  });

  // ---- turns 聚合 ----
  const turnRecords = folder.turns.slice().sort((a, b) => a.turnIdx - b.turnIdx);
  const turnsAgg = turnRecords.map((record) => {
    const ownSteps = steps.filter((step) => step.turnIdx === record.turnIdx);
    const lastStep = ownSteps.length > 0 ? ownSteps[ownSteps.length - 1] : null;
    const totalTokens = lastStep ? lastStep.totalTokens : 0;
    const prevTurn = turnRecords.find((t) => t.turnIdx < record.turnIdx);
    let prevTotal = 0;
    if (prevTurn) {
      const prevSteps = steps.filter((step) => step.turnIdx === prevTurn.turnIdx);
      prevTotal = prevSteps.length > 0 ? prevSteps[prevSteps.length - 1].totalTokens : 0;
    }
    // 未收到 turn/end 的进行中轮次: 用会话末事件时间兜底 (真实时间戳, 非估算)
    const turnEnd = record.endTime > 0 ? record.endTime : folder.lastTime;
    const durationMs = record.startTime > 0 && turnEnd > record.startTime ? turnEnd - record.startTime : 0;
    let outputTokens = 0;
    let cacheHit = null;
    for (const step of ownSteps) {
      outputTokens += step.outputTokens || 0;
      if (cacheHit === null && step.cacheHit !== null && step.cacheHit !== undefined) cacheHit = step.cacheHit;
    }
    return {
      turnIdx: record.turnIdx,
      stepsCount: ownSteps.length,
      time: record.startTime || (lastStep ? lastStep.time : 0),
      timestamp: formatClock(record.startTime || (lastStep ? lastStep.time : 0)),
      totalTokens,
      tokenDelta: prevTotal === 0 ? totalTokens : totalTokens - prevTotal,
      outputTokens,
      cacheHit,
      durationSec: Math.round(durationMs / 1000),
      durationFormatted: formatDurationSeconds(Math.round(durationMs / 1000)),
      reason: record.reason,
      userSnippet:
        record.userSnippet ||
        (lastStep ? lastStep.userSnippet : "") ||
        (ownSteps.length > 0 ? resolveTurnUserSnippet(folder, ownSteps[0]) : "") ||
        "",
      inputSnippet: lastStep ? lastStep.inputSnippet : "",
      breakdown: lastStep ? lastStep.breakdown : {
        system: systemTokens,
        tools: toolsTokens,
        user: sums.user,
        inject: sums.inject,
        skill: sums.skill,
        assistant: sums.assistant,
        tool: sums.tool
      },
      browserCategories: lastStep
        ? lastStep.browserCategories.map((cat) => ({
            key: cat.key,
            name: cat.name,
            count: cat.count,
            tokens: cat.tokens,
            formatted: cat.formatted,
            percent: cat.percent,
            color: cat.color
          }))
        : []
    };
  });

  // ---- 事件 (含 turn/step 反查, 官方 jn :1396-1406) ----
  const events = attachTurnStep(folder.events, folder.requests).slice(-bounds.maxEvents).map((event) => ({
    ...event,
    at: event.turn !== undefined ? "T" + event.turn + (event.step !== undefined ? " S" + event.step : "") : "",
    timeText: formatClock(event.time)
  }));

  // ---- token 统计 (真值 usage + 官方估算分类) ----
  const usageTotal = folder.usage.reportedTotal > 0
    ? folder.usage.reportedTotal
    : folder.usage.uncached + folder.usage.output + folder.usage.cacheRead + folder.usage.cacheWrite;
  const promptTotal = folder.usage.uncached + folder.usage.cacheRead + folder.usage.cacheWrite;
  const cacheHitRate =
    promptTotal > 0 ? ((folder.usage.cacheRead / promptTotal) * 100).toFixed(2) : "0.00";
  // 分类 = 逐请求累计的真实内容估算 (计费 Token 用在了哪里); 总量校准到服务商回报的计费总量
  const cumulative = folder.cumulativeCategories;
  const tokenCategoryRaw = {
    system: cumulative.system,
    tools: cumulative.tools,
    user: cumulative.user,
    inject: cumulative.inject,
    skill: cumulative.skill,
    toolCall: cumulative.tool + folder.generated.call,
    thinking: folder.generated.reasoning,
    reply: folder.generated.answer
  };
  let tokenSum = 0;
  for (const key of Object.keys(tokenCategoryRaw)) tokenSum += tokenCategoryRaw[key] || 0;
  const calibratedTokenCategories = calibrateBreakdown(
    tokenCategoryRaw,
    usageTotal > 0 ? usageTotal : Math.round(tokenSum)
  );
  const tokenCategories = normalizePercents(TOKEN_CATEGORY_META.map((meta) => {
    const raw = Math.round(tokenCategoryRaw[meta.key] || 0);
    const tokens = calibratedTokenCategories[meta.key];
    return {
      key: meta.key,
      label: meta.label,
      tokens,
      rawTokens: raw,
      formatted: formatK(tokens),
      percent: tokenSum > 0 ? Number(((raw / tokenSum) * 100).toFixed(2)) : 0,
      color: meta.color
    };
  }), 2);

  // ---- 耗时统计 (全部真实时间戳) ----
  const timing = folder.timing;
  const wallMs = timing.wallMs > 0
    ? timing.wallMs
    : folder.firstTime > 0 && folder.lastTime > folder.firstTime
      ? folder.lastTime - folder.firstTime
      : 0;
  const measuredMs = timing.ttftMs + timing.reasoningMs + timing.textMs + timing.toolArgMs + timing.toolsMs;
  const otherMs = Math.max(0, wallMs - measuredMs);
  const genMs = timing.reasoningMs + timing.textMs + timing.toolArgMs;
  const speed = genMs > 0 ? Number(((folder.usage.output / genMs) * 1000).toFixed(1)) : 0;
  const timingBuckets = [
    { key: "modelWait", ms: timing.ttftMs, blocks: timing.calls, unit: "次" },
    { key: "thinking", ms: timing.reasoningMs, blocks: timing.reasoningBlocks, unit: "内容块" },
    { key: "reply", ms: timing.textMs, blocks: timing.textBlocks, unit: "内容块" },
    { key: "toolParam", ms: timing.toolArgMs, blocks: timing.toolArgBlocks, unit: "内容块" },
    { key: "toolExec", ms: timing.toolsMs, blocks: timing.toolCalls, unit: "次" },
    { key: "other", ms: otherMs, blocks: 0, unit: "" }
  ];
  const timingSum = timingBuckets.reduce((acc, bucket) => acc + bucket.ms, 0);
  const timingCategories = normalizePercents(timingBuckets.map((bucket) => {
    const meta = TIMING_CATEGORY_META.find((item) => item.key === bucket.key) || { label: bucket.key, color: "#94a3b8" };
    const percent = timingSum > 0 ? Number(((bucket.ms / timingSum) * 100).toFixed(1)) : 0;
    const detailParts = [];
    if (bucket.ms > 0) detailParts.push(formatDurationHm(bucket.ms));
    if (bucket.blocks > 0) detailParts.push(bucket.blocks + bucket.unit);
    return {
      key: bucket.key,
      label: meta.label,
      percent,
      detail: detailParts.length > 0 ? detailParts.join(" · ") : "0",
      ms: Math.round(bucket.ms),
      color: meta.color
    };
  }), 1);
  const ruler = buildRuler(wallMs);

  // ---- 统计汇总 (全部来自事件流) ----
  // 工具调用口径 (官方 Nn :1438 + Xn :1596):
  //   - Snapshot.toolCalls = surface 里 cat==='tool'|'skill' 的节点数 → 只统计**顶层** tool/call。
  //     PTC 程序内的嵌套调用 (tool/ptc-dispatch) 官方只计入文件活动与命令执行, 不计入工具调用总数。
  //   - toolTally / tools 时间表则包含嵌套调用 (官方在 ptc-dispatch 分支也调用 Xn)。
  const toolTally = Object.fromEntries([...folder.toolTally.entries()].sort((a, b) => b[1] - a[1]));
  const toolCallsByName = Object.fromEntries([...folder.topLevelTally.entries()].sort((a, b) => b[1] - a[1]));
  const toolCallBuckets = { bash: 0, read: 0, edit: 0, other: 0 };
  for (const [name, count] of folder.topLevelTally.entries()) {
    if (name === "bash" || name === "pwsh") toolCallBuckets.bash += count;
    else if (name === "read" || name === "read_image") toolCallBuckets.read += count;
    else if (name === "write" || name === "edit") toolCallBuckets.edit += count;
    else toolCallBuckets.other += count; // 含 run_code (code-mode 包装器)
  }

  const fileOpsResult = callDshFileOps(folder);

  // 官方 Snapshot.counts.toolCalls = surface 里 cat==='tool'|'skill' 且带 tool 的节点数
  // (off-index.pretty.mjs:1413-1414) —— 这是 KPI 统计卡"工具调用"的官方口径。
  let skillNodesWithTool = 0;
  for (const node of folder.surface.values()) {
    if (node.cat === "skill" && node.tool !== undefined) skillNodesWithTool += 1;
  }
  const surfaceToolCalls = (folder.catCounts.tool || 0) + skillNodesWithTool;

  // ---- 编队 / 子 Agent 聚合 (页面"编队"面板读 dshContext.fleet) -----------------
  // 数据源全部是真实事件, 没有数据就是空数组/0, 不做任何兜底编造:
  //   subagent/catalog    → 子 Agent 目录 (childId 唯一; name 可选, 不依赖 name 去重)
  //   team/member         → 编队成员 (member.id 与 subagent.childId 同源)
  //   team/task           → 任务板任务 (同 id 多条时保留 revision 最大的一条)
  //   team/mode           → 编队开关
  //   subagent/descriptor → 本会话自身是子 Agent 时的描述 (child 会话 seq 0)
  const fleetSubagents = [...folder.subagentMap.values()];
  const fleetMembers = [...folder.teamMembers.values()];
  const fleetTasks = [...folder.teamTasks.values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((task) => {
      const record = {
        id: task.id,
        title: task.subject,
        status: task.status,
        revision: task.revision
      };
      const ownerId = task.ownerId;
      if (ownerId !== "") {
        record.ownerId = ownerId;
        // assignee 只能是"可读的成员名": 成员事件缺失时宁可只给 ownerId, 也不把 id 伪装成人名
        const owner = folder.teamMembers.get(ownerId);
        if (owner) record.assignee = owner.name || owner.id;
      }
      if (Array.isArray(task.blockedBy) && task.blockedBy.length > 0) record.blockedBy = task.blockedBy.slice(0, 20);
      if (Array.isArray(task.writeScopes) && task.writeScopes.length > 0) record.writeScopes = task.writeScopes.slice(0, 20);
      return record;
    });
  const fleet = {
    subagentCount: fleetSubagents.length,
    subagents: fleetSubagents,
    tasks: fleetTasks,
    members: fleetMembers,
    teamEnabled: folder.teamMode === null ? false : !!folder.teamMode,
    descriptor: folder.subagentDescriptor
  };

  const stats = {
    // 官方 counts 结构 (lib/index.d.ts:144-151 TimelineCounts)
    counts: {
      turns: folder.counts.turns,
      steps: steps.length,
      injects: folder.counts.injects,
      compactions: folder.counts.compactions,
      prunes: folder.counts.prunes,
      skills: folder.skills.size,
      toolCalls: surfaceToolCalls
    },
    toolCallsSurface: surfaceToolCalls,
    turnsCount: folder.counts.turns,
    // 唯一真源: steps 数组长度 (验收: stats.stepsCount === dshContext.steps.length)
    stepsCount: steps.length,
    stepsTotal: folder.counts.steps,
    skillsCount: folder.skills.size,
    answersCount: folder.answers,
    humanInputs: folder.humanInputs,
    events: {
      inject: folder.counts.injects,
      compact: folder.counts.compactions,
      prune: folder.counts.prunes
    },
    io: fileOpsResult.io,
    toolCalls: toolCallBuckets,
    toolCallsByName,
    toolCallsTotal: [...folder.topLevelTally.values()].reduce((a, b) => a + b, 0),
    toolCallsAllByName: toolTally,
    toolCallsAllTotal: [...folder.toolTally.values()].reduce((a, b) => a + b, 0),
    // 不去重的原始结果计数 (含重放重复项), 仅供口径核对
    toolCallsRaw: {
      total: [...folder.rawToolTally.values()].reduce((a, b) => a + b, 0),
      byName: Object.fromEntries([...folder.rawToolTally.entries()].sort((a, b) => b[1] - a[1]))
    },
    // legacy 兼容: app.js 的统计条读 cmd.head/grep/echo/other, 这里把真实程序分布折进这 4 个桶,
    // 保证 head+grep+echo+other === 真实命令总数; 完整分布见 commandsByProgram / commandStats。
    commands: bucketizePrograms(fileOpsResult.commandStats),
    commandStats: fileOpsResult.commandStatsDetail,
    commandsByProgram: fileOpsResult.programs,
    // 编队摘要 (与 dshContext.fleet 同源, 保证页面两处读数一致)
    //   current      = "当前 Agent 累计 token": 本会话 usage 全部字段求和
    //                  (input + cacheRead + cacheWrite + output), 即这个 Agent 到目前为止
    //                  吃进去+吐出来的 token 总量。**不是**当前上下文窗口占用
    //                  (那个看 currentContext.currentTokens / stats.currentContext)。
    //   subCount     = 真实子 Agent 数 = subagent/catalog 按 childId 去重后的条数
    //                  (= dshContext.fleet.subagentCount; 旧实现按 name 去重导致恒 0)
    //   taskCount / memberCount = team/task、team/member 的真实条数 (无编队数据时为 0)
    fleet: {
      current: formatK(usageTotal),
      currentTokens: Math.round(usageTotal),
      subCount: fleetSubagents.length,
      taskCount: fleetTasks.length,
      memberCount: fleetMembers.length
    },
    usage: {
      uncached: folder.usage.uncached,
      cacheRead: folder.usage.cacheRead,
      cacheWrite: folder.usage.cacheWrite,
      output: folder.usage.output,
      prompt: promptTotal,
      total: usageTotal,
      calls: folder.usage.calls
    }
  };

  const sessionMeta = {
    version: DSH_EVENTS_VERSION,
    filePath: folder.meta.filePath || "",
    sessionId: folder.meta.id || folder.meta.sessionId || "",
    cwd: folder.meta.cwd || "",
    title: folder.title || folder.meta.title || "",
    provider: folder.provider,
    model: folder.model,
    reasoningEffort: folder.reasoningEffort,
    contextWindow: folder.contextWindow,
    maxOutputTokens: folder.maxOutputTokens,
    firstTime: folder.firstTime,
    lastTime: folder.lastTime,
    startTime: formatDateTime(folder.firstTime),
    lastTimeText: formatDateTime(folder.lastTime),
    eventCount: folder.eventCount,
    eventTypes: Object.fromEntries([...folder.byType.entries()].sort((a, b) => b[1] - a[1])),
    tools: Object.fromEntries([...folder.toolNames.entries()].sort((a, b) => b[1] - a[1])),
    headerTools: folder.headerTools,
    skills: [...folder.skills.values()].sort((a, b) => b.count - a.count),
    subagents: fleetSubagents, // = dshContext.fleet.subagents (按 childId 去重)
    fleet: {
      subagentCount: fleet.subagentCount,
      taskCount: fleetTasks.length,
      memberCount: fleetMembers.length,
      teamEnabled: fleet.teamEnabled
    },
    models: [...folder.models.keys()],
    commandsByProgram: fileOpsResult.programs,
    commandCalls: folder.commandCalls.slice(-1024),
    stepsTrimmed,
    systemMessageCount: folder.systemMessageCount,
    inboxSpliceCount: folder.inboxSplices.length,
    inboxSplices: folder.inboxSplices.slice(-20),
    fileOpsPending: fileOpsResult.pending,
    toolEventCount: folder.toolEvents.length,
    jobEventCount: folder.jobEvents.length
  };

  // 体积硬上限 ①: browserCategories 明细 (含 textPool 里被引用的全文) 超预算时
  // 只折叠较早步骤的 items UI 明细, stats/token/commands/fileOps 一律不动
  const browserBudget = applyBrowserCategoriesBudget(
    steps,
    DSH_BROWSER_LIMITS.budgetBytes,
    DSH_BROWSER_LIMITS.keepSteps,
    folder.textPool
  );
  let textPool = compactTextPool(folder.textPool, steps);
  sessionMeta.browserCategoriesBytesBefore = browserBudget.bytesBefore;
  sessionMeta.browserCategoriesBytesAfter = browserBudget.bytesAfter;

  // 文本截断统计 (页面/运维核对"详情到底存了多长": 上限 vs 实际截断条数)
  let textItemCount = 0;
  let truncatedItemCount = 0;
  for (const step of steps) {
    const cats = step && step.browserCategories;
    if (!Array.isArray(cats)) continue;
    for (const cat of cats) {
      const items = cat && cat.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item) continue;
        textItemCount += 1;
        if (item.truncated === true) truncatedItemCount += 1;
      }
    }
  }
  sessionMeta.textTruncation = {
    limits: {
      itemFullText: DSH_TEXT_LIMITS.itemFullText,
      systemSummary: DSH_TEXT_LIMITS.systemSummary,
      schemaText: DSH_TEXT_LIMITS.schemaText
    },
    items: textItemCount,
    truncatedItems: truncatedItemCount,
    systemSummaryChars: folder.systemSummaryChars,
    systemSummaryTruncated: !!folder.systemSummaryTruncated,
    tools: folder.headerTools.length,
    truncatedTools: folder.headerTools.filter((tool) => tool.schemaTruncated === true).length
  };

  const result = {
    stats,
    steps,
    textPool,
    turns: turnsAgg,
    events,
    fileOps: fileOpsResult.fileOps,
    commands: fileOpsResult.commands,
    curCategories,
    tokenStats: {
      totalUsage: usageTotal,
      totalUsageFormatted: formatK(usageTotal),
      promptTokens: promptTotal,
      uncachedTokens: folder.usage.uncached,
      cacheReadTokens: folder.usage.cacheRead,
      cacheWriteTokens: folder.usage.cacheWrite,
      outputTokens: folder.usage.output,
      requests: folder.usage.calls,
      cacheHitRate,
      categories: tokenCategories
    },
    timingStats: {
      activeDuration: formatDurationHm(wallMs),
      speed,
      wallMs: Math.round(wallMs),
      ttftMs: Math.round(timing.ttftMs),
      genMs: Math.round(genMs),
      reasoningMs: Math.round(timing.reasoningMs),
      textMs: Math.round(timing.textMs),
      toolArgMs: Math.round(timing.toolArgMs),
      toolsMs: Math.round(timing.toolsMs),
      idleMs: Math.round(otherMs),
      toolCalls: timing.toolCalls,
      tools: timing.tools,
      categories: timingCategories,
      ruler
    },
    currentContext: {
      modelInfo: [folder.provider, folder.model].filter(Boolean).join(" · ") || folder.model || "",
      // 当前上下文 = 末次请求的真实 prompt (usage.input+cacheRead+cacheWrite), 无 usage 时退回估算
      currentTokens,
      composedTokens: Math.round(compositionTotal),
      estimatedTokens: Math.round(compositionTotal),
      promptTokens: folder.requests.length > 0
        ? folder.requests[folder.requests.length - 1].prompt || 0
        : 0,
      limitTokens: folder.contextWindow || 0,
      maxOutputTokens: folder.maxOutputTokens,
      watermark: folder.contextWindow > 0
        ? Number(((currentTokens / folder.contextWindow) * 100).toFixed(1))
        : 0,
      categories: curCategories
    },
    // 编队 / 子 Agent (页面"编队"面板直接读 dshContext.fleet):
    //   无编队数据的会话 subagents/tasks/members 一律是空数组, 不编造占位成员
    fleet,
    sessionMeta
  };

  // 体积硬上限 ②: 真实分片字节 ≤ 12MB (WKWebView 承受上限)。
  // 估算体积超过 probeBytes 才真跑 JSON.stringify; 超预算按 keepStepsLadder
  // (120→100→80→60→40→20→0) 阶梯减少"保留明细的最近步数", 再压缩文本池重测。
  const payloadBudget = applyPayloadBudget(result, DSH_BROWSER_LIMITS.keepSteps);
  textPool = Array.isArray(result.textPool) ? result.textPool : textPool;
  sessionMeta.browserCategoriesTrimmed = browserBudget.trimmed || payloadBudget.trimmed;
  sessionMeta.browserCategoriesTrimmedSteps = Math.max(browserBudget.trimmedSteps, payloadBudget.trimmedSteps);
  sessionMeta.browserCategoriesKeepSteps = payloadBudget.keepStepsUsed;
  sessionMeta.payloadBudget = payloadBudget;
  sessionMeta.textPoolSize = textPool.length;
  sessionMeta.textPoolBytes = textPool.reduce((n, s) => n + strLen(s), 0);
  return result;
}

/**
 * 百分比归一化: 四舍五入后把残差补给最大项, 保证整组 percent 精确等于 100.0
 * (页面用 percent 画堆叠条/环图, 和为 100 才不会留缝或溢出)
 */
export function normalizePercents(items, decimals = 1) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const factor = Math.pow(10, decimals);
  let assigned = 0;
  let largestIndex = 0;
  let largestValue = -1;
  for (let i = 0; i < items.length; i += 1) {
    const value = Number(items[i].percent) || 0;
    const rounded = Math.round(value * factor) / factor;
    items[i].percent = rounded;
    assigned += rounded;
    if (value > largestValue) {
      largestValue = value;
      largestIndex = i;
    }
  }
  const remainder = Math.round((100 - assigned) * factor) / factor;
  if (remainder !== 0 && items[largestIndex]) {
    items[largestIndex].percent = Math.round((items[largestIndex].percent + remainder) * factor) / factor;
  }
  return items;
}

/** 程序分布 → app.js 的 4 个统计桶 (head / grep / echo / other), other 为其余全部之和 */
function bucketizePrograms(programTally) {
  const tally = programTally && typeof programTally === "object" ? programTally : {};
  const buckets = { head: 0, grep: 0, echo: 0, other: 0 };
  for (const key of Object.keys(tally)) {
    const count = Number(tally[key]) || 0;
    if (key === "head") buckets.head += count;
    else if (key === "grep") buckets.grep += count;
    else if (key === "echo") buckets.echo += count;
    else buckets.other += count;
  }
  return buckets;
}

/** step brief 的 "In" 行: 本步新进入上下文的节点标题 (最多 6 条) */
function buildInputSnippet(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  const names = [];
  for (const node of nodes) {
    const title = node && node.title ? node.title : "";
    if (title !== "" && !names.includes(title)) names.push(title);
    if (names.length >= 6) break;
  }
  return names.join(" / ");
}

/** 步骤 DNA 条带: 由真实分类构成生成 (不造假消息) */
function buildDnaBands(breakdown, turnIdx, stepIdx, timeText) {
  const bands = [];
  let offset = 0;
  const push = (key, cat, color, title, tokens) => {
    const value = Math.round(tokens || 0);
    if (value <= 0) return;
    bands.push({
      key,
      cat,
      color,
      title,
      tokens: value,
      off: offset,
      snippet: title,
      toolName: cat === "tools" ? "tools" : cat,
      turnIdx: turnIdx || 1,
      stepIdx: stepIdx || 1,
      time: timeText || ""
    });
    offset += value;
  };
  for (const meta of CONTEXT_CATEGORY_META) {
    const tokens = breakdown && breakdown[meta.key] !== undefined ? breakdown[meta.key] : 0;
    push(meta.key, meta.key, meta.color, meta.label, tokens);
  }
  return bands;
}

/** 官方 jn(): 按最近的 request 反查事件的 turn/step */
function attachTurnStep(events, requests) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq);
  return events.map((event) => {
    if (event.turn !== undefined) return event;
    let found;
    let previous;
    for (const request of sorted) {
      if (request.seq <= event.seq) previous = request;
      else {
        found = request;
        break;
      }
    }
    const next = { ...event };
    if (found) {
      next.turn = found.turn;
      next.step = found.step;
    } else if (previous) {
      next.turn = previous.turn;
      next.step = previous.step;
    }
    return next;
  });
}

function buildRuler(wallMs) {
  const total = Math.max(0, Math.round(wallMs));
  const parts = ["0"];
  for (let i = 1; i <= 4; i += 1) parts.push(formatDurationSeconds(Math.round((total * i) / 4 / 1000)));
  return parts;
}

/**
 * 调用 dsh-fileops.mjs (agent-6) 做文件活动/命令执行聚合。
 * 该模块缺失时明确降级: fileOps/commands 用本模块已算好的真实命令列表 (commandsRaw),
 * fileOps 返回空数组并在 sessionMeta.fileOpsPending 标注 —— 不造任何假数据。
 */
let injectedFileOps = null;

/** 允许测试/宿主覆盖 dsh-fileops 模块 (默认用静态导入的 agent-6 实现) */
export function setDshFileOpsModule(module) {
  if (module && typeof module === "object") injectedFileOps = module;
}

function loadDshFileOps() {
  return injectedFileOps || dshFileOpsModule || null;
}

function callDshFileOps(folder) {
  const emptyIo = { user: folder.humanInputs, read: 0, write: 0, search: 0, image: 0, mode: 0 };
  const module = loadDshFileOps();
  if (module && typeof module.buildFileActivity === "function" && typeof module.buildCommandActivity === "function") {
    try {
      const fileActivity = module.buildFileActivity(folder.toolEvents, {
        cwd: folder.meta.cwd || "",
        // ~/x 与 /Users/reno/x 必须归并到同一路径 (agent-6 的路径归一需要 home)
        home: os.homedir()
      });
      const commandActivity = module.buildCommandActivity(folder.toolEvents, folder.jobEvents, {
        maxCommandChars: DSH_EVENT_BOUNDS.maxCommandChars
      });
      const io = fileActivity && fileActivity.io ? fileActivity.io : emptyIo;
      io.user = folder.humanInputs;
      return {
        pending: false,
        fileOps: (fileActivity && fileActivity.fileOps) || [],
        commands: (commandActivity && commandActivity.commands) || [],
        commandStats: (commandActivity && commandActivity.commandStats) || {},
        commandStatsDetail: (commandActivity && commandActivity.commandStatsDetail) || null,
        programs: (commandActivity && commandActivity.programs) || [],
        io
      };
    } catch (error) {
      // 聚合模块异常 → 显式降级, 不吞成假数据
      return degradedFileOps(folder, "error: " + (error && error.message ? error.message : String(error)));
    }
  }
  return degradedFileOps(folder, "dsh-fileops.mjs not available");
}

function degradedFileOps(folder, reason) {
  const io = { user: folder.humanInputs, read: 0, write: 0, search: 0, image: 0, mode: 0 };
  for (const event of folder.toolEvents) {
    const kind = FILE_OP_KIND[event.name];
    if (kind === "read") io.read += 1;
    else if (kind === "write") io.write += 1;
    else if (kind === "search") io.search += 1;
    if (event.name === "read_image") io.image += 1;
  }
  const commands = folder.commandsRaw.map((record) => ({
    seq: record.seq,
    cmd: record.cmd,
    program: record.program,
    status: record.status === "running" ? "background" : record.status,
    ms: Number.isFinite(record.end) && Number.isFinite(record.start) ? Math.max(0, record.end - record.start) : 0,
    turn: record.turn === undefined ? 1 : record.turn,
    step: record.step === undefined ? 1 : record.step,
    time: formatClock(record.start),
    exitCode: record.exit,
    isError: record.err === true,
    nested: record.nested === true,
    tag: record.nested ? "嵌套" : record.tool === "run_code" ? "代码" : "CLI"
  }));
  const commandStats = { head: 0, grep: 0, echo: 0, other: 0 };
  for (const record of folder.commandsRaw) {
    const program = record.program;
    if (program === "head") commandStats.head += 1;
    else if (program === "grep") commandStats.grep += 1;
    else if (program === "echo") commandStats.echo += 1;
    else commandStats.other += 1;
  }
  const programs = [...folder.programTally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    pending: true,
    pendingReason: reason,
    fileOps: [],
    commands,
    commandStats,
    commandStatsDetail: folder.commandStatsRaw,
    programs,
    io
  };
}

// ============================================================================
// 7. 公开入口
// ============================================================================

/**
 * foldDshSession — 同步折叠一个 DSH 会话日志
 * @param {string} filePath session.v4.jsonl.zstd 路径
 * @param {object} [meta] 会话元信息 (id/cwd/title/start/last, 来自 sessions.json); 仅作展示兜底, 不参与计算
 * @returns {{stats,steps,turns,events,fileOps,commands,curCategories,tokenStats,timingStats,currentContext,sessionMeta}}
 */
export function foldDshSession(filePath, meta = {}) {
  const folder = new DshSessionFolder({ ...(meta || {}), filePath });
  if (!filePath || !fs.existsSync(filePath)) {
    return folder.finish();
  }
  let raw;
  try {
    const buffer = fs.readFileSync(filePath);
    const decompressed = zlib.zstdDecompressSync(buffer);
    raw = decompressed.toString("utf8");
  } catch (error) {
    const result = folder.finish();
    result.sessionMeta.error = "decompress failed: " + (error && error.message ? error.message : String(error));
    return result;
  }
  folder.feedLines(raw);
  return folder.finish();
}

/**
 * foldDshSessionAsync — 流式折叠 (大文件场景; 与同步版结果完全一致)
 * 用 createZstdDecompress 逐块解压 + 按行切分, 峰值内存只与单行相关。
 */
export async function foldDshSessionAsync(filePath, meta = {}) {
  const folder = new DshSessionFolder({ ...(meta || {}), filePath });
  if (!filePath || !fs.existsSync(filePath)) return folder.finish();
  const { pipeline } = __mods["node:stream/promises"];
  const { Transform } = __mods["node:stream"];
  let carry = "";
  const splitter = new Transform({
    transform(chunk, _encoding, callback) {
      carry += chunk.toString("utf8");
      let index = carry.indexOf("\n");
      while (index >= 0) {
        const line = carry.slice(0, index);
        carry = carry.slice(index + 1);
        folder.feedLine(line);
        index = carry.indexOf("\n");
      }
      callback();
    },
    flush(callback) {
      if (carry.trim() !== "") folder.feedLine(carry);
      carry = "";
      callback();
    }
  });
  try {
    await pipeline(fs.createReadStream(filePath), zlib.createZstdDecompress(), splitter);
  } catch (error) {
    const result = folder.finish();
    result.sessionMeta.error = "stream decompress failed: " + (error && error.message ? error.message : String(error));
    return result;
  }
  return folder.finish();
}

// 逐行喂入 (供测试/自定义读取器复用)
DshSessionFolder.prototype.feedLines = function feedLines(raw) {
  if (typeof raw !== "string" || raw === "") return;
  let index = raw.indexOf("\n");
  let cursor = 0;
  while (index >= 0) {
    this.feedLine(raw.slice(cursor, index));
    cursor = index + 1;
    index = raw.indexOf("\n", cursor);
  }
  if (cursor < raw.length) this.feedLine(raw.slice(cursor));
};
