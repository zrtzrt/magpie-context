/**
 * magpie-context / dsh-fileops.mjs
 *
 * 纯函数数据聚合模块: 把归一化的工具事件 / 任务事件聚合成
 *   1) 文件活动  buildFileActivity(toolEvents, opts)  -> { fileOps, io }
 *   2) 命令执行  buildCommandActivity(toolEvents, jobEvents, opts) -> { commands, commandStats, notable, programs }
 *
 * 契约: /tmp/dshctx-ref/FILEOPS-CONTRACT.md (字段名由 Lead 定稿, 不得改名)
 * 语义来源: 官方 dsh-context 美化源码
 *   - 文件操作抽取      off-index.pretty.mjs:238-385 (Fe/Le/Be/Ve/He/Ue/We/Ke/qe/Je/Ye)
 *   - 命令状态机        off-index.pretty.mjs:408-436 (et/rt)
 *   - 程序名解析        off-index.pretty.mjs:437-628,891-911 (包装器剥离 / St / jt / Mt)
 *   - programTally      off-index.pretty.mjs:1596-1601
 *   - commandCalls 去重环 off-index.pretty.mjs:1214-1218
 *
 * 硬约束:
 *   - 纯函数: 不 import fs / net / 任何第三方依赖; 不读 process.env
 *   - 确定性: 不使用 Date.now() / Math.random(); 同输入两次调用结果 JSON 完全一致
 *   - 空输入返回空数组 / 空对象 (页面走空态), 绝不生成 mock 兜底数据
 *   - 只做真实计算: 拿不到的数字一律 0 / 缺省, 不编造
 *
 * opts (两个构建函数共用, 均可省略):
 *   { cwd, home, mode, user }
 *   - cwd  会话工作目录: 相对路径按它解析 (缺省则保留相对形态, 仍做 ./ .. 折叠)
 *   - home 家目录: 用于展开 ~ (缺省时 ~ 保持字面量, 不与 cwd 拼接, 保证可预期)
 *   - mode 写入 io.mode (例如 agentPreset 'ptc'), 缺省 null
 *   - user 人类输入次数 (文件模块无法从工具事件推出), 缺省 0
 *
 * io 口径: 计"工具调用真实次数"而非展开后的文件行数 —— read 覆盖 read/read_image
 *          (官方 Fe 把 read_image 归为 read), write 覆盖 write/edit, search 覆盖 grep/glob,
 *          image 是其中 read_image 的次数 (子集)。同一 callId 的重复事件只计一次。
 */

// ---------------------------------------------------------------------------
// 0. 通用小工具
// ---------------------------------------------------------------------------

const BACKTICK = "\u0060";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 第一个非空字符串 (去首尾空白后判空); 用于路径 / 命令等"必须有内容"的字段 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** 第一个"已定义"的字符串 (允许空串); 用于 content / old_string 这类可以为空的正文 */
function firstDefinedString(...values) {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return "";
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/**
 * epoch ms -> 'HH:MM:SS' (本地时区, 与页面展示一致)。
 * 非有限数字返回 '' (页面直接显示该字符串, 空串即不显示)。
 */
export function formatClock(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const t = date.getTime();
  if (!Number.isFinite(t)) return "";
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
}

/**
 * 按 callId 去重: 会话日志重放/续写时会出现同一 callId 的重复 tool/result,
 * 官方实现用 callId 做 Map key (重复结果只保留一条), 这里等价地只保留首次出现。
 */
function dedupeByCall(events) {
  const seen = new Set();
  const out = [];
  for (const event of events) {
    if (!isObject(event)) {
      out.push(event);
      continue;
    }
    const callId = typeof event.callId === "string" && event.callId !== "" ? event.callId : "";
    if (callId === "") {
      out.push(event);
      continue;
    }
    const key = callId + "|" + (typeof event.name === "string" ? event.name : "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function compareText(a, b) {
  const x = typeof a === "string" ? a : "";
  const y = typeof b === "string" ? b : "";
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function shorten(text, max) {
  const s = typeof text === "string" ? text : "";
  const limit = Number.isFinite(max) && max > 0 ? max : 40;
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + "…";
}

/**
 * 判断一个已经归一成正斜杠的路径是否为绝对路径。
 *
 * 原来只认 `p.startsWith("/")`, 于是 Windows 盘符路径 (`C:/Users/x/a.js`) 和
 * UNC 路径 (`//server/share/a.js`) 都被当成相对路径, 会被拼上 cwd 变成
 * `<cwd>/C:/Users/x/a.js` —— 同一个文件在 Windows 上因此被拆成多个 key,
 * 文件活动统计里出现重复条目, 行数/次数也被拆散。
 * @param {string} p 已把反斜杠换成斜杠的路径
 */
function isAbsolutePathText(p) {
  if (typeof p !== "string" || p === "") return false;
  if (p.startsWith("/")) return true; // POSIX 绝对路径 或 UNC (//server/share)
  return /^[A-Za-z]:\//.test(p); // Windows 盘符绝对路径
}

function normalizeOpts(opts) {
  const o = isObject(opts) ? opts : {};
  return {
    cwd: typeof o.cwd === "string" ? o.cwd : "",
    home: typeof o.home === "string" ? o.home : "",
    mode: typeof o.mode === "string" && o.mode !== "" ? o.mode : null,
    user: toFiniteNumber(o.user) ?? 0,
  };
}

/** 工具事件里的 args: 契约说已是对象, 但容忍 JSON 字符串 (逐级降级, 不抛错) */
function asArgs(event) {
  const raw = isObject(event) ? event.args : undefined;
  if (isObject(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// 1. 路径归一
// ---------------------------------------------------------------------------

function stripQuotes(text) {
  let s = typeof text === "string" ? text.trim() : "";
  if (s.length >= 2) {
    const head = s[0];
    const tail = s[s.length - 1];
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'") || (head === BACKTICK && tail === BACKTICK)) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

/** 词法折叠 . 与 .. (不触碰真实文件系统) */
/**
 * 拆出「根前缀」: 盘符 (`C:`) 或 UNC 共享 (`//server/share`) 或 POSIX 的 `/`。
 * 前缀不参与 ../ 折叠, 也不能被加上额外的前导斜杠 —— 否则 Windows 路径会被
 * 折叠成 `/C:/Users/x` 这种既不是 POSIX 也不是 Windows 的第三种形态。
 * @returns {{prefix:string, rest:string, absolute:boolean}}
 */
function splitRootPrefix(p) {
  if (/^[A-Za-z]:\//.test(p)) return { prefix: p.slice(0, 2), rest: p.slice(2), absolute: true };
  if (p.startsWith("//")) {
    const parts = p.slice(2).split("/");
    const server = parts.shift() || "";
    const share = parts.shift() || "";
    const prefix = "//" + server + (share ? "/" + share : "");
    return { prefix, rest: "/" + parts.join("/"), absolute: true };
  }
  if (p.startsWith("/")) return { prefix: "", rest: p, absolute: true };
  return { prefix: "", rest: p, absolute: false };
}

function collapseSegments(pathText, isAbsolute) {
  const { prefix, rest } = splitRootPrefix(pathText);
  const parts = rest.split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  if (prefix) return prefix + "/" + joined;
  if (isAbsolute) return "/" + joined;
  return joined;
}

/**
 * 路径归一: 去首尾空白 -> 去成对引号 -> 去 file:// -> 反斜杠转正斜杠
 *           -> ~ 展开 (需 opts.home) -> 相对路径按 opts.cwd 解析 -> 折叠 ./..
 * 归一后的字符串只用作"同一文件"的 key; 展示仍用原文路径 (见 buildFileActivity)。
 */
export function normalizePath(rawPath, opts = {}) {
  const o = normalizeOpts(opts);
  let p = stripQuotes(rawPath);
  if (p === "") return "";
  if (p.startsWith("file://")) p = p.slice("file://".length);
  p = p.replace(/\\/g, "/").trim();
  if (p === "") return "";

  // ~ 展开; home 未知时保持字面量并且不拼 cwd, 避免把 ~/x 变成 <cwd>/~/x
  let unresolvedTilde = false;
  if (p === "~" || p.startsWith("~/")) {
    if (o.home) {
      const home = o.home.replace(/\\/g, "/").replace(/\/+$/, "");
      p = home + (p === "~" ? "" : p.slice(1));
    } else {
      unresolvedTilde = true;
    }
  }

  const isAbsolute = isAbsolutePathText(p);
  if (!isAbsolute && !unresolvedTilde && o.cwd) {
    const cwd = o.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (cwd !== "") p = cwd + "/" + p;
  }

  const absoluteNow = isAbsolutePathText(p);
  const collapsed = collapseSegments(p, absoluteNow);
  if (collapsed === "" || collapsed === ".") {
    return absoluteNow ? "/" : ".";
  }
  return collapsed;
}

/** 取路径最后一段 (文件名); 展示用 */
export function baseNameOf(pathText) {
  const s = typeof pathText === "string" ? pathText : "";
  const idx = s.lastIndexOf("/");
  const name = idx >= 0 ? s.slice(idx + 1) : s;
  return name === "" ? s : name;
}

// ---------------------------------------------------------------------------
// 2. 行数 / 出现次数
// ---------------------------------------------------------------------------

/**
 * 行数统计 (官方 Ve): 数换行符; 结尾有换行则不再 +1; 空串 = 0 行。
 * 'a\nb' -> 2; 'a\nb\n' -> 2; '' -> 0; '\n' -> 1; '\n\n' -> 2
 */
export function countLines(text) {
  if (typeof text !== "string" || text === "") return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** needle 在 haystack 中出现的次数 (非重叠) */
export function countOccurrences(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string" || needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 3. 文件操作: 工具 -> 类别 / 路径 / 行数 / 详情
// ---------------------------------------------------------------------------

/** 官方 Fe (off-index:238-240) + 常见别名 (不同 agent 的同类工具) */
const FILE_TOOL_KIND = {
  read: "read",
  read_file: "read",
  view_file: "read",
  read_resource: "read",
  read_image: "read",
  read_image_file: "read",
  write: "write",
  write_file: "write",
  write_to_file: "write",
  edit: "write",
  edit_file: "write",
  replace_file_content: "write",
  multi_replace_file_content: "write",
  grep: "search",
  grep_search: "search",
  search: "search",
  glob: "search",
  find_by_name: "search",
  list_dir: "search",
};

const SEARCH_TOOLS = new Set(["grep", "grep_search", "search", "glob", "find_by_name", "list_dir"]);
const IMAGE_TOOLS = new Set(["read_image", "read_image_file"]);

/** 官方 Le (off-index:243-244): str_replace_editor 按 command 判读/写 */
export function toolKindOf(name, args) {
  if (typeof name !== "string" || name === "") return null;
  const lower = name.toLowerCase();
  if (lower === "str_replace_editor") {
    const command = isObject(args) ? firstString(args.command, args.Command) : "";
    return command.toLowerCase() === "view" ? "read" : "write";
  }
  return Object.hasOwn(FILE_TOOL_KIND, lower) ? FILE_TOOL_KIND[lower] : null;
}

/** 官方 Be (off-index:249-259): grep/glob 取 path 否则 pattern; 其余 file_path -> filePath -> path */
function rawPathOf(name, args) {
  if (!isObject(args)) return "";
  const lower = typeof name === "string" ? name.toLowerCase() : "";
  if (SEARCH_TOOLS.has(lower)) {
    return firstString(args.path, args.dir, args.SearchPath, args.pattern, args.query, args.Query, args.glob);
  }
  return firstString(
    args.file_path,
    args.filePath,
    args.path,
    args.Path,
    args.target_file,
    args.AbsolutePath,
    args.absolute_path,
  );
}

/** 官方 He/Ue (off-index:269-282) + append/overwrite 语义 */
function lineDeltaOf(name, args, meta) {
  const lower = typeof name === "string" ? name.toLowerCase() : "";
  const empty = { added: 0, removed: 0 };
  if (!isObject(args)) return empty;

  if (lower === "edit" || lower === "edit_file" || lower === "replace_file_content" || lower === "multi_replace_file_content") {
    const added = countLines(firstDefinedString(args.new_string, args.replacement, args.Replacement, args.ReplacementContent, args.new_str));
    const removed = countLines(firstDefinedString(args.old_string, args.target, args.Target, args.TargetContent, args.old_str));
    return { added, removed };
  }
  if (lower === "write" || lower === "write_file" || lower === "write_to_file") {
    const content = firstDefinedString(args.content, args.Content, args.CodeContent, args.file_text);
    const added = countLines(content);
    // overwrite 计全文 (added = 全文行数); append 只计新增 (added = 追加片段行数, removed 恒 0)
    return { added, removed: 0 };
  }
  if (lower === "str_replace_editor") {
    const command = firstString(isObject(meta) ? meta.command : "", args.command, args.Command).toLowerCase();
    if (command === "str_replace") {
      return { added: countLines(firstDefinedString(args.new_str)), removed: countLines(firstDefinedString(args.old_str)) };
    }
    if (command === "insert") return { added: countLines(firstDefinedString(args.new_str)), removed: 0 };
    if (command === "create") return { added: countLines(firstDefinedString(args.file_text)), removed: 0 };
  }
  return empty;
}

/** 官方 We/Ke (off-index:283-298): 读取区间来自结果 meta, 否则用参数 limit 估算 */
function readRangeOf(meta, args) {
  if (isObject(meta) && typeof meta.path === "string" && Array.isArray(meta.lines) && meta.lines.length > 0) {
    const offset = toFiniteNumber(meta.offset);
    if (offset !== undefined && offset >= 1) {
      return { start: Math.floor(offset), count: meta.lines.length, est: false };
    }
  }
  const limit = toFiniteNumber(isObject(args) ? args.limit : undefined);
  const offset = toFiniteNumber(isObject(args) ? args.offset : undefined);
  if (limit !== undefined && limit > 0) {
    return {
      start: offset !== undefined && offset > 0 ? Math.floor(offset) : 1,
      count: Math.floor(limit),
      est: true,
    };
  }
  if (offset !== undefined && offset > 0) return { start: Math.floor(offset), count: 0, est: true };
  return null;
}

/** 官方 Je (off-index:303-316): 从 grep/glob 结果 meta 抽出 {path, hits}[] */
function grepFilesOf(meta) {
  if (!isObject(meta)) return [];
  // 官方 Je (off-index:303-316): 只有 truncated===false 且 shape ∈ {matches,paths} 时才按命中文件展开;
  // 其它情况一律只记 1 条 (Be() 用 pattern 当 path), 否则会过度展开 (M 会话 11 vs 官方 7)。
  if (meta.truncated !== false) return [];
  if (meta.shape === "matches" && Array.isArray(meta.files)) {
    const out = [];
    for (const file of meta.files) {
      if (!isObject(file)) continue;
      if (typeof file.path !== "string" || file.path === "") continue;
      const hits = Array.isArray(file.matches) ? file.matches.length : 0;
      out.push({ path: file.path, hits });
    }
    return out;
  }
  if (meta.shape === "paths" && Array.isArray(meta.paths)) {
    const out = [];
    for (const p of meta.paths) {
      if (typeof p === "string" && p !== "") out.push({ path: p, hits: 0 });
    }
    return out;
  }
  return [];
}

/** 官方 qe (off-index:300-303): 'pattern' 或 'pattern (include)' */
function patternLabelOf(args) {
  if (!isObject(args)) return "";
  const pattern = firstString(args.pattern, args.query, args.Query, args.glob);
  if (pattern === "") return "";
  const include = firstString(args.include);
  return include ? pattern + " (" + include + ")" : pattern;
}

function imageSizeOf(resultText) {
  if (typeof resultText !== "string") return "";
  const m = /image\/[A-Za-z0-9.+-]+ image,\s*(\d+)x(\d+)\s*px/.exec(resultText);
  return m ? m[1] + "x" + m[2] : "";
}

function writeOpLabelOf(name, args, meta) {
  const lower = typeof name === "string" ? name.toLowerCase() : "";
  if (lower === "str_replace_editor") {
    const command = firstString(isObject(args) ? args.command : "", isObject(meta) ? meta.command : "").toLowerCase();
    if (command === "create") return "新建文件";
    if (command === "insert") return "插入内容";
    if (command === "str_replace") return "替换内容";
  }
  const operation = firstString(isObject(meta) ? meta.operation : "");
  if (operation !== "") {
    if (operation === "create") return "新建文件";
    if (operation === "append") return "追加写入";
    if (operation === "overwrite") return "覆盖写入";
  }
  if (isObject(args)) {
    if (args.append === true || args.Append === true || args.append === "true") return "追加写入";
    if (args.overwrite === true || args.Overwrite === true || args.overwrite === "true") return "覆盖写入";
  }
  return "写入文件";
}

/**
 * edit 的"替换处数": replace_all 时用结果 diff 的 oldText 数出真实出现次数,
 * 否则一次替换只算 1 处 (与 edit 工具语义一致)。拿不到证据就是 1, 不猜。
 */
function replacementCountOf(args, meta) {
  const replaceAll = isObject(args) && (args.replace_all === true || args.replaceAll === true || args.replace_all === "true");
  if (!replaceAll) return 1;
  const oldText = firstDefinedString(isObject(args) ? args.old_string : "", isObject(args) ? args.target : "");
  if (oldText === "" || !isObject(meta) || !Array.isArray(meta.diffs)) return 1;
  let total = 0;
  for (const diff of meta.diffs) {
    if (!isObject(diff)) continue;
    total += countOccurrences(firstDefinedString(diff.oldText), oldText);
  }
  return total > 0 ? total : 1;
}

/** 单条工具事件 -> 若干文件操作记录 (search 会展开成多文件) */
function extractFileOps(event, name, kind, o, order) {
  const args = asArgs(event);
  const meta = isObject(event.meta) ? event.meta : {};
  const base = {
    tool: typeof event.name === "string" ? event.name : name,
    turn: toFiniteNumber(event.turn) ?? 0,
    step: toFiniteNumber(event.step) ?? 0,
    time: toFiniteNumber(event.time),
    isError: event.isError === true,
    nested: event.nested === true,
    order,
    kind,
  };
  const lower = typeof name === "string" ? name.toLowerCase() : "";

  // ---- 搜索: 按结果命中的文件逐条展开 (官方 Ye 的 search 分支) ----
  if (kind === "search") {
    const label = patternLabelOf(args);
    const files = grepFilesOf(meta);
    const argPath = rawPathOf(name, args);
    const records = [];
    if (files.length > 0) {
      const argKey = argPath ? normalizePath(argPath, o) : "";
      const coversArg = argKey !== "" && files.some((f) => normalizePath(f.path, o) === argKey);
      // 显式 path 且不在命中集合里 (通常是个目录): 补一条"查询"记录, 与官方一致
      if (argKey !== "" && !coversArg) {
        records.push({
          ...base,
          rawPath: stripQuotes(argPath),
          detail: label ? '搜索 "' + shorten(label) + '"' : "搜索",
          added: 0,
          removed: 0,
          hits: 0,
          images: 0,
        });
      }
      for (const file of files) {
        records.push({
          ...base,
          rawPath: stripQuotes(file.path),
          detail: file.hits > 0 ? "匹配 " + file.hits + " 处" : "匹配路径",
          added: 0,
          removed: 0,
          hits: file.hits,
          images: 0,
        });
      }
      return records;
    }
    // 无结果 meta: 归到显式 path; 只有 pattern 时按官方语义记在 pattern 上并打 pattern 标记
    const hasExplicitPath = firstString(args.path, args.dir, args.SearchPath) !== "";
    const fallback = argPath || ".";
    const suffix = base.isError ? " (失败)" : "";
    const labelText = label ? '搜索 "' + shorten(label) + '"' : lower === "list_dir" ? "列目录" : "搜索";
    records.push({
      ...base,
      rawPath: stripQuotes(fallback),
      detail: labelText + suffix,
      added: 0,
      removed: 0,
      hits: 0,
      images: 0,
      pattern: !hasExplicitPath,
    });
    return records;
  }

  const rawPath = rawPathOf(name, args);
  if (rawPath === "") return [];
  const { added, removed } = lineDeltaOf(name, args, meta);
  const isImage = IMAGE_TOOLS.has(lower);
  let detail = "";
  let images = 0;

  if (isImage) {
    images = 1;
    const size = imageSizeOf(event.resultText);
    detail = size ? "读取图片 " + size : "读取图片";
  } else if (kind === "read") {
    const range = readRangeOf(meta, args);
    if (range === null) {
      detail = "读取文件";
    } else if (range.count > 0) {
      const end = range.start + range.count - 1;
      detail = "读取 " + range.start + "-" + end + " 行" + (range.est ? " (估算)" : "");
    } else {
      detail = "读取 " + range.start + " 行起" + (range.est ? " (估算)" : "");
    }
  } else {
    const label = writeOpLabelOf(name, args, meta);
    if (lower === "edit" || lower === "edit_file" || lower === "replace_file_content" || lower === "multi_replace_file_content") {
      detail = "替换 " + replacementCountOf(args, meta) + " 处 (+" + added + "/-" + removed + ")";
    } else {
      detail = label + " (+" + added + "/-" + removed + ")";
    }
  }
  if (base.isError) detail += " (失败)";

  return [
    {
      ...base,
      rawPath: stripQuotes(rawPath),
      detail,
      added,
      removed,
      hits: 0,
      images,
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. 文件活动聚合
// ---------------------------------------------------------------------------

/**
 * @param {Array} toolEvents 归一化工具事件 (契约: 见文件头)
 * @param {Object} [opts] { cwd, home, mode, user }
 * @returns {{ fileOps: Array, io: { user:number, read:number, write:number, search:number, image:number, mode:string|null } }}
 */
export function buildFileActivity(toolEvents, opts = {}) {
  const o = normalizeOpts(opts);
  const events = dedupeByCall(Array.isArray(toolEvents) ? toolEvents : []);
  const groups = new Map();
  const counters = { read: 0, write: 0, search: 0, image: 0 };

  events.forEach((event, index) => {
    if (!isObject(event)) return;
    const name = typeof event.name === "string" ? event.name : "";
    if (name === "") return;
    const args = asArgs(event);
    const kind = toolKindOf(name, args);
    if (kind === null) return;

    const records = extractFileOps(event, name, kind, o, index);
    // io 计"工具调用次数" (真实次数), 搜索按命中文件展开只影响 fileOps 行, 不重复计 io
    if (records.length > 0) {
      if (kind === "read") counters.read += 1;
      else if (kind === "write") counters.write += 1;
      else counters.search += 1;
      if (records.some((record) => record.images > 0)) counters.image += 1;
    }
    for (const record of records) {
      const key = normalizePath(record.rawPath, o);
      if (key === "") continue;
      let group = groups.get(key);
      if (group === undefined) {
        group = { key, displayPaths: [], ops: [] };
        groups.set(key, group);
      }
      const display = record.rawPath;
      if (display !== "" && !group.displayPaths.includes(display)) group.displayPaths.push(display);
      group.ops.push(record);
    }
  });

  const fileOps = [];
  for (const group of groups.values()) {
    const ops = group.ops.slice().sort((a, b) => a.order - b.order);
    const first = ops[0];
    let reads = 0;
    let writes = 0;
    let searches = 0;
    let images = 0;
    let added = 0;
    let removed = 0;
    for (const op of ops) {
      if (op.kind === "read") reads += 1;
      else if (op.kind === "write") writes += 1;
      else searches += 1;
      if (op.images > 0) images += op.images;
      added += op.added || 0;
      removed += op.removed || 0;
    }
    const last = ops[ops.length - 1];

    // 展示路径: 取最短的一种写法 (同长取最早出现的), 即"原文路径"
    let displayPath = group.displayPaths.length > 0 ? group.displayPaths[0] : group.key;
    for (const candidate of group.displayPaths) {
      if (candidate.length < displayPath.length) displayPath = candidate;
    }

    // 主导操作: 次数多者胜; 平票按 write > read > search 优先级 (图片不计入主导, 归到 read)
    let op = "read";
    if (writes > 0 && writes >= reads && writes >= searches) op = "write";
    else if (reads > 0) op = "read";
    else if (searches > 0) op = "search";
    else if (images > 0) op = "read";

    const operations = [];
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      const source = ops[i];
      const entry = {
        tool: source.tool,
        detail: source.detail,
        time: formatClock(source.time),
        turn: source.turn,
        step: source.step,
        op: source.kind,
      };
      if (source.nested) entry.nested = true;
      if (source.hits > 0) entry.hits = source.hits;
      if (source.pattern === true) entry.pattern = true;
      if (source.added > 0) entry.added = source.added;
      if (source.removed > 0) entry.removed = source.removed;
      if (source.images > 0) entry.images = source.images;
      if (source.isError) entry.isError = true;
      operations.push(entry);
    }

    const record = {
      path: displayPath,
      name: baseNameOf(displayPath),
      op,
      reads,
      writes,
      searches,
      added,
      removed,
      time: formatClock(last.time),
      lastTurn: last.turn || first.turn || 0,
      lastStep: last.step || first.step || 0,
      images,
      operations,
      key: group.key,
    };
    fileOps.push(record);
  }

  fileOps.sort((a, b) => {
    const activityA = a.reads + a.writes + a.searches + a.images;
    const activityB = b.reads + b.writes + b.searches + b.images;
    if (activityA !== activityB) return activityB - activityA;
    const lineA = a.added + a.removed;
    const lineB = b.added + b.removed;
    if (lineA !== lineB) return lineB - lineA;
    return compareText(a.path, b.path) || compareText(a.key, b.key);
  });

  const io = {
    user: o.user,
    read: counters.read,
    write: counters.write,
    search: counters.search,
    image: counters.image,
    mode: o.mode,
  };

  return { fileOps, io };
}

// ---------------------------------------------------------------------------
// 5. 命令: 语句切分 / 程序名解析
// ---------------------------------------------------------------------------

/** 官方 it (off-index:437-439): 需要剥离的包装器 */
const WRAPPER_WORDS = new Set([
  "env", "sudo", "doas", "command", "exec", "time", "nohup", "nice",
  "stdbuf", "timeout", "caffeinate", "noglob", "nocorrect",
]);
/** 这些 wrapper 的选项需要吞掉后面的值 (官方 at/ot 简化版) */
const WRAPPER_VALUE_OPTIONS = new Set([
  "-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--chdir", "-D", "--close-from",
  "-h", "--host", "-r", "--role", "-t", "--type", "-U", "--other-user", "-R", "--chroot",
  "-n", "--adjustment", "-f", "--format", "-o", "--output", "-s", "--signal", "-k",
  "--kill-after", "-i", "--input", "-e", "--error", "-a", "-S", "--split-string", "-w",
]);
const CD_WORDS = new Set(["cd", "pushd", "popd", "set-location", "sl"]);
/** 官方 st (off-index:439): 复合语句关键字, 程序名统一归为 'shell' */
const SHELL_KEYWORDS = new Set([
  "[", "[[", "for", "if", "while", "until", "case", "do", "then", "else", "elif",
  "function", "select", "coproc", "done", "fi", "esac", "{", "}", "!", "export", "set",
]);

/** 按 && || ; | 与换行切分语句, 尊重引号 (官方 wt 的简化版) */
export function splitStatements(cmd) {
  if (typeof cmd !== "string" || cmd === "") return [];
  const out = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote !== "") {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
        current += cmd[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === BACKTICK) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      current += ch + cmd[i + 1];
      i += 1;
      continue;
    }
    if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
      out.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** 语句 -> 词数组 (尊重引号与反斜杠转义) */
export function splitWords(statement) {
  if (typeof statement !== "string") return [];
  const words = [];
  let current = "";
  let quote = "";
  let hasContent = false;
  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i];
    if (quote !== "") {
      if (ch === "\\" && quote === '"' && i + 1 < statement.length) {
        current += statement[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === BACKTICK) {
      quote = ch;
      hasContent = true;
      continue;
    }
    if (ch === "\\" && i + 1 < statement.length) {
      current += statement[i + 1];
      i += 1;
      hasContent = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      if (hasContent) {
        words.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) words.push(current);
  return words;
}

/** 程序名: 去目录前缀 + 去 .exe/.cmd/.bat (官方 St) */
export function programNameOf(word) {
  let text = typeof word === "string" ? word.trim() : "";
  if (text === "") return "";
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (slash >= 0) text = text.slice(slash + 1);
  if (/\.(?:exe|cmd|bat)$/i.test(text)) text = text.replace(/\.(?:exe|cmd|bat)$/i, "");
  return text.trim();
}

/**
 * 单条语句 -> 真实可执行名。
 * 依次剥离: 前置重定向 / 环境变量赋值 / env|sudo|time|nohup|timeout 等包装器及其选项。
 * 空语句返回 ''。
 */
export function programOfStatement(statement) {
  const words = splitWords(statement);
  let i = 0;
  for (let guard = 0; guard < 64 && i < words.length; guard += 1) {
    const word = words[i];
    // 前置重定向: 自带目标的 2>&1 / >file / <file 只吞自己; 光杆的 > / < / &> 再吞一个目标词
    if (word === "&>" || /^\d*[<>]+$/.test(word)) {
      i += 1;
      if (i < words.length) i += 1;
      continue;
    }
    if (/^\d*[<>]+\S+$/.test(word)) {
      i += 1;
      continue;
    }
    // 环境变量赋值: FOO=1 / FOO+=1
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)) {
      i += 1;
      continue;
    }
    const bare = programNameOf(word);
    const lower = bare.toLowerCase();
    // 复合语句 (for/if/while/[...) 没有真实可执行名, 归为 'shell' (官方 st/Tt 语义)
    if (SHELL_KEYWORDS.has(lower)) return "shell";
    if (WRAPPER_WORDS.has(lower)) {
      i += 1;
      while (i < words.length && /^-{1,2}[A-Za-z0-9]/.test(words[i])) {
        const option = words[i];
        i += 1;
        if (WRAPPER_VALUE_OPTIONS.has(option) && i < words.length) i += 1;
      }
      // timeout 的第一个非选项参数是时长
      if (lower === "timeout" && i < words.length && !/^-/.test(words[i])) i += 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return "";
  return programNameOf(words[i]);
}

/**
 * 整条命令行 -> 主命令的可执行名。
 * 管道 / && / ; / 换行串联时, 以"主命令"为准: 跳过开头的 cd 跳转, 取第一个真正的可执行名。
 * 例: 'cd /tmp/x && node a.mjs' -> 'node'; 'FOO=1 sudo -u root npm i' -> 'npm'
 */
export function parseProgram(cmd, fallback = "shell") {
  if (typeof cmd !== "string" || cmd.trim() === "") return fallback;
  const statements = splitStatements(cmd);
  let firstProgram = "";
  for (const statement of statements) {
    const program = programOfStatement(statement);
    if (program === "") continue;
    if (firstProgram === "") firstProgram = program;
    if (!CD_WORDS.has(program.toLowerCase())) return program;
  }
  if (firstProgram !== "") return firstProgram;
  return fallback;
}

/** 解析出的程序列表 (主命令 + 其余语句, 官方 jt/Mt 的简化语义), 去重且保持顺序 */
export function parsePrograms(cmd) {
  if (typeof cmd !== "string" || cmd.trim() === "") return [];
  const list = [];
  for (const statement of splitStatements(cmd)) {
    const program = programOfStatement(statement);
    if (program === "" || CD_WORDS.has(program.toLowerCase())) continue;
    if (!list.includes(program)) list.push(program);
  }
  return list;
}

// ---------------------------------------------------------------------------
// 6. 命令状态判定 (官方 et/rt, off-index:408-436)
// ---------------------------------------------------------------------------

const BASH_TOOLS = new Set(["bash", "pwsh", "run_command", "shell", "shell_command", "terminal"]);

/** 结果文本里的状态标记 (官方 et) */
export function parseStatusMarkers(resultText) {
  const text = typeof resultText === "string" ? resultText : "";
  const out = {};
  if (text === "") return out;

  if (/(?:^|\n)\[killed by signal: ([^\]\n]+)\]/.test(text) || /(?:^|\n)\[shell killed by signal: ([^\]\n]+)\]/.test(text)) {
    out.killed = true;
  }
  const exitMatch =
    /(?:^|\n)\[exit code: (-?\d+)\]/.exec(text) ||
    /(?:^|\n)\[Command finished with exit code (-?\d+)\]/.exec(text) ||
    /(?:^|\n)\[shell exited: code (-?\d+)\]/.exec(text) ||
    /(?:^|\n)exit code: (-?\d+)\s*$/m.exec(text);
  if (exitMatch) out.exitCode = Number(exitMatch[1]);

  if (/(?:^|\n)\[timed out after \d+ms\]/.test(text) || /(?:^|\n)\[Command timed out or OOM\]/.test(text)) out.timedOut = true;
  if (/(?:^|\n)\[sandbox: file access denied/.test(text)) out.denied = true;
  if (/(?:^|\n)\[stopped: [^\]\n]+\]/.test(text)) out.stopped = true;
  if (/(?:^|\n)started background job \S+/.test(text) || /moved to background job/.test(text)) out.backgroundAck = true;
  if (/(?:^|\n)\[output truncated/.test(text)) out.truncated = true;
  if (/(?:^|\n)\[stderr\]\n/.test(text)) out.stderr = true;
  if (/\bcommand not found\b/i.test(text) || /\bnot recognized as an internal or external command\b/i.test(text)) out.notFound = true;
  if (/(?:^|\n)Killed(?::\s*\d+)?\s*$/m.test(text)) out.killed = true;
  return out;
}

function exitCodeOfJob(job) {
  if (!isObject(job)) return undefined;
  const direct = toFiniteNumber(job.exitCode);
  if (direct !== undefined) return direct;
  const detail = typeof job.detail === "string" ? job.detail : "";
  const m = /exit code:\s*(-?\d+)/.exec(detail);
  return m ? Number(m[1]) : undefined;
}

/**
 * 综合 job.status + exitCode + 结果文本标记 -> { status, exitCode, killed, timedOut, denied, notFound }
 * status 只取契约允许的 'completed' | 'failed' | 'background' (killed 归入 failed 并带 killed 标记)
 */
export function resolveCommandStatus({ job, markers, isError, background }) {
  const m = isObject(markers) ? markers : {};
  const out = {
    status: "completed",
    exitCode: undefined,
    killed: false,
    timedOut: m.timedOut === true,
    denied: m.denied === true,
    notFound: m.notFound === true,
  };

  if (isObject(job)) {
    const jobStatus = typeof job.status === "string" ? job.status.toLowerCase() : "";
    const jobExit = exitCodeOfJob(job);
    if (jobStatus === "completed" || jobStatus === "success" || jobStatus === "succeeded") {
      out.status = "completed";
      out.exitCode = jobExit !== undefined ? jobExit : 0;
      return out;
    }
    if (jobStatus === "failed" || jobStatus === "error" || jobStatus === "timeout" || jobStatus === "timedout") {
      out.status = "failed";
      out.exitCode = jobExit;
      if (jobStatus === "timeout" || jobStatus === "timedout") out.timedOut = true;
      return out;
    }
    if (jobStatus === "killed" || jobStatus === "cancelled" || jobStatus === "canceled" || jobStatus === "stopped" || jobStatus === "aborted") {
      out.status = "failed";
      out.killed = true;
      out.exitCode = jobExit;
      return out;
    }
    if (jobStatus === "running" || jobStatus === "pending" || jobStatus === "queued" || jobStatus === "started") {
      out.status = "background";
      out.exitCode = jobExit;
      return out;
    }
  }

  if (m.killed === true || m.stopped === true || m.timedOut === true || m.denied === true || m.notFound === true) {
    out.status = "failed";
    out.killed = m.killed === true || m.stopped === true;
    out.exitCode = m.exitCode;
    return out;
  }
  if (m.exitCode !== undefined) {
    out.exitCode = m.exitCode;
    out.status = m.exitCode === 0 ? "completed" : "failed";
    return out;
  }
  if (isError === true) {
    out.status = "failed";
    return out;
  }
  out.status = background === true ? "background" : "completed";
  return out;
}

// ---------------------------------------------------------------------------
// 7. 命令抽取
// ---------------------------------------------------------------------------

/** 从代码文本里读一个字符串字面量 (支持 " ' 与反引号, 以及常见转义) */
function readStringLiteral(source) {
  if (typeof source !== "string" || source === "") return null;
  const quote = source[0];
  if (quote !== '"' && quote !== "'" && quote !== BACKTICK) return null;
  const escapes = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", '"': '"', "'": "'", "/": "/" };
  escapes[BACKTICK] = BACKTICK;
  let out = "";
  for (let i = 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1];
      out += Object.hasOwn(escapes, next) ? escapes[next] : next;
      i += 1;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
  }
  return null;
}

/** 命令行参数 (兼容 command / CommandLine / commandLine / cmd / script) */
function commandTextOf(event, args) {
  const direct = firstString(
    isObject(args) ? args.command : "",
    isObject(args) ? args.CommandLine : "",
    isObject(args) ? args.commandLine : "",
    isObject(args) ? args.cmd : "",
    isObject(args) ? args.script : "",
    isObject(args) ? args.Script : "",
  );
  if (direct !== "") return direct;
  const argText = isObject(event) && typeof event.argText === "string" ? event.argText : "";
  if (argText === "") return "";
  const m = /"(?:command|CommandLine|commandLine|cmd)"\s*:\s*("(?:[^"\\]|\\.)*")/i.exec(argText);
  if (!m) return "";
  const literal = readStringLiteral(m[1]);
  return literal !== null ? literal.value.trim() : "";
}

/**
 * run_code 程序里显式写出的命令 (没有嵌套 bash 事件时的兜底):
 * 只认 command / CommandLine 的字符串字面量, 去重保序。
 */
export function commandsInCode(code) {
  if (typeof code !== "string" || code === "") return [];
  const out = [];
  const seen = new Set();
  const re = /(?:^|[^A-Za-z0-9_$])(?:command|CommandLine|commandLine)\s*:\s*/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const literal = readStringLiteral(code.slice(match.index + match[0].length));
    if (literal === null) continue;
    const text = literal.value.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function jobKeyOf(job) {
  if (!isObject(job)) return [];
  const keys = [];
  for (const value of [job.callId, job.toolCallId, job.subCallId, job.jobId, job.id]) {
    if (typeof value === "string" && value !== "" && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

function normalizeCommandKey(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// 8. 命令活动聚合
// ---------------------------------------------------------------------------

const MAX_CMD_CHARS = 4096;

/**
 * @param {Array} toolEvents 归一化工具事件
 * @param {Array} jobEvents  归一化任务事件 [{ id,label,status,ms,exitCode,detail,time,turn,step, callId? }]
 * @param {Object} [opts] { cwd, home, mode, user, synthesizeFromJobs=true }
 * @returns {{ commands: Array, commandStats: Object, notable: Object, programs: Array }}
 */
export function buildCommandActivity(toolEvents, jobEvents, opts = {}) {
  const o = normalizeOpts(opts);
  const events = dedupeByCall(Array.isArray(toolEvents) ? toolEvents : []);
  const jobs = (Array.isArray(jobEvents) ? jobEvents : []).filter(isObject);
  const synthesizeFromJobs = !(isObject(opts) && opts.synthesizeFromJobs === false);
  // 宿主可覆盖命令截断长度 (dsh-events 传 maxCommandChars, 与 DSH_EVENT_BOUNDS 对齐)
  const maxCmdChars = toFiniteNumber(isObject(opts) ? opts.maxCommandChars : undefined) ?? MAX_CMD_CHARS;

  // 嵌套子调用索引: 判断 run_code 是否已经有嵌套 bash 事件 (有则不重复解析代码)
  const nestedChildren = new Map();
  for (const event of events) {
    if (!isObject(event) || event.nested !== true) continue;
    const parent = firstString(event.parentCallId, event.rootCallId);
    if (parent === "") continue;
    if (!nestedChildren.has(parent)) nestedChildren.set(parent, []);
    nestedChildren.get(parent).push(event);
  }

  // job 索引: callId 精确匹配优先, label 文本匹配兜底
  const jobsByCall = new Map();
  for (const job of jobs) {
    for (const key of jobKeyOf(job)) {
      if (!jobsByCall.has(key)) jobsByCall.set(key, job);
    }
  }
  const usedJobs = new Set();
  const takeJob = (event, cmdText) => {
    for (const key of [event.callId, event.subCallId, event.toolCallId]) {
      if (typeof key !== "string" || key === "") continue;
      const job = jobsByCall.get(key);
      if (isObject(job) && !usedJobs.has(job)) {
        usedJobs.add(job);
        return job;
      }
    }
    const wanted = normalizeCommandKey(cmdText);
    if (wanted === "") return null;
    for (const job of jobs) {
      if (usedJobs.has(job)) continue;
      if (normalizeCommandKey(job.label) === wanted) {
        usedJobs.add(job);
        return job;
      }
    }
    return null;
  };

  const commands = [];

  const pushCommand = (cmdText, event, options) => {
    const raw = typeof cmdText === "string" ? cmdText.trim() : "";
    if (raw === "") return;
    const args = asArgs(event);
    const job = options.job !== undefined ? options.job : takeJob(event, raw);
    const markers = parseStatusMarkers(event.resultText);
    const wantsBackground =
      (isObject(args) && (args.run_in_background === true || args.runInBackground === true || args.background === true)) ||
      markers.backgroundAck === true;
    const resolved = resolveCommandStatus({ job, markers, isError: event.isError === true, background: wantsBackground });

    const start = firstFinite(event.startTime, event.callTime, event.time);
    const end = firstFinite(event.endTime, event.resultTime, event.finishTime);
    // 工具耗时: 优先宿主给的 durationMs, 否则用起止时间差 (都没有就是 undefined -> 最终 0)
    const durationMs = toFiniteNumber(event.durationMs);
    const spanMs = firstFinite(
      durationMs !== undefined ? Math.max(0, durationMs) : undefined,
      start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined,
    );
    let jobMs;
    if (isObject(job)) {
      jobMs = firstFinite(job.ms, job.durationMs);
      if (jobMs === undefined) {
        const jobStart = firstFinite(job.startedAt, job.start);
        const jobEnd = firstFinite(job.finishedAt, job.end);
        if (jobStart !== undefined && jobEnd !== undefined) jobMs = Math.max(0, jobEnd - jobStart);
      }
    }
    const ms = Math.round(firstFinite(jobMs, spanMs) ?? 0);

    const toolName = typeof event.name === "string" ? event.name : "";
    // codeMode (run_code) 的 program 就是 run_code 本身 (官方 Ot(): tool === 'run_code' → 'run_code'),
    // 不能拿 TS 代码片段去当 shell 解析 (否则会得到 "const" 这种假程序名)。
    const program = options.codeMode === true
      ? "run_code"
      : parseProgram(raw, "shell");
    const truncated = raw.length > maxCmdChars;
    const resultText = typeof event.resultText === "string" ? event.resultText : "";

    const record = {
      seq: commands.length + 1,
      tool: toolName,
      cmd: truncated ? raw.slice(0, maxCmdChars) : raw,
      program,
      status: resolved.status,
      ms,
      turn: toFiniteNumber(event.turn) ?? 0,
      step: toFiniteNumber(event.step) ?? 0,
      time: formatClock(start !== undefined ? start : event.time),
      nested: event.nested === true,
      background: wantsBackground || resolved.status === "background",
      codeMode: options.codeMode === true,
      isError: event.isError === true,
      outChars: resultText.length,
      outTruncated: markers.truncated === true,
    };
    if (truncated) record.cmdTruncated = true;
    if (resolved.exitCode !== undefined) record.exitCode = resolved.exitCode;
    if (resolved.killed) record.killed = true;
    if (resolved.timedOut) record.timedOut = true;
    if (resolved.notFound) record.notFound = true;
    // label 优先用人读的描述 (job.label 就是命令行本身, 与 cmd 重复)
    const label = firstString(
      isObject(args) ? args.description : "",
      isObject(args) ? args.Description : "",
      isObject(job) ? job.label : "",
    );
    if (label !== "") record.label = label;
    const cwd = firstString(isObject(args) ? args.workdir : "", isObject(args) ? args.cwd : "");
    if (cwd !== "") record.cwd = cwd;
    if (isObject(job)) {
      const jobId = firstString(job.id, job.jobId);
      if (jobId !== "") record.jobId = jobId;
    }
    commands.push(record);
  };

  for (const event of events) {
    if (!isObject(event)) continue;
    const name = typeof event.name === "string" ? event.name.toLowerCase() : "";
    if (name === "") continue;
    if (BASH_TOOLS.has(name)) {
      const cmdText = commandTextOf(event, asArgs(event));
      if (cmdText === "") continue;
      pushCommand(cmdText, event, { codeMode: false });
      continue;
    }
    if (name === "run_code") {
      // 官方口径 (off-index.pretty.mjs:1779-1792 + 1819-1844): **每个** run_code 的 tool/call
      // 都要建成一条 CommandRecord (codeMode:true, cmd=args.code); 程序内的嵌套 bash 由
      // tool/ptc-dispatch 另行记录, 两者都保留 (官方就是这么双记的, 不是去重)。
      const args = asArgs(event);
      const code = firstDefinedString(args.code, args.CodeContent, args.script);
      const rawCmd = typeof code === "string" ? code : "";
      if (rawCmd.trim() === "") continue;
      pushCommand(rawCmd, event, { codeMode: true });
      continue;
    }
  }

  // job 兜底: 事件流里没有对应 bash 调用的 job, 用 label 还原一条真实命令 (不造假数据)
  if (synthesizeFromJobs) {
    const known = new Set(commands.map((c) => normalizeCommandKey(c.cmd)));
    for (const job of jobs) {
      if (usedJobs.has(job)) continue;
      const kind = typeof job.kind === "string" ? job.kind.toLowerCase() : "";
      if (kind !== "" && kind !== "bash" && kind !== "shell" && kind !== "run_command") continue;
      const label = firstString(job.label, job.cmd, job.command);
      if (label === "") continue;
      const key = normalizeCommandKey(label);
      if (key === "" || known.has(key)) continue;
      known.add(key);
      usedJobs.add(job);
      pushCommand(
        label,
        { name: "bash", args: {}, turn: job.turn, step: job.step, time: job.time, nested: false, isError: false, resultText: "" },
        { job, codeMode: false },
      );
      const last = commands[commands.length - 1];
      if (last !== undefined) {
        last.fromJob = true;
        last.time = formatClock(firstFinite(job.time, job.startedAt, job.start));
      }
    }
  }

  // 时间顺序: 轮次 -> 步 -> 采集顺序 (事件流本身按时间升序, seq 即采集序)
  commands.sort((a, b) => {
    if (a.turn !== b.turn) return a.turn - b.turn;
    if (a.step !== b.step) return a.step - b.step;
    return a.seq - b.seq;
  });
  // 排序后重排 seq, 与页面展示顺序一致
  commands.forEach((command, index) => {
    command.seq = index + 1;
  });

  // commandStats / programs
  const tally = new Map();
  for (const command of commands) {
    const key = command.program !== "" ? command.program : "other";
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const commandStats = {};
  for (const [name, count] of tally) commandStats[name] = count;
  const programs = Array.from(tally.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : compareText(a.name, b.name)));

  // notable: 最慢程序 / 失败最多程序 / 重复最多命令
  let slowest = null;
  for (const command of commands) {
    if (slowest === null || command.ms > slowest.ms) slowest = { program: command.program, ms: command.ms };
  }
  const failTally = new Map();
  for (const command of commands) {
    if (command.status !== "failed") continue;
    failTally.set(command.program, (failTally.get(command.program) || 0) + 1);
  }
  let mostFail = null;
  for (const [program, count] of failTally) {
    if (mostFail === null || count > mostFail.count) mostFail = { program, count };
  }
  // 去重环语义 (官方 commandCalls, 上限 1024): 同一条命令出现多次才算"重复最多"
  const repeatTally = new Map();
  for (const command of commands) {
    const key = command.cmd;
    if (key === "") continue;
    repeatTally.set(key, (repeatTally.get(key) || 0) + 1);
  }
  let mostRepeat = null;
  for (const [cmd, count] of repeatTally) {
    if (count <= 1) continue;
    if (mostRepeat === null || count > mostRepeat.count || (count === mostRepeat.count && compareText(cmd, mostRepeat.cmd) < 0)) {
      mostRepeat = { cmd, count };
    }
  }

  // 官方 commandStats {runs,failed,ms,bg} (Ft/It 语义): 真实累加, 供 stats.commands 使用
  const commandStatsDetail = { runs: 0, failed: 0, ms: 0, bg: 0 };
  for (const command of commands) {
    commandStatsDetail.runs += 1;
    if (command.status === "failed") commandStatsDetail.failed += 1;
    commandStatsDetail.ms += Math.max(0, command.ms || 0);
    if (command.background) commandStatsDetail.bg += 1;
  }

  return {
    commands,
    commandStats,
    commandStatsDetail,
    notable: { slowest, mostFail, mostRepeat },
    programs,
  };
}

export default { buildFileActivity, buildCommandActivity };

// 供测试与其它模块复用的内部常量 (只读)
export const FILEOPS_INTERNALS = Object.freeze({
  FILE_TOOL_KIND,
  BASH_TOOLS,
  WRAPPER_WORDS,
  CD_WORDS,
  SHELL_KEYWORDS,
  MAX_CMD_CHARS,
});
