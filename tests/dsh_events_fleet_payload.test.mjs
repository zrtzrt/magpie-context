// tests/dsh_events_fleet_payload.test.mjs
// ---------------------------------------------------------------------------
// 数据层回归: "看不到消息详情" + 编队/子 Agent 聚合 (dshContext.fleet) + 分片 ≤ 12MB
//
// 覆盖:
//   1. 正文上限: items[].fullText 24,000 / 系统提示词 20,000 / 工具 schema 12,000
//      超限才截断, 末尾带 "…(已截断, 原文 N 字符)", 条目带 truncated: true
//   2. textPool + tx 去重机制保持 (同一段长文本只存一份)
//   3. dshContext.fleet: subagent/catalog + team/task + team/member + team/mode,
//      stats.fleet.subCount 与真实子 Agent 数对齐 (旧实现按 name 去重导致恒 0)
//   4. 单会话详情分片真实 JSON 字节 ≤ 12MB, 超预算按 keepStepsLadder 降采样,
//      但 stats/steps 长度/命令/文件操作等统计口径不被裁剪影响
// ---------------------------------------------------------------------------
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  foldDshSession,
  clipText,
  DSH_TEXT_LIMITS,
  DSH_BROWSER_LIMITS,
  DSH_PAYLOAD_LIMITS,
  estimateCategoriesBytes,
  applyBrowserCategoriesBudget,
  foldItemsOlderThan,
  resolveItemFullText
} from "../dsh-events.mjs";

// ---------------------------------------------------------------------------
// 会话夹具: 真实 DSH 会话格式 (zstd 压缩的 JSONL, {type, seq, time, data})
// ---------------------------------------------------------------------------
const tempDirs = [];

function writeDshSession(events, meta = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-dsh-payload-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "session.v4.jsonl.zstd");
  const raw = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  fs.writeFileSync(filePath, zlib.zstdCompressSync(Buffer.from(raw, "utf8")));
  return { filePath, meta };
}

function eventBuilder() {
  let seq = 0;
  return (type, data) => ({ type, seq: (seq += 1), time: 1700000000000 + seq, data });
}

/** 取条目正文 (支持池化后的 tx) */
function itemText(session, item) {
  return resolveItemFullText(session, item);
}

function lastStep(session) {
  return session.steps[session.steps.length - 1] || {};
}

function categoryOf(step, key) {
  return (step.browserCategories || []).find((cat) => cat.key === key) || { items: [] };
}

/** 一个最小但完整的单步会话: 系统提示词 + 用户消息 + 工具调用/结果 + 助手回复 */
function singleStepSession(options = {}) {
  const ev = eventBuilder();
  const systemText = options.systemText || "S".repeat(36000);
  const userText = options.userText || "U".repeat(4000);
  const toolText = options.toolText || "T".repeat(30000);
  const tools = options.tools || [
    { name: "run_code", description: "D".repeat(20000), parameters: { type: "object" } },
    { name: "read", description: "read file", parameters: { type: "object" } }
  ];
  const events = [
    ev("session", { cwd: "/tmp", title: "fixture" }),
    ev("request/header", { header: { tools, config: { provider: "p", model: "m", maxTokens: 8 } }, reason: "initial" }),
    ev("system/message", { message: { role: "system", content: [{ type: "text", text: systemText }] } }),
    ev("turn/start", { turn: 1 }),
    // 真实 DSH user/message: content 在 data 顶层 (不是 data.message)
    ev("user/message", { turn: 1, step: 1, content: [{ type: "text", text: userText }] }),
    ev("step/start", { turn: 1, step: 1 }),
    ev("tool/call", { callId: "c1", name: "read", arguments: "{\"file_path\":\"/tmp/a\"}" }),
    ev("tool/result", { callId: "c1", message: { role: "tool", content: [{ type: "text", text: toolText }] } }),
    ev("assistant/message", {
      turn: 1,
      step: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 },
      message: { role: "assistant", content: [{ type: "text", text: "done" }] }
    }),
    ev("step/end", { turn: 1, step: 1 }),
    ev("turn/end", { turn: 1 })
  ];
  return writeDshSession(events, { id: "sess-limits", sessionId: "sess-limits" });
}

describe("条目正文上限 — 修复『看不到消息详情』", () => {
  it("上限常量: fullText 24,000 / 系统提示词 20,000 / schema 12,000", () => {
    assert.equal(DSH_TEXT_LIMITS.itemFullText, 24000);
    assert.equal(DSH_TEXT_LIMITS.systemSummary, 20000);
    assert.equal(DSH_TEXT_LIMITS.schemaText, 12000);
    // 旧实现是 400/160/800, 这里必须严格大于旧值, 否则等于没修
    assert.ok(DSH_TEXT_LIMITS.itemFullText > 800);
    assert.ok(DSH_TEXT_LIMITS.systemSummary > 400);
    assert.ok(DSH_TEXT_LIMITS.schemaText > 800);
  });

  it("clipText: 未超限原样返回, 超限才追加『…(已截断, 原文 N 字符)』", () => {
    assert.deepEqual(clipText("短文本", 100), { text: "短文本", truncated: false, originalChars: 3 });
    const clipped = clipText("x".repeat(120), 100);
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.originalChars, 120);
    assert.equal(clipped.text.length, 100 + "…(已截断, 原文 120 字符)".length);
    assert.ok(clipped.text.startsWith("x".repeat(100)));
    assert.ok(clipped.text.endsWith("…(已截断, 原文 120 字符)"));
    assert.equal(clipText("", 100).truncated, false);
    assert.equal(clipText(undefined, 100).text, "");
  });

  it("系统提示词: 保留 20,000 字符全文, 超过才截断并标注原文长度", () => {
    const fixture = singleStepSession({ systemText: "S".repeat(36000) });
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    const systemItem = categoryOf(lastStep(folded), "system").items[0];
    assert.ok(systemItem, "系统提示词条目必须存在");
    const text = itemText(folded, systemItem);
    assert.ok(text.length > 20000, "系统提示词正文应远长于旧的 400 字符");
    assert.equal(systemItem.truncated, true);
    assert.ok(text.endsWith("…(已截断, 原文 36000 字符)"));
    // 未超限的系统提示词 (旧实现也会被砍) 现在应完整保留
    const small = singleStepSession({ systemText: "系统提示词".repeat(1000) }); // 5,000 字符
    const smallFolded = foldDshSession(small.filePath, small.meta);
    const smallItem = categoryOf(lastStep(smallFolded), "system").items[0];
    assert.equal(itemText(smallFolded, smallItem), "系统提示词".repeat(1000));
    assert.equal(smallItem.truncated, undefined, "未超限不应标 truncated");
  });

  it("工具 schema: 上限 12,000 字符, 短 schema 不截断", () => {
    const fixture = singleStepSession();
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    const items = categoryOf(lastStep(folded), "tools").items;
    const big = items.find((item) => item.title === "run_code");
    const small = items.find((item) => item.title === "read");
    assert.ok(big && small, "两个工具的明细都要在");
    const bigText = itemText(folded, big);
    assert.ok(bigText.length > 800, "旧实现只留 800 字符");
    assert.equal(big.truncated, true);
    // 原文长度 = 完整 schema JSON 的字符数 (截断标注里写的就是它)
    const schemaChars = folded.sessionMeta.textTruncation.truncatedTools === 1
      ? bigText.match(/…\(已截断, 原文 (\d+) 字符\)$/)[1]
      : "0";
    assert.equal(bigText.endsWith("…(已截断, 原文 " + schemaChars + " 字符)"), true);
    assert.ok(!small.truncated, "短 schema 不应被标记截断");
    assert.ok(itemText(folded, small).startsWith("{\"name\":\"read\""));
  });

  it("items[].fullText: 24,000 字符上限 + 池化去重 (tx 机制保留)", () => {
    const fixture = singleStepSession({ toolText: "T".repeat(90000) });
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    const toolItem = categoryOf(lastStep(folded), "tool").items[0];
    const toolTextOfItem = itemText(folded, toolItem);
    assert.equal(toolItem.truncated, true);
    assert.equal(toolTextOfItem.length, DSH_TEXT_LIMITS.itemFullText + "…(已截断, 原文 90000 字符)".length);
    assert.ok(toolTextOfItem.endsWith("…(已截断, 原文 90000 字符)"));
    // 长文本入池: 条目上不留内联 fullText, 用 tx 回读
    assert.equal(typeof toolItem.tx, "number", "≥200 字符的正文必须入池 (tx)");
    assert.equal(toolItem.fullText, undefined);
    assert.equal(folded.textPool[toolItem.tx], toolTextOfItem, "池里存的正文必须与回读一致");
    assert.equal(new Set(folded.textPool).size, folded.textPool.length, "池内不允许重复字符串");
    // 用户消息也必须是真实正文 (旧实现只给 160 字符 snippet)
    const userItem = categoryOf(lastStep(folded), "user").items[0];
    assert.equal(itemText(folded, userItem), "U".repeat(4000));
  });

  it("sessionMeta.textTruncation 汇总真实截断条数与上限", () => {
    const fixture = singleStepSession({ toolText: "T".repeat(90000) });
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    const report = folded.sessionMeta.textTruncation;
    assert.equal(report.limits.itemFullText, DSH_TEXT_LIMITS.itemFullText);
    assert.equal(report.limits.systemSummary, DSH_TEXT_LIMITS.systemSummary);
    assert.equal(report.limits.schemaText, DSH_TEXT_LIMITS.schemaText);
    assert.equal(report.systemSummaryChars, 36000);
    assert.equal(report.systemSummaryTruncated, true);
    assert.equal(report.truncatedTools, 1);
    assert.equal(report.tools, 2);
    assert.ok(report.truncatedItems >= 3, "系统提示词 + 大 schema + 长工具结果都应被标记: " + report.truncatedItems);
    assert.ok(report.items >= report.truncatedItems);
  });
});

describe("编队 / 子 Agent 聚合 (dshContext.fleet)", () => {
  function fleetSession(extraEvents) {
    const ev = eventBuilder();
    const events = [
      ev("session", { cwd: "/tmp", title: "fleet" }),
      ev("turn/start", { turn: 1 }),
      ev("step/start", { turn: 1, step: 1 }),
      ev("assistant/message", {
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 },
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
      }),
      ev("step/end", { turn: 1, step: 1 }),
      ev("turn/end", { turn: 1 })
    ];
    for (const extra of extraEvents) events.push(extra);
    return writeDshSession(events, { id: "sess-fleet", sessionId: "sess-fleet" });
  }

  const catalogEvents = (ev) => [
    // 真实数据里 name 常常缺失 (实测 54 条 catalog 只有少数带 name)
    ev("subagent/catalog", { version: 3, childId: "child-a", mode: "continuable", label: "审计 parity", name: "auditor" }),
    ev("subagent/catalog", { version: 3, childId: "child-b", mode: "continuable", label: "录制会话" }),
    // 同一 childId 的重放事件: 只更新字段, 不重复计数
    ev("subagent/catalog", { version: 3, childId: "child-b", mode: "continuable", label: "录制会话" })
  ];

  it("subagent/catalog 按 childId 去重, 没有 name 也要计数 (stats.fleet.subCount 不再恒 0)", () => {
    const ev = eventBuilder();
    const fixture = fleetSession(catalogEvents(ev));
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    assert.equal(folded.fleet.subagentCount, 2, "两个 childId, 重复事件去重");
    assert.equal(folded.fleet.subagents.length, 2);
    assert.equal(folded.stats.fleet.subCount, folded.fleet.subagentCount, "stats.fleet.subCount 必须与真实子 Agent 数一致");
    assert.equal(folded.sessionMeta.subagents.length, 2);
    const byId = new Map(folded.fleet.subagents.map((item) => [item.childId, item]));
    assert.equal(byId.get("child-a").name, "auditor");
    assert.equal(byId.get("child-a").mode, "continuable");
    assert.equal(byId.get("child-b").label, "录制会话");
    assert.equal(byId.get("child-b").name, undefined, "没 name 就不该编一个出来");
    for (const item of folded.fleet.subagents) {
      assert.equal(item.parentId, "sess-fleet", "catalog 所在会话就是父 Agent");
    }
  });

  it("team/task 取 revision 最新态, owner → assignee 用成员真实名字", () => {
    const ev = eventBuilder();
    const extras = [
      ...catalogEvents(ev),
      ev("team/member", { version: 1, teamId: "team-1", member: { id: "child-a", name: "auditor", description: "审计", provider: "spawn", context: "ctx", phase: "running" } }),
      ev("team/member", { version: 1, teamId: "team-1", member: { id: "child-b", name: "recorder", description: "录制", provider: "spawn", context: "ctx", phase: "idle" } }),
      ev("team/mode", { enabled: true }),
      ev("team/task", { version: 1, teamId: "team-1", task: { id: "task-1", revision: 1, subject: "数据层", status: "pending", ownerId: "", blockedBy: [], writeScopes: [] } }),
      ev("team/task", { version: 1, teamId: "team-1", task: { id: "task-1", revision: 2, subject: "数据层", status: "in_progress", ownerId: "child-a", blockedBy: ["task-0"], writeScopes: ["dsh-events.mjs"] } }),
      // 更旧的 revision 迟到: 不能覆盖最新态
      ev("team/task", { version: 1, teamId: "team-1", task: { id: "task-1", revision: 1, subject: "数据层", status: "pending", ownerId: "", blockedBy: [], writeScopes: [] } }),
      ev("team/task", { version: 1, teamId: "team-1", task: { id: "task-2", revision: 1, subject: "页面", status: "completed", ownerId: "child-b", blockedBy: [], writeScopes: [] } })
    ];
    const fixture = fleetSession(extras);
    const folded = foldDshSession(fixture.filePath, fixture.meta);

    assert.equal(folded.fleet.teamEnabled, true);
    assert.equal(folded.fleet.members.length, 2);
    assert.equal(folded.stats.fleet.memberCount, 2);
    assert.equal(folded.fleet.tasks.length, 2);
    assert.equal(folded.stats.fleet.taskCount, 2);

    const task1 = folded.fleet.tasks.find((task) => task.id === "task-1");
    assert.equal(task1.revision, 2, "只保留 revision 最大的最新态");
    assert.equal(task1.status, "in_progress");
    assert.equal(task1.title, "数据层");
    assert.equal(task1.assignee, "auditor", "ownerId 要映射成成员真实名字");
    assert.equal(task1.ownerId, "child-a");
    assert.deepEqual(task1.blockedBy, ["task-0"]);
    assert.deepEqual(task1.writeScopes, ["dsh-events.mjs"]);
    const task2 = folded.fleet.tasks.find((task) => task.id === "task-2");
    assert.equal(task2.assignee, "recorder");
    assert.equal(task2.status, "completed");
  });

  it("没有编队数据的会话: 空数组 / 0, 不造占位成员", () => {
    const fixture = singleStepSession();
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    assert.equal(folded.fleet.subagentCount, 0);
    assert.deepEqual(folded.fleet.subagents, []);
    assert.deepEqual(folded.fleet.tasks, []);
    assert.deepEqual(folded.fleet.members, []);
    assert.equal(folded.fleet.teamEnabled, false);
    assert.equal(folded.stats.fleet.subCount, 0);
    assert.equal(folded.stats.fleet.taskCount, 0);
    assert.equal(folded.stats.fleet.memberCount, 0);
  });

  it("subagent/descriptor 记录本会话自身是子 Agent 时的描述", () => {
    const ev = eventBuilder();
    const fixture = fleetSession([
      ev("subagent/descriptor", {
        version: 3,
        mode: "continuable",
        provider: "spawn",
        label: "Build module",
        agentProvider: "magpie",
        agentModel: "group/deepseek-v4.1-flash",
        agentReasoningEffort: "max"
      })
    ]);
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    assert.equal(folded.fleet.descriptor.mode, "continuable");
    assert.equal(folded.fleet.descriptor.label, "Build module");
    assert.equal(folded.fleet.descriptor.agentModel, "group/deepseek-v4.1-flash");
    // descriptor 属于"本会话自身", 不是子 Agent, 不参与 subagentCount
    assert.equal(folded.fleet.subagentCount, 0);
  });

  it("stats.fleet.current = 当前 Agent 累计 token (= tokenStats.totalUsage)", () => {
    const fixture = singleStepSession();
    const folded = foldDshSession(fixture.filePath, fixture.meta);
    assert.equal(folded.stats.fleet.currentTokens, folded.tokenStats.totalUsage);
    assert.equal(folded.stats.fleet.current, folded.tokenStats.totalUsageFormatted);
  });
});

describe("单会话详情分片预算 (≤ 12MB)", () => {
  it("预算常量: 12MB 硬上限, 阶梯 keepSteps 含 120/100/…", () => {
    assert.equal(DSH_PAYLOAD_LIMITS.shardBytes, 12 * 1024 * 1024);
    assert.ok(DSH_PAYLOAD_LIMITS.budgetBytes < DSH_PAYLOAD_LIMITS.shardBytes);
    assert.equal(DSH_BROWSER_LIMITS.keepSteps, 120, "默认只保留最近 120 步明细 (与 daemon 降采样对齐)");
    // 最后一档不得为 0: 全清 items 会让页面每一步每个分类都显示「未保留独立条目明细」,
    // 剩余体积由 daemon 的 trimDetailPayloadInPlace 兜底 (它能同时看到 s.turns)。
    assert.deepEqual(DSH_PAYLOAD_LIMITS.keepStepsLadder, [120, 100, 80, 60, 40, 20]);
  });

  it("超预算的重会话: 真实分片字节 ≤ 12MB, 阶梯降采样, 统计口径不变", () => {
    const ev = eventBuilder();
    const STEPS = 400;
    const events = [
      ev("session", { cwd: "/tmp", title: "heavy" }),
      ev("request/header", {
        header: { tools: [{ name: "read", description: "read", parameters: { type: "object" } }], config: { provider: "p", model: "m" } },
        reason: "initial"
      }),
      ev("system/message", { message: { role: "system", content: [{ type: "text", text: "S".repeat(30000) }] } }),
      ev("turn/start", { turn: 1 })
    ];
    for (let index = 0; index < STEPS; index += 1) {
      const stepNo = index + 1;
      events.push(ev("user/message", { turn: 1, step: stepNo, content: [{ type: "text", text: "提问 " + index + " " + "Q".repeat(2000) }] }));
      events.push(ev("step/start", { turn: 1, step: stepNo }));
      events.push(ev("tool/call", { callId: "c" + index, name: "read", arguments: "{}" }));
      // 每步两段唯一长文本 (工具输出 60,000 / 助手回复 30,000) → 池里各截到 24,000+ 标注,
      // 400 步 ≈ 19MB 池文本, 远超 11.5MB 预算 → 必须触发阶梯降采样
      events.push(ev("tool/result", {
        callId: "c" + index,
        message: { role: "tool", content: [{ type: "text", text: "R" + index + "-" + "r".repeat(60000) }] }
      }));
      events.push(ev("assistant/message", {
        turn: 1,
        step: stepNo,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1 },
        message: { role: "assistant", content: [{ type: "text", text: "A" + index + "-" + "a".repeat(30000) }] }
      }));
      events.push(ev("step/end", { turn: 1, step: stepNo }));
    }
    events.push(ev("turn/end", { turn: 1 }));
    const fixture = writeDshSession(events, { id: "sess-heavy", sessionId: "sess-heavy" });

    const folded = foldDshSession(fixture.filePath, fixture.meta);
    const shardBytes = Buffer.byteLength(JSON.stringify(folded), "utf8");

    assert.equal(folded.steps.length, STEPS, "步骤数不得被预算裁剪掉");
    assert.equal(folded.stats.stepsCount, STEPS);
    assert.ok(shardBytes <= DSH_PAYLOAD_LIMITS.shardBytes, "单分片必须 ≤ 12MB, 实际 " + (shardBytes / 1048576).toFixed(2) + "MB");
    const guard = folded.sessionMeta.payloadBudget;
    assert.equal(guard.limitBytes, DSH_PAYLOAD_LIMITS.shardBytes);
    assert.equal(guard.trimmed, true, "这么重的会话必须触发阶梯降采样");
    assert.ok(guard.keepStepsUsed < DSH_BROWSER_LIMITS.keepSteps, "保留步数应被阶梯下调: " + guard.keepStepsUsed);
    assert.equal(folded.sessionMeta.browserCategoriesKeepSteps, guard.keepStepsUsed);
    if (guard.measured) {
      assert.ok(guard.bytes <= DSH_PAYLOAD_LIMITS.budgetBytes, "守卫实测字节必须落在预算内");
    }
    // 最近的步骤仍然保留明细 (用户看的就是这里), 更早的步骤只剩分类骨架
    const keep = guard.keepStepsUsed;
    const recentStep = folded.steps[folded.steps.length - 1];
    const recentItems = recentStep.browserCategories.reduce((sum, cat) => sum + (cat.items || []).length, 0);
    assert.ok(recentItems > 0, "最近一步必须保留明细条目");
    if (keep > 0 && folded.steps.length > keep) {
      const oldest = folded.steps[0];
      const oldestItems = oldest.browserCategories.reduce((sum, cat) => sum + (cat.items || []).length, 0);
      assert.equal(oldestItems, 0, "更早的步骤只保留分类骨架");
      // 分类统计骨架不能被裁掉
      for (const cat of oldest.browserCategories) {
        assert.ok(typeof cat.count === "number");
        assert.ok(typeof cat.tokens === "number");
      }
    }
    // 池里不留孤儿: 被折叠掉的步骤不再引用池条目
    const referenced = new Set();
    for (const step of folded.steps) {
      for (const cat of step.browserCategories) {
        for (const item of cat.items || []) {
          if (typeof item.tx === "number") referenced.add(item.tx);
          if (typeof item.sx === "number") referenced.add(item.sx);
        }
      }
    }
    assert.equal(referenced.size, folded.textPool.length, "池必须与引用一一对应");
  });

  it("estimateCategoriesBytes 计入池引用 (否则池化后预算永远不触发)", () => {
    const pool = ["P".repeat(5000), "Q".repeat(7000)];
    const steps = [{
      browserCategories: [{
        key: "tool", label: "工具", count: 2, tokens: 10,
        items: [{ id: "a", tx: 0, title: "t" }, { id: "b", tx: 1, title: "t" }, { id: "c", tx: 0, title: "t" }]
      }]
    }];
    const withPool = estimateCategoriesBytes(steps, pool);
    const withoutPool = estimateCategoriesBytes(steps);
    assert.ok(withPool > withoutPool, "带池引用时必须把池内文本算进体积");
    assert.ok(withPool >= 12000, "去重后仍要计两份不同的池文本: " + withPool);
    assert.ok(withPool < 12000 + 2000, "同一池条目被多次引用只算一份");
    // 老调用方 (不传 pool) 口径不变
    assert.equal(withoutPool, estimateCategoriesBytes(steps, null));
  });

  it("foldItemsOlderThan / applyBrowserCategoriesBudget 是纯 steps 变换且幂等", () => {
    const build = () => Array.from({ length: 200 }, (_, index) => ({
      browserCategories: [{
        key: "user", label: "用户", count: 2, tokens: 10,
        items: [{ id: "u" + index, title: "标题", tokens: 5, fullText: "长文本".repeat(300) }]
      }]
    }));
    const steps = build();
    const side = { stats: { stepsCount: 200 } };
    const sideBefore = JSON.stringify(side);

    assert.equal(foldItemsOlderThan(steps, 120), 80, "200 步保留最近 120 步 → 折叠 80 步");
    assert.equal(foldItemsOlderThan(steps, 120), 0, "已经折叠过的步骤不会再计一次");
    assert.equal(steps.length, 200, "折叠不得改变步骤数");
    assert.equal(steps[80].browserCategories[0].items.length, 1, "保留最近 120 步 (下标 80..199)");
    assert.deepEqual(steps[79].browserCategories[0].items, []);
    assert.equal(steps[79].browserCategories[0].itemsTrimmed, true);
    assert.equal(steps[79].browserCategories[0].count, 2, "分类统计骨架保留");
    assert.equal(JSON.stringify(side), sideBefore, "纯 steps 变换不得触碰其他数据");

    const fresh = build();
    const report = applyBrowserCategoriesBudget(fresh, 1024, 50);
    assert.equal(report.trimmed, true);
    assert.equal(report.trimmedSteps, 150);
    assert.equal(report.keepSteps, 50);
    const untouched = build();
    const report2 = applyBrowserCategoriesBudget(untouched, 100 * 1024 * 1024, 120);
    assert.equal(report2.trimmed, false);
    assert.equal(untouched[0].browserCategories[0].items.length, 1, "未超预算不动任何东西");
  });
});

describe("真实会话抽检 (有真实数据时)", () => {
  const SESSION_ROOT = path.join(os.homedir(), ".dsh", "sessions");

  function topSessions(limit) {
    const found = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "session.v4.jsonl.zstd") found.push({ filePath: full, size: fs.statSync(full).size });
      }
    };
    walk(SESSION_ROOT);
    found.sort((left, right) => right.size - left.size);
    return found.slice(0, limit);
  }

  it("最大的几个真实会话: 分片 ≤ 12MB, fleet.subCount 与 subagents 一致", () => {
    const samples = topSessions(5);
    if (samples.length === 0) return; // 无真实数据的机器上跳过 (不算失败)
    for (const sample of samples) {
      const folded = foldDshSession(sample.filePath);
      const bytes = Buffer.byteLength(JSON.stringify(folded), "utf8");
      assert.ok(
        bytes <= DSH_PAYLOAD_LIMITS.shardBytes,
        path.basename(path.dirname(sample.filePath)) + " 分片 " + (bytes / 1048576).toFixed(2) + "MB 超过 12MB"
      );
      assert.equal(folded.fleet.subagentCount, folded.fleet.subagents.length);
      assert.equal(folded.stats.fleet.subCount, folded.fleet.subagentCount);
      assert.equal(folded.sessionMeta.subagents.length, folded.fleet.subagents.length);
      // 条目正文必须严格受上限约束, 且带截断标注
      for (const step of folded.steps) {
        for (const cat of step.browserCategories) {
          for (const item of cat.items || []) {
            const text = resolveItemFullText(folded, item);
            if (text.length <= DSH_TEXT_LIMITS.itemFullText) continue;
            assert.ok(/…\(已截断, 原文 \d+ 字符\)$/.test(text), "超限文本必须带截断标注");
            assert.equal(item.truncated, true);
          }
        }
      }
    }
  });
});

describe("技能注入条目", () => {
  it("skill 分类有 count/tokens 时必须同时有条目明细 (旧实现只有计数没有条目)", () => {
    const ev = eventBuilder();
    const events = [
      ev("session", { cwd: "/tmp", title: "skill-fixture" }),
      ev("request/header", { header: { tools: [{ name: "skill", description: "d", parameters: { type: "object" } }], config: { provider: "p", model: "m" } }, reason: "initial" }),
      ev("system/message", { message: { role: "system", content: [{ type: "text", text: "S".repeat(500) }] } }),
      ev("turn/start", { turn: 1 }),
      ev("user/message", { turn: 1, step: 1, content: [{ type: "text", text: "use skill" }] }),
      ev("step/start", { turn: 1, step: 1 }),
      ev("tool/call", { callId: "s1", name: "skill", arguments: "{\"name\":\"office\"}" }),
      ev("tool/result", { callId: "s1", message: { role: "tool", toolCallId: "s1", content: [{ type: "text", text: "Skill: office\n" + "K".repeat(9000) }] } }),
      ev("assistant/message", { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20 }, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      ev("step/end", { turn: 1, step: 1 }),
      ev("turn/end", { turn: 1 })
    ];
    const fixture = writeDshSession(events, { id: "sess-skill", sessionId: "sess-skill" });
    const session = foldDshSession(fixture.filePath, fixture.meta);
    const step = lastStep(session);
    const skillCat = categoryOf(step, "skill");
    assert.ok(skillCat.count > 0, "skill 分类应有真实计数");
    assert.ok((skillCat.items || []).length > 0, "skill 分类有计数却没有条目明细");
    const toolCat = categoryOf(step, "tool");
    const toolItemIds = (toolCat.items || []).map((it) => String(it.id)).join(",");
    assert.ok(!toolItemIds.includes(":s1"), "已转为 skill 的节点不应同时出现在 tool 条目里: " + toolItemIds);
  });
});
