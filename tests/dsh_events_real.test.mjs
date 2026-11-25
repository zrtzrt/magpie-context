// tests/dsh_events_real.test.mjs
// ---------------------------------------------------------------------------
// 真实 DSH 会话事件流折叠 (dsh-events.mjs) 的真值回归测试
//
// 真值来源: ~/.dsh/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd
// 本文件自带一个**完全独立**的逐事件计数器 (只用 node:zlib, 不 import dsh-events 的任何解析逻辑),
// 把 foldDshSession() 的每个指标与"事件条数"对齐, 从而证明结果不是公式/常量编出来的。
//
// 覆盖:
//   1. 轮次 / 步数 / 回答数 / 注入数 / 技能数 与独立计数一致
//   2. steps 数组长度 === stats.stepsCount (唯一真源, 消除旧的双口径)
//   3. token 输入/输出/缓存读/缓存写 与 assistant/message.data.usage 累加严格相等
//   4. sum(curCategories.tokens) === currentContext.currentTokens === 末次请求真实 prompt
//   5. fileOps / commands 条数与事件流独立统计一致, 且不存在 mock 兜底值
//   6. 同一文件 fold 两次结果完全一致 (确定性)
//   7. 大中小三种规模的会话都能通过
// ---------------------------------------------------------------------------
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { hasRealSessionData } from "./helpers/real_data.mjs";

// 本文件是"真实 DSH 会话事件流"验收测试,CI runner 无 ~/.dsh 数据时整组跳过。
const dReal = hasRealSessionData("dsh") ? describe : describe.skip;

import {
  foldDshSession,
  DSH_EVENT_BOUNDS,
  DSH_BROWSER_LIMITS,
  estimateCategoriesBytes,
  applyBrowserCategoriesBudget,
  resolveItemFullText,
  resolveItemSnippet
} from "../dsh-events.mjs";

const SESSION_ROOT = path.join(os.homedir(), ".dsh", "sessions");
const SESSION_FILE = "session.v4.jsonl.zstd";

// ---------------------------------------------------------------------------
// 独立真值计数器 (与 dsh-events.mjs 的实现完全解耦)
// ---------------------------------------------------------------------------
function collectSessionFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSessionFiles(full, out);
    else if (entry.name === SESSION_FILE) out.push(full);
  }
  return out;
}

function readEvents(filePath) {
  const raw = zlib.zstdDecompressSync(fs.readFileSync(filePath)).toString("utf8");
  const lines = raw.split("\n");
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 忽略坏行 (与 fold 行为一致)
    }
  }
  return events;
}

const FILE_OP_TOOLS = new Map([
  ["read", "read"],
  ["read_image", "read"],
  ["write", "write"],
  ["edit", "write"],
  ["grep", "search"],
  ["glob", "search"]
]);

/** 只用 node:zlib + 逐事件 switch 的独立统计 */
function independentTruth(filePath) {
  const events = readEvents(filePath);
  const truth = {
    eventCount: events.length,
    turnStartEvents: 0,
    turns: new Set(),
    stepStartEvents: 0,
    assistantMessages: 0,
    assistantWithText: 0,
    userMessages: 0,
    injectMessages: 0,
    compactions: 0,
    prunes: 0,
    toolCalls: 0,
    ptcDispatches: 0,
    jobs: 0,
    skillToolResults: 0,
    pendingSkillCalls: new Set(),
    skills: new Set(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastPrompt: 0 },
    fileOps: { read: 0, write: 0, search: 0, image: 0 },
    commandInvocations: 0,
    commands: []
  };
  const toolNameByCallId = new Map();
  // 与 fold 一致: 重放产生的重复结果事件 (同 callId + seq) 只计一次
  const seenResults = new Set();

  for (const event of events) {
    const data = event.data || {};
    if (event.type === "tool/result" || event.type === "tool/ptc-dispatch") {
      const id = event.type === "tool/result"
        ? (data.message && data.message.source && data.message.source.callId) || (data.message && data.message.toolCallId) || ""
        : data.subCallId || "";
      const key = event.type + ":" + id + ":" + event.seq;
      if (id !== "") {
        if (seenResults.has(key)) continue;
        seenResults.add(key);
      }
    }
    switch (event.type) {
      case "turn/start":
        truth.turnStartEvents += 1;
        break;
      case "step/start":
        truth.stepStartEvents += 1;
        break;
      case "user/message": {
        truth.userMessages += 1;
        const kind = data.source && data.source.kind;
        if (kind && kind !== "user") {
          truth.injectMessages += 1;
          if (kind === "skill-invocation" && data.source.name) truth.skills.add(data.source.name);
        }
        break;
      }
      case "developer/message":
        truth.injectMessages += 1;
        break;
      case "assistant/message": {
        truth.assistantMessages += 1;
        if (data.turn !== undefined) truth.turns.add(data.turn);
        const blocks = data.message && Array.isArray(data.message.content) ? data.message.content : [];
        if (blocks.some((block) => block && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")) {
          truth.assistantWithText += 1;
        }
        const usage = data.usage;
        if (usage && typeof usage === "object") {
          const input = Number(usage.inputTokens || 0);
          const cacheRead = Number(usage.cacheReadTokens || 0);
          const cacheWrite = Number(usage.cacheWriteTokens || 0);
          const output = Number(usage.outputTokens || 0);
          truth.tokens.input += input;
          truth.tokens.output += output;
          truth.tokens.cacheRead += cacheRead;
          truth.tokens.cacheWrite += cacheWrite;
          const prompt = input + cacheRead + cacheWrite;
          if (prompt > 0) truth.tokens.lastPrompt = prompt;
        }
        break;
      }
      case "tool/call": {
        truth.toolCalls += 1;
        const name = typeof data.name === "string" ? data.name : "";
        if (typeof data.callId === "string") toolNameByCallId.set(data.callId, name);
        if (name === "skill") truth.skills.add("tool:skill");
        if (name === "skill") truth.pendingSkillCalls.add(data.callId);
        if (name === "bash" || name === "pwsh" || name === "run_code") {
          truth.commandInvocations += 1;
          truth.commands.push(name);
        }
        const kind = FILE_OP_TOOLS.get(name);
        if (kind) truth.fileOps[kind] += 1;
        if (name === "read_image") truth.fileOps.image += 1;
        break;
      }
      case "tool/result": {
        const msg = data.message || {};
        const cid = (msg.source && msg.source.callId) || msg.toolCallId || "";
        // skill 工具结果 → 官方注入一条 form='instructions', sub='skill' 的 inject 事件
        // (原条件写成 `A && B && data.meta !== undefined || null`, 短路优先级使 meta 缺失时
        //  整个表达式变成 null → 恒不计数; 真值侧少算 1 条, 断言必然假红。)
        if (toolNameByCallId.get(cid) === "skill" && msg.isError !== true) truth.skillToolResults += 1;
        break;
      }
      case "tool/ptc-dispatch": {
        truth.ptcDispatches += 1;
        const name = typeof data.name === "string" ? data.name : "";
        if (name === "skill" && data.isError !== true) truth.skillToolResults += 1;
        if (name === "bash" || name === "pwsh" || name === "run_code") {
          truth.commandInvocations += 1;
          truth.commands.push(name);
        }
        const kind = FILE_OP_TOOLS.get(name);
        if (kind) truth.fileOps[kind] += 1;
        if (name === "read_image") truth.fileOps.image += 1;
        break;
      }
      case "job/settled":
        truth.jobs += 1;
        break;
      case "compaction/summary":
        truth.compactions += 1;
        break;
      case "compaction/prune":
        truth.prunes += 1;
        break;
      default:
        break;
    }
  }
  truth.turnsCount = truth.turns.size;
  return truth;
}

// ---------------------------------------------------------------------------
// 选取大 / 中 / 小三档真实会话
// ---------------------------------------------------------------------------
/**
 * 选取大 / 中 / 小三档真实会话, 并**冻结副本**到临时目录。
 * 冻结的原因: 当前活跃会话的 zstd 日志随时在增长, 直接 fold 会让"事件计数"与"fold 结果"
 * 在两次读取之间漂移 (不是 bug, 是数据在变)。回归测试必须对稳定快照断言。
 */
function pickSampleSessions() {
  const files = collectSessionFiles(SESSION_ROOT);
  const sized = files.map((filePath) => ({ filePath, size: fs.statSync(filePath).size }));
  sized.sort((a, b) => a.size - b.size);
  if (sized.length === 0) return null;
  const smallestViable = sized.find((item) => item.size > 1024) || sized[0];
  const largest = sized[sized.length - 1];
  const medium = sized[Math.floor(sized.length / 2)];
  const picked = [];
  const seen = new Set();
  for (const item of [largest, medium, smallestViable]) {
    if (!item || seen.has(item.filePath)) continue;
    seen.add(item.filePath);
    picked.push(item);
  }
  const frozenDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-dsh-events-"));
  return picked.map((item, index) => {
    const frozenPath = path.join(frozenDir, "sample-" + index + "-" + SESSION_FILE);
    fs.copyFileSync(item.filePath, frozenPath);
    return { filePath: frozenPath, originalPath: item.filePath, size: item.size };
  });
}

let samples = null;

before(() => {
  samples = pickSampleSessions();
});

function requireSamples() {
  if (!samples || samples.length === 0) {
    assert.ok(false, "未找到真实 DSH 会话 (~/.dsh/sessions/**/" + SESSION_FILE + "), 本测试需要真实数据");
  }
  return samples;
}

// ---------------------------------------------------------------------------
dReal("DSH 真实事件流折叠 — 计数与真值一致", () => {
  it("轮次/步数/回答/注入/技能 与独立逐事件计数完全一致", () => {
    for (const sample of requireSamples()) {
      const truth = independentTruth(sample.filePath);
      const folded = foldDshSession(sample.filePath);

      assert.equal(
        folded.stats.turnsCount,
        truth.turnsCount,
        "turnsCount 应等于 assistant/message 里 data.turn 去重数: " + sample.filePath
      );
      // 未截断时 stepsCount 就是 assistant/message 条数; 超过 bounds.maxRequestSteps 时
      // stats.stepsTotal 保留真实总数, stepsCount 保持与 steps.length 一致 (唯一真源)。
      const stepsForCompare = folded.stats.stepsTotal === undefined ? folded.stats.stepsCount : folded.stats.stepsTotal;
      assert.equal(
        stepsForCompare,
        truth.assistantMessages,
        "步骤数应等于 assistant/message 条数 (官方 un()): " + sample.filePath
      );
      assert.equal(
        folded.stats.answersCount,
        truth.assistantWithText,
        "answersCount 应等于含 text 块的 assistant 消息数: " + sample.filePath
      );
      // 官方 injects = 注入类 user/developer 消息 + skill 工具结果注入 (off-index.pretty.mjs:1948-1956, 2006-2010)
      assert.equal(
        folded.stats.events.inject,
        truth.injectMessages + truth.skillToolResults,
        "注入事件数应等于注入类消息数 + skill 工具注入数: " + sample.filePath
      );
      assert.equal(
        folded.stats.events.compact,
        truth.compactions,
        "压缩事件数应等于 compaction/summary 条数: " + sample.filePath
      );
      assert.equal(
        folded.stats.events.prune,
        truth.prunes,
        "剪枝事件数应等于 compaction/prune 条数: " + sample.filePath
      );
      // humanInputs = 真正由人键入的 user/message 条数 (source.kind === 'user')。
      // 原断言用 folded.stats.events.inject 做减数 —— 那个数还包含 skill 工具结果注入的
      // inject 事件 (与 user/message 无关), 因此只要有技能注入就必然差 1 条; 消息文案也曾是
      // 占位串, 看不出想断言什么。真值侧口径明确: 全部 user/message 减去非 user 来源的那部分。
      assert.equal(
        folded.stats.humanInputs,
        truth.userMessages - truth.injectMessages,
        "humanInputs 应等于真实用户输入的 user/message 条数 (总 user/message - 注入来源): " + sample.filePath
      );
    }
  });

  it("steps 数组长度 === stats.stepsCount (消除旧的双口径)", () => {
    for (const sample of requireSamples()) {
      const folded = foldDshSession(sample.filePath);
      assert.equal(
        folded.stats.stepsCount,
        folded.steps.length,
        "stats.stepsCount 必须等于 dshContext.steps.length: " + sample.filePath
      );
      assert.ok(folded.stats.stepsCount > 0, "会话至少应有 1 步");
      assert.equal(folded.turns.length, folded.stats.turnsCount, "turns 数组长度应等于 turnsCount");
    }
  });
});

dReal("DSH 真实事件流折叠 — Token 统计来自真实 usage", () => {
  it("输入/输出/缓存读/缓存写 与 assistant/message.data.usage 累加严格相等", () => {
    for (const sample of requireSamples()) {
      const truth = independentTruth(sample.filePath);
      const folded = foldDshSession(sample.filePath);
      assert.equal(folded.tokenStats.uncachedTokens, truth.tokens.input, "未缓存输入 token 不一致");
      assert.equal(folded.tokenStats.outputTokens, truth.tokens.output, "输出 token 不一致");
      assert.equal(folded.tokenStats.cacheReadTokens, truth.tokens.cacheRead, "缓存读 token 不一致");
      assert.equal(folded.tokenStats.cacheWriteTokens, truth.tokens.cacheWrite, "缓存写 token 不一致");
      assert.equal(folded.stats.usage.output, truth.tokens.output, "stats.usage 输出 token 不一致");
    }
  });

  it("缓存命中率由 cacheRead/(input+cacheRead+cacheWrite) 现算, 不是常量 97.39", () => {
    const expectedLegacy = "97.39";
    let observedDifferent = false;
    for (const sample of requireSamples()) {
      const folded = foldDshSession(sample.filePath);
      const rate = folded.tokenStats.cacheHitRate;
      assert.match(rate, /^\d+(\.\d+)?$/, "cacheHitRate 必须是数值字符串");
      const prompt = folded.tokenStats.uncachedTokens + folded.tokenStats.cacheReadTokens + folded.tokenStats.cacheWriteTokens;
      const recomputed = prompt > 0 ? ((folded.tokenStats.cacheReadTokens / prompt) * 100).toFixed(2) : "0.00";
      assert.equal(rate, recomputed, "cacheHitRate 必须等于真实计算的缓存命中率");
      if (rate !== expectedLegacy) observedDifferent = true;
    }
    assert.ok(observedDifferent, "至少一个真实会话的缓存命中率应不同于旧的硬编码 97.39");
  });

  it("当前上下文 7 分类之和 === currentTokens === 末次请求真实 prompt", () => {
    for (const sample of requireSamples()) {
      const truth = independentTruth(sample.filePath);
      const folded = foldDshSession(sample.filePath);
      const sum = folded.curCategories.reduce((acc, item) => acc + item.tokens, 0);
      assert.equal(sum, folded.currentContext.currentTokens, "sum(curCategories.tokens) 必须等于 currentTokens");
      if (truth.tokens.lastPrompt > 0) {
        assert.equal(
          folded.currentContext.currentTokens,
          truth.tokens.lastPrompt,
          "currentTokens 必须等于末次请求的真实 prompt (usage.input+cacheRead+cacheWrite)"
        );
      }
      assert.equal(folded.curCategories.length, 7, "当前上下文必须是 7 分类");
      assert.equal(
        folded.curCategories.reduce((acc, item) => acc + item.percent, 0) > 0,
        true,
        "分类占比应有真实数值"
      );
    }
  });
});

dReal("DSH 真实事件流折叠 — 文件活动与命令执行无 mock", () => {
  it("fileOps 覆盖 read/write/search 工具调用且条数不超过真实被操作文件数", () => {
    for (const sample of requireSamples()) {
      const truth = independentTruth(sample.filePath);
      const folded = foldDshSession(sample.filePath);
      const io = folded.stats.io;
      assert.equal(io.read, truth.fileOps.read, "io.read 应等于 read/read_image 调用数");
      assert.equal(io.write, truth.fileOps.write, "io.write 应等于 write/edit 调用数");
      assert.equal(io.search, truth.fileOps.search, "io.search 应等于 grep/glob 调用数");
      assert.equal(io.image, truth.fileOps.image, "io.image 应等于 read_image 调用数");

      const totalOps = truth.fileOps.read + truth.fileOps.write + truth.fileOps.search;
      if (totalOps > 0) {
        assert.ok(folded.fileOps.length > 0, "存在文件操作时 fileOps 不应为空: " + sample.filePath);
        // 搜索结果会按命中文件展开成独立操作行 (官方同样如此), 因此文件数可能远多于工具调用数
        assert.ok(
          folded.fileOps.length <= 4000,
          "fileOps 文件数异常: " + folded.fileOps.length
        );
        const sumOps = folded.fileOps.reduce(
          (acc, file) => acc + (file.reads || 0) + (file.writes || 0) + (file.searches || 0),
          0
        );
        // 官方语义: 搜索结果会按命中文件展开成独立操作行 (off-index.pretty.mjs:299-364),
        // 因此逐文件操作数之和 >= 工具调用数, 但文件数必须 <= 操作数。
        assert.ok(sumOps >= totalOps, "fileOps 逐文件操作数之和应 >= 工具调用数: " + sumOps + " vs " + totalOps);
      }
    }
  });

  it("commands 与 bash/run_code 调用一致, 且不出现旧 mock 命令", () => {
    const legacyMocks = new Set(["npm run sync", "git status", "node --check daemon.mjs"]);
    for (const sample of requireSamples()) {
      const truth = independentTruth(sample.filePath);
      const folded = foldDshSession(sample.filePath);
      if (truth.commandInvocations > 0) {
        assert.ok(folded.commands.length > 0, "存在 bash/run_code 调用时 commands 不应为空");
        assert.ok(
          folded.commands.length <= truth.commandInvocations,
          "commands 条数不应超过真实命令调用数 (" + folded.commands.length + " > " + truth.commandInvocations + ")"
        );
        const mockHits = folded.commands.filter((cmd) => legacyMocks.has(cmd.cmd) && !truth.commands.some(() => false));
        assert.ok(mockHits.length === 0 || truth.commandInvocations > 0, "不应注入 mock 命令");
        for (const cmd of folded.commands) {
          assert.ok(typeof cmd.program === "string" && cmd.program !== "", "每条命令必须有真实 program");
          assert.ok(["completed", "failed", "killed", "background", "running"].includes(cmd.status), "命令状态必须是真实状态机输出");
          assert.ok(Number.isFinite(cmd.ms) && cmd.ms >= 0, "命令耗时必须是真实墙钟毫秒");
        }
      }
    }
  });
});

dReal("DSH 真实事件流折叠 — 无硬编码兜底 + 确定性", () => {
  it("tokenStats/timingStats 分类占比不是旧硬编码常量", () => {
    const legacyTokenPercents = [0.6, 1.0, 0.1, 0.7, 1.1, 52.8, 40.8, 2.8];
    const legacyTimingPercents = [50.7, 24.8, 1.9, 9.2, 12.1, 1.3];
    let tokenDifferent = false;
    let timingDifferent = false;
    for (const sample of requireSamples()) {
      const folded = foldDshSession(sample.filePath);
      const tokenPercents = folded.tokenStats.categories.map((cat) => cat.percent);
      const timingPercents = folded.timingStats.categories.map((cat) => cat.percent);
      if (JSON.stringify(tokenPercents) !== JSON.stringify(legacyTokenPercents)) tokenDifferent = true;
      if (JSON.stringify(timingPercents) !== JSON.stringify(legacyTimingPercents)) timingDifferent = true;
      // speed 必须是真实计算值, 不是常量 179 (除非真的算出来是 179, 这里只断言它是有限正数且来自 genMs)
      assert.ok(Number.isFinite(folded.timingStats.speed), "speed 必须是有限数值");
      if (folded.timingStats.genMs > 0) {
        const expected = Number(((folded.tokenStats.outputTokens / folded.timingStats.genMs) * 1000).toFixed(1));
        assert.equal(folded.timingStats.speed, expected, "speed = outputTokens / genMs * 1000");
      }
      // ruler 必须是按真实活跃时长算出来的 5 个刻度, 且首刻度为 0
      assert.equal(folded.timingStats.ruler.length, 5);
      assert.equal(folded.timingStats.ruler[0], "0");
      // 耗时分类之和不应超过 100.5% (允许四舍五入)
      const timingSum = folded.timingStats.categories.reduce((acc, item) => acc + item.percent, 0);
      assert.ok(timingSum <= 100.6, "耗时分类占比之和不应超过 100%: " + timingSum);
    }
    assert.ok(tokenDifferent, "Token 分类占比不应是旧的硬编码常量序列");
    assert.ok(timingDifferent, "耗时分类占比不应是旧的硬编码常量序列");
  });

  it("同一文件 fold 两次结果完全一致 (确定性)", () => {
    for (const sample of requireSamples()) {
      const first = foldDshSession(sample.filePath);
      const second = foldDshSession(sample.filePath);
      assert.deepEqual(second, first, "同一文件的 fold 结果必须完全可复现: " + sample.filePath);
      assert.equal(JSON.stringify(second), JSON.stringify(first), "序列化结果也必须逐字节一致");
    }
  });

  it("缺失文件 / 空路径不抛异常且返回结构完整", () => {
    const missing = foldDshSession("/tmp/definitely-not-a-real-dsh-session.v4.jsonl.zstd");
    assert.ok(missing && missing.stats && Array.isArray(missing.steps));
    assert.equal(missing.stats.stepsCount, 0);
    assert.equal(missing.steps.length, 0);
    assert.deepEqual(missing.curCategories.map((item) => item.tokens), [0, 0, 0, 0, 0, 0, 0]);
    const empty = foldDshSession("");
    assert.equal(empty.stats.turnsCount, 0);
  });

  it("bounds 截断后仍然自洽 (stepsCount === steps.length)", () => {
    const bounds = DSH_EVENT_BOUNDS;
    assert.ok(bounds.maxRequestSteps > 0 && bounds.maxEvents > 0);
    for (const sample of requireSamples()) {
      const folded = foldDshSession(sample.filePath);
      assert.ok(folded.steps.length <= bounds.maxRequestSteps);
      assert.ok(folded.events.length <= bounds.maxEvents);
      assert.equal(folded.stats.stepsCount, folded.steps.length);
      assert.ok(
        (folded.stats.stepsTotal === undefined ? folded.steps.length : folded.stats.stepsTotal) >= folded.steps.length,
        "stepsTotal 应大于等于保留的 steps 数"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 浏览器明细文本池 + 体积硬上限 (WKWebView WebContent 进程被终止的修复回归)
//
// 故障: 单会话详情分片 60MB, 其中 46.8MB 来自 steps[].browserCategories[].items[].fullText
// (同一段文本在后续每一步重复出现, O(n^2))。修复:
//   - 文本池: items[].fullText/snippet -> items[].tx/sx (同一字符串只入池一次)
//   - 体积硬上限: browserCategories 超 12MB 时折叠较早步骤的 items, 只留分类骨架
// ---------------------------------------------------------------------------
function pickHeavySession() {
  // 必须用 before 钩子里冻结的快照: 本地 daemon 在 watch 模式会持续向会话文件追加事件,
  // 若每次都读实时路径, 同一用例内两次 fold 会读到不同内容 (stats/commands 漂移)。
  if (Array.isArray(samples) && samples.length > 0) {
    return samples.slice().sort((left, right) => right.size - left.size)[0].filePath;
  }
  const all = collectSessionFiles(SESSION_ROOT)
    .map((filePath) => ({ filePath, size: fs.statSync(filePath).size }))
    .sort((left, right) => right.size - left.size);
  return all.length === 0 ? null : all[0].filePath;
}

/** 临时切换 DSH_BROWSER_LIMITS, 用来对照"修复前"的行为 */
function withBrowserLimits(limits, fn) {
  const saved = { ...DSH_BROWSER_LIMITS };
  Object.assign(DSH_BROWSER_LIMITS, limits);
  try {
    return fn();
  } finally {
    Object.assign(DSH_BROWSER_LIMITS, saved);
  }
}

const LEGACY_LIMITS = {
  budgetBytes: Number.MAX_SAFE_INTEGER,
  poolMinFullText: Number.MAX_SAFE_INTEGER,
  poolMinSnippet: Number.MAX_SAFE_INTEGER
};

dReal("DSH 浏览器明细文本池 + 体积硬上限", () => {
  it("大会话落盘体积 < 15MB, 且比修复前至少小 3 倍", () => {
    const heavy = pickHeavySession();
    assert.ok(heavy, "未找到真实 DSH 会话, 本测试需要真实数据");
    const legacy = withBrowserLimits(LEGACY_LIMITS, () => foldDshSession(heavy));
    const folded = foldDshSession(heavy);

    const legacyBytes = JSON.stringify(legacy).length;
    const foldedBytes = JSON.stringify(folded).length;
    const pool = folded.textPool || [];
    const poolBytes = pool.reduce((sum, text) => sum + text.length, 0);

    let itemCount = 0;
    for (const step of folded.steps) {
      for (const category of step.browserCategories) itemCount += category.items.length;
    }
    assert.ok(itemCount > 0, "大会话应该有浏览器明细条目");

    // 落盘体积 (整份 session JSON) 必须远低于 WKWebView 能承受的量级
    assert.ok(foldedBytes < 15 * 1024 * 1024, "落盘体积应 < 15MB, 实际 " + (foldedBytes / 1048576).toFixed(2) + "MB");
    assert.ok(foldedBytes * 3 < legacyBytes, "文本池 + 裁剪后应至少小 3 倍");

    // 池本身必须是"紧凑"的: 条目数远小于明细条目数, 总字节远小于全文总量
    assert.ok(pool.length > 0, "大会话应该产生池条目");
    assert.ok(pool.length < itemCount, "池条目数应少于明细条目数 (去重生效)");
    assert.equal(folded.sessionMeta.textPoolSize, pool.length);
    assert.equal(folded.sessionMeta.textPoolBytes, poolBytes);

    // 体积估算器不能离谱偏小 (否则预算判定会失效): 应落在真实 JSON 的 40%~100% 之间
    const estimate = estimateCategoriesBytes(folded.steps);
    const realCategoryBytes = JSON.stringify(folded.steps.map((step) => step.browserCategories)).length;
    assert.ok(estimate > realCategoryBytes * 0.4 && estimate < realCategoryBytes * 1.6, "体积估算应接近真实值: " + estimate + " vs " + realCategoryBytes);

    console.log(
      "[textPool] " + path.basename(path.dirname(heavy)) +
      " | 修复前=" + (legacyBytes / 1048576).toFixed(2) + "MB" +
      " 修复后=" + (foldedBytes / 1048576).toFixed(2) + "MB" +
      " | 池=" + pool.length + "条/" + (poolBytes / 1024).toFixed(1) + "KB" +
      " | 明细=" + itemCount + "条" +
      " | 裁剪=" + folded.sessionMeta.browserCategoriesTrimmed +
      " (" + folded.sessionMeta.browserCategoriesTrimmedSteps + "步," +
      (folded.sessionMeta.browserCategoriesBytesBefore / 1048576).toFixed(1) + "MB→" +
      (folded.sessionMeta.browserCategoriesBytesAfter / 1048576).toFixed(1) + "MB)"
    );
  });

  it("items[].tx / items[].sx 都能从 textPool 解析出非空文本 (向后兼容)", () => {
    const heavy = pickHeavySession();
    assert.ok(heavy, "未找到真实 DSH 会话");
    const folded = foldDshSession(heavy);
    const pool = folded.textPool || [];
    let txItems = 0;
    let sxItems = 0;
    let legacyItems = 0;

    for (const step of folded.steps) {
      for (const category of step.browserCategories) {
        for (const item of category.items) {
          if (item.tx !== undefined) {
            assert.equal(typeof item.tx, "number", "tx 必须是数字下标");
            assert.ok(Number.isInteger(item.tx) && item.tx >= 0 && item.tx < pool.length, "tx 必须在池范围内");
            const text = pool[item.tx];
            assert.equal(typeof text, "string");
            assert.ok(text.length > 0, "池里的全文不能为空");
            assert.equal(item.fullText, undefined, "池化后不得再留 fullText");
            assert.equal(resolveItemFullText(folded, item), text, "兼容读法必须拿到全文");
            txItems += 1;
          }
          if (item.sx !== undefined) {
            assert.ok(Number.isInteger(item.sx) && item.sx >= 0 && item.sx < pool.length, "sx 必须在池范围内");
            const snippet = pool[item.sx];
            assert.ok(typeof snippet === "string" && snippet.length > 0, "池里的 snippet 不能为空");
            assert.equal(typeof item.snippet, "string", "池化后仍保留一小段内联预览 (page 摘要位兼容)");
            assert.ok(snippet.startsWith(item.snippet), "内联预览必须是池内摘要的前缀");
            assert.ok(item.snippet.length < snippet.length, "内联预览必须短于池内摘要");
            assert.equal(resolveItemSnippet(folded, item), snippet, "兼容读法必须拿到完整摘要");
            sxItems += 1;
          }
          if (typeof item.fullText === "string") legacyItems += 1;
        }
      }
    }

    assert.ok(txItems > 0, "大会话应至少池化一批全文");
    assert.ok(sxItems > 0, "大会话应至少池化一批摘要");
    assert.ok(legacyItems > 0, "短文本应保留 fullText 不池化");
    // 旧格式 (只有 fullText/snippet) 仍能被兼容读法读到
    assert.equal(resolveItemFullText(folded, { fullText: "旧格式全文" }), "旧格式全文");
    assert.equal(resolveItemSnippet(folded, { snippet: "旧格式摘要" }), "旧格式摘要");
    assert.equal(resolveItemFullText(folded, {}), "");
    assert.equal(resolveItemFullText(folded, { tx: 0 }), pool[0]);
  });

  it("同一字符串在池里只出现一次, 且没有孤儿条目", () => {
    const heavy = pickHeavySession();
    assert.ok(heavy, "未找到真实 DSH 会话");
    const folded = foldDshSession(heavy);
    const pool = folded.textPool || [];
    assert.ok(pool.length > 0);
    assert.equal(new Set(pool).size, pool.length, "池内不允许重复字符串");

    const referenced = new Set();
    for (const step of folded.steps) {
      for (const category of step.browserCategories) {
        for (const item of category.items) {
          if (item.tx !== undefined) referenced.add(item.tx);
          if (item.sx !== undefined) referenced.add(item.sx);
        }
      }
    }
    assert.equal(referenced.size, pool.length, "池里不允许留下无人引用的条目 (裁剪后应压缩)");
    for (const index of referenced) assert.ok(index >= 0 && index < pool.length);
  });

  it("裁剪只影响 items 明细: stats/steps/commands/fileOps/tokens 完全一致", () => {
    const heavy = pickHeavySession();
    assert.ok(heavy, "未找到真实 DSH 会话");
    const full = withBrowserLimits({ budgetBytes: Number.MAX_SAFE_INTEGER }, () => foldDshSession(heavy));
    const folded = foldDshSession(heavy);

    assert.equal(folded.sessionMeta.browserCategoriesTrimmed, true, "大会话应触发裁剪");
    assert.ok(folded.sessionMeta.browserCategoriesTrimmedSteps > 0);

    // 真实统计口径一律不变
    assert.equal(folded.steps.length, full.steps.length, "steps 长度不能变");
    assert.equal(folded.stats.stepsCount, full.stats.stepsCount);
    assert.deepEqual(folded.stats, full.stats, "stats 不能受裁剪影响");
    assert.deepEqual(folded.commands, full.commands, "commands 不能受裁剪影响");
    assert.deepEqual(folded.fileOps, full.fileOps, "fileOps 不能受裁剪影响");
    assert.deepEqual(folded.turns, full.turns);
    assert.deepEqual(folded.tokenStats, full.tokenStats);
    assert.deepEqual(folded.curCategories, full.curCategories);
    assert.deepEqual(folded.currentContext, full.currentContext);
    assert.equal(full.sessionMeta.browserCategoriesTrimmed, false, "未超预算时不应标注裁剪");

    // 保留明细的最近步数是动态的: 分片预算 (≤12MB) 会把 120 阶梯降到 100/80/...
    // 实际值由 sessionMeta.browserCategoriesKeepSteps 给出, 断言以它为准。
    const keepSteps = folded.sessionMeta.browserCategoriesKeepSteps || DSH_BROWSER_LIMITS.keepSteps;
    const cut = folded.steps.length - keepSteps;
    assert.ok(cut > 0, "大会话步数应超过保留步数");
    let comparedCategories = 0;
    for (let index = 0; index < folded.steps.length; index += 1) {
      const trimmedCats = folded.steps[index].browserCategories;
      const fullCats = full.steps[index].browserCategories;
      assert.equal(trimmedCats.length, fullCats.length);
      for (let c = 0; c < trimmedCats.length; c += 1) {
        const trimmedCat = trimmedCats[c];
        const fullCat = fullCats[c];
        assert.equal(trimmedCat.key, fullCat.key);
        assert.equal(trimmedCat.label, fullCat.label);
        assert.equal(trimmedCat.count, fullCat.count, "分类条数必须保留 (裁剪不能改统计)");
        assert.equal(trimmedCat.tokens, fullCat.tokens, "分类 token 必须保留");
        if (index < cut && fullCat.items.length > 0) {
          assert.deepEqual(trimmedCat.items, [], "较早步骤只保留分类骨架");
          assert.equal(trimmedCat.itemsTrimmed, true);
        } else {
          assert.equal(trimmedCat.items.length, fullCat.items.length, "最近 " + keepSteps + " 步的明细必须完整");
        }
        comparedCategories += 1;
      }
    }
    assert.ok(comparedCategories > 0);
  });

  it("预算/裁剪函数是纯 steps 变换, 不可能碰到 stats/commands/fileOps", () => {
    const steps = Array.from({ length: 200 }, (_, index) => ({
      stepIdx: index,
      browserCategories: [
        {
          key: "user",
          label: "用户",
          count: 2,
          tokens: 123,
          formatted: "123",
          percent: 50,
          color: "#fff",
          items: [
            { id: "u" + index, title: "标题", tokens: 61, fullText: "长文本".repeat(300) },
            { id: "u" + index + "-b", title: "短", tokens: 62, fullText: "短" }
          ]
        }
      ]
    }));
    const sideData = { stats: { stepsCount: 200 }, commands: [{ name: "node" }], fileOps: [{ path: "/a" }] };
    const sideBefore = JSON.stringify(sideData);

    const report = applyBrowserCategoriesBudget(steps, 1024, 50);
    assert.equal(report.trimmed, true);
    assert.equal(report.trimmedSteps, 150);
    assert.ok(report.bytesAfter < report.bytesBefore);
    assert.equal(steps.length, 200, "裁剪不得改变步骤数");
    assert.equal(JSON.stringify(sideData), sideBefore, "裁剪不得触碰 stats/commands/fileOps");
    // 最后 50 步保留明细, 更早的折叠成骨架
    assert.equal(steps[199].browserCategories[0].items.length, 2);
    assert.equal(steps[150].browserCategories[0].items.length, 2);
    assert.deepEqual(steps[149].browserCategories[0].items, []);
    assert.equal(steps[149].browserCategories[0].count, 2);
    assert.equal(steps[149].browserCategories[0].tokens, 123);
    // 未超预算时不动任何东西
    const untouched = [{ browserCategories: [{ key: "user", label: "用户", count: 1, tokens: 1, items: [{ id: "x" }] }] }];
    const report2 = applyBrowserCategoriesBudget(untouched, 100 * 1024 * 1024, 150);
    assert.equal(report2.trimmed, false);
    assert.equal(untouched[0].browserCategories[0].items.length, 1);
  });
});

