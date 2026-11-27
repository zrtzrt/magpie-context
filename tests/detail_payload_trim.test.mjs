// tests/detail_payload_trim.test.mjs
// 回归: 大会话详情分片超 12MB 预算时, 旧实现会把**所有步骤所有分类**的 items 清空,
// 且不设 itemsTrimmed —— 页面于是每格都显示「该分类在此步骤有 N 项，但未保留独立条目明细」。
//
// 真实案例: 1500 步的 DSH 会话 30.4MB, items=all 后仍有 30.1MB ——
// 说明裁剪顺序错了: 体积主因是 turns 里的 fullText/thinking/blocks, 不是条目明细。
//
// 本测试锁定三条契约:
//   1. 裁剪后必须 ≤ 12MB (WKWebView 内存上限)
//   2. 最近 40 步必须保留真实条目 (用户当前正在看的步骤要能看到明细)
//   3. 任何 items 为空且 count>0 的分类, 必须显式 itemsTrimmed=true (不许静默丢失)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDaemon } from "./helpers/daemon_harness.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LIMIT = 12 * 1024 * 1024;
const CATEGORY_KEYS = ["system", "tools", "user", "inject", "skill", "assistant", "tool"];

function makeCategory(key, stepNo) {
  return {
    key, label: key, name: key, count: 5, tokens: 1000, formatted: "1.0k", percent: 14, color: "#000000",
    items: Array.from({ length: 5 }, (_, j) => ({
      id: key + ":" + stepNo + ":" + j,
      idx: j + 1,
      title: key + " item " + j,
      snippet: "snippet " + key + " " + stepNo + " " + j,
      toolName: key,
      tokens: 200,
      diff: "0",
      fullText: "FULLTEXT " + key + " step " + stepNo + " item " + j + " " + "x".repeat(2000)
    }))
  };
}

function makeSession(options = {}) {
  const steps = options.steps === undefined ? 1500 : options.steps;
  const turns = options.turns === undefined ? 1500 : options.turns;
  const msgsPerTurn = options.msgsPerTurn === undefined ? 6 : options.msgsPerTurn;
  const dshSteps = [];
  for (let i = 0; i < steps; i += 1) {
    dshSteps.push({
      stepIdx: i + 1, turnIdx: i + 1, stepInTurn: 1, totalStepsInTurn: 1,
      time: 1794469443975, timestamp: "12:00:00", totalTokens: 5000, tokenDelta: 10,
      promptTokens: 5000, outputTokens: 10, cacheHit: null, durationSec: 1, durationFormatted: "1s",
      userSnippet: "u".repeat(200), inputSnippet: "bash",
      breakdown: { system: 1000, tools: 1000, user: 1000, inject: 500, skill: 500, assistant: 500, tool: 500 },
      browserCategories: CATEGORY_KEYS.map((key) => makeCategory(key, i)),
      dnaBands: Array.from({ length: 20 }, (_, j) => ({
        key: "band-" + j, cat: "tool", color: "#000000", title: "band " + j, tokens: 10,
        toolName: "bash", off: j, turnIdx: i + 1, stepIdx: i + 1, time: "12:00:00"
      })),
      thinking: "t".repeat(200), toolCalls: ["bash"], isError: false, exitCode: null
    });
  }
  const turnList = [];
  for (let i = 0; i < turns; i += 1) {
    turnList.push({
      turnIdx: i + 1, time: 1794469443975, timestamp: "12:00:00", totalTokens: 5000, tokenDelta: 10,
      userText: "USER " + i,
      messages: Array.from({ length: msgsPerTurn }, (_, j) => ({
        idx: j,
        role: j === 0 ? "user" : "assistant",
        cat: j === 0 ? "user" : "assistant",
        tokens: 500, chars: 100, snippet: "snippet " + i + " " + j,
        fullText: "F".repeat(3000), thinking: "T".repeat(1000),
        blocks: Array.from({ length: 5 }, (_, k) => ({ type: "text", text: "B".repeat(500) }))
      }))
    });
  }
  return {
    id: "synthetic-big", name: "合成大会话", agent: "dsh", agentName: "DSH",
    cwd: "/tmp", model: "deepseek-chat", modelLimit: 131072,
    currentTokens: 5000, peakTokens: 5000, turnsCount: turns,
    turns: turnList,
    dshContext: {
      steps: dshSteps,
      turns: [],
      commands: Array.from({ length: 3000 }, (_, i) => ({
        seq: i, tool: "bash", cmd: "echo " + i, program: "echo", status: "completed", ms: 10,
        turn: 1, step: 1, time: "12:00:00", nested: false, background: false, codeMode: false,
        isError: false, outChars: 100, outTruncated: false, exitCode: 0, label: "List " + i, jobId: "bash-" + i
      })),
      sessionMeta: { commandCalls: Array.from({ length: 1024 }, (_, i) => "command-" + i), browserCategoriesKeepSteps: 120 },
      fileOps: [], events: [], stats: {}, tokenStats: {}, timingStats: {}
    }
  };
}

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("详情分片裁剪 (trimDetailPayloadInPlace)", () => {
  it("小会话不触发裁剪, 不写 payloadTrimmed", async () => {
    const daemon = await loadDaemon();
    const small = makeSession({ steps: 5, turns: 5, msgsPerTurn: 2 });
    daemon.trimDetailPayloadInPlace(small);
    assert.equal(small.dshContext.sessionMeta.payloadTrimmed, undefined);
    assert.ok((small.dshContext.steps[0].browserCategories[0].items || []).length > 0);
  });

  it("大会话裁到 12MB 以内, 且最近 40 步仍保留真实条目", async () => {
    const daemon = await loadDaemon();
    const big = makeSession();
    assert.ok(bytesOf(big) > LIMIT, "合成数据必须超过预算, 否则测试无意义");
    daemon.trimDetailPayloadInPlace(big);
    const after = bytesOf(big);
    assert.ok(after <= LIMIT, "裁剪后仍超预算: " + (after / 1048576).toFixed(1) + "MB");
    const steps = big.dshContext.steps;
    const recent = steps.slice(-40);
    for (const step of recent) {
      for (const cat of step.browserCategories) {
        assert.ok((cat.items || []).length > 0, "最近步骤不允许丢明细: " + cat.key);
      }
    }
    const last = steps[steps.length - 1];
    assert.ok(last.browserCategories[0].items[0].title.length > 0);
  });

  it("任何 items 为空且 count>0 的分类必须显式 itemsTrimmed", async () => {
    const daemon = await loadDaemon();
    const big = makeSession();
    daemon.trimDetailPayloadInPlace(big);
    let silent = 0;
    for (const step of big.dshContext.steps) {
      for (const cat of step.browserCategories) {
        if ((cat.items || []).length === 0 && Number(cat.count) > 0 && cat.itemsTrimmed !== true) {
          silent += 1;
        }
      }
    }
    assert.equal(silent, 0, "有 " + silent + " 个分类静默丢失明细 (无 itemsTrimmed)");
  });

  it("页面必须解析 textPool 池引用 (tx/sx), 否则全池化后点开条目只看到标题", () => {
    const code = fs.readFileSync(path.join(PROJECT_ROOT, "page", "app.js"), "utf8");
    assert.ok(code.includes("function resolvePooledText("), "缺少 resolvePooledText: 池化正文无法还原");
    assert.ok(code.includes("resolvePooledText(s, it.tx)"), "getBandFullText 必须先解析 item.tx");
    assert.ok(code.includes("resolvePooledText(s, it.sx)"), "snippet 兜底也必须解析 item.sx");
  });

  it("裁剪记录不再出现 items=all, 且保留最近步数被写回 sessionMeta", async () => {
    const daemon = await loadDaemon();
    const big = makeSession();
    daemon.trimDetailPayloadInPlace(big);
    const trims = big.dshContext.sessionMeta.payloadTrimmed.trims;
    assert.ok(!trims.includes("browserCategories.items=all"), "不应再整片清空: " + trims.join(","));
    assert.ok(trims.some((t) => t.indexOf("turns.messages.") === 0), "应先裁 turns 重字段");
    const keep = big.dshContext.sessionMeta.browserCategoriesKeepSteps;
    assert.ok(Number.isFinite(keep) && keep > 0 && keep <= 120);
  });
});
