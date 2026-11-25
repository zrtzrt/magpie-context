// tests/step_breakdown_per_step.test.mjs
// 回归: 每步 7 类构成必须随该步真实上下文变化 (不许整轮共用一个快照)。
// 旧实现 daemon.mjs 的 breakdownOf 直接返回 turn.breakdown → 同一轮内每一步的 7 类数值完全相同,
// 页面上全量柱状图恒平、增量模式差值恒 0; 只有 DSH 侧 (dsh-events 每次请求一份构成) 正常。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDaemon, withMockAntigravityTranscript } from "./helpers/daemon_harness.mjs";
import { createTranscriptLine } from "./helpers/fixtures.mjs";

const CATEGORIES = ["system", "tools", "user", "inject", "skill", "assistant", "tool"];

const breakdownSum = (bd) => CATEGORIES.reduce((acc, key) => acc + (Number(bd && bd[key]) || 0), 0);

/** 同一轮内相邻两步的 7 类构成是否完全一致 (全一致 = 快照复用, 即回归目标) */
function countIdenticalNeighborPairs(steps) {
  let identical = 0;
  let pairs = 0;
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].turnIdx !== steps[i - 1].turnIdx) continue;
    pairs += 1;
    const same = CATEGORIES.every(
      (key) => (Number(steps[i].breakdown[key]) || 0) === (Number(steps[i - 1].breakdown[key]) || 0)
    );
    if (same) identical += 1;
  }
  return { identical, pairs };
}

/** 7 类之和必须等于该步真实 prompt (堆叠柱与「实际 X」同口径, 不许越界/对不上) */
function assertBreakdownMatchesTotal(steps, label) {
  for (const step of steps) {
    const total = Number(step.totalTokens) || 0;
    if (total <= 0) continue;
    assert.equal(
      breakdownSum(step.breakdown),
      total,
      label + " 第 " + step.stepIdx + " 步: 7 类之和必须等于 totalTokens"
    );
  }
}

describe("每步上下文构成 (step.breakdown) 必须逐步变化", () => {
  it("① Antigravity: 同一轮内多步的真实 prompt 不同 → 构成也必须不同", async () => {
    const lines = [
      createTranscriptLine("USER_INPUT", "请把三个文件都读一遍并汇总", { step_index: 1, created_at: "2026-11-12T10:00:00.000Z" }),
      createTranscriptLine("PLANNER_RESPONSE", "先读第一个文件", {
        step_index: 2, created_at: "2026-11-12T10:00:05.000Z",
        input_tokens: 4000, cache_read_tokens: 1000, output_tokens: 120,
        tool_calls: [{ name: "read_file", args: { Path: "/tmp/a.txt" } }]
      }),
      createTranscriptLine("GENERIC", "A 文件内容 AAAA", { step_index: 2, status: "success", created_at: "2026-11-12T10:00:06.000Z" }),
      createTranscriptLine("PLANNER_RESPONSE", "再读第二个文件", {
        step_index: 3, created_at: "2026-11-12T10:00:10.000Z",
        input_tokens: 6000, cache_read_tokens: 1500, output_tokens: 150,
        tool_calls: [{ name: "read_file", args: { Path: "/tmp/b.txt" } }]
      }),
      createTranscriptLine("GENERIC", "B 文件内容 BBBB", { step_index: 3, status: "success", created_at: "2026-11-12T10:00:11.000Z" }),
      createTranscriptLine("PLANNER_RESPONSE", "三个文件都读完了", {
        step_index: 4, created_at: "2026-11-12T10:00:15.000Z",
        input_tokens: 8000, cache_read_tokens: 2000, output_tokens: 200
      })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const steps = (session.dshContext && session.dshContext.steps) || [];
      assert.ok(steps.length >= 3, "三条 PLANNER_RESPONSE 必须产出至少 3 步, 实际 " + steps.length);

      const totals = steps.map((step) => Number(step.totalTokens) || 0);
      assert.deepEqual(totals.slice(0, 3), [5000, 7500, 10000], "每步 prompt = input_tokens + cache_read_tokens");

      assertBreakdownMatchesTotal(steps, "antigravity");

      const { identical, pairs } = countIdenticalNeighborPairs(steps);
      assert.ok(pairs > 0, "必须有同一轮内的相邻步才能验证本回归");
      assert.equal(identical, 0, "同一轮内相邻步的 7 类构成不得完全相同 (实际 " + identical + "/" + pairs + " 对相同)");

      // 具体到语义: 工具结果逐步累积 → tool 类必须递增
      const toolSeries = steps.map((step) => Number(step.breakdown.tool) || 0);
      assert.ok(toolSeries[0] <= toolSeries[1], "第 2 步的 tool 类不应小于第 1 步: " + toolSeries.join(","));
      assert.ok(toolSeries[1] < toolSeries[2], "读完两个文件后 tool 类必须增长: " + toolSeries.join(","));
    });
  });

  it("② Codex: 多次真实 token_usage_record → 构成随 prompt 变化", async () => {
    const daemon = await loadDaemon();
    const jsonl = (obj) => JSON.stringify(obj);
    const lines = [
      jsonl({ timestamp: "2026-11-12T11:00:00.000Z", type: "session_meta", payload: { session_id: "sess-step", cwd: "/tmp/proj", timestamp: "2026-11-12T11:00:00.000Z", base_instructions: { text: "You are Codex." } } }),
      jsonl({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "读三个文件" }] } }),
      jsonl({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: jsonl({ cmd: "cat /tmp/a.txt" }) } }),
      jsonl({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "AAAA" } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第一个文件读完了" }] } }),
      jsonl({ type: "token_usage_record", payload: { turn_id: "t1", usage: { input_tokens: 3000, cached_input_tokens: 500, cache_write_input_tokens: 0, output_tokens: 60 } } }),
      jsonl({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c2", arguments: jsonl({ cmd: "cat /tmp/b.txt" }) } }),
      jsonl({ type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "BBBBBBBB" } }),
      jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第二个也读完了" }] } }),
      jsonl({ type: "token_usage_record", payload: { turn_id: "t1", usage: { input_tokens: 5000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 80 } } }),
      jsonl({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } })
    ];
    const filePath = path.join(os.tmpdir(), "codex-stepbreakdown-" + process.pid + "-" + Date.now() + ".jsonl");
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
    try {
      const session = daemon.parseCodexSession(filePath, { id: "codex-step", codexSessionId: "sess-step" }, []);
      const dc = daemon.buildDshContextPayload(session);
      const steps = dc.steps || [];
      assert.ok(steps.length >= 2, "两次 token_usage_record 必须产出至少 2 步, 实际 " + steps.length);
      assertBreakdownMatchesTotal(steps, "codex");
      const { identical, pairs } = countIdenticalNeighborPairs(steps);
      assert.ok(pairs > 0, "必须有同一轮内的相邻步");
      assert.equal(identical, 0, "同一轮内相邻步的 7 类构成不得完全相同");
    } finally {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
  });
});
