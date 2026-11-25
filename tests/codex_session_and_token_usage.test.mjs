// tests/codex_session_and_token_usage.test.mjs
// ① tokenStats.totalUsage 口径统一 (uncachedInput + cacheRead + cacheWrite + output)
// ② Codex rollout (~/.codex/archived_sessions/rollout-*.jsonl) 真实会话解析
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDaemon } from "./helpers/daemon_harness.mjs";

const HOME = process.env.HOME || "";
const CODEX_DIR = path.join(HOME, ".codex/archived_sessions");

/** 独立重算 rollout 文件的真实计量 (不复用 daemon 代码, 作为真值对照) */
function recomputeRolloutTruth(filePath) {
  const truth = {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, records: 0,
    taskStarted: 0, taskComplete: 0, calls: 0, outputs: 0, cmdItems: 0,
    lastPrompt: 0, messages: 0, assistantMessages: 0
  };
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj = null;
    try { obj = JSON.parse(trimmed); } catch (e) { continue; }
    const payload = (obj && obj.payload) || {};
    if (obj.type === "token_usage_record") {
      const usage = payload.usage || {};
      truth.input += Number(usage.input_tokens) || 0;
      truth.cacheRead += Number(usage.cached_input_tokens) || 0;
      truth.cacheWrite += Number(usage.cache_write_input_tokens) || 0;
      truth.output += Number(usage.output_tokens) || 0;
      truth.records += 1;
      truth.lastPrompt = Number(usage.input_tokens) || 0;
    } else if (obj.type === "response_item" && payload.type === "function_call") {
      truth.calls += 1;
    } else if (obj.type === "response_item" && payload.type === "function_call_output") {
      truth.outputs += 1;
    } else if (obj.type === "response_item" && payload.type === "message") {
      truth.messages += 1;
      if (payload.role === "assistant") truth.assistantMessages += 1;
    } else if (obj.type === "event_msg" && payload.type === "task_started") {
      truth.taskStarted += 1;
    } else if (obj.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      truth.taskComplete += 1;
    } else if (obj.type === "event_msg" && payload.type === "item_completed") {
      const item = payload.item || {};
      if (item.type === "CommandExecution") truth.cmdItems += 1;
    }
  }
  truth.uncached = Math.max(0, truth.input - truth.cacheRead - truth.cacheWrite);
  return truth;
}

function listRealRollouts() {
  if (!fs.existsSync(CODEX_DIR)) return [];
  return fs.readdirSync(CODEX_DIR)
    .filter(name => name.startsWith("rollout-") && name.endsWith(".jsonl"))
    .map(name => path.join(CODEX_DIR, name))
    .filter(filePath => {
      try { return fs.statSync(filePath).isFile(); } catch (e) { return false; }
    });
}

describe("tokenStats.totalUsage 口径统一 (uncherInput + cacheRead + cacheWrite + output)", () => {
  const buildSession = (overrides = {}) => Object.assign({
    id: "usage-caliber-session",
    agent: "antigravity",
    agentName: "Antigravity",
    model: "gemini-3.8-flash",
    modelLimit: 100000,
    totalInputTokens: 1200,
    totalCacheRead: 4800,
    totalCacheWrite: 300,
    totalOutputTokens: 900,
    currentTokens: 6000,
    fileOps: [],
    turns: [{
      turnIdx: 1,
      time: Date.UTC(2026, 0, 1, 0, 0, 0),
      timestamp: "2026-01-01 08:00:00",
      userText: "hi",
      totalTokens: 6000,
      tokenDelta: 0,
      promptTokens: 6000,
      breakdown: {
        systemTokens: 1000,
        toolsTokens: 800,
        userTokens: 200,
        assistantTokens: 700,
        toolResultTokens: 1200
      },
      messages: [
        { idx: 0, role: "user", tokens: 200, chars: 10, snippet: "hi", fullText: "hi" },
        { idx: 1, role: "assistant", tokens: 700, chars: 30, snippet: "ok", fullText: "ok" },
        { idx: 2, role: "tool_result", toolName: "run_command", tokens: 1200, chars: 40, snippet: "out", fullText: "out" }
      ]
    }]
  }, overrides);

  it("totalUsage = uncached + cacheRead + cacheWrite + output (含 cacheRead, 不再是 Σinput+Σoutput)", async () => {
    const daemon = await loadDaemon();
    const dc = daemon.buildDshContextPayload(buildSession());
    const expected = 1200 + 4800 + 300 + 900;
    assert.equal(dc.tokenStats.totalUsage, expected, "totalUsage 必须含 cacheRead/cacheWrite");
    assert.notEqual(dc.tokenStats.totalUsage, 1200 + 900, "旧口径 Σinput+Σoutput 必须被替换");
    assert.equal(dc.tokenStats.totalUsageFormatted, daemon.formatK(expected));
    assert.equal(dc.tokenStats.uncachedTokens, 1200);
    assert.equal(dc.tokenStats.cacheReadTokens, 4800);
    assert.equal(dc.tokenStats.cacheWriteTokens, 300);
    assert.equal(dc.tokenStats.outputTokens, 900);
  });

  it("卡片中心数字 >= 当前上下文 (同一会话量级自洽)", async () => {
    const daemon = await loadDaemon();
    const dc = daemon.buildDshContextPayload(buildSession());
    assert.ok(dc.tokenStats.totalUsage >= dc.currentContext.currentTokens,
      "总用量 " + dc.tokenStats.totalUsage + " 必须 >= 当前上下文 " + dc.currentContext.currentTokens);
    assert.equal(dc.stats.fleet.current, daemon.formatK(dc.tokenStats.totalUsage),
      "fleet.current 必须等于 totalUsage 的格式化值");
  });

  it("cacheHitRate = cacheRead / (uncachedInput + cacheRead + cacheWrite)", async () => {
    const daemon = await loadDaemon();
    const dc = daemon.buildDshContextPayload(buildSession());
    const expected = ((4800 / (1200 + 4800 + 300)) * 100).toFixed(2);
    assert.equal(dc.tokenStats.cacheHitRate, expected);
    // cacheWrite 必须进分母: 旧口径 cacheRead/(input+cacheRead) 会算出不同值
    assert.notEqual(dc.tokenStats.cacheHitRate, ((4800 / (1200 + 4800)) * 100).toFixed(2));
  });

  it("分类百分比分母 = totalUsage, 且各分类 token 之和 == totalUsage", async () => {
    const daemon = await loadDaemon();
    const dc = daemon.buildDshContextPayload(buildSession());
    const cats = dc.tokenStats.categories;
    assert.equal(cats.length, 8, "分类骨架恒为 8 条");
    const sum = cats.reduce((acc, cat) => acc + cat.tokens, 0);
    assert.equal(sum, dc.tokenStats.totalUsage, "分类之和必须 == totalUsage (环形图中心与分片自洽)");
    for (const cat of cats) {
      const expectedPercent = Number(((cat.tokens / dc.tokenStats.totalUsage) * 100).toFixed(2));
      assert.equal(cat.percent, expectedPercent, cat.key + " 的百分比分母必须是 totalUsage");
      assert.equal(cat.formatted, daemon.formatK(cat.tokens));
    }
    const percentSum = cats.reduce((acc, cat) => acc + cat.percent, 0);
    assert.ok(Math.abs(percentSum - 100) <= 0.5, "百分比之和应 ≈ 100, 实际 " + percentSum);
  });

  it("无 cacheWrite 的会话口径仍成立 (cacheWrite 缺省 0)", async () => {
    const daemon = await loadDaemon();
    const dc = daemon.buildDshContextPayload(buildSession({ totalCacheWrite: undefined }));
    assert.equal(dc.tokenStats.cacheWriteTokens, 0);
    assert.equal(dc.tokenStats.totalUsage, 1200 + 4800 + 900);
    assert.equal(dc.tokenStats.cacheHitRate, ((4800 / 6000) * 100).toFixed(2));
  });

  it("真实 antigravity 会话: totalUsage 自洽且 >= currentTokens", async () => {
    const daemon = await loadDaemon();
    const brainRoot = path.join(HOME, ".gemini/antigravity/brain");
    if (!fs.existsSync(brainRoot)) return;
    const candidates = [];
    for (const id of fs.readdirSync(brainRoot)) {
      const dir = path.join(brainRoot, id, ".system_generated/logs");
      const file = fs.existsSync(path.join(dir, "transcript_full.jsonl"))
        ? path.join(dir, "transcript_full.jsonl")
        : (fs.existsSync(path.join(dir, "transcript.jsonl")) ? path.join(dir, "transcript.jsonl") : "");
      if (file === "") continue;
      try { candidates.push({ id, size: fs.statSync(file).size }); } catch (e) { /* 并发删除 → 跳过 */ }
    }
    candidates.sort((a, b) => a.size - b.size);
    for (const { id } of candidates.slice(0, 3)) {
      const now = new Date().toISOString();
      const session = daemon.parseAntigravitySession(id, "", "", now, now, {}, []);
      const dc = daemon.buildDshContextPayload(session);
      const expected = (Number(session.totalInputTokens) || 0)
        + (Number(session.totalCacheRead) || 0)
        + (Number(session.totalCacheWrite) || 0)
        + (Number(session.totalOutputTokens) || 0);
      assert.equal(dc.tokenStats.totalUsage, expected, "真实会话 totalUsage 必须等于四项之和");
      assert.ok(dc.tokenStats.totalUsage >= dc.currentContext.currentTokens,
        "真实会话: totalUsage " + dc.tokenStats.totalUsage + " 必须 >= currentTokens " + dc.currentContext.currentTokens);
      const sum = dc.tokenStats.categories.reduce((acc, cat) => acc + cat.tokens, 0);
      assert.equal(sum, dc.tokenStats.totalUsage, "真实会话分类之和必须 == totalUsage");
    }
  });
});

describe("Codex rollout 会话解析 (真实文件)", () => {
  it("collectCodexRolloutMetas: agent=codex, id 唯一, 文件存在", async () => {
    const daemon = await loadDaemon();
    if (listRealRollouts().length === 0) return; // 本机没有 codex 归档时跳过
    const metas = Object.values(daemon.collectCodexRolloutMetas());
    assert.ok(metas.length >= 1, "至少扫描到 1 个 rollout 文件");
    const ids = metas.map(meta => meta.id);
    assert.equal(new Set(ids).size, ids.length, "同一 thread 的多个 rollout 也必须拿到唯一 id");
    for (const meta of metas) {
      assert.equal(meta.agent, "codex");
      assert.ok(String(meta.id).startsWith("codex-"), "id 必须是 codex- 前缀: " + meta.id);
      assert.ok(fs.existsSync(meta.filePath), "rollout 文件必须存在: " + meta.filePath);
      assert.ok(String(meta.codexSessionId || "").length > 0, "必须记录真实 session_id");
    }
  });

  it("真实 rollout: 轮次/步数/真实 token 与独立重算一致", async () => {
    const daemon = await loadDaemon();
    const files = listRealRollouts();
    if (files.length === 0) return;
    let checkedWithUsage = 0;
    for (const filePath of files) {
      const truth = recomputeRolloutTruth(filePath);
      const meta = { id: "codex-test-" + path.basename(filePath, ".jsonl").slice(-12), filePath };
      const session = daemon.parseCodexSession(filePath, meta, []);
      assert.equal(session.agent, "codex");
      assert.equal(session.id, meta.id);
      assert.equal(session.totalInputTokens, truth.uncached, "未缓存输入必须 = Σ(input-cached-cacheWrite)");
      assert.equal(session.totalCacheRead, truth.cacheRead, "cacheRead 必须 = Σ cached_input_tokens");
      assert.equal(session.totalCacheWrite, truth.cacheWrite, "cacheWrite 必须 = Σ cache_write_input_tokens");
      assert.equal(session.totalOutputTokens, truth.output, "output 必须 = Σ output_tokens");
      assert.equal(session.turnsCount, truth.taskStarted, "轮次必须 = task_started 事件数");
      // 每条 assistant 正文消息 = 一步; 纯工具调用的模型调用也会生成一步 (不丢调用)
      assert.ok(session.stepsCount >= truth.assistantMessages,
        "步数 " + session.stepsCount + " 必须 >= assistant 正文消息数 " + truth.assistantMessages);
      if (truth.records > 0) {
        // 每次真实模型调用 (token_usage_record) 最多一步, 且不会少于 assistant 正文 + 工具调用批次
        assert.ok(session.stepsCount <= truth.records,
          "步数 " + session.stepsCount + " 不应超过真实模型调用数 " + truth.records);
        if (truth.assistantMessages === truth.records) {
          assert.equal(session.stepsCount, truth.records, "每次调用都有正文时步数 == 调用数");
        }
      }
      if (truth.records > 0) {
        checkedWithUsage += 1;
        assert.equal(session.currentTokens, truth.lastPrompt, "当前上下文 = 末次真实 prompt (input_tokens)");
        assert.equal(session.codexTokenSource, "token_usage_record", "有真实 usage 记录时必须用它, 不估算");
        const dc = daemon.buildDshContextPayload(session);
        assert.equal(dc.tokenStats.totalUsage, truth.uncached + truth.cacheRead + truth.cacheWrite + truth.output);
        assert.equal(dc.tokenStats.totalUsage,
          dc.tokenStats.categories.reduce((acc, cat) => acc + cat.tokens, 0));
        assert.ok(dc.tokenStats.totalUsage >= dc.currentContext.currentTokens,
          "Codex: totalUsage 必须 >= currentTokens");
      } else {
        assert.equal(session.currentTokens, 0, "没有真实 usage 的 rollout 当前上下文必须是 0 (不估算)");
      }
      for (const turn of session.turns) {
        assert.equal(turn.breakdown && typeof turn.breakdown, "object");
        for (const key of ["systemTokens", "toolsTokens", "userTokens", "injectTokens", "skillTokens", "assistantTokens", "toolResultTokens"]) {
          assert.ok(Number.isFinite(Number(turn.breakdown[key])), "breakdown." + key + " 必须是数字");
        }
        for (const message of turn.messages) {
          assert.ok(typeof message.fullText === "string");
          assert.ok(!Number.isNaN(Number(message.tokens)));
        }
      }
    }
    assert.ok(checkedWithUsage >= 1, "至少一个真实 rollout 带 token_usage_record");
  });

  it("真实 rollout: 工具调用 → fileOps / commands (复用 extractFileOpsFromToolCall)", async () => {
    const daemon = await loadDaemon();
    const files = listRealRollouts();
    if (files.length === 0) return;
    const withCalls = files
      .map(filePath => ({ filePath, truth: recomputeRolloutTruth(filePath) }))
      .filter(entry => entry.truth.calls > 0)
      .sort((a, b) => b.truth.calls - a.truth.calls);
    if (withCalls.length === 0) return;
    const { filePath, truth } = withCalls[0];
    const session = daemon.parseCodexSession(filePath, { id: "codex-tools" }, []);
    const dc = daemon.buildDshContextPayload(session);
    assert.equal(dc.commands.length, truth.cmdItems,
      "commands 条数必须等于真实 CommandExecution 事件数 (不编造)");
    for (const command of dc.commands) {
      assert.ok(typeof command.cmd === "string" && command.cmd.trim() !== "", "命令行不能为空");
      assert.ok(["completed", "failed"].includes(command.status));
      assert.ok(Number.isInteger(command.turn) && command.turn >= 1);
    }
    // 真实 shell 调用会产出 read 型 fileOps (cat/head 等), 至少要有 ops
    const opCount = session.fileOps.reduce((acc, item) => acc + (item.ops || []).length, 0);
    assert.ok(opCount > 0, "真实 shell 调用必须解析出文件操作");
    for (const item of session.fileOps) {
      assert.ok(typeof item.path === "string" && item.path !== "");
      assert.ok(item.reads + item.writes + item.searches > 0);
    }
  });

  it("真实 rollout: 每个会话 卡片中心数字 >= 当前上下文 (含无 token 记录的早期 rollout)", async () => {
    const daemon = await loadDaemon();
    const metas = Object.values(daemon.collectCodexRolloutMetas());
    if (metas.length === 0) return;
    let withMetering = 0;
    for (const meta of metas) {
      const session = daemon.parseCodexSession(meta.filePath, meta, []);
      const dc = daemon.buildDshContextPayload(session);
      assert.ok(dc.tokenStats.totalUsage >= dc.currentContext.currentTokens,
        session.id + ": totalUsage " + dc.tokenStats.totalUsage + " 必须 >= currentTokens " + dc.currentContext.currentTokens);
      if (session.codexTokenSource === "token_usage_record") withMetering += 1;
      if (session.codexTokenSource === "") {
        // 没有任何真实计量: 两个口径都必须是 0 (不拿内容估算冒充 token 计量)
        assert.equal(session.noRealTokenUsage, true);
        assert.equal(dc.tokenStats.totalUsage, 0);
        assert.equal(dc.currentContext.currentTokens, 0);
        assert.equal(dc.tokenStats.categories.reduce((acc, cat) => acc + cat.tokens, 0), 0,
          "没有真实计量时分类累计也必须是 0 (与中心数字同一空态)");
      }
    }
    assert.ok(withMetering >= 1, "至少一个真实 rollout 带 token_usage_record");
  });

  it("真实 rollout: dshContext.browserCategories 的 assistant/tool/user 都有真实条目", async () => {
    const daemon = await loadDaemon();
    const files = listRealRollouts();
    if (files.length === 0) return;
    const withMessages = files
      .map(filePath => ({ filePath, truth: recomputeRolloutTruth(filePath) }))
      .filter(entry => entry.truth.assistantMessages > 0)
      .sort((a, b) => b.truth.assistantMessages - a.truth.assistantMessages);
    if (withMessages.length === 0) return;
    const session = daemon.parseCodexSession(withMessages[0].filePath, { id: "codex-browser" }, []);
    const dc = daemon.buildDshContextPayload(session);
    assert.ok(Array.isArray(dc.steps) && dc.steps.length > 0, "必须生成 steps");

    const itemCount = new Map();
    for (const step of dc.steps) {
      for (const category of step.browserCategories || []) {
        for (const item of category.items || []) {
          itemCount.set(category.key, (itemCount.get(category.key) || 0) + 1);
          assert.ok(typeof item.fullText === "string" && item.fullText.length > 0, "item.fullText 不能为空");
          assert.ok(item.fullText.length <= 24000, "item.fullText ≤ 24,000");
          assert.ok(item.snippet.length <= 400, "item.snippet ≤ 400");
          assert.ok(Number(item.tokens) > 0, "item.tokens > 0");
        }
      }
    }
    for (const key of ["assistant", "tool", "user"]) {
      assert.ok((itemCount.get(key) || 0) > 0, "分类 " + key + " 必须有真实条目, 实际 " + JSON.stringify(Object.fromEntries(itemCount)));
    }
  });
});

describe("Codex 单文件容错 (损坏 / 半行 / 空文件)", () => {
  const writeTemp = (lines) => {
    const target = path.join(os.tmpdir(), "codex-rollout-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".jsonl");
    fs.writeFileSync(target, lines.join("\n"), "utf8");
    return target;
  };
  const jsonl = (obj) => JSON.stringify(obj);

  it("半行 / 非 JSON / 尾部截断 → 跳过但仍能解析有效记录", async () => {
    const daemon = await loadDaemon();
    const lines = [
      jsonl({ timestamp: "2026-10-09T01:00:00.000Z", type: "session_meta", payload: { session_id: "sess-ft", cwd: "/tmp/proj", timestamp: "2026-10-09T01:00:00.000Z", base_instructions: { text: "You are Codex." } } }),
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"',
      "this is not json at all",
      jsonl({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我把 ls 结果看一下" }] } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] } }),
      jsonl({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: jsonl({ cmd: "ls -la /tmp/proj" }) } }),
      "   ",
      jsonl({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "total 0" } }),
      jsonl({ type: "token_usage_record", payload: { turn_id: "t1", usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 50 } } }),
      jsonl({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "ls -la /tmp/proj"], exit_code: 0, status: "completed", duration: { secs: 0, nanos: 5000000 } } } }),
      jsonl({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }),
      '{"type":"token_usage_record","payload":{"usage"'
    ];
    const filePath = writeTemp(lines);
    try {
      const session = daemon.parseCodexSession(filePath, { id: "codex-ft", codexSessionId: "sess-ft" }, []);
      assert.equal(session.codexCorruptLines, 3, "3 条损坏记录必须被计数跳过");
      assert.equal(session.turnsCount, 1, "只有 1 个真实 task_started 轮次");
      assert.equal(session.stepsCount, 1, "1 条 assistant 消息 = 1 步");
      assert.equal(session.totalInputTokens, 400, "uncached = 1000 - 600");
      assert.equal(session.totalCacheRead, 600);
      assert.equal(session.totalOutputTokens, 50);
      assert.equal(session.currentTokens, 1000);
      assert.equal(session.codexSessionId, "sess-ft");
      const dc = daemon.buildDshContextPayload(session);
      assert.equal(dc.tokenStats.totalUsage, 400 + 600 + 0 + 50);
      assert.equal(dc.commands.length, 1);
      assert.equal(dc.commands[0].cmd, "ls -la /tmp/proj");
      assert.equal(dc.commands[0].exitCode, 0);
      assert.equal(dc.commands[0].status, "completed");
      assert.ok(session.turns[0].messages.some(m => m.role === "system" && m.fullText === "You are Codex."),
        "base_instructions.text 必须作为真实系统提示词保留");
      assert.ok(session.turns[0].messages.some(m => m.role === "user"));
      assert.ok(session.turns[0].messages.some(m => m.role === "tool_result" && m.fullText === "total 0"));
    } finally {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
  });

  it("apply_patch → 写操作 fileOps (真实 patch 解析)", async () => {
    const daemon = await loadDaemon();
    const patch = [
      "*** Begin Patch",
      "*** Update File: /tmp/proj/app.js",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "+const b = 3;",
      "*** End Patch"
    ].join("\n");
    const lines = [
      jsonl({ timestamp: "2026-10-09T01:00:00.000Z", type: "session_meta", payload: { session_id: "sess-patch", cwd: "/tmp/proj" } }),
      jsonl({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "改一下 app.js" }] } }),
      jsonl({ type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "p1", arguments: patch } }),
      jsonl({ type: "response_item", payload: { type: "function_call_output", call_id: "p1", output: "Success. Updated the following files:\nM /tmp/proj/app.js" } }),
      jsonl({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } })
    ];
    const filePath = writeTemp(lines);
    try {
      const session = daemon.parseCodexSession(filePath, { id: "codex-patch" }, []);
      assert.equal(session.fileOps.length, 1, "patch 必须解析出 1 个文件");
      assert.equal(session.fileOps[0].path, "/tmp/proj/app.js");
      assert.equal(session.fileOps[0].writes, 1);
      assert.equal(session.fileOps[0].added, 2, "+ 行数必须真实统计");
      assert.equal(session.fileOps[0].removed, 1, "- 行数必须真实统计");
      const dc = daemon.buildDshContextPayload(session);
      assert.equal(dc.fileOps.length, 1);
      assert.equal(dc.tokenStats.totalUsage, 0, "没有 token_usage_record 时不编造 token");
      assert.equal(dc.currentContext.currentTokens, 0, "没有真实计量时当前上下文也保持 0, 与卡片中心数字自洽");
    } finally {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
  });

  it("空文件 / 不存在文件 → 不抛错, 返回空会话", async () => {
    const daemon = await loadDaemon();
    const emptyPath = writeTemp([""]);
    try {
      const empty = daemon.parseCodexSession(emptyPath, { id: "codex-empty", codexSessionId: "sess-empty" }, []);
      assert.equal(empty.turnsCount, 0);
      assert.equal(empty.stepsCount, 0);
      assert.equal(empty.totalInputTokens, 0);
      assert.equal(empty.currentTokens, 0);
      const dc = daemon.buildDshContextPayload(empty);
      assert.equal(dc.tokenStats.totalUsage, 0);
      assert.equal(dc.steps.length, 0);
    } finally {
      try { fs.unlinkSync(emptyPath); } catch (e) { /* ignore */ }
    }
    const missing = daemon.parseCodexSession(path.join(os.tmpdir(), "codex-does-not-exist-" + Date.now() + ".jsonl"), { id: "codex-missing" }, []);
    assert.equal(missing.turnsCount, 0);
    assert.equal(missing.agent, "codex");
  });

  it("损坏行不影响有真实 usage 的文件 (总 token 只来自有效记录)", async () => {
    const daemon = await loadDaemon();
    const usage = (input, cached, output) => jsonl({
      type: "token_usage_record",
      payload: { turn_id: "t1", usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } }
    });
    const lines = [
      jsonl({ type: "session_meta", payload: { session_id: "sess-mix", cwd: "/tmp/proj" } }),
      jsonl({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第一次回复" }] } }),
      usage(1000, 400, 100),
      "GARBAGE LINE",
      jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第二次回复" }] } }),
      usage(2000, 1500, 200),
      jsonl({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } })
    ];
    const filePath = writeTemp(lines);
    try {
      const session = daemon.parseCodexSession(filePath, { id: "codex-mix" }, []);
      assert.equal(session.codexCorruptLines, 1);
      assert.equal(session.stepsCount, 2, "两条 assistant 消息 = 两步");
      assert.equal(session.totalCacheRead, 1900);
      assert.equal(session.totalOutputTokens, 300);
      assert.equal(session.totalInputTokens, (1000 - 400) + (2000 - 1500), "uncached 必须逐条减掉 cached");
      assert.equal(session.currentTokens, 2000, "当前上下文 = 末次 prompt");
      const dc = daemon.buildDshContextPayload(session);
      assert.equal(dc.tokenStats.totalUsage, session.totalInputTokens + 1900 + 300);
      assert.equal(dc.steps.length, 2);
      assert.equal(dc.steps[0].promptTokens, 1000, "第一步 prompt 必须来自第 1 条 usage");
      assert.equal(dc.steps[1].promptTokens, 2000, "第二步 prompt 必须来自第 2 条 usage");
      assert.ok(dc.tokenStats.totalUsage >= dc.currentContext.currentTokens);
    } finally {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
  });
});
