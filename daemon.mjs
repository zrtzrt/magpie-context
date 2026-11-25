// daemon.mjs - 实时同步与解析 Magpie 上下文透视数据 (直读 usage.jsonl 与各 Agent 真实会话)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";

// DSH 真实事件流折叠器 (zstd 全量解压 + 逐事件统计, 无任何公式/常量兜底)
import { foldDshSession } from "./dsh-events.mjs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "";

const USAGE_JSONL_PATH = path.join(HOME, ".config/magpie/usage.jsonl");
const SESSIONS_JSON_PATH = path.join(HOME, ".cache/magpie/sessions.json");
const APP_LOG_PATH = path.join(HOME, "Library/Logs/magpie/app.log");
// 输出目录: 默认 page/; 测试可用 MAGPIE_CONTEXT_PAGE_DIR 指向临时目录, 避免与并发的 daemon/测试互相覆盖
const CONTEXT_PAGE_DIR_OVERRIDE = process.env.MAGPIE_CONTEXT_PAGE_DIR
  ? path.resolve(process.env.MAGPIE_CONTEXT_PAGE_DIR)
  : null;
const CONTEXT_DATA_JS_PATH = CONTEXT_PAGE_DIR_OVERRIDE
  ? path.join(CONTEXT_PAGE_DIR_OVERRIDE, "context-data.js")
  : path.resolve(
      __dirname,
      fs.existsSync(path.join(__dirname, "page")) ? "page" : "../../page",
      "context-data.js"
    );

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

// ==========================================
// M1: 辅助解析函数 (工具状态推断、文件操作抽取与路径规范化)
// ==========================================

/**
 * 推断工具执行退出码与错误状态 (权威移植 dsh-context client.js Vo/Ho 状态机)
 * @param {string} output - 工具标准输出/错误文本
 * @param {boolean} explicitIsError - 事件级显式错误标志
 * @param {string} explicitStatus - 事件级状态字符串
 * @returns {{ isError: boolean, exitCode: number | null }}
 */
export function inferToolExitAndStatus(output, explicitIsError = false, explicitStatus = "") {
  let isError = Boolean(explicitIsError);
  let exitCode = null;

  if (explicitStatus === "ERROR" || explicitStatus === "error" || explicitStatus === "failed") {
    isError = true;
  }

  if (typeof output !== "string" || !output) {
    return { isError, exitCode };
  }

  const trimmed = output.trimEnd();

  // 1. Authoritative Vo Pattern 1:
  // /(shell killed by signal: [^\]\n]+|shell exited(?:: code \d+)?)\]$/
  const r1 = /\[(shell killed by signal: [^\]\n]+|shell exited(?:: code \d+)?)\]$/.exec(trimmed);
  if (r1 !== null) {
    const exitMatch = /\[exit code:\s*(\d+)\]\s*$/.exec(trimmed.slice(0, r1.index));
    if (exitMatch !== null) {
      return { isError: true, exitCode: Number(exitMatch[1]) };
    }
    const codeMatch = /: code (\d+)$/.exec(r1[1]);
    if (codeMatch === null) {
      return { isError: r1[1].startsWith("shell killed"), exitCode: null };
    }
    const num = Number(codeMatch[1]);
    return { isError: num !== 0, exitCode: num === 0 ? null : num };
  }

  // 2. Authoritative Vo Pattern 2: Standalone [exit code: N] at end
  const r2 = /\[exit code:\s*(\d+)\]$/.exec(trimmed);
  if (r2 !== null) {
    const num = Number(r2[1]);
    return { isError: num !== 0, exitCode: num };
  }

  // 3. Authoritative Vo Pattern 3: Killed by signal or status killed/failed
  if (
    /\[killed by signal: [^\]\n]+\]$/.test(trimmed) ||
    /\[status: (?:killed|failed)(?:, [^\]\n]*)?\]$/.test(trimmed)
  ) {
    return { isError: true, exitCode: null };
  }

  // 4. DSH / Runner patterns:
  const rDshFinished = /(?:^|\n)\[Command finished with exit code (\d+)\]\s*$/.exec(trimmed);
  if (rDshFinished !== null) {
    const num = Number(rDshFinished[1]);
    return { isError: num !== 0, exitCode: num };
  }

  const rDshShellExited = /(?:^|\n)\[shell exited: code (\d+)\](?=\n|$)/.exec(trimmed);
  if (rDshShellExited !== null) {
    const num = Number(rDshShellExited[1]);
    return { isError: num !== 0, exitCode: num };
  }

  // 5. Antigravity runner output conventions:
  const rAgExited = /(?:^|\n)Command exited with code (\d+)\./i.exec(trimmed);
  if (rAgExited !== null) {
    const num = Number(rAgExited[1]);
    return { isError: num !== 0, exitCode: num };
  }

  const rAgExitCode = /(?:^|\n)Exit Code:\s*(\d+)/i.exec(trimmed);
  if (rAgExitCode !== null) {
    const num = Number(rAgExitCode[1]);
    return { isError: num !== 0, exitCode: num };
  }

  // 6. Generic failure keywords or signals
  if (
    /(?:^|\n)\[timed out after \d+ms\](?=\n|$)/.test(trimmed) ||
    /(?:^|\n)\[Command timed out or OOM\](?=\n|$)/.test(trimmed) ||
    /(?:^|\n)\[sandbox: file access denied under [^\]\n]+\](?=\n|$)/.test(trimmed)
  ) {
    return { isError: true, exitCode: null };
  }

  return { isError, exitCode };
}

/**
 * 规范化工具调用参数结构，确保完整保留参数，不丢弃任何内容
 */
/**
 * 稳定哈希 (确定性 id 用): 同一输入永远得到同一摘要
 */
export function stableHash(str) {
  return crypto.createHash("sha1").update(String(str), "utf8").digest("hex");
}

/**
 * 确定性 call id —— 数据契约 v2 硬要求: 会话数据里禁止 Date.now() / Math.random()。
 * 只要有一个随机字段, 详情文件每轮 sync 都会变 → "内容未变不重写" 失效 (每 5s 全量重写)。
 * 组成: 作用域(会话/轮次/步号) + 序号 + 工具名 + 参数, 取 sha1 前 10 位。
 */
export function stableCallId(...parts) {
  const payload = JSON.stringify(parts.map((p) => (p === undefined || p === null ? "" : String(p))));
  return "call_" + stableHash(payload).slice(0, 10);
}

export function normalizeToolCalls(rawToolCalls, contextKey = "") {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.map((tc, idx) => {
    const name = tc.name || tc.ToolName || tc.toolSummary || "tool";
    const rawArgs = tc.args !== undefined ? tc.args : (tc.Arguments !== undefined ? tc.Arguments : tc.arguments);
    let parsedArgs = rawArgs;
    if (typeof rawArgs === "string") {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (_) {
        parsedArgs = rawArgs;
      }
    }
    const argumentsStr = typeof rawArgs === "object" ? JSON.stringify(rawArgs) : (typeof rawArgs === "string" ? rawArgs : "");
    return {
      id: tc.id || tc.callId || stableCallId("antigravity", contextKey, idx, name, argumentsStr),
      name,
      args: parsedArgs,
      arguments: argumentsStr,
      argsRaw: argumentsStr,
      toolSummary: tc.toolSummary || ""
    };
  });
}

/**
 * 精确计算字符串行数 (对标 dsh-context ln 规范)
 */
export function countLines(str) {
  if (!str || typeof str !== "string") return 0;
  return str.split("\n").length;
}

/**
 * 解包可能嵌套字符串化或 JSON 化的参数值
 */
export function unwrapArg(val) {
  if (val === undefined || val === null) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        trimmed === "true" || trimmed === "false" ||
        /^-?\d+(\.\d+)?$/.test(trimmed)) {
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        return val;
      }
    }
  }
  return val;
}

/**
 * 路径规范化 (剥除引号、file:// 前缀，统一斜杠，解析工作区相对路径)
 */
export function normalizePath(rawPath, cwd = "") {
  if (!rawPath || typeof rawPath !== "string") return "";
  let p = rawPath.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (p.startsWith("file://")) {
    p = p.slice(7);
  }
  p = p.replace(/\\/g, "/");
  p = p.replace(/^(?:\.\/)+/, "");

  if (cwd && !p.startsWith("/") && p !== ".") {
    const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    p = normCwd + "/" + p;
  }
  return p;
}

/**
 * 分解目录前缀、文件名与扩展名
 */
export function splitPath(normPath) {
  const lastSlash = normPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normPath.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? normPath.slice(lastSlash + 1) : normPath;
  const lastDot = name.lastIndexOf(".");
  const ext = lastDot >= 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  return { dir, name, ext };
}

/**
 * 真实工具调用中提取文件操作事件 (提取 read / write / search 与行变更)
 */
export function extractFileOpsFromToolCall(toolName, rawArgs, resultText, turnIdx, time, stepId, cwd = "") {
  const args = {};
  for (const [k, v] of Object.entries(rawArgs || {})) {
    if (k === "Content" || k === "content" || k === "CodeContent" || k === "TargetContent" || 
        k === "ReplacementContent" || k === "file_text" || k === "new_str" || k === "old_str" || 
        k === "CommandLine" || k === "Target" || k === "Replacement") {
      args[k] = v;
    } else {
      args[k] = unwrapArg(v);
    }
  }
  const ops = [];

  // 1. Read Operations (view_file, read_file, read_url_content, read_resource)
  if (toolName === "view_file" || toolName === "read_file" || toolName === "read") {
    const p = normalizePath(args.AbsolutePath || args.Path || args.path || args.file_path, cwd);
    if (p) {
      const s = Number(args.StartLine) || 1;
      const e = Number(args.EndLine) || 0;
      const readLines = (e >= s) ? (e - s + 1) : countLines(resultText);
      ops.push({
        path: p,
        kind: "read",
        tool: toolName,
        detail: e >= s ? `L${s}-${e}` : (readLines ? `${readLines} lines` : "read"),
        readLines,
        added: 0,
        removed: 0,
        turn: turnIdx,
        time,
        stepId
      });
    }
  }
  // read_image: 官方 Fe 把 read_image 归为 read (lib/index.d.ts:343-365 的 FileOpRecord.kind),
  // 图片读取也计入 fileOps 且单独标记 images。
  else if (toolName === "read_image" || toolName === "read_image_file") {
    const p = normalizePath(args.file_path || args.Path || args.path, cwd);
    if (p) {
      ops.push({
        path: p,
        kind: "read",
        tool: toolName,
        detail: "image",
        readLines: 0,
        added: 0,
        removed: 0,
        images: 1,
        turn: turnIdx,
        time,
        stepId
      });
    }
  } else if (toolName === "read_url_content") {
    const url = args.Url || args.url || "";
    if (url) {
      ops.push({
        path: url,
        kind: "read",
        tool: toolName,
        detail: "url",
        readLines: countLines(resultText),
        added: 0,
        removed: 0,
        turn: turnIdx,
        time,
        stepId
      });
    }
  } else if (toolName === "read_resource") {
    const uri = args.Uri || args.uri || "";
    if (uri) {
      ops.push({
        path: uri,
        kind: "read",
        tool: toolName,
        detail: "resource",
        readLines: countLines(resultText),
        added: 0,
        removed: 0,
        turn: turnIdx,
        time,
        stepId
      });
    }
  }

  // 2. Write Operations (write_file, write_to_file, edit_file, replace_file_content, str_replace_editor)
  else if (toolName === "write_file" || toolName === "write_to_file" || toolName === "write") {
    const p = normalizePath(args.TargetFile || args.Path || args.path || args.file_path, cwd);
    if (p) {
      const content = args.CodeContent || args.Content || args.content || "";
      const added = countLines(content);
      const isOverwrite = args.Overwrite === true || args.Overwrite === "true";
      const isAppend = args.Append === true || args.Append === "true";
      ops.push({
        path: p,
        kind: "write",
        tool: toolName,
        detail: isAppend ? "append" : (isOverwrite ? "overwrite" : "create"),
        readLines: 0,
        added,
        removed: 0,
        turn: turnIdx,
        time,
        stepId
      });
    }
  } else if (toolName === "edit_file" || toolName === "replace_file_content" || toolName === "edit") {
    const p = normalizePath(args.TargetFile || args.Path || args.path || args.file_path, cwd);
    if (p) {
      const target = args.Target || args.TargetContent || args.old_string || "";
      const rep = args.Replacement || args.ReplacementContent || args.new_string || "";
      const added = countLines(rep);
      let removed = countLines(target);
      if (removed === 0 && args.StartLine && args.EndLine) {
        const s = Number(args.StartLine);
        const e = Number(args.EndLine);
        if (e >= s) removed = e - s + 1;
      }
      ops.push({
        path: p,
        kind: "write",
        tool: toolName,
        detail: args.Instruction || args.Description || (args.StartLine ? `L${args.StartLine}-${args.EndLine || args.StartLine}` : "edit"),
        readLines: 0,
        added,
        removed,
        turn: turnIdx,
        time,
        stepId
      });
    }
  } else if (toolName === "str_replace_editor") {
    const p = normalizePath(args.path || args.file_path, cwd);
    if (p) {
      if (args.command === "view") {
        ops.push({
          path: p,
          kind: "read",
          tool: toolName,
          detail: "view",
          readLines: countLines(resultText),
          added: 0,
          removed: 0,
          turn: turnIdx,
          time,
          stepId
        });
      } else {
        const added = countLines(args.new_str || args.file_text || "");
        const removed = countLines(args.old_str || "");
        ops.push({
          path: p,
          kind: "write",
          tool: toolName,
          detail: args.command || "str_replace",
          readLines: 0,
          added,
          removed,
          turn: turnIdx,
          time,
          stepId
        });
      }
    }
  }

  // 3. Search Operations (grep_search, find_by_name, list_dir, glob)
  else if (toolName === "grep_search" || toolName === "grep") {
    const p = normalizePath(args.SearchPath || args.path || ".", cwd);
    ops.push({
      path: p,
      kind: "search",
      tool: toolName,
      detail: args.Query || args.query || args.pattern || "grep",
      readLines: 0,
      added: 0,
      removed: 0,
      turn: turnIdx,
      time,
      stepId
    });
  } else if (toolName === "find_by_name" || toolName === "glob") {
    const p = normalizePath(args.SearchDirectory || args.path || ".", cwd);
    ops.push({
      path: p,
      kind: "search",
      tool: toolName,
      detail: args.Pattern || args.pattern || "find",
      readLines: 0,
      added: 0,
      removed: 0,
      turn: turnIdx,
      time,
      stepId
    });
  } else if (toolName === "list_dir") {
    const p = normalizePath(args.DirectoryPath || args.path || ".", cwd);
    ops.push({
      path: p,
      kind: "search",
      tool: toolName,
      detail: "list_dir",
      readLines: 0,
      added: 0,
      removed: 0,
      turn: turnIdx,
      time,
      stepId
    });
  }

  // 4. Shell Operations (run_command, bash)
  else if (toolName === "run_command" || toolName === "bash") {
    const cmd = args.CommandLine || args.cmd || "";
    const mCat = cmd.match(/^(?:cat|head|tail)(?:\s+(?:-[nAcbqvV\d]+|\d+|--lines=\d+|--bytes=\d+))*\s+([^\s;&|]+)/);
    if (mCat && !mCat[1].startsWith("-") && isNaN(Number(mCat[1]))) {
      const p = normalizePath(mCat[1], cwd);
      if (p && !p.startsWith("-")) {
        ops.push({
          path: p,
          kind: "read",
          tool: "run_command",
          detail: cmd.slice(0, 40),
          readLines: countLines(resultText),
          added: 0,
          removed: 0,
          turn: turnIdx,
          time,
          stepId
        });
      }
    }
    const mDiff = cmd.match(/^git\s+(?:diff|log|show)\s+([^\s;&|]+)/);
    if (mDiff && !mDiff[1].startsWith("-")) {
      const p = normalizePath(mDiff[1], cwd);
      if (p && !p.startsWith("-")) {
        ops.push({
          path: p,
          kind: "read",
          tool: "git",
          detail: "git diff",
          readLines: countLines(resultText),
          added: 0,
          removed: 0,
          turn: turnIdx,
          time,
          stepId
        });
      }
    }
  }

  return ops;
}

/**
 * 聚合所有单次文件操作并生成结构化 fileOps 数组
 */
export function aggregateFileOperations(rawOps) {
  if (!Array.isArray(rawOps) || rawOps.length === 0) return [];
  const fileMap = new Map();

  for (const op of rawOps) {
    if (!op || !op.path) continue;
    let f = fileMap.get(op.path);
    if (!f) {
      const { dir, name, ext } = splitPath(op.path);
      f = {
        path: op.path,
        dir,
        name,
        ext,
        reads: 0,
        writes: 0,
        searches: 0,
        added: 0,
        removed: 0,
        lastTurn: op.turn || 1,
        time: op.time || "",
        ops: []
      };
      fileMap.set(op.path, f);
    }

    if (op.kind === "read") f.reads++;
    else if (op.kind === "write") f.writes++;
    else if (op.kind === "search") f.searches++;
    if (op.images) f.images = (f.images || 0) + op.images;

    f.added += (op.added || 0);
    f.removed += (op.removed || 0);
    f.lastTurn = Math.max(f.lastTurn || 0, op.turn || 1);
    if (op.time) f.time = op.time;
    f.ops.push(op);
  }

  const files = Array.from(fileMap.values());

  // 排序每个文件内的操作历史 (按轮次与步骤倒序，最新优先)
  files.forEach(f => {
    f.ops.sort((a, b) => {
      if (b.turn !== a.turn) return (b.turn || 0) - (a.turn || 0);
      return (Number(b.stepId) || 0) - (Number(a.stepId) || 0);
    });
    if (f.ops.length > 0) {
      f.lastTurn = f.ops[0].turn;
      f.time = f.ops[0].time;
    }
  });

  // 文件列表排序: 总活动数倒序 -> 变更总行数倒序 -> 路径字典序
  files.sort((a, b) => {
    const actA = a.reads + a.writes + a.searches;
    const actB = b.reads + b.writes + b.searches;
    if (actB !== actA) return actB - actA;
    const linesA = a.added + a.removed;
    const linesB = b.added + b.removed;
    if (linesB !== linesA) return linesB - linesA;
    return a.path.localeCompare(b.path);
  });

  return files;
}

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
  const brainLogDir = path.join(HOME, `.gemini/antigravity/brain/${sessionId}/.system_generated/logs`);
  const transcriptFullPath = path.join(brainLogDir, "transcript_full.jsonl");
  const transcriptStdPath = path.join(brainLogDir, "transcript.jsonl");
  const transcriptPath = fs.existsSync(transcriptFullPath) ? transcriptFullPath : transcriptStdPath;

  const turns = [];
  const sessionOps = [];
  const pendingToolCalls = [];
  const distinctTools = new Set();
  let dynamicSystemPrompt = "";

  let model = meta?.models?.[0]?.model || usageReqs[0]?.model || "gemini-3.8-flash";
  let totalInputTokens = meta?.input || 0;
  let totalOutputTokens = meta?.output || 0;
  let totalCacheRead = meta?.cache_read || 0;
  let cost = meta?.cost || 0;

  // 1. 如果有物理 transcript.jsonl / transcript_full.jsonl，解析出精确的消息内容与轮次
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
          // 真实事件时间戳 (ms): 每步耗时 / 活跃时长 / 输出速度全部由它推导;
          // 缺失时记 0 (绝不拿 Date.now() 冒充, 否则耗时会凭空变成几天)。
          const stepMs = step.created_at ? new Date(step.created_at).getTime() : 0;

          if (stype === "SYSTEM_MESSAGE") {
            const sText = step.content || "";
            const sTokens = estimateTokens(sText);
            cumTokens += sTokens;

            if (!dynamicSystemPrompt) {
              dynamicSystemPrompt = sText;
            }

            if (!curTurn) {
              // 会话以 SYSTEM_MESSAGE 起始（如 Subagent 启动指令、调度器上下文）
              turnIdx++;
              curTurn = {
                turnIdx,
                time: stepMs || Date.now(),
                timestamp: formatTime(step.created_at),
                userText: sText.slice(0, 160).replace(/\n/g, " "),
                totalTokens: sTokens,
                tokenDelta: sTokens,
                breakdown: {
                  systemTokens: sTokens,
                  toolsTokens: 0,
                  userTokens: 0,
                  assistantTokens: 0,
                  toolResultTokens: 0
                },
                isCompaction: false,
                isBloat: false,
                messages: [
                  {
                    idx: 0,
                    role: "system",
                    cat: "system",
                    tokens: sTokens,
                    chars: sText.length,
                    time: stepMs,
                    snippet: sText.slice(0, 200).replace(/\n/g, " "),
                    fullText: sText
                  }
                ]
              };
              turns.push(curTurn);
              lastTokens = curTurn.totalTokens;
            } else {
              // 运行期中途 SYSTEM_MESSAGE 注入指令
              const isInitial = curTurn.messages.length === 0;
              const role = isInitial ? "system" : "inject";
              curTurn.totalTokens += sTokens;
              // 注入内容单独归类 (不再落到 tool 残差里), 分类口径与 DSH 侧一致
              if (role === "inject") {
                curTurn.breakdown.injectTokens = (curTurn.breakdown.injectTokens || 0) + sTokens;
              }
              curTurn.messages.push({
                idx: curTurn.messages.length,
                role,
                cat: role,
                tokens: sTokens,
                chars: sText.length,
                time: stepMs,
                snippet: sText.slice(0, 200).replace(/\n/g, " "),
                fullText: sText
              });
            }
          } else if (stype === "USER_INPUT") {
            const uText = step.content || "";
            const uTokens = estimateTokens(uText);
            cumTokens += uTokens;

            // 若当前轮次由起始 SYSTEM_MESSAGE 建立且尚未包含 user 消息，则填入该轮次
            if (curTurn && !curTurn.messages.some(m => m.role === "user")) {
              curTurn.userText = uText.slice(0, 160).replace(/\n/g, " ");
              curTurn.breakdown.userTokens = uTokens;
              curTurn.totalTokens += uTokens;
              curTurn.messages.push({
                idx: curTurn.messages.length,
                role: "user",
                cat: "user",
                tokens: uTokens,
                chars: uText.length,
                time: stepMs,
                snippet: uText.slice(0, 200).replace(/\n/g, " "),
                fullText: uText // 100% LOSSLESS!
              });
            } else {
              turnIdx++;
              const sysTokens = 4500;
              const toolsTokens = 3200;

              curTurn = {
                turnIdx,
                time: stepMs || Date.now(),
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
                    cat: "system",
                    tokens: sysTokens,
                    chars: 14000,
                    time: stepMs,
                    snippet: "系统身份设定与行为准则 (Antigravity Assistant System Prompt)",
                    // 该分支的 system 正文一定是占位/硬编码 (真实 SYSTEM_MESSAGE 走上面的分支),
                    // 打上 synthetic 标记 → 上下文浏览器条目不会把它当成真实内容造成编造。
                    synthetic: !(turnIdx === 1 && dynamicSystemPrompt),
                    fullText: turnIdx === 1 ? (dynamicSystemPrompt || `# Antigravity System Instructions\nYou are Antigravity, an agentic AI coding assistant designed by Google DeepMind.\n- Maintain documentation integrity.\n- Follow sandbox and environment boundaries.\n- Format code snippets cleanly and link files with file:// URIs.`) : "[系统指令与行为准则已在第 1 轮载入]"
                  },
                  {
                    idx: 1,
                    role: "tools",
                    cat: "tools",
                    tokens: toolsTokens,
                    chars: 9800,
                    time: stepMs,
                    snippet: "工具声明 Schema",
                    // tools 条目改由 transcript 里真实 tool_calls(name/args) 汇总生成, 该合成消息不作为条目来源
                    synthetic: true,
                    fullText: turnIdx === 1 ? `Available Tools Schema:\n- run_command(CommandLine, toolSummary, WaitMsBeforeAsync)\n- read_file(Path, StartLine, EndLine)\n- edit_file(Path, Target, Replacement)\n- write_file(Path, Content, Overwrite)\n- search_web(query, domain)` : "[工具声明 Schema 已在第 1 轮载入]"
                  },
                  {
                    idx: 2,
                    role: "user",
                    cat: "user",
                    tokens: uTokens,
                    chars: uText.length,
                    time: stepMs,
                    snippet: uText.slice(0, 200).replace(/\n/g, " "),
                    fullText: uText // 100% LOSSLESS!
                  }
                ]
              };
              turns.push(curTurn);
              lastTokens = curTurn.totalTokens;
            }
          } else if (stype === "PLANNER_RESPONSE" && curTurn) {
            const respText = step.content || "";
            const structuredToolCalls = normalizeToolCalls(
              step.tool_calls,
              sessionId + ":" + (curTurn ? curTurn.turnIdx : "") + ":" + (step.step_index !== undefined ? step.step_index : "")
            );
            const toolNames = structuredToolCalls.map(tc => tc.name);
            toolNames.forEach(n => distinctTools.add(n));

            const rTokens = step.output_tokens || estimateTokens(respText);

            // 压入待匹配工具调用队列，供随后的 GENERIC 结果关联
            for (const tc of structuredToolCalls) {
              pendingToolCalls.push({
                ...tc,
                turn: curTurn.turnIdx,
                time: step.created_at ? formatTime(step.created_at) : curTurn.timestamp,
                stepId: step.step_index
              });
            }

            // 官方 transcript 中：真实上下文输入 Tokens = 增量输入 input_tokens + Prompt 缓存命中 cache_read_tokens
            const realInputTokens = (step.input_tokens || 0) + (step.cache_read_tokens || 0);
            if (realInputTokens > 0) {
              // 真实计量: 本次请求的 prompt 总量 = 增量输入 input_tokens + prompt 缓存命中 cache_read_tokens
              // (与 DSH 侧 steps[].totalTokens / currentContext.currentTokens 同口径)
              curTurn.totalTokens = realInputTokens;
              curTurn.promptTokens = realInputTokens;
            } else {
              cumTokens += rTokens;
              curTurn.totalTokens += rTokens;
            }

            if (step.cache_read_tokens) {
              curTurn.cacheRead = (curTurn.cacheRead || 0) + step.cache_read_tokens;
              totalCacheRead += step.cache_read_tokens;
            }
            totalInputTokens += (step.input_tokens || 0);
            totalOutputTokens += rTokens;

            curTurn.breakdown.assistantTokens += rTokens;

            const fullThinking = step.thinking || "";
            let fullParts = [];
            if (fullThinking) {
              fullParts.push(`[Thinking 思考过程]:\n${fullThinking}`);
            }
            if (respText) {
              fullParts.push(respText);
            }
            if (structuredToolCalls.length > 0) {
              fullParts.push(`[Tool Calls 工具调用]:\n${JSON.stringify(structuredToolCalls, null, 2)}`);
            }
            const asstFullText = fullParts.join("\n\n") || "[模型思考与规划]";

            const blocks = [
              ...(fullThinking ? [{ type: "reasoning", lineCount: countLines(fullThinking) }] : []),
              ...structuredToolCalls.map(tc => ({
                type: "tool-call",
                id: tc.id,
                name: tc.name,
                arguments: tc.args
              })),
              ...(respText ? [{ type: "text", lineCount: countLines(respText) }] : [])
            ];

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "assistant",
              cat: "assistant",
              tokens: rTokens,
              // 真实计量 (transcript 原文): prompt 总量 / 增量输入 / 缓存命中 / 输出 / 时间戳
              promptTokens: realInputTokens,
              inputTokens: Number(step.input_tokens) || 0,
              cacheReadTokens: Number(step.cache_read_tokens) || 0,
              outputTokens: rTokens,
              time: stepMs,
              chars: respText.length + fullThinking.length,
              thinking: fullThinking,
              toolCalls: toolNames,
              snippet: respText.slice(0, 200).replace(/\n/g, " ") || (toolNames.length ? `[调用工具: ${toolNames.join(", ")}]` : "[模型思考与规划]"),
              fullText: asstFullText, // 100% LOSSLESS!
              blocks
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

            const associatedCall = pendingToolCalls.shift() || null;
            const toolName = associatedCall?.name || "tool";
            const { isError, exitCode } = inferToolExitAndStatus(outText, step.status === "ERROR" || step.status === "error", step.status);

            if (associatedCall) {
              const ops = extractFileOpsFromToolCall(
                associatedCall.name,
                associatedCall.args,
                outText,
                curTurn.turnIdx,
                associatedCall.time || curTurn.timestamp,
                step.step_index,
                cwd
              );
              if (ops && ops.length > 0) {
                sessionOps.push(...ops);
              }
            }

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "tool_result",
              cat: "tool",
              toolName,
              toolCallId: associatedCall?.id || null,
              call: associatedCall,
              tokens: oTokens,
              chars: outText.length,
              time: stepMs,
              isError,
              exitCode,
              snippet: `[工具输出/文件内容] ${outText.slice(0, 180).replace(/\n/g, " ")}`,
              fullText: outText, // 100% LOSSLESS!
              blocks: [
                {
                  type: "tool-result",
                  toolName,
                  callId: associatedCall?.id || null,
                  exitCode,
                  isError,
                  lineCount: countLines(outText)
                }
              ]
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

  const fileOps = aggregateFileOperations(sessionOps);

  if (distinctTools.size > 0) {
    const dynamicToolsSchema = Array.from(distinctTools).map(t => `- ${t}(...)`).join("\n");
    turns.forEach(t => {
      const toolsMsg = (t.messages || []).find(m => m.role === "tools");
      if (toolsMsg) {
        toolsMsg.fullText = `Available Tools Schema:\n${dynamicToolsSchema}`;
      }
    });
  }

  // 会话级口径: 峰值/当前都取**真实 prompt 计量** (input_tokens + cache_read_tokens)
  const promptTokensOfTurns = turns.map(t => Number(t.promptTokens) || 0).filter(v => v > 0);
  const peakTokens = Math.max(
    ...promptTokensOfTurns,
    ...turns.map(t => Number(t.totalTokens) || 0),
    meta?.input || 0
  );
  const currentTokens = promptTokensOfTurns.length > 0
    ? promptTokensOfTurns[promptTokensOfTurns.length - 1]
    : (turns[turns.length - 1]?.totalTokens || peakTokens);
  const limit = getModelLimit(model);
  const rawRatio = (currentTokens / limit) * 100;
  const watermarkPercent = rawRatio < 1 && rawRatio > 0 ? Number(rawRatio.toFixed(1)) : Math.min(100, Math.round(rawRatio));

  return {
    id: sessionId,
    name: title || `Antigravity 会话 ${sessionId.slice(0, 8)}`,
    agent: "antigravity",
    agentName: "Antigravity",
    agentIcon: "antigravity.svg",
    cwd: cwd || "",
    model,
    modelLimit: limit,
    watermarkPercent,
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
    fileOps,
    turns
  };
}

/**
 * 3. 解析 DSH 真实会话
 */
function parseDshSession(filePath, meta, usageReqs = []) {
  const sid = meta?.id || path.basename(path.dirname(filePath));
  let cwd = meta?.cwd || "";
  // 目录扫描模式下 meta.title 可能为空, 此时由 fold 的 session/title 事件提供
  const title = meta?.title || "";
  const start = meta?.start;
  const last = meta?.last;
  let model = meta?.models?.[0]?.model || meta?.model || usageReqs[0]?.model || "workbuddy/kimi-k3.1-pro";

  const turns = [];
  const sessionOps = [];
  const pendingDshCalls = [];
  let dynamicSystemPrompt = "";
  let dynamicToolsSchema = "";
  let compactionCount = 0;
  let bloatCount = 0;

  // 1. 如果有物理 zstd 会话，解压提取核心事件 (移除 head -n 300 截断)
  if (fs.existsSync(filePath)) {
    try {
      const cmd = `zstd -dc "${filePath}" 2>/dev/null | grep -E '"(system/message|request/header|turn/start|user/message|assistant/message|tool/call|tool/result|request/context|step/end)"'`;
      const out = execSync(cmd, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
      const lines = out.split("\n").filter(Boolean);

      let curTurn = null;
      let pendingTurn = null;
      let turnIdx = 0;
      let cumTokens = 0;
      let lastTotal = 0;
      // 系统提示词 / 工具定义 token: 由真实内容估算 (解析到就更新), 不再是 3800/2900 常量
      let sysTokens = 0;
      let toolsTokens = 0;

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          const type = ev.type;

          if (type === "system/message") {
            const msg = ev.data?.message;
            if (typeof msg?.content === "string") dynamicSystemPrompt = msg.content;
            else if (Array.isArray(msg?.content)) {
              dynamicSystemPrompt = msg.content.map(b => b.text || "").filter(Boolean).join("\n");
            }
            if (dynamicSystemPrompt) sysTokens = estimateTokens(dynamicSystemPrompt);
          } else if (type === "request/header") {
            const tools = ev.data?.header?.tools || ev.data?.tools || [];
            if (tools.length > 0) {
              dynamicToolsSchema = tools.map(t => `- ${t.name}: ${t.description || ""}`).join("\n");
              toolsTokens = estimateTokens(JSON.stringify(tools));
            }
          } else if (type === "turn/start") {
            // 官方口径: 轮次由 turn/start 的 data.turn 定义 (user/message 本身不带 turn 号)
            const startNo = Number(ev.data?.turn);
            turnIdx = Number.isFinite(startNo) && startNo > 0 ? startNo : turnIdx + 1;
            if (pendingTurn) {
              pendingTurn.turnIdx = turnIdx;
              pendingTurn.totalTokens = sysTokens + toolsTokens + cumTokens;
              turns.push(pendingTurn);
              curTurn = pendingTurn;
              pendingTurn = null;
            } else {
              curTurn = {
                turnIdx,
                time: ev.time || 0,
                timestamp: formatTime(ev.time),
                userText: "",
                totalTokens: sysTokens + toolsTokens + cumTokens,
                tokenDelta: lastTotal > 0 ? sysTokens + toolsTokens + cumTokens - lastTotal : 0,
                breakdown: {
                  systemTokens: sysTokens,
                  toolsTokens,
                  userTokens: 0,
                  assistantTokens: 0,
                  toolResultTokens: 0
                },
                isCompaction: false,
                isBloat: false,
                messages: []
              };
              turns.push(curTurn);
            }
          } else if (type === "tool/call") {
            const tc = ev.data || {};
            const tName = tc.name || "tool";
            const parsedArgs = typeof tc.arguments === "string" ? unwrapArg(tc.arguments) : (tc.arguments || {});
            const sc = {
              id: tc.callId || tc.id || stableCallId(
                "dsh",
                sid,
                curTurn ? curTurn.turnIdx : 1,
                pendingDshCalls.length,
                tName,
                typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments)
              ),
              name: tName,
              args: parsedArgs,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              turn: curTurn ? curTurn.turnIdx : 1,
              time: formatTime(ev.time)
            };
            pendingDshCalls.push(sc);
          } else if (type === "request/context" && ev.data?.model) {
            model = ev.data.model;
          } else if (type === "user/message") {
            const uText = ev.data?.content || ev.data?.message?.content || "";
            const str = typeof uText === "string" ? uText : JSON.stringify(uText);
            const uTokens = estimateTokens(str);
            cumTokens += uTokens;

            const total = sysTokens + toolsTokens + cumTokens;
            const isCompaction = lastTotal > 10000 && total < lastTotal * 0.75;
            if (isCompaction) compactionCount++;

            curTurn = {
              turnIdx: turnIdx || 1,
              time: ev.time || 0,
              timestamp: formatTime(ev.time),
              userText: str.slice(0, 160).replace(/\n/g, " "),
              totalTokens: total,
              tokenDelta: lastTotal > 0 ? total - lastTotal : 0,
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
                  cat: "system",
                  tokens: sysTokens,
                  chars: 12000,
                  snippet: "DSH 全局架构与行为准则 (System Instructions)",
                  fullText: turnIdx === 1 ? (dynamicSystemPrompt || `# DeepSeek Harness System Prompt\nYou are an autonomous agent capable of shell execution and code development.`) : "[系统指令与行为准则已在第 1 轮载入]"
                },
                {
                  idx: 1,
                  role: "tools",
                  cat: "tools",
                  tokens: toolsTokens,
                  chars: 8500,
                  snippet: "DSH 挂载工具与 MCP Schema (Tools Definition)",
                  fullText: turnIdx === 1 ? (dynamicToolsSchema ? `Available Tools:\n${dynamicToolsSchema}` : `Available Tools:\n- bash\n- file_editor\n- mcp_tools`) : "[工具声明 Schema 已在第 1 轮载入]"
                },
                {
                  idx: 2,
                  role: "user",
                  cat: "user",
                  tokens: uTokens,
                  chars: str.length,
                  snippet: str.slice(0, 200).replace(/\n/g, " "),
                  fullText: str // 100% LOSSLESS!
                }
              ]
            };

            if (lastTotal > 0 && total - lastTotal > 18000) {
              curTurn.isBloat = true;
              bloatCount++;
            }

            // 轮次边界由 turn/start 决定: 先缓存, 收到 turn/start 后再按真实 turn 号入列
            if (pendingTurn) {
              const extra = curTurn.messages.filter(m => m.role === "user");
              for (const message of extra) {
                message.idx = pendingTurn.messages.length;
                pendingTurn.messages.push(message);
              }
              pendingTurn.userText = pendingTurn.userText
                ? pendingTurn.userText + " | " + curTurn.userText
                : curTurn.userText;
              curTurn = pendingTurn;
            } else {
              pendingTurn = curTurn;
            }
            lastTotal = total;
          } else if (type === "assistant/message" && curTurn) {
            const msg = ev.data?.message || {};
            let aText = "";
            let reasoning = "";
            const structuredCalls = [];
            const toolCalls = [];

            if (typeof msg.content === "string") {
              aText = msg.content;
            } else if (Array.isArray(msg.content)) {
              for (const p of msg.content) {
                if (p.type === "text") aText += (aText ? "\n" : "") + (p.text || "");
                if (p.type === "reasoning" || p.type === "thought") reasoning += (reasoning ? "\n" : "") + (p.text || p.content || "");
                if (p.type === "tool-call") {
                  const tName = p.name || "tool";
                  toolCalls.push(tName);
                  const parsedArgs = typeof p.arguments === "string" ? unwrapArg(p.arguments) : (p.arguments || {});
                  const sc = {
                    id: p.id || stableCallId(
                      "dsh",
                      sid,
                      curTurn.turnIdx,
                      pendingDshCalls.length,
                      tName,
                      typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments)
                    ),
                    name: tName,
                    args: parsedArgs,
                    arguments: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments),
                    turn: curTurn.turnIdx,
                    time: formatTime(ev.time)
                  };
                  structuredCalls.push(sc);
                  pendingDshCalls.push(sc);
                }
              }
            }

            let fullParts = [];
            if (reasoning) fullParts.push(`[Thinking 思考过程]:\n${reasoning}`);
            if (aText) fullParts.push(aText);
            if (structuredCalls.length > 0) fullParts.push(`[Tool Calls 工具调用]:\n${JSON.stringify(structuredCalls, null, 2)}`);
            const fullText = fullParts.join("\n\n") || aText || "[模型思考与规划]";

            const aTokens = estimateTokens(fullText);
            cumTokens += aTokens;
            curTurn.breakdown.assistantTokens += aTokens;
            curTurn.totalTokens += aTokens;

            const blocks = [
              ...(reasoning ? [{ type: "reasoning", lineCount: countLines(reasoning) }] : []),
              ...structuredCalls.map(tc => ({
                type: "tool-call",
                id: tc.id,
                name: tc.name,
                arguments: tc.args
              })),
              ...(aText ? [{ type: "text", lineCount: countLines(aText) }] : [])
            ];

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "assistant",
              cat: "assistant",
              tokens: aTokens,
              chars: fullText.length,
              thinking: reasoning,
              toolCalls,
              snippet: aText.slice(0, 200).replace(/\n/g, " ") || (toolCalls.length ? `[工具调用: ${toolCalls.join(", ")}]` : ""),
              fullText, // 100% LOSSLESS!
              blocks
            });
          } else if (type === "tool/result" && curTurn) {
            const res = ev.data?.message?.content || "";
            const str = typeof res === "string" ? res : JSON.stringify(res);
            const rTokens = estimateTokens(str);
            cumTokens += rTokens;
            curTurn.breakdown.toolResultTokens += rTokens;
            curTurn.totalTokens += rTokens;

            const associatedCall = pendingDshCalls.shift() || null;
            const toolName = associatedCall?.name || "tool";
            const { isError, exitCode } = inferToolExitAndStatus(str, ev.data?.isError === true, ev.data?.status);

            if (associatedCall) {
              const ops = extractFileOpsFromToolCall(
                associatedCall.name,
                associatedCall.args,
                str,
                curTurn.turnIdx,
                associatedCall.time || curTurn.timestamp,
                ev.seq || 0,
                cwd
              );
              if (ops && ops.length > 0) {
                sessionOps.push(...ops);
              }
            }

            curTurn.messages.push({
              idx: curTurn.messages.length,
              role: "tool",
              cat: "tool",
              toolName,
              toolCallId: associatedCall?.id || null,
              tokens: rTokens,
              chars: str.length,
              isError,
              exitCode,
              snippet: str.slice(0, 200).replace(/\n/g, " "),
              fullText: str, // 100% LOSSLESS!
              blocks: [
                {
                  type: "tool-result",
                  toolName,
                  callId: associatedCall?.id || null,
                  exitCode,
                  isError,
                  lineCount: countLines(str)
                }
              ]
            });
          }
        } catch (e) {}
      }
      // 没有 turn/start 的会话: 缓存中的最后一轮也要入列
      // (若已有 turn/start 且缓存轮次里没有任何 assistant 消息, 说明它只是尚未开始下一轮的
      //  用户输入, 不构成真实轮次, 直接丢弃 —— 保证 turns.length === turn/start 数)
      if (pendingTurn) {
        turns.push(pendingTurn);
        pendingTurn = null;
      }
      // 与 fold 口径对齐: 轮次 = 有 assistant 消息的轮次 (官方 turns = requests 里 data.turn 去重)
      if (turns.some(t => (t.messages || []).some(m => m.role === "assistant"))) {
        for (let i = turns.length - 1; i >= 0; i -= 1) {
          if (!(turns[i].messages || []).some(m => m.role === "assistant")) turns.splice(i, 1);
        }
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

  // ==========================================================================
  // 真值来源切换: 所有统计/构成/文件活动/命令执行/token/耗时一律来自 dsh-events.mjs 的
  // 事件流折叠 (zstd 全量解压 + 逐事件统计), 不再使用上面的 grep 结果做任何数字兜底。
  // 上面的 turns/messages 仅用于"对话正文"无损展示 (page/app.js 的消息列表)。
  // ==========================================================================
  const folded = foldDshSession(filePath, { id: sid, cwd, title, start, last });
  const foldedStats = folded.stats;
  // 目录扫描模式下 meta 里没有 cwd/title, 以折叠器从事件流读到的为准
  if (!cwd && folded.sessionMeta && folded.sessionMeta.cwd) cwd = folded.sessionMeta.cwd;

  const fileOps = folded.fileOps.length > 0 ? folded.fileOps : aggregateFileOperations(sessionOps);

  const realCurrentTokens = folded.currentContext.currentTokens;
  const limit = folded.sessionMeta.contextWindow || getModelLimit(folded.sessionMeta.model || model);
  const peakTokens = Math.max(realCurrentTokens, ...folded.steps.map(step => step.totalTokens), 0);

  return {
    id: sid,
    name: title || folded.sessionMeta.title || `DSH 会话 ${sid.slice(0, 8)}`,
    agent: "dsh",
    agentName: "DeepSeek Harness",
    agentIcon: "deepseek.svg",
    cwd,
    model: folded.sessionMeta.model || model,
    modelLimit: limit,
    watermarkPercent: limit > 0 ? Number(((realCurrentTokens / limit) * 100).toFixed(1)) : 0,
    peakTokens,
    currentTokens: realCurrentTokens,
    totalInputTokens: foldedStats.usage.uncached,
    totalOutputTokens: foldedStats.usage.output,
    totalCacheRead: foldedStats.usage.cacheRead,
    totalCacheWrite: foldedStats.usage.cacheWrite,
    cacheHitRate: folded.tokenStats.cacheHitRate,
    cost: meta?.cost || 0,
    startTime: folded.sessionMeta.startTime || formatTime(start),
    lastTime: folded.sessionMeta.lastTimeText || formatTime(last),
    timeAgo: timeAgo(last),
    // 会话级 turnsCount 与 transcript.turns 一一对应 (页面列表/详情一致);
    // dshContext.stats.turnsCount 是官方口径 (data.turn 去重), 在 dshContext 内部自洽。
    turnsCount: turns.length,
    stepsCount: foldedStats.stepsCount,
    answersCount: foldedStats.answersCount,
    skillsCount: foldedStats.skillsCount,
    compactionCount: foldedStats.events.compact,
    bloatCount,
    fileOps,
    turns,
    // 真实的 dsh-context 数据载荷 (buildContextDataset 不再覆盖它)
    dshContext: folded
  };
}

/**
 * 4. 构建全量会话大盘数据
 */
/**
 * 读取会话索引 (sessions.json)。
 * Magpie 新版本把 ~/.cache/magpie/sessions.json 改成了自定义二进制缓存 (魔数 "MGPSC"),
 * JSON.parse 会失败; 此时回退为直接扫描真实会话目录 (DSH session.v4.jsonl.zstd / Antigravity transcript.jsonl),
 * 保证插件不依赖 Magpie 的缓存格式。
 */
/**
 * Codex (OpenAI Codex CLI / Desktop) 会话解析
 * 数据源: ~/.codex/archived_sessions/rollout-*.jsonl (每行一个 JSON 记录)
 *
 * 真实记录类型 (本机 rollout 实测):
 *   session_meta                        payload.session_id / cwd / timestamp / cli_version / model_provider
 *                                       payload.base_instructions.text (真实系统提示词) / context_window
 *   turn_context                        payload.turn_id / cwd / workspace_roots
 *   response_item (message)             payload.role (user/assistant/developer) + payload.content[]
 *   response_item (function_call)       payload.name / arguments (JSON 字符串) / call_id
 *   response_item (function_call_output) payload.call_id / output (真实工具输出)
 *   token_usage_record                  payload.usage = { input_tokens, cached_input_tokens,
 *                                       cache_write_input_tokens, output_tokens, reasoning_output_tokens }
 *                                       —— **每次模型调用的真实计量** (input_tokens 已含 cached)
 *   event_msg (task_started/task_complete/turn_aborted)  → 轮次边界
 *   event_msg (token_count)             payload.info.total_token_usage (线程累计; 无记录时的兜底)
 *   event_msg (item_completed)          item.type=CommandExecution → 真实 command / exit_code / 输出
 *
 * 约定:
 *   · token 一律用真实 token_usage_record 累加 (缺失时才退回 token_count 的线程累计值), 绝不估算;
 *   · 轮次 = task_started … task_complete/turn_aborted (没有边界事件时用 turn_context 序号兜底);
 *   · 每轮内一条 assistant 消息 = 一次模型调用 = 一步;
 *   · 工具调用复用 extractFileOpsFromToolCall / aggregateFileOperations 生成 fileOps 与 commands;
 *   · 文件损坏/半行容错跳过 (归档文件可能被 Codex 进程持续追加 → 一次性 readFileSync 读全)。
 */
const CODEX_TOOL_CANONICAL = new Map(Object.entries({
  exec_command: "bash",
  shell: "bash",
  local_shell: "bash",
  exec: "bash",
  unified_exec: "bash",
  container_exec: "bash",
  write_stdin: "bash",
  read_file: "read_file",
  read_many_files: "read_file",
  write_file: "write_file",
  create_file: "write_file",
  edit_file: "edit_file",
  apply_patch: "edit_file",
  list_dir: "list_dir",
  grep_files: "grep_search",
  search_files: "grep_search",
  find_files: "glob",
  glob: "glob",
  view_image: "read_image"
}));

/** Codex function_call.arguments 是 JSON 字符串 (apply_patch 是纯文本 patch) */
function parseCodexToolArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
    return { input: parsed };
  } catch (e) {
    return { input: text };
  }
}

/** Codex apply_patch: 从 patch 文本里解析真实文件与增删行数 */
function extractCodexPatchOps(patchText, turnIdx, time, stepId, cwd) {
  const ops = [];
  const text = String(patchText === undefined || patchText === null ? "" : patchText);
  if (text === "") return ops;
  let current = null;
  const flush = () => {
    if (!current) return;
    const p = normalizePath(current.path, cwd);
    if (p) {
      ops.push({
        path: p,
        kind: "write",
        tool: "apply_patch",
        detail: current.op,
        readLines: 0,
        added: current.added,
        removed: current.removed,
        turn: turnIdx,
        time,
        stepId
      });
    }
    current = null;
  };
  for (const line of text.split("\n")) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (header) {
      flush();
      current = { op: String(header[1]).toLowerCase(), path: header[2], added: 0, removed: 0 };
      continue;
    }
    if (/^\*\*\* (End Patch|Begin Patch)/.test(line)) {
      if (line.indexOf("End Patch") !== -1) flush();
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && line.indexOf("+++") !== 0) current.added += 1;
    else if (line.startsWith("-") && line.indexOf("---") !== 0) current.removed += 1;
  }
  flush();
  return ops;
}

/** Codex message.content[] → 纯文本 (input_text / output_text / text 都是真实正文) */
function codexContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") { parts.push(item); continue; }
    if (typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

/** 是否只是环境/指令包装块 (真实内容, 但不是用户正文) → 归到 inject */
const CODEX_WRAPPER_RE = /^<(environment_context|user_instructions|model_switch|app-context|INSTRUCTIONS)>/;

export function parseCodexSession(filePath, meta, usageReqs = []) {
  const turns = [];
  const sessionOps = [];
  const pendingCalls = new Map();

  let raw = "";
  try {
    // 归档文件可能被别的进程追加: 一次读全, 不做增量拼接
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    raw = "";
  }

  let sessionId = String((meta && meta.codexSessionId) || "");
  let cwd = String((meta && meta.cwd) || "");
  let title = String((meta && meta.title) || "");
  let model = String((meta && meta.model) || "");
  let modelLimit = Number((meta && meta.modelLimit) || 0) || 0;
  let systemText = "";
  let startMs = Number(meta && meta.start ? new Date(meta.start).getTime() : 0) || 0;
  let lastMs = 0;
  let corruptLines = 0;
  let threadTotals = null;
  let compactionCount = 0;
  const usageInOrder = [];
  const usageByTurnKey = new Map();
  const exitInfoByCallId = new Map();
  const toolResultCallMessages = new Map();
  let turnSeq = 0;
  let curTurn = null;
  let stepOpen = null;

  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") records.push(obj);
    } catch (e) {
      corruptLines += 1; // 半行 / 损坏行 → 跳过, 不影响其它记录
    }
  }

  const startNewTurn = (timeMs, key) => {
    turnSeq += 1;
    const turn = {
      turnIdx: turnSeq,
      key: key || ("turn-" + turnSeq),
      time: timeMs || 0,
      timestamp: formatTime(timeMs || startMs || 0),
      userText: "",
      totalTokens: 0,
      tokenDelta: 0,
      promptTokens: 0,
      outputTokens: 0,
      breakdown: {
        systemTokens: 0,
        toolsTokens: 0,
        userTokens: 0,
        injectTokens: 0,
        skillTokens: 0,
        assistantTokens: 0,
        toolResultTokens: 0
      },
      isCompaction: false,
      isBloat: false,
      messages: []
    };
    turns.push(turn);
    if (key) usageByTurnKey.set(key, turn);
    return turn;
  };
  const ensureTurn = (timeMs) => {
    if (!curTurn) curTurn = startNewTurn(timeMs || lastMs, null);
    return curTurn;
  };
  const pushMessage = (turn, role, cat, text, timeMs, extra) => {
    const body = String(text === undefined || text === null ? "" : text);
    const tokens = extra && extra.tokens ? extra.tokens : Math.max(1, estimateTokens(body));
    const message = Object.assign({
      idx: turn.messages.length,
      role,
      cat,
      tokens,
      chars: body.length,
      time: timeMs || 0,
      snippet: body.slice(0, 200).replace(/\n/g, " "),
      fullText: body
    }, extra || {});
    message.tokens = tokens;
    message.chars = body.length;
    turn.messages.push(message);
    return message;
  };

  for (const obj of records) {
    const type = obj.type;
    const payload = (obj.payload && typeof obj.payload === "object") ? obj.payload : {};
    const tsMs = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
    if (tsMs > 0) lastMs = Math.max(lastMs, tsMs);

    if (type === "session_meta") {
      sessionId = String(payload.session_id || payload.id || sessionId);
      cwd = String(payload.cwd || cwd);
      const bi = payload.base_instructions;
      if (bi && typeof bi.text === "string" && bi.text !== "") systemText = bi.text;
      if (payload.timestamp) {
        const metaMs = new Date(payload.timestamp).getTime();
        if (metaMs > 0) startMs = metaMs;
      }
      const cw = payload.context_window;
      if (cw && Number(cw.context_window) > 0) modelLimit = Number(cw.context_window);
      continue;
    }

    if (type === "world_state") {
      // session_meta 只有 model_provider; 真实模型名还可能出现在 world_state.collaboration_mode
      const state = (payload.state && typeof payload.state === "object") ? payload.state : {};
      const collab = (state.collaboration_mode && typeof state.collaboration_mode === "object") ? state.collaboration_mode : {};
      if (!model && collab.model) model = String(collab.model);
      continue;
    }

    if (type === "turn_context") {
      if (Number(payload.context_window) > 0) modelLimit = Number(payload.context_window);
      const key = String(payload.turn_id || "");
      if (!curTurn) curTurn = startNewTurn(tsMs, key || null);
      continue;
    }

    if (type === "token_usage_record") {
      const u = (payload.usage && typeof payload.usage === "object") ? payload.usage : {};
      const usage = {
        turnId: String(payload.turn_id || ""),
        input: Number(u.input_tokens) || 0,
        cacheRead: Number(u.cached_input_tokens) || 0,
        cacheWrite: Number(u.cache_write_input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        reasoning: Number(u.reasoning_output_tokens) || 0,
        time: tsMs
      };
      usageInOrder.push(usage);
      if (usage.turnId && usageByTurnKey.has(usage.turnId)) {
        const turn = usageByTurnKey.get(usage.turnId);
        if (!turn.usage) turn.usage = [];
        turn.usage.push(usage);
      }
      continue;
    }

    if (type === "response_item") {
      const ptype = payload.type;
      if (ptype === "message") {
        const role = String(payload.role || "");
        const text = codexContentText(payload.content);
        const turn = ensureTurn(tsMs);
        if (role === "user") {
          const isWrapper = CODEX_WRAPPER_RE.test(text.trim());
          const cat = isWrapper ? "inject" : "user";
          const message = pushMessage(turn, cat, cat, text, tsMs);
          if (cat === "user") {
            turn.breakdown.userTokens += message.tokens;
            if (!turn.userText) {
              const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              turn.userText = (plain || text.slice(0, 160).replace(/\n/g, " ")).slice(0, 160);
              // 首条用户消息可能是结构化载荷 ({"page_id":null} 之类) → 不拿它当标题
              const looksStructured = plain === "" || plain.startsWith("{") || plain.startsWith("[");
              if (!title && !looksStructured) title = plain.slice(0, 60);
            }
          } else {
            turn.breakdown.injectTokens += message.tokens;
          }
          stepOpen = null;
        } else if (role === "assistant") {
          const message = pushMessage(turn, "assistant", "assistant", text, tsMs, { toolCalls: [] });
          stepOpen = message;
        } else {
          // developer / system: 真实注入指令 (首条之前视为系统指令)
          const cat = turns.length <= 1 && !turn.userText ? "system" : "inject";
          const message = pushMessage(turn, cat, cat, text, tsMs);
          if (cat === "system") turn.breakdown.systemTokens += message.tokens;
          else turn.breakdown.injectTokens += message.tokens;
        }
        continue;
      }

      if (ptype === "function_call") {
        const name = String(payload.name || "tool");
        const callId = String(payload.call_id || payload.id || "");
        const args = parseCodexToolArguments(payload.arguments);
        const canonical = CODEX_TOOL_CANONICAL.get(name) || name;
        const turn = ensureTurn(tsMs);
        if (!stepOpen) {
          stepOpen = pushMessage(turn, "assistant", "assistant", "", tsMs, { toolCalls: [], tokens: 1 });
          stepOpen.fullText = "";
        }
        const call = {
          id: callId || stableCallId(String(turn.turnIdx), String(turn.messages.length), name, String(tsMs)),
          name,
          canonical,
          args,
          turnIdx: turn.turnIdx,
          time: tsMs,
          stepId: turn.messages.length
        };
        pendingCalls.set(call.id, call);
        stepOpen.toolCalls.push(canonical);
        const argSummary = canonical === "bash"
          ? ("$ " + String(args.cmd || args.CommandLine || "").trim())
          : JSON.stringify(args).slice(0, 200);
        const callLine = "[Tool Calls 工具调用]: " + name + (argSummary ? (" " + argSummary) : "");
        stepOpen.fullText = stepOpen.fullText === "" ? callLine : (stepOpen.fullText + "\n\n" + callLine);
        stepOpen.snippet = stepOpen.fullText.slice(0, 200).replace(/\n/g, " ");
        stepOpen.chars = stepOpen.fullText.length;
        stepOpen.tokens = Math.max(1, estimateTokens(stepOpen.fullText));
        continue;
      }

      if (ptype === "function_call_output") {
        const callId = String(payload.call_id || "");
        const call = pendingCalls.get(callId) || null;
        const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output === undefined ? "" : payload.output);
        const turn = ensureTurn(tsMs);
        const info = exitInfoByCallId.get(callId) || null;
        const inferred = inferToolExitAndStatus(output, false, info && info.status ? info.status : "");
        const exitCode = info && info.exitCode !== null && info.exitCode !== undefined ? info.exitCode : inferred.exitCode;
        const isError = exitCode !== null && exitCode !== undefined ? Number(exitCode) !== 0 : inferred.isError;
        const toolName = call ? call.canonical : "tool";
        const message = pushMessage(turn, "tool_result", "tool", output, tsMs, {
          toolName,
          toolCallId: callId || null,
          call: call ? { name: call.name, args: call.args, id: call.id } : null,
          isError,
          exitCode: exitCode === undefined ? null : exitCode
        });
        // 真实命令行 / 真实耗时 (来自 CommandExecution) 供 commands 列表直接取用
        if (info && info.command) message.command = info.command;
        if (info && Number(info.durationMs) > 0) message.ms = Number(info.durationMs);
        // item_completed 事件可能晚于 function_call_output 写入 → 记录后统一回填 (见循环后)
        if (callId) toolResultCallMessages.set(callId, message);
        if (call && call.canonical) message.toolCalls = [call.canonical];
        turn.breakdown.toolResultTokens += message.tokens;
        if (call) {
          if (call.name === "apply_patch" || String(call.args.patch || call.args.input || "").indexOf("*** Begin Patch") !== -1) {
            const patchText = String(call.args.patch || call.args.input || "");
            sessionOps.push(...extractCodexPatchOps(patchText, call.turnIdx, formatTime(call.time), call.stepId, cwd));
          } else {
            const ops = extractFileOpsFromToolCall(call.canonical, call.args, output, call.turnIdx, formatTime(call.time), call.stepId, cwd);
            if (ops && ops.length > 0) sessionOps.push(...ops);
          }
        }
        pendingCalls.delete(callId);
        stepOpen = null;
        continue;
      }

      if (ptype === "compaction" || ptype === "context_compaction") compactionCount += 1;
      continue;
    }

    if (type === "event_msg") {
      const ptype = payload.type;
      if (ptype === "thread_settings_applied") {
        // 真实模型名在 thread_settings 里 (session_meta 只有 model_provider)
        const settings = (payload.thread_settings && typeof payload.thread_settings === "object") ? payload.thread_settings : {};
        if (settings.model) model = String(settings.model);
        continue;
      }
      if (ptype === "task_started") {
        const key = String(payload.turn_id || payload.root_turn_id || "");
        if (Number(payload.model_context_window) > 0) modelLimit = Number(payload.model_context_window);
        curTurn = startNewTurn(tsMs, key || null);
        stepOpen = null;
        continue;
      }
      if (ptype === "task_complete" || ptype === "turn_aborted") {
        curTurn = null;
        stepOpen = null;
        continue;
      }
      if (ptype === "token_count") {
        const info = payload.info || {};
        if (info.total_token_usage && typeof info.total_token_usage === "object") threadTotals = info.total_token_usage;
        if (Number(info.model_context_window) > 0) modelLimit = Number(info.model_context_window);
        continue;
      }
      if (ptype === "item_completed") {
        const item = (payload.item && typeof payload.item === "object") ? payload.item : {};
        if (item.type === "CommandExecution") {
          const id = String(item.id || "");
          let commandText = "";
          if (Array.isArray(item.command)) {
            const argv = item.command.filter(part => typeof part === "string");
            // /bin/zsh -lc "<cmd>" → 取真实命令行本身
            commandText = argv.length >= 3 && /(^|\/)(zsh|bash|sh)$/.test(argv[0]) ? argv[argv.length - 1] : argv.join(" ");
          } else if (typeof item.command === "string") {
            commandText = item.command;
          }
          if (id) {
            const dur = item.duration && typeof item.duration === "object" ? item.duration : null;
            const durationMs = dur ? ((Number(dur.secs) || 0) * 1000 + Math.round((Number(dur.nanos) || 0) / 1e6)) : 0;
            exitInfoByCallId.set(id, {
              exitCode: item.exit_code === undefined ? null : item.exit_code,
              status: item.status || "",
              command: commandText,
              durationMs
            });
          }
        }
        continue;
      }
      continue;
    }
  }

  // CommandExecution 事件 (真实 command / exit_code / duration) 可能晚于 function_call_output 落盘,
  // 因此解析完整个文件后按 call_id 统一回填到对应的 tool_result 消息 (commands / fileOps 全靠它)。
  for (const pair of exitInfoByCallId) {
    const callId = pair[0];
    const info = pair[1];
    const message = toolResultCallMessages.get(callId);
    if (!message || !info) continue;
    if (info.command) message.command = info.command;
    if (Number(info.durationMs) > 0) message.ms = Number(info.durationMs);
    if (info.exitCode !== null && info.exitCode !== undefined) {
      message.exitCode = info.exitCode;
      message.isError = Number(info.exitCode) !== 0;
    }
  }

  // 系统提示词 (base_instructions.text) 挂到首轮, 真实内容
  if (systemText !== "") {
    if (turns.length === 0) startNewTurn(startMs, null);
    const first = turns[0];
    const sysTokens = Math.max(1, estimateTokens(systemText));
    first.breakdown.systemTokens += sysTokens;
    first.messages.unshift({
      idx: 0,
      role: "system",
      cat: "system",
      tokens: sysTokens,
      chars: systemText.length,
      time: first.time || startMs || 0,
      snippet: systemText.slice(0, 200).replace(/\n/g, " "),
      fullText: systemText
    });
    first.messages.forEach((message, i) => { message.idx = i; });
  }
  // 没有任何真实内容 (只有 session_meta 或文件为空) 时不造轮次: 页面显示空态, 不编数据

  // ===== 真实 token 归属: 每个 turn 的 token_usage_record 按调用顺序配给该轮的 assistant 消息 =====
  let prevPrompt = 0;
  for (const turn of turns) {
    const usages = Array.isArray(turn.usage) ? turn.usage : [];
    delete turn.usage;
    const assistantMsgs = turn.messages.filter(m => m.role === "assistant");
    usages.forEach((usage, i) => {
      const message = assistantMsgs[i];
      if (!message) return;
      message.promptTokens = Math.max(0, usage.input);
      message.outputTokens = usage.output;
      message.cacheReadTokens = usage.cacheRead;
      message.inputTokens = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
      if (message.outputTokens > 0) message.tokens = message.outputTokens;
    });
    const lastUsage = usages.length > 0 ? usages[usages.length - 1] : null;
    const turnOutput = usages.reduce((acc, usage) => acc + usage.output, 0);
    turn.outputTokens = turnOutput;
    if (turnOutput > 0) turn.breakdown.assistantTokens = Math.max(turn.breakdown.assistantTokens, turnOutput);
    const turnPrompt = lastUsage ? Math.max(0, lastUsage.input) : 0;
    turn.promptTokens = turnPrompt;
    if (turnPrompt > 0) {
      turn.totalTokens = turnPrompt;
      turn.tokenDelta = prevPrompt > 0 ? turnPrompt - prevPrompt : 0;
      prevPrompt = turnPrompt;
    } else {
      turn.totalTokens = turn.messages.reduce((acc, m) => acc + (Number(m.tokens) || 0), 0);
      turn.tokenDelta = 0;
    }
    turn.isBloat = turn.tokenDelta > 18000;
  }

  // ===== 会话级真实 token 汇总 (input_tokens 已含 cached/cacheWrite) =====
  let inputSum = 0;
  let cacheReadSum = 0;
  let cacheWriteSum = 0;
  let outputSum = 0;
  for (const usage of usageInOrder) {
    inputSum += usage.input;
    cacheReadSum += usage.cacheRead;
    cacheWriteSum += usage.cacheWrite;
    outputSum += usage.output;
  }
  let tokenSource = usageInOrder.length > 0 ? "token_usage_record" : "";
  if (usageInOrder.length === 0 && threadTotals) {
    inputSum = Number(threadTotals.input_tokens) || 0;
    cacheReadSum = Number(threadTotals.cached_input_tokens) || 0;
    cacheWriteSum = Number(threadTotals.cache_write_input_tokens) || 0;
    outputSum = Number(threadTotals.output_tokens) || 0;
    tokenSource = "token_count";
  }
  if (usageInOrder.length === 0 && !threadTotals && Array.isArray(usageReqs) && usageReqs.length > 0) {
    // 网关侧 usage.jsonl 的真实计量兜底 (只有该会话在网关留下记录时才有)
    for (const req of usageReqs) {
      const inTok = Number(req.in || req.input || 0) || 0;
      const outTok = Number(req.out || req.output || 0) || 0;
      const cacheRead = Number(req.cache_read || 0) || 0;
      inputSum += Math.max(0, inTok - cacheRead);
      cacheReadSum += cacheRead;
      outputSum += outTok;
    }
    tokenSource = "usage.jsonl";
  }
  const uncachedInput = Math.max(0, inputSum - cacheReadSum - cacheWriteSum);

  const currentTokens = (() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const prompt = Number(turns[i].promptTokens) || 0;
      if (prompt > 0) return prompt;
    }
    return 0;
  })();
  const peakTokens = Math.max(currentTokens, ...turns.map(turn => Number(turn.totalTokens) || 0), 0);
  const promptForCache = uncachedInput + cacheReadSum + cacheWriteSum;
  const cacheHitRate = promptForCache > 0 ? ((cacheReadSum / promptForCache) * 100).toFixed(2) : "0.00";
  const stepsCount = turns.reduce((acc, turn) => acc + turn.messages.filter(m => m.role === "assistant").length, 0);
  const limit = modelLimit > 0 ? modelLimit : getModelLimit(model);
  const fileOps = aggregateFileOperations(sessionOps);
  const lastTurnTime = turns.reduce((acc, turn) => Math.max(acc, Number(turn.time) || 0), 0);
  const endMs = lastTurnTime > 0 ? Math.max(lastTurnTime, lastMs) : (lastMs || startMs);

  return {
    id: String((meta && meta.id) || ("codex-" + (sessionId || path.basename(filePath, path.extname(filePath))))),
    name: title || ("Codex 会话 " + String(sessionId).slice(0, 8)),
    agent: "codex",
    agentName: "Codex",
    agentIcon: "codex.svg",
    codexSessionId: sessionId,
    codexSourcePath: filePath,
    codexTokenSource: tokenSource,
    // 整个 rollout 没有任何真实 token 记录 (早期版本不落 token_usage_record):
    // 打标给 buildDshContextPayload, 让它不要把内容估算当成「当前上下文」,
    // 否则卡片中心数字 (真实 0) 会小于当前上下文 (估算值), 同一会话两个口径就打架了。
    noRealTokenUsage: tokenSource === "",
    codexCorruptLines: corruptLines,
    cwd,
    model,
    modelLimit: limit,
    watermarkPercent: limit > 0 ? Number(((currentTokens / limit) * 100).toFixed(1)) : 0,
    peakTokens,
    currentTokens,
    totalInputTokens: uncachedInput,
    totalOutputTokens: outputSum,
    totalCacheRead: cacheReadSum,
    totalCacheWrite: cacheWriteSum,
    cacheHitRate,
    cost: 0,
    startTime: formatTime(startMs || (turns[0] && turns[0].time) || 0),
    lastTime: formatTime(endMs || 0),
    timeAgo: timeAgo(endMs || startMs || Date.now()),
    turnsCount: turns.length,
    stepsCount,
    answersCount: stepsCount,
    skillsCount: 0,
    compactionCount,
    bloatCount: turns.filter(turn => turn.isBloat).length,
    fileOps,
    turns
  };
}

/**
 * 4. 构建全量会话大盘数据
 */
/**
 * 扫描 Codex rollout 文件 (~/.codex/archived_sessions + ~/.codex/sessions)。
 * 同一 thread 会被切成多个 rollout 文件 (session_meta.session_id 相同) → id 用 codex-<session_id>,
 * 冲突时按文件时间追加序号, 保证会话 id / 详情分片文件名唯一且稳定。
 * 抽成独立函数: 便于单测直接断言扫描结果 (会话数 / id 唯一性 / agent 归属)。
 */
export function collectCodexRolloutMetas() {
    const out = {};
  // 3) Codex: ~/.codex/archived_sessions/rollout-*.jsonl (每行一个 JSON 记录; 可能被 Codex 持续追加)
  //    同一 thread 会被切成多个 rollout 文件 (session_meta.session_id 相同) → id 用 codex-<session_id>,
  //    冲突时按文件时间追加序号, 保证会话 id / 详情分片文件名唯一且稳定。
  const codexRoots = [
    path.join(HOME, ".codex/archived_sessions"),
    path.join(HOME, ".codex/sessions")
  ];
  const codexEntries = [];
  for (const root of codexRoots) {
    if (!fs.existsSync(root)) continue;
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { names = []; }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const filePath = path.join(root, name);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch (e) { stat = null; }
      if (!stat || !stat.isFile()) continue;
      codexEntries.push({ filePath, stat });
    }
  }
  codexEntries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  const codexIdUsed = new Map();
  for (const entry of codexEntries) {
    let sid = "";
    try {
      const fd = fs.openSync(entry.filePath, "r");
      const headBuf = Buffer.alloc(262144);
      const n = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      fs.closeSync(fd);
      const headText = headBuf.subarray(0, n).toString("utf8");
      const firstLine = headText.split("\n").find(line => line.trim() !== "") || "";
      const head = JSON.parse(firstLine);
      const payload = head && head.payload ? head.payload : {};
      sid = String(payload.session_id || payload.id || "");
    } catch (e) {
      sid = "";
    }
    if (!sid) sid = path.basename(entry.filePath, ".jsonl").replace(/^rollout-/, "");
    const baseId = "codex-" + sid;
    const seen = codexIdUsed.get(baseId) || 0;
    codexIdUsed.set(baseId, seen + 1);
    const id = seen === 0 ? baseId : baseId + "-" + (seen + 1);
    out[entry.filePath] = {
      agent: "codex",
      id,
      codexSessionId: sid,
      cwd: "",
      title: "",
      model: "",
      modelLimit: 0,
      start: entry.stat.mtimeMs,
      last: entry.stat.mtimeMs,
      size: entry.stat.size,
      filePath: entry.filePath
    };
  }

  return out;
}

function scanSessionsFromDisk() {
  const files = {};

  // 1) DSH: ~/.dsh/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd
  const dshRoot = path.join(HOME, ".dsh/sessions");
  if (fs.existsSync(dshRoot)) {
    let workspaceDirs = [];
    try { workspaceDirs = fs.readdirSync(dshRoot, { withFileTypes: true }).filter(e => e.isDirectory()); } catch {}
    for (const ws of workspaceDirs) {
      const wsDir = path.join(dshRoot, ws.name);
      let sessionDirs = [];
      try { sessionDirs = fs.readdirSync(wsDir, { withFileTypes: true }).filter(e => e.isDirectory()); } catch {}
      for (const sd of sessionDirs) {
        const filePath = path.join(wsDir, sd.name, "session.v4.jsonl.zstd");
        if (!fs.existsSync(filePath)) continue;
        let stat = null;
        try { stat = fs.statSync(filePath); } catch {}
        const meta = {
          agent: "dsh",
          id: sd.name,
          cwd: "",
          title: "",
          start: stat ? stat.mtimeMs : Date.now(),
          last: stat ? stat.mtimeMs : Date.now(),
          size: stat ? stat.size : 0,
          filePath
        };
        // cwd / createdAt / title 由 parseDshSession -> foldDshSession 从事件流中取得
        // (这里不再解压, 避免与 fold 重复解压 100MB+)
        files[filePath] = meta;
      }
    }
  }

  // 2) Antigravity: ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
  const brainRoot = path.join(HOME, ".gemini/antigravity/brain");
  if (fs.existsSync(brainRoot)) {
    let dirs = [];
    try { dirs = fs.readdirSync(brainRoot, { withFileTypes: true }).filter(e => e.isDirectory()); } catch {}
    for (const d of dirs) {
      const transcript = path.join(brainRoot, d.name, ".system_generated/logs/transcript.jsonl");
      if (!fs.existsSync(transcript)) continue;
      let stat = null;
      try { stat = fs.statSync(transcript); } catch {}
      const meta = {
        agent: "antigravity",
        id: d.name,
        cwd: "",
        title: "",
        start: stat ? stat.mtimeMs : Date.now(),
        last: stat ? stat.mtimeMs : Date.now(),
        size: stat ? stat.size : 0,
        filePath: transcript
      };
      try {
        const fd = fs.openSync(transcript, "r");
        const headBuf = Buffer.alloc(1048576);
        const n = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
        fs.closeSync(fd);
        const headText = headBuf.subarray(0, n).toString("utf8");
        const cwdMatch = headText.match(/Working directory:\s*([^\n"<>\\]+)/);
        if (cwdMatch) meta.cwd = cwdMatch[1].trim();
        const firstUser = headText.split("\n").find(l => l.includes('"type":"USER_INPUT"'));
        if (firstUser) {
          try {
            const ev = JSON.parse(firstUser);
            let content = typeof ev.content === "string" ? ev.content : "";
            const reqMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (reqMatch) content = reqMatch[1];
            content = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (content) meta.title = content.slice(0, 60);
          } catch {}
        }
      } catch {}
      files[transcript] = meta;
    }
  }

  // 3) Codex: ~/.codex/archived_sessions + ~/.codex/sessions 下的 rollout-*.jsonl
  //    同一 thread 会被切成多个 rollout 文件 → id 用 codex-<session_id>, 冲突追加序号
  Object.assign(files, collectCodexRolloutMetas());

  return { files };
}
function loadSessionsIndex() {
  if (fs.existsSync(SESSIONS_JSON_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SESSIONS_JSON_PATH, "utf8"));
    } catch (e) {
      const head = (() => {
        try { return fs.readFileSync(SESSIONS_JSON_PATH).subarray(0, 5).toString("latin1"); } catch { return ""; }
      })();
      console.log("[Daemon] sessions.json 不可解析(可能为二进制缓存 " + JSON.stringify(head) + "), 使用目录扫描");
    }
  }
  return scanSessionsFromDisk();
}

/** 去掉会话 id 前缀 (`session-` / `subagent-` / `agent-`), 便于和裸 uuid 的 childId 对齐 */
function stripSessionIdPrefix(rawId) {
  const value = String(rawId === null || rawId === undefined ? "" : rawId).trim();
  if (value === "") return "";
  return value.replace(/^(?:session|subagent|agent)-/i, "");
}

/**
 * 子 Agent ↔ 会话映射回填 (在 buildContextDataset 组装完 sessions 之后调用一次)。
 *
 * 匹配规则: 对每个子 Agent 的 childId 生成三个候选键 ——
 *   ① childId 原样          ② `session-${childId}`        ③ 去掉前缀后的裸 id
 * 任一命中「已加载会话 id」(CONTEXT_SESSIONS[].id, 含去前缀索引) → sessionId = 该会话 id, matched = true;
 * 未加载但命中「扫描到的会话 id 集合」→ sessionId = null (该会话没有详情可跳转), matched = true;
 * 都不命中 → sessionId = null, matched = false。
 *
 * 复杂度: 索引全部走 Set/Map, 每个子 Agent 最多 3 次查表 → O(会话数 + 子Agent数), 不做嵌套扫描。
 */
export function linkFleetSubagentSessions(sessions, scannedSessionIds) {
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const loadedByKey = new Map(); // 候选键 -> 已加载会话真实 id
  for (const session of sessionList) {
    const rawId = session && session.id !== null && session.id !== undefined ? String(session.id) : "";
    if (rawId === "") continue;
    if (!loadedByKey.has(rawId)) loadedByKey.set(rawId, rawId);
    const bareId = stripSessionIdPrefix(rawId);
    if (bareId !== "" && !loadedByKey.has(bareId)) loadedByKey.set(bareId, rawId);
  }
  const scannedKeys = new Set();
  const scannedList = scannedSessionIds instanceof Set
    ? Array.from(scannedSessionIds)
    : (Array.isArray(scannedSessionIds) ? scannedSessionIds : []);
  for (const rawId of scannedList) {
    const id = String(rawId === null || rawId === undefined ? "" : rawId).trim();
    if (id === "") continue;
    scannedKeys.add(id);
    const bareId = stripSessionIdPrefix(id);
    if (bareId !== "") scannedKeys.add(bareId);
  }

  let total = 0;
  let linked = 0;
  let matched = 0;
  for (const session of sessionList) {
    const fleet = session && session.dshContext ? session.dshContext.fleet : null;
    const subagents = fleet && Array.isArray(fleet.subagents) ? fleet.subagents : null;
    if (!subagents || subagents.length === 0) continue;
    let sessionMatched = 0;
    for (const subagent of subagents) {
      if (!subagent || typeof subagent !== "object") continue;
      total += 1;
      const childRaw = String(subagent.childId || subagent.id || "").trim();
      const candidates = childRaw === ""
        ? []
        : [childRaw, "session-" + childRaw, stripSessionIdPrefix(childRaw)];
      let loadedId = null;
      for (const key of candidates) {
        if (key !== "" && loadedByKey.has(key)) { loadedId = loadedByKey.get(key); break; }
      }
      let inScanned = false;
      if (loadedId === null) {
        for (const key of candidates) {
          if (key !== "" && scannedKeys.has(key)) { inScanned = true; break; }
        }
      }
      subagent.sessionId = loadedId;
      subagent.matched = loadedId !== null || inScanned;
      if (loadedId !== null) linked += 1;
      if (subagent.matched) {
        matched += 1;
        sessionMatched += 1;
      }
    }
    if (fleet) fleet.matchedSubagentCount = sessionMatched;
  }
  return { total, matched, linked };
}

export function buildContextDataset() {
  const sessions = [];
  // 索引里扫描到的全部会话 id (含未加载进 sessions 的): 供子 Agent ↔ 会话映射使用
  const scannedSessionIds = new Set();

  // 读取 usage.jsonl
  const { reqsBySession, unlinkedRequests } = readUsageRequests();

  // 读取会话索引: 优先 sessions.json (JSON); 若被 Magpie 换成二进制缓存则回退到真实会话目录扫描
  {
    try {
      const d = loadSessionsIndex();
      const files = d.files || {};

      const sortedEntries = Object.entries(files).sort((a, b) => {
        const timeA = new Date(a[1].last || a[1].start || 0).getTime();
        const timeB = new Date(b[1].last || b[1].start || 0).getTime();
        return timeB - timeA;
      });

      let antigravityCount = 0;
      let dshCount = 0;
      let codexCount = 0;
      for (const [fpath, meta] of sortedEntries) {
        const agent = meta.agent;
        const sid = meta.id || path.basename(fpath, path.extname(fpath));
        scannedSessionIds.add(String(sid));
        const matchedUsage = reqsBySession.get(sid) || [];

        if (agent === "antigravity" && antigravityCount < 25) {
          sessions.push(parseAntigravitySession(sid, meta.cwd, meta.title, meta.start, meta.last, meta, matchedUsage));
          antigravityCount++;
        } else if (agent === "dsh" && dshCount < 25) {
          sessions.push(parseDshSession(meta.filePath || fpath, meta, matchedUsage));
          dshCount++;
        } else if (agent === "codex" && codexCount < 25) {
          // Codex: ~/.codex/archived_sessions/rollout-*.jsonl, 与 DSH/Antigravity 并列的真实数据源
          sessions.push(parseCodexSession(meta.filePath || fpath, meta, matchedUsage));
          codexCount++;
        }
      }
    } catch (e) {
      console.error("[Daemon] Error building session index:", e.message);
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
    clusters.slice(-15).forEach((c) => {
      const first = c.requests[0];
      const last = c.requests[c.requests.length - 1];
      // 稳定 id (数据契约 v2): 用聚类首条请求的 route_id / 起始时间, 不再拼 Date.now()。
      // 否则每次 sync 都换 id → 详情文件名不稳定 → watch 模式每 5s 新建+删除 15 个分片(磁盘抖动),
      // 且页面懒加载可能拿到已被清理的旧文件名。
      const clusterKey = first.route_id || new Date(c.start).getTime() || 0;
      const sid = `usage-cluster-${clusterKey}-${c.agent}`;
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

/** 秒 → "12s" / "1m2s" (timingStats.ruler 刻度用) */
function formatDurationSeconds(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${total % 60}s`;
}

function buildDshContextPayload(s) {
  // ==========================================================================
  // 仅用于**非 DSH** 会话 (antigravity 等)。DSH 会话的 dshContext 由 dsh-events.mjs 的
  // foldDshSession 提供真实事件流数据, 不会进入本函数。
  // 本函数的所有数字只来自会话自身的真实字段, 不再有任何百分比常量 / 公式摊派 / mock 兜底;
  // 没有数据的维度一律返回 0 或空数组 (页面显示空态), 绝不再编数字。
  // ==========================================================================
  const turns = s.turns || [];
  const turnsCount = turns.length;
  const lastTurn = Object.assign({}, turns[turns.length - 1] || {});
  const limit = s.modelLimit || 0;

  // 1. 当前上下文 7 分类: 只取最后一条真实 breakdown (无数据即 0)
  const b = lastTurn.breakdown || {};
  const categoryRaw = {
    system: Number(b.systemTokens) || 0,
    tools: Number(b.toolsTokens) || 0,
    user: Number(b.userTokens) || 0,
    inject: Number(b.injectTokens) || 0,
    skill: Number(b.skillTokens) || 0,
    assistant: Number(b.assistantTokens) || 0,
    tool: Number(b.toolResultTokens) || 0
  };
  const sysTok = categoryRaw.system;
  const toolsTok = categoryRaw.tools;
  const categoryColors = {
    system: "#a855f7", tools: "#eab308", user: "#10b981", inject: "#c026d3",
    skill: "#f97316", assistant: "#3b82f6", tool: "#06b6d4"
  };
  const categoryLabels = {
    system: "系统提示词", tools: "工具定义", user: "用户消息", inject: "注入内容",
    skill: "技能注入", assistant: "助手消息", tool: "工具结果"
  };
  let categorySum = 0;
  for (const key of Object.keys(categoryRaw)) categorySum += categoryRaw[key];
  // 当前上下文 = **最后一次请求的真实 prompt 总量** (transcript 的 input_tokens + cache_read_tokens),
  // 与 DSH 侧 currentContext.currentTokens 同口径; 没有真实计量才退回分类加总。
  let lastPromptTokens = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const promptTokens = Number(turns[i] && turns[i].promptTokens) || 0;
    if (promptTokens > 0) { lastPromptTokens = promptTokens; break; }
  }
  // 没有任何真实 token 计量的会话 (如早期 Codex rollout): 当前上下文同样保持 0,
  // 不用内容估算冒充计量口径 —— 保证「卡片中心数字 >= 当前上下文」在同一会话内恒成立。
  const noRealMetering = s.noRealTokenUsage === true && Number(s.totalInputTokens || 0) === 0
    && Number(s.totalCacheRead || 0) === 0 && Number(s.totalOutputTokens || 0) === 0;
  // 没有任何 assistant 消息的会话 (如只有一条 SYSTEM_MESSAGE 的残缺 transcript):
  // 不存在真实模型请求, 当前上下文按 0 处理, 不用内容估算冒充计量口径。
  const hasAssistantMessage = turns.some(turn => (turn.messages || []).some(message => message.role === "assistant"));
  const currentTokens = !hasAssistantMessage
    ? 0
    : (lastPromptTokens > 0
      ? lastPromptTokens
      : ((categorySum > 0 && !noRealMetering) ? categorySum : Number(s.currentTokens) || 0));
  const wm = limit > 0 ? Number(((currentTokens / limit) * 100).toFixed(1)) : 0;
  // 7 分类是「逐类真实内容量级估算」, 总量**校准**到真实 prompt —— 与 dsh-events 同口径
  // (那里也是「分类 = 真实内容估算, 总量校准到服务商回报的计费总量」)。不做无依据的常量摊派。
  const categoryScale = categorySum > 0 && currentTokens > 0 ? currentTokens / categorySum : 1;
  const scaledCategoryTokens = {};
  let scaledCategorySum = 0;
  for (const key of Object.keys(categoryRaw)) {
    const scaled = Math.max(0, Math.round((Number(categoryRaw[key]) || 0) * categoryScale));
    scaledCategoryTokens[key] = scaled;
    scaledCategorySum += scaled;
  }
  // 四舍五入余量补到最大的一类, 保证 7 分类之和 == 当前上下文 (堆叠条与中心数字不会对不上)
  if (scaledCategorySum !== currentTokens && currentTokens > 0) {
    let biggestKey = null;
    for (const key of Object.keys(scaledCategoryTokens)) {
      if (biggestKey === null || scaledCategoryTokens[key] > scaledCategoryTokens[biggestKey]) biggestKey = key;
    }
    if (biggestKey !== null) {
      scaledCategoryTokens[biggestKey] = Math.max(0, scaledCategoryTokens[biggestKey] + (currentTokens - scaledCategorySum));
    }
  }
  const curCategories = Object.keys(categoryRaw).map(key => {
    const tokens = scaledCategoryTokens[key];
    const percent = currentTokens > 0
      ? Math.max(0, Math.min(100, Number(((tokens / currentTokens) * 100).toFixed(1))))
      : 0;
    return {
      key,
      label: categoryLabels[key],
      tokens,
      formatted: formatK(tokens),
      percent,
      color: categoryColors[key]
    };
  });

  // 2. Token 统计: 总量用真实 usage, 分类占比用各轮真实 breakdown 累加
  // 口径 (与 dsh-events.mjs foldDshSession 完全一致):
  //   totalUsage = uncachedInput + cacheReadTokens + cacheWriteTokens + outputTokens
  // 旧口径 Σinput + Σoutput 漏掉了 cacheRead: 缓存命中率高时 prompt 绝大部分都在 cacheRead 里,
  // 卡片中心数字会比「当前上下文」小一个量级, 也与分类累计口径对不上。
  const uncachedInputTokens = Number(s.totalInputTokens || 0);
  const cacheReadTokens = Number(s.totalCacheRead || 0);
  const cacheWriteTokens = Number(s.totalCacheWrite || 0);
  const outputTokensTotal = Number(s.totalOutputTokens || 0);
  const totalUsage = uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokensTotal;
  const cumulative = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 };
  let replyTokens = 0;
  let thinkingTokens = 0;
  let toolCallTokens = 0;
  for (const turn of turns) {
    const bd = turn.breakdown || {};
    cumulative.system += Number(bd.systemTokens) || 0;
    cumulative.tools += Number(bd.toolsTokens) || 0;
    cumulative.user += Number(bd.userTokens) || 0;
    cumulative.inject += Number(bd.injectTokens) || 0;
    cumulative.skill += Number(bd.skillTokens) || 0;
    cumulative.assistant += Number(bd.assistantTokens) || 0;
    cumulative.tool += Number(bd.toolResultTokens) || 0;
    for (const message of turn.messages || []) {
      if (message.role === "assistant") {
        if (typeof message.thinking === "string" && message.thinking !== "") thinkingTokens += Number(message.tokens) || 0;
        else replyTokens += Number(message.tokens) || 0;
      } else if (message.role === "tool" || message.role === "tool_result") {
        toolCallTokens += Number(message.tokens) || 0;
      }
    }
  }
  const tokenRaw = {
    system: cumulative.system,
    tools: cumulative.tools,
    user: cumulative.user,
    inject: cumulative.inject,
    skill: cumulative.skill,
    toolCall: cumulative.tool + toolCallTokens,
    thinking: thinkingTokens,
    reply: replyTokens
  };
  let tokenRawSum = 0;
  for (const key of Object.keys(tokenRaw)) tokenRawSum += tokenRaw[key];
  const tokenLabels = {
    system: "系统提示词", tools: "工具定义", user: "用户消息", inject: "注入内容",
    skill: "技能注入", toolCall: "工具调用", thinking: "模型思考", reply: "模型回复"
  };
  const tokenColors = {
    system: "#a855f7", tools: "#eab308", user: "#10b981", inject: "#c026d3",
    skill: "#f97316", toolCall: "#d97706", thinking: "#8b5cf6", reply: "#f43f5e"
  };
  // 分类累计按真实 totalUsage 校准 (与 currentContext 7 分类同一原则):
  // 分类数字是「逐轮真实 breakdown + 真实消息 token」的累加, 总量校准到真实 totalUsage,
  // 保证 卡片中心数字 == 各分类之和 == 百分比分母 (环形图不会出现「分类和 ≠ 中心数字」)。
  // 没有任何真实计量的会话 (noRealMetering): 分类累计一并归零, 与中心数字保持同一空态
  // (内容估算仍保留在 steps / browserCategories 明细里, 不冒充 token 计量)
  const tokenScale = totalUsage > 0 && tokenRawSum > 0 ? totalUsage / tokenRawSum : (noRealMetering ? 0 : 1);
  const tokenDenom = totalUsage > 0 ? totalUsage : tokenRawSum;
  const scaledTokenRaw = {};
  let scaledTokenSum = 0;
  for (const key of Object.keys(tokenRaw)) {
    scaledTokenRaw[key] = Math.max(0, Math.round((Number(tokenRaw[key]) || 0) * tokenScale));
    scaledTokenSum += scaledTokenRaw[key];
  }
  if (totalUsage > 0 && scaledTokenSum !== totalUsage) {
    let biggestKey = null;
    for (const key of Object.keys(scaledTokenRaw)) {
      if (biggestKey === null || scaledTokenRaw[key] > scaledTokenRaw[biggestKey]) biggestKey = key;
    }
    if (biggestKey !== null) scaledTokenRaw[biggestKey] = Math.max(0, scaledTokenRaw[biggestKey] + (totalUsage - scaledTokenSum));
  }
  const tokenCategories = Object.keys(tokenRaw).map(key => {
    const tokens = scaledTokenRaw[key];
    const percent = tokenDenom > 0
      ? Math.max(0, Math.min(100, Number(((tokens / tokenDenom) * 100).toFixed(2))))
      : 0;
    return {
      key,
      label: tokenLabels[key],
      tokens,
      formatted: formatK(tokens),
      percent,
      color: tokenColors[key]
    };
  });
  // 缓存命中率 = cacheRead / (uncachedInput + cacheRead + cacheWrite) —— 与 dsh-events 同口径
  const promptTotal = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const cacheHitRate = promptTotal > 0
    ? ((cacheReadTokens / promptTotal) * 100).toFixed(2)
    : "0.00";

  // 3. 耗时统计: 全部来自 transcript 的真实 created_at 时间戳 (不再有公式/百分比假值)
  //    · 相邻事件区间按「后一个事件」的类型归类, 区间互不重叠:
  //        PLANNER_RESPONSE → 模型生成 (等待 + 思考 + 生成)
  //        GENERIC          → 工具执行
  //        USER_INPUT / 运行期 SYSTEM_MESSAGE(注入) → **空闲**(等人 / 等调度 nudge), 不计入活跃时长
  //        ERROR / CHECKPOINT → 其他
  //    · 活跃时长 activeMs = 模型生成 + 工具执行 + 其他; 轮内跨度 - activeMs = idleMs
  //      (实测 4bb2d344: 轮内跨度 4h22m 里有 3h36m 是"注入前等人", 另有 62h 跨轮空闲;
  //       旧实现用「首末时间差」直接算出 75h34m 的假活跃时长)
  //    · created_at 只有 1 秒精度: 与上一条事件同一秒的模型步按 1s 下限计,
  //      否则「输出速度」会被 0ms 的分母放大到几千 tok/s
  //    · TTFT / 思考 / 参数生成在 transcript 里没有分点时间数据 → 不拆假桶, 桶上标 estimated: true
  const MIN_STEP_MS = 1000;
  const formatSpanHm = (ms) => {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.round((total % 60000) / 1000);
    if (hours > 0) return hours + "h" + minutes + "m";
    if (minutes > 0) return minutes + "m" + seconds + "s";
    return seconds + "s";
  };
  let spanMs = 0;       // 各轮「首条事件 → 末条事件」跨度之和 (含轮内空闲)
  let genMs = 0;        // 模型生成 (PLANNER_RESPONSE 到达前的真实间隔)
  let toolsMs = 0;      // 工具执行 (GENERIC 到达前的真实间隔)
  let otherMs = 0;      // ERROR / CHECKPOINT 等其他真实间隔
  let idleGapMs = 0;    // 注入 / 用户消息到达前的等待 (空闲, 不计活跃)
  let toolEventCount = 0;
  let modelEventCount = 0;
  let wallFirstTime = 0;
  let wallLastTime = 0;
  for (const turn of turns) {
    const timed = (turn.messages || [])
      .map(message => ({ role: message && message.role, time: Number(message && message.time) || 0 }))
      .filter(entry => entry.time > 0);
    if (timed.length === 0) continue;
    const turnStart = timed[0].time;
    const turnEnd = timed[timed.length - 1].time;
    if (turnEnd > turnStart) spanMs += turnEnd - turnStart;
    wallFirstTime = wallFirstTime > 0 ? Math.min(wallFirstTime, turnStart) : turnStart;
    wallLastTime = Math.max(wallLastTime, turnEnd);
    for (let i = 1; i < timed.length; i += 1) {
      const deltaMs = timed[i].time - timed[i - 1].time;
      if (deltaMs < 0) continue;
      const role = timed[i].role;
      if (role === "assistant") {
        genMs += Math.max(deltaMs, MIN_STEP_MS); // 1s 精度 → 同秒也算 1s, 不记 0
        modelEventCount += 1;
      } else if (role === "tool_result" || role === "tool") {
        toolsMs += deltaMs;
        toolEventCount += 1;
      } else if (role === "user" || role === "inject" || role === "system") {
        idleGapMs += deltaMs;
      } else {
        otherMs += deltaMs;
      }
    }
  }
  // 兜底: 没有任何相邻事件对但有首末时间戳时, 用首末事件差当跨度
  if (spanMs <= 0 && wallFirstTime > 0 && wallLastTime > wallFirstTime) spanMs = wallLastTime - wallFirstTime;
  let activeMs = genMs + toolsMs + otherMs;
  // 1 秒精度下限可能让桶和略超真实跨度 (极短会话尤其明显) → 等比压回跨度内, 不改变相对占比
  if (spanMs > 0 && activeMs > spanMs) {
    const fitRatio = spanMs / activeMs;
    genMs *= fitRatio;
    toolsMs *= fitRatio;
    otherMs *= fitRatio;
    activeMs = spanMs;
  }
  const idleMs = Math.max(idleGapMs, Math.max(0, spanMs - activeMs));
  const durationMs = activeMs; // 兼容语义: 耗时统计一律以「活跃时长」为基准
  const timingBuckets = [
    { key: "modelGen", label: "模型生成", ms: genMs, blocks: modelEventCount, unit: " 步", color: "#3b82f6" },
    { key: "toolExec", label: "工具执行", ms: toolsMs, blocks: toolEventCount, unit: " 次", color: "#10b981" },
    { key: "other", label: "其他开销", ms: otherMs, blocks: 0, unit: "", color: "#94a3b8" }
  ];
  const timingSumMs = timingBuckets.reduce((acc, bucket) => acc + bucket.ms, 0);
  const timingCategories = timingBuckets.map(bucket => {
    const percent = timingSumMs > 0
      ? Math.max(0, Math.min(100, Number(((bucket.ms / timingSumMs) * 100).toFixed(1))))
      : 0;
    const detailParts = [];
    if (bucket.ms > 0) detailParts.push(formatSpanHm(bucket.ms));
    if (bucket.blocks > 0) detailParts.push(bucket.blocks + bucket.unit);
    return {
      key: bucket.key,
      label: bucket.label,
      percent,
      detail: detailParts.length > 0 ? detailParts.join(" · ") : "—",
      ms: Math.round(bucket.ms),
      color: bucket.color,
      estimated: true
    };
  });

  // 4. 统计汇总: 全部从真实消息/文件操作数出来
  const messageCounts = { user: 0, read: 0, write: 0, search: 0, image: 0 };
  const toolCallCounts = { bash: 0, read: 0, edit: 0, other: 0 };
  for (const turn of turns) {
    for (const message of turn.messages || []) {
      if (message.role === "user") messageCounts.user += 1;
      for (const toolName of message.toolCalls || []) {
        if (toolName === "run_command" || toolName === "bash") toolCallCounts.bash += 1;
        else if (toolName === "read_file" || toolName === "read" || toolName === "view_file") toolCallCounts.read += 1;
        else if (toolName === "edit_file" || toolName === "write_file" || toolName === "edit" || toolName === "write") toolCallCounts.edit += 1;
        else toolCallCounts.other += 1;
      }
    }
  }
  for (const fileOp of Array.isArray(s.fileOps) ? s.fileOps : []) {
    messageCounts.read += fileOp.reads || 0;
    messageCounts.write += fileOp.writes || 0;
    messageCounts.search += fileOp.searches || 0;
  }
  const stats = {
    turnsCount,
    stepsCount: 0, // 在 steps 生成后回填 (见函数末尾), 保证 stepsCount === steps.length
    stepsTotal: 0,
    skillsCount: 0,
    answersCount: turns.reduce((acc, turn) => acc + (turn.messages || []).filter(m => m.role === "assistant").length, 0),
    events: {
      inject: 0,
      compact: Number(s.compactionCount) || 0,
      prune: 0
    },
    io: messageCounts,
    toolCalls: toolCallCounts,
    commands: { head: 0, grep: 0, echo: 0, other: 0 },
    fleet: {
      current: formatK(totalUsage),
      subCount: 0
    }
  };

  // 5. 生成细粒度步骤集合 (Steps: 物理模型交互请求) 与轮次聚合集合 (Turns)
  const steps = [];
  const turnsAgg = [];
  let globalStepCounter = 0;
  let prevStepTok = 0;
  let prevTurnTok = 0;

  // DNA 条带: 每条带都要带真实工具信息, 否则 DNA 模式读不出"这一步用了哪个工具"
  const buildBands = (breakdown, turnIdx, stepIdx, timeText, stepTools = []) => {
    const primaryTool = stepTools.length > 0 ? stepTools[0] : "";
    const defs = [
      ["system", "系统提示词", "#a855f7", breakdown.system || 0],
      ["tools", "工具定义", "#eab308", breakdown.tools || 0],
      ["user", "用户消息", "#10b981", breakdown.user || 0],
      ["inject", "注入内容", "#c026d3", breakdown.inject || 0],
      ["skill", "技能注入", "#f97316", breakdown.skill || 0],
      ["assistant", "助手消息", "#3b82f6", breakdown.assistant || 0],
      ["tool", "工具结果", "#06b6d4", breakdown.tool || 0]
    ];
    const bands = [];
    let offset = 0;
    for (const [key, label, color, tokens] of defs) {
      const value = Math.round(tokens);
      if (value <= 0) continue;
      const toolName = key === "tool" && primaryTool ? primaryTool : key;
      const title = key === "tool"
        ? (primaryTool ? "工具结果 · " + primaryTool : label)
        : label;
      bands.push({
        key,
        cat: key,
        color,
        title,
        tokens: value,
        off: offset,
        snippet: title,
        toolName,
        toolCalls: stepTools.slice(0, 6),
        turnIdx: turnIdx || 1,
        stepIdx: stepIdx || 1,
        time: timeText || ""
      });
      offset += value;
    }
    return bands;
  };

  // --- 上下文浏览器条目: 一律由**真实消息**填充 (禁止硬编码/编造) ------------------
  // 文本上限与 DSH 侧一致 (dsh-events.mjs DSH_BROWSER_LIMITS): fullText ≤ 24,000 / snippet ≤ 400。
  // 超限截断并标 truncated:true; 单会话分片体积仍由 trimDetailPayloadInPlace() 兜底。
  const BROWSER_ITEM_TEXT_LIMIT = 24000;
  const BROWSER_ITEM_SNIPPET_LIMIT = 400;
  // DNA 单柱条带上限: 与页面 lcDnaItemBands 的 LC_DNA_MAX_BANDS 同口径 (超限按 token 合并「其他」)
  const DNA_MAX_BANDS_PER_STEP = 28;
  // 单条用户消息超长时不再逐步复制 (只挂该轮第一步), 控制分片体积
  const BROWSER_LONG_USER_DUP_LIMIT = 8000;
  const BROWSER_CATEGORY_ORDER = ["system", "tools", "user", "inject", "skill", "assistant", "tool"];
  const BROWSER_ROLE_TO_CAT = {
    system: "system", tools: "tools", user: "user", inject: "inject",
    skill: "skill", assistant: "assistant", tool: "tool", tool_result: "tool"
  };

  // 已知的占位/合成前缀: 这些文本不是真实内容, 一律不造条目。
  // 注意: 这里不能简单用 "以 [ 开头" 判定 —— "[Tool Calls 工具调用]:" / "[Thinking 思考过程]:" 是
  // 解析器为**真实**工具调用/思考拼的正文, 属于真实内容, 必须保留。
  const PLACEHOLDER_ITEM_PREFIXES = [
    "[系统指令与行为准则", "[工具声明 Schema", "[模型思考与规划]",
    "[网关调用]", "[Tool Results & Files]", "[已截断显示]"
  ];
  const isPlaceholderItemText = (text) => {
    const trimmed = String(text === null || text === undefined ? "" : text).trim();
    if (trimmed === "") return true;
    for (const prefix of PLACEHOLDER_ITEM_PREFIXES) {
      if (trimmed.startsWith(prefix)) return true;
    }
    return false;
  };

  const clipBrowserText = (raw) => {
    const text = String(raw === null || raw === undefined ? "" : raw);
    if (text.length <= BROWSER_ITEM_TEXT_LIMIT) return { fullText: text, truncated: false };
    return { fullText: text.slice(0, BROWSER_ITEM_TEXT_LIMIT), truncated: true };
  };

  const toBrowserSnippet = (text, fallback) => {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    const base = flat !== "" ? flat : String(fallback || "");
    return base.length > BROWSER_ITEM_SNIPPET_LIMIT ? base.slice(0, BROWSER_ITEM_SNIPPET_LIMIT) : base;
  };

  const browserItemTitle = (cat, message) => {
    if (cat === "tool") return "工具结果 · " + (message.toolName || "tool");
    if (cat === "assistant") {
      const calls = Array.isArray(message.toolCalls)
        ? message.toolCalls.filter(name => typeof name === "string" && name !== "")
        : [];
      return calls.length > 0 ? "助手回复 [" + calls.slice(0, 4).join(", ") + "]" : "助手回复";
    }
    if (cat === "system") return "系统提示词";
    if (cat === "inject") return "运行时注入";
    if (cat === "skill") return "技能注入";
    if (cat === "user") return "用户消息";
    return cat;
  };

  // 工具定义条目: 由 transcript 里真实的 tool_calls(name/args) 按 name 汇总, 不含任何编造 schema
  const buildToolSchemaItems = () => {
    const agg = new Map();
    const touch = (rawName) => {
      const name = String(rawName);
      if (!agg.has(name)) agg.set(name, { count: 0, argKeys: new Set(), samples: [] });
      const rec = agg.get(name);
      rec.count += 1;
      return rec;
    };
    for (const turn of turns) {
      for (const message of turn.messages || []) {
        for (const name of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
          if (typeof name === "string" && name !== "") touch(name);
        }
        if ((message.role === "tool_result" || message.role === "tool") && message.toolName) touch(message.toolName);
        const call = message.call;
        if (call && call.name) {
          const rec = touch(call.name);
          if (call.args && typeof call.args === "object") {
            for (const argKey of Object.keys(call.args)) rec.argKeys.add(argKey);
            if (rec.samples.length < 2) rec.samples.push(call.args);
          }
        }
      }
    }
    const schemaItems = [];
    for (const [name, rec] of agg) {
      const argLine = rec.argKeys.size > 0
        ? "参数: " + Array.from(rec.argKeys).join(", ")
        : "参数: (transcript 未捕获)";
      const parts = ["工具: " + name, "真实调用次数: " + rec.count, argLine];
      if (rec.samples.length > 0) {
        // 真实参数样本只留一行的短摘要: 工具定义条目在**每一步**都会出现 (每次请求都带 schema),
        // 单条必须够小 —— 否则 9 个工具 × 400 步 = 3600 条会把单会话分片顶到 12MB 上限。
        const sampleJson = JSON.stringify(rec.samples[0]);
        parts.push("参数样本: " + (sampleJson.length > 120 ? sampleJson.slice(0, 120) + "…" : sampleJson));
      }
      const raw = parts.join("\n");
      const clipped = clipBrowserText(raw);
      schemaItems.push({
        cat: "tools",
        id: "tools:" + name,
        title: name,
        toolName: name,
        snippet: toBrowserSnippet(name + " · " + argLine, name),
        fullText: clipped.fullText,
        truncated: clipped.truncated,
        tokens: Math.max(1, estimateTokens(raw))
      });
    }
    return schemaItems;
  };

  /**
   * 轮次内把真实消息按「该步读取顺序」归属到具体 step (单次 O(消息数)):
   *   · assistant            → 归属自身那一步
   *   · tool_result          → 归属发起它的前一条 assistant 所在的步
   *   · system/inject/skill  → 归属其后第一条 assistant 所在的步 (注入后被读取)
   *   · user                 → 该轮每一步都可见 (每步上下文里都有本轮用户消息)
   *   · tools                → 真实工具定义汇总, 每步可见
   */
  const buildTurnStepBuckets = (turn, stepCount) => {
    const buckets = Array.from({ length: Math.max(0, stepCount) }, () => {
      const empty = {};
      for (const key of BROWSER_CATEGORY_ORDER) empty[key] = [];
      return empty;
    });
    if (stepCount <= 0) return buckets;
    const messages = Array.isArray(turn.messages) ? turn.messages : [];
    const lastStep = stepCount - 1;
    const stepOfAsstPos = new Map();
    messages.forEach((message, pos) => {
      if (message && message.role === "assistant") {
        stepOfAsstPos.set(pos, Math.min(stepOfAsstPos.size, lastStep));
      }
    });
    const prevAsstPos = new Array(messages.length).fill(-1);
    const nextAsstPos = new Array(messages.length).fill(-1);
    let cursor = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (stepOfAsstPos.has(i)) cursor = i;
      prevAsstPos[i] = cursor;
    }
    cursor = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (stepOfAsstPos.has(i)) cursor = i;
      nextAsstPos[i] = cursor;
    }
    const pushItem = (stepIdx, item) => {
      const bucket = buckets[stepIdx] || buckets[lastStep];
      if (bucket && bucket[item.cat]) bucket[item.cat].push(item);
    };
    const turnIdxOf = turn.turnIdx || 1;

    messages.forEach((message, pos) => {
      if (!message) return;
      const cat = BROWSER_ROLE_TO_CAT[message.role];
      if (!cat || cat === "tools" || cat === "user") return; // tools/user 走下面的特例
      if (message.synthetic === true) return;                // 合成占位消息不造条目
      const raw = String(message.fullText === undefined || message.fullText === null ? "" : message.fullText);
      if (isPlaceholderItemText(raw)) return;
      let stepIdx;
      if (cat === "assistant") {
        stepIdx = stepOfAsstPos.has(pos) ? stepOfAsstPos.get(pos) : lastStep;
      } else if (cat === "tool") {
        const prev = prevAsstPos[pos];
        stepIdx = prev >= 0 && stepOfAsstPos.has(prev) ? stepOfAsstPos.get(prev) : 0;
      } else {
        const next = nextAsstPos[pos];
        stepIdx = next >= 0 && stepOfAsstPos.has(next) ? stepOfAsstPos.get(next) : lastStep;
      }
      const clipped = clipBrowserText(raw);
      const item = {
        cat,
        id: cat + ":" + turnIdxOf + ":" + pos,
        title: browserItemTitle(cat, message),
        snippet: toBrowserSnippet(raw, browserItemTitle(cat, message)),
        fullText: clipped.fullText,
        tokens: Math.max(1, Math.round(Number(message.tokens) || estimateTokens(raw))),
        toolName: message.toolName
          || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? message.toolCalls[0] : cat),
        diff: "0"
      };
      if (clipped.truncated) item.truncated = true;
      pushItem(stepIdx, item);
    });

    // user: 本轮真实用户消息对该轮每一步都可见 (不跨轮复制, 长文本只挂第一步)
    messages.forEach((message, pos) => {
      if (!message || message.role !== "user" || message.synthetic === true) return;
      const raw = String(message.fullText === undefined || message.fullText === null ? "" : message.fullText);
      if (isPlaceholderItemText(raw)) return;
      const clipped = clipBrowserText(raw);
      const stepsForUser = raw.length > BROWSER_LONG_USER_DUP_LIMIT
        ? [0]
        : buckets.map((_, stepIdx) => stepIdx);
      for (const stepIdx of stepsForUser) {
        const item = {
          cat: "user",
          id: "user:" + turnIdxOf + ":" + pos,
          title: "用户消息",
          snippet: toBrowserSnippet(raw, "用户消息"),
          fullText: clipped.fullText,
          tokens: Math.max(1, Math.round(Number(message.tokens) || estimateTokens(raw))),
          toolName: "user",
          diff: "0"
        };
        if (clipped.truncated) item.truncated = true;
        pushItem(stepIdx, item);
      }
    });

    // tools: 真实工具定义 (按 name 汇总) —— 每次请求都带工具声明 (与 DSH 侧 headerTools 口径一致),
    // 所以该轮每一步都可见。
    if (toolSchemaItems.length > 0) {
      for (let stepIdx = 0; stepIdx < stepCount; stepIdx += 1) {
        for (const schemaItem of toolSchemaItems) pushItem(stepIdx, Object.assign({}, schemaItem));
      }
    }
    return buckets;
  };

  const toolSchemaItems = buildToolSchemaItems();

  // 分类占比: 分母统一用 7 类之和 (而不是步 token, 否则当分类和 > 步 token 时会越界成 4718%)
  // 分类骨架永远返回 7 条; items 为该步真实消息条目 (读取顺序), 无明细即空数组。
  const browserOf = (breakdown, flatItems) => {
    const defs = [
      ["system", "系统提示词", "#a855f7"], ["tools", "工具定义", "#eab308"],
      ["user", "用户消息", "#10b981"], ["inject", "注入内容", "#c026d3"],
      ["skill", "技能注入", "#f97316"], ["assistant", "助手消息", "#3b82f6"],
      ["tool", "工具结果", "#06b6d4"]
    ];
    let sum = 0;
    for (const [key] of defs) sum += Math.max(0, Number(breakdown[key]) || 0);
    const grouped = new Map();
    for (const item of Array.isArray(flatItems) ? flatItems : []) {
      if (!grouped.has(item.cat)) grouped.set(item.cat, []);
      grouped.get(item.cat).push(item);
    }
    return defs.map(([key, label, color]) => {
      const tokens = Math.round(Math.max(0, Number(breakdown[key]) || 0));
      const percent = sum > 0 ? Math.max(0, Math.min(100, Math.round((tokens / sum) * 100))) : 0;
      const items = grouped.get(key) || [];
      return {
        key, label, name: label,
        count: items.length > 0 ? items.length : (tokens > 0 ? 1 : 0),
        tokens,
        formatted: formatK(tokens),
        percent,
        color,
        items
      };
    });
  };

  /**
   * DNA 条带: 与 browserCategories[].items[] **同源**, 按读取顺序逐条生成
   * (分类顺序 system→tools→user→inject→skill→assistant→tool, 类目内按消息顺序)。
   * 条数按 items 实际情况, 不设假上限; 超过 DNA_MAX_BANDS_PER_STEP 时按 token 把最小的若干条
   * 合并成一条「其他」(总量不丢, 与页面 lcDnaItemBands 同口径), 「其他」的 cat 取被合并条目里
   * token 最大的分类, 保证 7 分类契约不被破坏。
   */
  const buildItemBands = (flatItems, turnIdx, stepIdx, timeText) => {
    const collected = [];
    for (const item of Array.isArray(flatItems) ? flatItems : []) {
      const tokens = Math.round(Math.max(0, Number(item.tokens) || 0));
      if (tokens <= 0) continue;
      // 字段保持页面 DNA 渲染所需的最小集 (cat/color/title/tokens/off/toolName/turnIdx/stepIdx/time);
      // 不重复放 snippet (与 title 相同) 与 catName (页面用 cat/title 兜底), 避免 4800 条 × 冗余字段的浪费。
      collected.push({
        key: item.id,
        cat: item.cat,
        color: categoryColors[item.cat] || "#94a3b8",
        title: item.title,
        tokens,
        toolName: item.toolName || item.cat
      });
    }
    if (collected.length === 0) return [];
    let bands = collected;
    if (bands.length > DNA_MAX_BANDS_PER_STEP) {
      const keep = DNA_MAX_BANDS_PER_STEP - 1;
      const byTokens = bands.map((_, i) => i).sort((a, b) => bands[a].tokens - bands[b].tokens);
      const drop = new Set(byTokens.slice(0, bands.length - keep));
      let dominant = null;
      for (let i = 0; i < bands.length; i += 1) {
        if (drop.has(i) && (!dominant || bands[i].tokens > dominant.tokens)) dominant = bands[i];
      }
      const merged = [];
      let other = null;
      bands.forEach((band, i) => {
        if (!drop.has(i)) { merged.push(band); return; }
        if (!other) {
          other = {
            key: "other",
            cat: dominant ? dominant.cat : band.cat,
            color: "#94a3b8",
            title: "其他条目",
            tokens: 0,
            toolName: dominant ? dominant.toolName : band.toolName,
            count: 0
          };
          merged.push(other);
        }
        other.tokens += band.tokens;
        other.count += 1;
      });
      bands = merged;
    }
    let offset = 0;
    for (const band of bands) {
      band.off = offset;
      offset += band.tokens;
      band.turnIdx = turnIdx || 1;
      band.stepIdx = stepIdx || 1;
      band.time = timeText || "";
    }
    return bands;
  };

  turns.forEach((turn, tIdx) => {
    const turnIdx = turn.turnIdx || (tIdx + 1);
    const turnTime = Number(turn.time) || 0;
    const turnTimestamp = turn.timestamp || formatTime(turnTime) || "";
    const userText = turn.userText || "";
    const messages = turn.messages || [];
    const assistantMsgs = messages.filter(m => m.role === "assistant");
    // ---- 每步 7 类构成: 轮级常量 + 截至该步的真实消息累计 + 未枚举残差 ----
    // 旧实现直接复制 turn.breakdown (整轮一份快照) → 同一轮内每一步的 7 类数值完全相同:
    // 全量柱状图恒平、增量模式差值全 0。DSH 侧 (dsh-events) 是「每次请求一份构成」,
    // 这里按同一口径逐步计算, 三个 agent 才能横向比较。
    const turnBreakdownRaw = turn.breakdown || {};
    const turnBaseSystem = Number(turnBreakdownRaw.systemTokens) || 0;
    const turnBaseTools = Number(turnBreakdownRaw.toolsTokens) || 0;
    // cumulativeBefore[pos] = 该位置消息**之前**已进入上下文的内容累计
    // (system/tools 由轮级常量承担, 这里不重复累计)
    const cumulativeBefore = new Array(messages.length + 1);
    cumulativeBefore[0] = { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 };
    for (let pos = 0; pos < messages.length; pos += 1) {
      const acc = Object.assign({}, cumulativeBefore[pos]);
      const cat = BROWSER_ROLE_TO_CAT[messages[pos] && messages[pos].role];
      if (cat && acc[cat] !== undefined) {
        acc[cat] += Math.max(0, Math.round(Number(messages[pos].tokens) || 0));
      }
      cumulativeBefore[pos + 1] = acc;
    }
    /**
     * 某一步的上下文构成。
     * 分类内部比例来自真实消息累计; transcript 没有逐条枚举的历史上下文 (摘要 / 文件缓存 /
     * 早期工具输出) 计入 tool 类 —— 与 AG 解析器对「历史工具结果与文件缓存上下文」的既有口径一致,
     * 并保证 7 类之和 == 该步真实 prompt 总量 (堆叠柱与「实际 X」不会对不上)。
     */
    const composeBreakdown = (cumulative, targetTokens) => {
      const bd = {
        system: turnBaseSystem,
        tools: turnBaseTools,
        user: cumulative.user,
        inject: cumulative.inject,
        skill: cumulative.skill,
        assistant: cumulative.assistant,
        tool: cumulative.tool
      };
      const target = Math.max(0, Math.round(Number(targetTokens) || 0));
      let sum = 0;
      for (const key of Object.keys(bd)) sum += bd[key];
      if (target <= 0 || sum <= 0) return bd;
      if (sum < target) {
        // transcript 未逐条枚举的历史上下文 (摘要 / 文件缓存 / 早期工具输出) 计入 tool 类
        bd.tool += target - sum;
        return bd;
      }
      if (sum > target) {
        // 该步真实 prompt 小于已枚举内容 (中途压缩/剪枝) → 等比缩放, 保住分类比例
        const scale = target / sum;
        for (const key of Object.keys(bd)) bd[key] = Math.max(0, Math.round(bd[key] * scale));
      }
      // 四舍五入余量补到最大一类: 7 类之和恒等于该步真实 prompt (堆叠柱不会越界)
      let scaled = 0;
      let biggest = null;
      for (const key of Object.keys(bd)) {
        scaled += bd[key];
        if (biggest === null || bd[key] > bd[biggest]) biggest = key;
      }
      if (biggest !== null && scaled !== target) bd[biggest] = Math.max(0, bd[biggest] + (target - scaled));
      return bd;
    };

    // 每条 assistant 消息 = 一次真实模型交互 (没有 assistant 消息的轮次不造步)
    const stepSource = assistantMsgs.length > 0 ? assistantMsgs : [null];
    // 该轮每一步的上下文浏览器条目 (真实消息 → 按读取顺序归属到步)
    const stepBuckets = buildTurnStepBuckets(turn, stepSource.length);
    // 每步耗时 = 上一条真实事件 (工具结果 / 注入 / 用户消息) → 本次 PLANNER_RESPONSE 的真实间隔
    const assistantPositions = [];
    messages.forEach((entry, pos) => {
      if (entry && entry.role === "assistant") assistantPositions.push(pos);
    });
    const prevEventTimeOf = (pos) => {
      for (let i = pos - 1; i >= 0; i -= 1) {
        const eventTime = Number(messages[i] && messages[i].time) || 0;
        if (eventTime > 0) return eventTime;
      }
      return 0;
    };

    stepSource.forEach((message, index) => {
      globalStepCounter += 1;
      // 真实计量: 该次请求的 prompt 总量 (input + cacheRead) = 该步真实上下文;
      // 没有真实计量才退回消息 token / 轮 token 估算。
      const stepPromptTokens = Number(message && message.promptTokens) || 0;
      const stepOutputTokens = Number(message && message.outputTokens) || Number(message && message.tokens) || 0;
      const stepTokens = stepPromptTokens > 0
        ? stepPromptTokens
        : (Number(turn.promptTokens) || Number(message && message.tokens) || Number(turn.totalTokens) || 0);
      const messagePos = assistantPositions.length > index ? assistantPositions[index] : -1;
      // 该步构成 = 截至该次请求之前的内容累计 (messagePos 之前的消息) + 未枚举残差
      const breakdown = composeBreakdown(
        cumulativeBefore[messagePos >= 0 ? messagePos : messages.length],
        stepTokens
      );
      const stepDelta = prevStepTok === 0 ? 0 : stepTokens - prevStepTok;
      prevStepTok = stepTokens;
      const prevMsgTime = messagePos > 0 ? prevEventTimeOf(messagePos) : 0;
      const msgTime = (message && Number(message.time)) || turnTime;
      // 与耗时桶同口径: created_at 1 秒精度 → 同秒也按 1s 下限计, 不记 0
      const stepGenMs = prevMsgTime > 0 && msgTime >= prevMsgTime
        ? Math.max(msgTime - prevMsgTime, MIN_STEP_MS)
        : 0;
      const durSec = stepGenMs > 0 ? Math.round(stepGenMs / 1000) : 0;
      const stepTimestamp = formatTime(msgTime) || turnTimestamp;
      const stepToolCalls = (message && message.toolCalls) || [];
      const toolName = stepToolCalls[0] || "assistant";
      // 该步条目: 读取顺序 = 分类顺序 (system→tools→...→tool), 类目内按消息顺序; idx 为类目内序号
      const stepItems = [];
      const stepBucket = stepBuckets[index];
      if (stepBucket) {
        for (const key of BROWSER_CATEGORY_ORDER) {
          (stepBucket[key] || []).forEach((item, itemIndex) => {
            item.idx = itemIndex + 1;
            item.turnIdx = turnIdx;
            item.stepIdx = globalStepCounter;
            item.time = stepTimestamp;
            stepItems.push(item);
          });
        }
      }
      const stepItemBands = buildItemBands(stepItems, turnIdx, index + 1, stepTimestamp);
      steps.push({
        stepIdx: globalStepCounter,
        turnIdx,
        stepInTurn: index + 1,
        totalStepsInTurn: stepSource.length,
        time: msgTime,
        timestamp: stepTimestamp,
        totalTokens: stepTokens,
        tokenDelta: stepDelta,
        promptTokens: stepPromptTokens,
        outputTokens: stepOutputTokens,
        genMs: Math.round(stepGenMs),
        inputTokens: Number(message && message.inputTokens) || 0,
        cacheReadTokens: Number(message && message.cacheReadTokens) || 0,
        cacheHit: null,
        durationSec: durSec,
        durationFormatted: formatDurationSeconds(durSec),
        userSnippet: userText,
        inputSnippet: toolName,
        breakdown,
        browserCategories: browserOf(breakdown, stepItems),
        // DNA 条带与 items 同源逐条生成; 该步完全没有真实条目时才退回分类骨架带 (不造假内容)
        dnaBands: stepItemBands.length > 0
          ? stepItemBands
          : buildBands(breakdown, turnIdx, index + 1, turnTimestamp, stepToolCalls),
        thinking: message && message.thinking ? String(message.thinking).slice(0, 200) : "",
        toolCalls: stepToolCalls,
        isError: Boolean(message && message.isError),
        exitCode: message && message.exitCode !== undefined ? message.exitCode : null
      });
    });

    const turnTokens = Number(turn.promptTokens) || Number(turn.totalTokens) || 0;
    const turnDelta = prevTurnTok === 0 ? 0 : turnTokens - prevTurnTok;
    prevTurnTok = turnTokens;
    const turnBreakdown = composeBreakdown(cumulativeBefore[messages.length], turnTokens);
    // 轮耗时 = 该轮首条事件 → 末条事件 (真实活跃时间; 不含轮间空闲, 避免把 62h 空闲算成一轮耗时)
    const turnTimedTimes = messages.map(entry => Number(entry && entry.time) || 0).filter(eventTime => eventTime > 0);
    const turnSpanMs = turnTimedTimes.length > 1
      ? Math.max(0, turnTimedTimes[turnTimedTimes.length - 1] - turnTimedTimes[0])
      : 0;
    const turnDurSec = Math.round(turnSpanMs / 1000);

    turnsAgg.push({
      turnIdx,
      stepsCount: stepSource.length,
      time: turnTime,
      timestamp: turnTimestamp,
      totalTokens: turnTokens,
      tokenDelta: turnDelta,
      outputTokens: stepSource.reduce((acc, m) => acc + (Number(m && m.outputTokens) || Number(m && m.tokens) || 0), 0),
      cacheHit: null,
      durationSec: turnDurSec,
      durationFormatted: formatDurationSeconds(turnDurSec),
      userSnippet: userText,
      inputSnippet: "turn_entry",
      breakdown: turnBreakdown,
      browserCategories: browserOf(turnBreakdown, turnTokens).map(c => ({
        key: c.key, name: c.name, count: c.count, tokens: c.tokens,
        formatted: c.formatted, percent: c.percent, color: c.color
      }))
    });
  });

  // 统计口径: stepsCount 与 steps[] 实际长度保持唯一真源
  stats.stepsCount = steps.length;
  stats.stepsTotal = steps.length;

  // 6. 生成上下文事件列表 (Events: 压缩剪枝、技能注入、膨胀警报)
  const events = [];
  events.push({
    kind: "inject",
    name: "系统指令与工作区环境载入",
    at: "T1 S1",
    turn: 1,
    tokens: sysTok + toolsTok,
    formattedTokens: formatK(sysTok + toolsTok),
    desc: `加载 ${s.agentName || s.agent} 基础系统提示词与常用工具 Schema`
  });

  turns.forEach((t, idx) => {
    if (t.isCompaction) {
      events.push({
        kind: "compaction",
        name: "上下文自动压缩与历史剪枝",
        at: `T${t.turnIdx || idx + 1}`,
        turn: t.turnIdx || idx + 1,
        tokens: -(t.tokenDelta ? Math.abs(t.tokenDelta) : 12000),
        formattedTokens: `-${formatK(t.tokenDelta ? Math.abs(t.tokenDelta) : 12000)}`,
        desc: "长会话超出阈值，触发自动消息摘要与修剪"
      });
    }
    if (t.isBloat) {
      events.push({
        kind: "prune",
        name: "单轮 Token 突增警报",
        at: `T${t.turnIdx || idx + 1}`,
        turn: t.turnIdx || idx + 1,
        tokens: t.tokenDelta || 18000,
        formattedTokens: `+${formatK(t.tokenDelta || 18000)}`,
        desc: "单步输出或工具结果过大，引起上下文阶跃"
      });
    }
  });

  // 7. 生成文件活动列表 (File Activity)
  // 优先直接使用会话级别真实提取的 session.fileOps，杜绝静态 Mock 数据注入
  const fileOps = Array.isArray(s.fileOps) ? s.fileOps : [];

  // 8. 生成命令执行列表 (Commands) —— 只从真实工具调用解析, 无任何 mock 兜底
  const commandsList = [];
  turns.forEach((turn, tIdx) => {
    (turn.messages || []).forEach(message => {
      const toolCalls = message.toolCalls || [];
      const isShell = toolCalls.includes("run_command") || toolCalls.includes("bash")
        || toolCalls.includes("run_code") || toolCalls.includes("exec_command") || toolCalls.includes("shell");
      if (!isShell) return;
      // 1) 结构化真实命令行 (Codex CommandExecution.command / 解析器已还原的 command)
      // 2) 回退: 工具参数 JSON ("CommandLine", 或 Codex exec_command 的 "cmd")
      // 3) 回退: 摘要里的 run_command: xxx
      let cmdStr = typeof message.command === "string" ? message.command.trim() : "";
      if (!cmdStr) {
        const cmdMatch = message.fullText?.match(/"CommandLine"\s*:\s*"([^"]+)"/)
          || message.fullText?.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)+)"/)
          || message.snippet?.match(/run_command:\s*(.+)/);
        if (!cmdMatch) return; // 解析不出真实命令行就不记 (绝不编一条)
        cmdStr = cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      if (!cmdStr) return;
      commandsList.push({
        cmd: cmdStr,
        program: cmdStr.trim().split(/\s+/)[0] || "shell",
        status: message.isError ? "failed" : "completed",
        ms: Number(message.ms) || 0,
        turn: turn.turnIdx || (tIdx + 1),
        time: turn.timestamp || "",
        exitCode: message.exitCode === undefined ? null : message.exitCode
      });
    });
  });

  // 9. 编队 (Fleet) / 子 Agent: 只从**真实工具返回**里取子会话 id
  //    invoke_subagent 返回 "Created the following subagent: { conversationId: ... }"
  //    manage_subagents(list) 返回 [{ role, type, conversationId }]
  //    conversationId 就是子会话 id —— 与 CONTEXT_SESSIONS[].id 的映射在 buildContextDataset()
  //    组装完 sessions 之后由 linkFleetSubagentSessions() 统一回填 (sessionId / matched)。
  const subagents = [];
  const seenChildIds = new Set();
  const SUBAGENT_TOOL_RE = /subagent/i;
  const CONVERSATION_ID_RE = /"conversationId"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
  for (const turn of turns) {
    for (const message of turn.messages || []) {
      if (!message || message.role !== "tool_result") continue;
      const toolName = String(message.toolName || "");
      if (!SUBAGENT_TOOL_RE.test(toolName)) continue;
      const text = String(message.fullText || "");
      if (text === "") continue;
      // invoke_subagent 的角色/类型在调用参数里 (Role / TypeName); manage_subagents 的 list 返回里在 role/type
      const callArgs = message.call && message.call.args && typeof message.call.args === "object"
        ? message.call.args
        : {};
      const argRole = callArgs.Role || callArgs.role || "";
      const argType = callArgs.TypeName || callArgs.type || callArgs.Type || "";
      CONVERSATION_ID_RE.lastIndex = 0;
      let hit = CONVERSATION_ID_RE.exec(text);
      while (hit !== null) {
        const childId = hit[1];
        if (!seenChildIds.has(childId)) {
          seenChildIds.add(childId);
          const nearby = text.slice(Math.max(0, hit.index - 400), hit.index + 400);
          const roleMatch = nearby.match(/"role"\s*:\s*"([^"]+)"/);
          const typeMatch = nearby.match(/"type"\s*:\s*"([^"]+)"/);
          subagents.push({
            childId,
            name: String((roleMatch && roleMatch[1]) || argRole || toolName),
            label: String((typeMatch && typeMatch[1]) || argType || toolName),
            mode: "antigravity-subagent",
            source: toolName,
            parentId: s.id === undefined || s.id === null ? null : String(s.id),
            sessionId: null,
            matched: false
          });
        }
        hit = CONVERSATION_ID_RE.exec(text);
      }
    }
  }
  const fleet = {
    subagentCount: subagents.length,
    subagents,
    tasks: []
  };
  stats.fleet.subCount = subagents.length;

  const timingSum = timingCategories.reduce((acc, item) => acc + item.percent, 0);
  // 里程碑刻度: 0 / 1/4 / 1/2 / 3/4 / 活跃时长 (与 DSH 侧 timingStats.ruler 同口径, 恒 5 个刻度)
  const ruler = ["0"];
  for (let i = 1; i <= 4; i += 1) ruler.push(formatSpanHm(Math.round((activeMs * i) / 4)));
  // 输出速度 = 真实 output tokens / 真实模型生成耗时 (除零兜底); 另给一个以活跃时长为分母的
  // 稳健口径 speedByActive, 便于核对 (1 秒时间戳精度下两者会有差异)
  const realOutputTokens = steps.reduce((acc, item) => acc + (Number(item.outputTokens) || 0), 0)
    || Number(s.totalOutputTokens || 0);
  // 输出速度: 主口径分母 = 活跃处理时长 (模型生成 + 工具执行)。transcript 的 created_at 只有
  // 1 秒精度, 纯模型时间会被「同秒事件」压到 0, 直接除会让速度虚高到几千 tok/s, 故以活跃时长为准,
  // 同时保留 speedByGenMs (纯模型时间口径) 供核对。
  const speed = activeMs > 0 ? Number(((realOutputTokens / activeMs) * 1000).toFixed(1)) : 0;
  const speedByGenMs = genMs > 0 ? Number(((realOutputTokens / genMs) * 1000).toFixed(1)) : 0;

  return {
    stats,
    steps,
    turns: turnsAgg,
    events,
    fileOps,
    commands: commandsList,
    fleet,
    curCategories,
    tokenStats: {
      totalUsage,
      totalUsageFormatted: formatK(totalUsage),
      uncachedTokens: uncachedInputTokens,
      outputTokens: outputTokensTotal,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate,
      categories: tokenCategories
    },
    timingStats: {
      activeDuration: formatSpanHm(activeMs),
      speed,
      speedByGenMs,
      activeMs: Math.round(activeMs),
      spanMs: Math.round(spanMs),
      idleMs: Math.round(idleMs),
      genMs: Math.round(genMs),
      toolsMs: Math.round(toolsMs),
      otherMs: Math.round(otherMs),
      ttftMs: 0, // transcript 没有首 token 时间点 → 不编造 TTFT
      toolCalls: toolEventCount,
      modelCalls: modelEventCount,
      firstTime: wallFirstTime,
      lastTime: wallLastTime,
      categories: timingCategories,
      timingSum,
      ruler
    },
    currentContext: {
      modelInfo: s.agent + " · " + s.model,
      currentTokens,
      promptTokens: lastPromptTokens,
      composedTokens: Math.round(categorySum),
      limitTokens: limit,
      watermark: wm,
      categories: curCategories
    }
  };
}

  // 为所有会话附加完整的 dsh-context 数据载荷 (结构 100% 对齐 dsh-context 官方规范)
  sessions.forEach(s => {
    // DSH 会话的 dshContext 已由 parseDshSession → foldDshSession 提供**真实事件流数据**,
    // 这里绝不能用旧公式覆盖 (否则 62MB 假数据会盖掉真值)。
    if (!s.dshContext) s.dshContext = buildDshContextPayload(s);
  });

  // 子 Agent ↔ 会话映射: sessions 组装完成后统一回填一次 (Set 索引, O(n))
  linkFleetSubagentSessions(sessions, scannedSessionIds);

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

// ==========================================
// 数据契约 v2 — 轻量索引 + 每会话懒加载详情
//   page/context-data.js  = 索引 (SUMMARY + 白名单 SESSIONS + DETAIL_DIR / DETAIL_FILES)
//   page/data/<safe>.js   = 单会话完整详情 (window.CONTEXT_SESSION_DETAIL[id] = 完整 session)
// 契约见 CONTRACT.md 『数据契约 (v2)』: 旧属性一个都不能少, 只是搬家。
// ==========================================

const PAGE_DIR = path.dirname(CONTEXT_DATA_JS_PATH);
const CONTEXT_DETAIL_DIR_NAME = "data";
const CONTEXT_DETAIL_DIR_PATH = path.join(PAGE_DIR, CONTEXT_DETAIL_DIR_NAME);
const CONTEXT_DETAIL_MANIFEST_PATH = path.join(CONTEXT_DETAIL_DIR_PATH, ".manifest.json");
const CONTEXT_DETAIL_GITIGNORE_PATH = path.join(CONTEXT_DETAIL_DIR_PATH, ".gitignore");
const CONTEXT_DETAIL_GITIGNORE_CONTENT =
  "# 自动生成 (daemon.mjs) — 每会话懒加载详情分片, 请勿入库\n*.js\n*.js.tmp\n.manifest.json\n";
const CONTEXT_DATA_VERSION = 2;
const DETAIL_MANIFEST_VERSION = 2;
const DETAIL_TMP_GRACE_MS = 60 * 1000;

/**
 * 索引字段白名单 (主页列表与 KPI 只用这些)。
 * turns / dshContext / fileOps / commands / events 等全部下沉到详情文件。
 */
export const SESSION_INDEX_FIELDS = Object.freeze([
  "id",
  "name",
  "agent",
  "agentName",
  "agentIcon",
  "cwd",
  "model",
  "modelLimit",
  "watermarkPercent",
  "peakTokens",
  "currentTokens",
  "totalInputTokens",
  "totalOutputTokens",
  "totalCacheRead",
  "cost",
  "startTime",
  "lastTime",
  "timeAgo",
  "turnsCount",
  "compactionCount",
  "bloatCount",
  "hasDshContext"
]);

/** 详情目录里绝不清理的文件 (仓库自带 / 人工维护) */
const DETAIL_PROTECTED_FILES = new Set([
  ".gitignore",
  ".gitkeep",
  ".manifest.json",
  ".DS_Store",
  "README",
  "README.md",
  "readme.md"
]);

/**
 * 会话 ID -> 详情文件名基。
 * 合同规定: id.replace(/[^A-Za-z0-9._-]/g, "_")
 * 额外加固: 空串 / "." / ".." / 隐藏文件前缀统一加 "_", 避免写出 ".js" 或覆盖 .gitignore。
 */
export function sanitizeSessionFileBase(sessionId) {
  const raw = sessionId === null || sessionId === undefined ? "" : String(sessionId);
  let safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === "" || safe === "." || safe === ".." || safe.startsWith(".")) {
    safe = "_" + safe;
  }
  return safe;
}

/**
 * 索引条目: 只拷贝 session 上真实存在的白名单字段 —— 保证「索引 + 详情」合并后与原始 session 完全一致。
 */
export function buildSessionIndexEntry(session) {
  const entry = {};
  for (const field of SESSION_INDEX_FIELDS) {
    if (session[field] !== undefined) entry[field] = session[field];
  }
  return entry;
}

/** sessionId -> "data/<safe>.js" 显式映射 (页面不自己拼路径); 撞名时追加短 hash, 保证一一对应 */
export function buildDetailFileMap(sessions) {
  const files = {};
  const owners = new Map();
  for (const session of sessions) {
    const id = session.id === null || session.id === undefined ? "" : String(session.id);
    let base = sanitizeSessionFileBase(id);
    if (owners.has(base) && owners.get(base) !== id) {
      let attempt = 0;
      let candidate = base + "-" + stableHash(id).slice(0, 8);
      while (owners.has(candidate) && owners.get(candidate) !== id) {
        attempt += 1;
        candidate = base + "-" + stableHash(id).slice(0, 8) + "-" + attempt;
      }
      base = candidate;
    }
    owners.set(base, id);
    files[id] = CONTEXT_DETAIL_DIR_NAME + "/" + base + ".js";
  }
  return files;
}

/**
 * 详情分片体积守卫。
 * WebKit(WKWebView) 对大脚本 + 巨型对象图很敏感: Magpie 的 ReactNativeWebView 在收到
 * 60MB 级分片时会因内存压力被系统回收(webViewWebContentProcessDidTerminate), 表现为
 * 『此页面已停止工作』。这里做**逐级降采样**, 保证单个分片不超过软上限, 同时保留全部统计口径
 * (只裁浏览器明细/长文本, 不动 stats / tokenStats / commands / fileOps / 轮次)。
 */
const DETAIL_PAYLOAD_SOFT_LIMIT = 12 * 1024 * 1024;

function trimDetailPayloadInPlace(session) {
  const bytesOf = () => Buffer.byteLength(JSON.stringify(session), "utf8");
  let bytes = bytesOf();
  if (bytes <= DETAIL_PAYLOAD_SOFT_LIMIT) return session;

  const trims = [];
  const dc = session && session.dshContext;

  // ① 较早步骤的条目折叠成**紧凑条目**(保留标题/tokens, 只去正文) —— 不再整片清空,
  //    否则界面会到处显示『暂无独立明细条目』。
  if (dc && Array.isArray(dc.steps) && dc.steps.length > 120) {
    const cutoff = dc.steps.length - 120;
    let compacted = 0;
    for (let i = 0; i < cutoff; i += 1) {
      const cats = dc.steps[i] && dc.steps[i].browserCategories;
      if (!Array.isArray(cats)) continue;
      for (const cat of cats) {
        if (!Array.isArray(cat.items) || cat.items.length === 0) continue;
        if (cat.items.every((it) => it && it.compact === 1)) continue;
        cat.items = cat.items.map((it) => ({
          id: it && it.id,
          idx: it && it.idx,
          title: it && it.title,
          toolName: it && it.toolName,
          tokens: it && it.tokens,
          compact: 1
        }));
        cat.itemsCompactOnly = true;
        compacted += 1;
      }
    }
    trims.push("browserCategories.compact>120steps");
    bytes = bytesOf();
  }

  // ①b 仍然超限: 先压缩较早轮次的消息正文(比清空条目更温和)
  if (bytes > DETAIL_PAYLOAD_SOFT_LIMIT && Array.isArray(session.turns) && session.turns.length > 40) {
    const turnCut = session.turns.length - 40;
    for (let ti = 0; ti < turnCut; ti += 1) {
      const turn = session.turns[ti];
      for (const msg of turn && turn.messages ? turn.messages : []) {
        if (typeof msg.fullText === "string" && msg.fullText.length > 1200) {
          msg.fullText = msg.fullText.slice(0, 1200) + "\n…(已截断以控制页面内存)";
        }
      }
    }
    trims.push("oldTurns.fullText@1200");
    bytes = bytesOf();
  }

  // ② 超长消息正文截断到 6000 字符 (只影响预览, 不影响 token 统计)
  if (bytes > DETAIL_PAYLOAD_SOFT_LIMIT && Array.isArray(session.turns)) {
    for (const turn of session.turns) {
      for (const msg of turn && turn.messages ? turn.messages : []) {
        if (typeof msg.fullText === "string" && msg.fullText.length > 6000) {
          msg.fullText = msg.fullText.slice(0, 6000) + "\n…(已截断以控制页面内存)";
        }
      }
    }
    trims.push("fullText@6000");
    bytes = bytesOf();
  }

  // ②b 仍然超限: 把所有消息正文压到 1500 字符 (比清空浏览器条目更温和, 保住条目骨架)
  if (bytes > DETAIL_PAYLOAD_SOFT_LIMIT && Array.isArray(session.turns)) {
    for (const turn of session.turns) {
      for (const msg of turn && turn.messages ? turn.messages : []) {
        if (typeof msg.fullText === "string" && msg.fullText.length > 1500) {
          msg.fullText = msg.fullText.slice(0, 1500) + "\n…(已截断以控制页面内存)";
        }
      }
    }
    trims.push("fullText@1500");
    bytes = bytesOf();
  }

  // ③ 仍然超限: 彻底丢弃浏览器条目明细
  if (bytes > DETAIL_PAYLOAD_SOFT_LIMIT && dc && Array.isArray(dc.steps)) {
    for (const step of dc.steps) {
      const cats = step && step.browserCategories;
      if (!Array.isArray(cats)) continue;
      for (const cat of cats) {
        if (Array.isArray(cat.items)) cat.items = [];
      }
    }
    trims.push("browserCategories.items=all");
    bytes = bytesOf();
  }

  if (dc) {
    dc.sessionMeta = dc.sessionMeta || {};
    dc.sessionMeta.payloadTrimmed = { limitBytes: DETAIL_PAYLOAD_SOFT_LIMIT, bytes: bytes, trims: Array.from(new Set(trims)) };
  }
  return session;
}

function buildDetailFileContent(fileName, session) {
  const id = session.id === null || session.id === undefined ? "" : String(session.id);
  return (
    "// " + CONTEXT_DETAIL_DIR_NAME + "/" + fileName + " — 自动生成 (daemon.mjs), 请勿手工编辑\n" +
    "(window.CONTEXT_SESSION_DETAIL ||= {})[" + JSON.stringify(id) + "] = " + JSON.stringify(session) + ";\n"
  );
}

/**
 * 详情内容「稳定指纹」: timeAgo 是纯派生的易变字段(索引里永远是最新值, 页面合并时以索引为准),
 * 不参与 hash —— 否则 watch 模式每 5s 都会因为分钟进位而重写全部大文件(百 MB 级磁盘抖动)。
 */
function detailStableHash(session) {
  const stableView = Object.assign({}, session, { timeAgo: "" });
  return stableHash(JSON.stringify(stableView));
}

/** 同步原子写: 先写 .tmp 再 rename, 页面永远不会读到半个文件 */
function atomicWriteFileSync(targetPath, content) {
  const tmpPath = targetPath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

function ensureDetailDir() {
  fs.mkdirSync(CONTEXT_DETAIL_DIR_PATH, { recursive: true });
  try {
    let current = null;
    try {
      current = fs.readFileSync(CONTEXT_DETAIL_GITIGNORE_PATH, "utf8");
    } catch (_) {
      current = null;
    }
    if (current !== CONTEXT_DETAIL_GITIGNORE_CONTENT) {
      fs.writeFileSync(CONTEXT_DETAIL_GITIGNORE_PATH, CONTEXT_DETAIL_GITIGNORE_CONTENT, "utf8");
    }
  } catch (_) {
    /* 非致命 */
  }
}

function readDetailManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTEXT_DETAIL_MANIFEST_PATH, "utf8"));
    if (parsed && parsed.version === DETAIL_MANIFEST_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch (_) {
    /* 首次运行 / 文件损坏 → 全量重写 */
  }
  return { version: DETAIL_MANIFEST_VERSION, entries: {} };
}

function writeDetailManifest(manifest) {
  try {
    const content = JSON.stringify(manifest) + "\n";
    let current = null;
    try {
      current = fs.readFileSync(CONTEXT_DETAIL_MANIFEST_PATH, "utf8");
    } catch (_) {
      current = null;
    }
    if (current === content) return false;
    atomicWriteFileSync(CONTEXT_DETAIL_MANIFEST_PATH, content);
    return true;
  } catch (_) {
    return false;
  }
}

function listDetailDirFiles() {
  const sizes = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(CONTEXT_DETAIL_DIR_PATH, { withFileTypes: true });
  } catch (_) {
    return sizes;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      sizes.set(entry.name, fs.statSync(path.join(CONTEXT_DETAIL_DIR_PATH, entry.name)).size);
    } catch (_) {
      /* ignore */
    }
  }
  return sizes;
}

/**
 * 清理过期详情文件: 只删 <safe>.js (以及崩溃残留的 .tmp),
 * .gitignore / README / 其它非详情文件一律不动。
 */
export function cleanupStaleDetailFiles(keepFileNames) {
  const keep = keepFileNames instanceof Set ? keepFileNames : new Set(keepFileNames || []);
  const removed = [];
  const now = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(CONTEXT_DETAIL_DIR_PATH, { withFileTypes: true });
  } catch (_) {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (DETAIL_PROTECTED_FILES.has(name)) continue;
    const fullPath = path.join(CONTEXT_DETAIL_DIR_PATH, name);
    if (name.endsWith(".js")) {
      if (keep.has(name)) continue;
      try {
        fs.unlinkSync(fullPath);
        removed.push(name);
      } catch (_) {
        /* ignore */
      }
      continue;
    }
    if (name.endsWith(".tmp")) {
      try {
        if (now - fs.statSync(fullPath).mtimeMs > DETAIL_TMP_GRACE_MS) {
          fs.unlinkSync(fullPath);
          removed.push(name);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  return removed;
}

function buildIndexContent(sessions, summary, detailFiles) {
  const indexSessions = sessions.map(buildSessionIndexEntry);
  return [
    "// context-data.js — 自动从 usage.jsonl 与真实会话构建 (数据契约 v2: 轻量索引)",
    "// 每会话完整详情见 page/data/<safe>.js, 页面按 window.CONTEXT_DETAIL_FILES[id] 懒加载",
    "window.CONTEXT_DATA_VERSION = " + CONTEXT_DATA_VERSION + ";",
    "window.CONTEXT_SUMMARY = " + JSON.stringify(summary, null, 2) + ";",
    "window.CONTEXT_SESSIONS = " + JSON.stringify(indexSessions) + ";",
    "window.CONTEXT_DETAIL_DIR = " + JSON.stringify(CONTEXT_DETAIL_DIR_NAME) + ";",
    "window.CONTEXT_DETAIL_FILES = " + JSON.stringify(detailFiles) + ";",
    ""
  ].join("\n");
}

/**
 * 把一份数据集落盘: 索引 + 每会话详情 + 清理过期文件。
 * 纯写入, 不重新解析 —— 测试可以复用同一份数据集做逐字段比对。
 * @returns {{sessionCount:number,indexBytes:number,detailFileCount:number,written:number,unchanged:number,removed:string[],durationMs:number}}
 */
export function writeContextDataset(sessions, summary) {
  const startedAt = Date.now();
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const detailFiles = buildDetailFileMap(safeSessions);

  ensureDetailDir();

  const previousEntries = readDetailManifest().entries || {};
  const nextEntries = {};
  const existingSizes = listDetailDirFiles();

  let written = 0;
  let unchanged = 0;

  for (const session of safeSessions) {
    const id = session.id === null || session.id === undefined ? "" : String(session.id);
    const relPath = detailFiles[id];
    if (!relPath) continue;
    const fileName = path.basename(relPath);
    trimDetailPayloadInPlace(session);
    const stableHash = detailStableHash(session);
    const previousEntry = previousEntries[fileName];
    const knownSize = existingSizes.get(fileName);

    // 内容未变(且文件大小一致) → 不重写, 避免 watch 模式每 5s 的磁盘抖动
    if (
      previousEntry &&
      previousEntry.id === id &&
      previousEntry.hash === stableHash &&
      typeof knownSize === "number" &&
      knownSize === previousEntry.bytes
    ) {
      nextEntries[fileName] = previousEntry;
      unchanged += 1;
      continue;
    }

    const content = buildDetailFileContent(fileName, session);
    atomicWriteFileSync(path.join(CONTEXT_DETAIL_DIR_PATH, fileName), content);
    const bytes = Buffer.byteLength(content, "utf8");
    existingSizes.set(fileName, bytes);
    nextEntries[fileName] = { id: id, hash: stableHash, bytes: bytes };
    written += 1;
  }

  const removed = cleanupStaleDetailFiles(new Set(Object.keys(nextEntries)));
  writeDetailManifest({ version: DETAIL_MANIFEST_VERSION, entries: nextEntries });

  const indexContent = buildIndexContent(safeSessions, summary || {}, detailFiles);
  atomicWriteFileSync(CONTEXT_DATA_JS_PATH, indexContent);

  return {
    sessionCount: safeSessions.length,
    indexBytes: Buffer.byteLength(indexContent, "utf8"),
    detailFileCount: Object.keys(detailFiles).length,
    written: written,
    unchanged: unchanged,
    removed: removed,
    durationMs: Date.now() - startedAt
  };
}

export function syncContextData() {
  const startedAt = Date.now();
  try {
    const { sessions, summary } = buildContextDataset();
    const stats = writeContextDataset(sessions, summary);
    console.log(
      "[Daemon] Synced context-data.js (v2 index " + (stats.indexBytes / 1024).toFixed(0) + "KB): " +
      stats.sessionCount + " sessions, " + summary.totalTurns + " turns " +
      "(Agents: Antigravity=" + summary.agents.antigravity + ", DSH=" + summary.agents.dsh +
      ", Codex=" + summary.agents.codex + ", Other=" + summary.agents.other + "); " +
      "details=" + stats.detailFileCount + " files (written " + stats.written + ", unchanged " + stats.unchanged +
      ", removed " + stats.removed.length + ") in " + (Date.now() - startedAt) + "ms"
    );
    return stats;
  } catch (e) {
    console.error("[Daemon] Error writing context-data.js:", e.message);
    return null;
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
