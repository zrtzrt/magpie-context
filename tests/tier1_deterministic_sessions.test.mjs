// tests/tier1_deterministic_sessions.test.mjs
// 数据契约 v2 回归: 会话数据必须是确定性的 (禁止 Date.now() / Math.random()),
// 否则 page/data/*.js 每轮 sync 都会变, "内容未变则不重写" 直接失效。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDaemon, withMockAntigravityTranscript } from "./helpers/daemon_harness.mjs";
import { createTranscriptLine } from "./helpers/fixtures.mjs";

// 旧实现形态: "call_" + Date.now() + "_" + idx + "_" + random
const LEGACY_RANDOM_ID = /call_\d{13}_\d+_[0-9a-z]{1,6}/;

describe("Tier 1 - 会话数据确定性 (禁止时间戳/随机数 id)", () => {
  it("① stableCallId: 同一输入恒定, 不同输入不同, 形态为 call_<10 hex>", async () => {
    const daemon = await loadDaemon();
    assert.equal(typeof daemon.stableCallId, "function", "stableCallId 必须导出");
    assert.equal(typeof daemon.stableHash, "function", "stableHash 必须导出");

    const a1 = daemon.stableCallId("dsh", "session-1", 3, 7, "run_command", '{"cmd":"ls"}');
    const a2 = daemon.stableCallId("dsh", "session-1", 3, 7, "run_command", '{"cmd":"ls"}');
    const b1 = daemon.stableCallId("dsh", "session-1", 3, 8, "run_command", '{"cmd":"ls"}');
    const b2 = daemon.stableCallId("dsh", "session-2", 3, 7, "run_command", '{"cmd":"ls"}');

    assert.equal(a1, a2, "同一输入必须得到同一 id");
    assert.notEqual(a1, b1, "序号不同必须得到不同 id");
    assert.notEqual(a1, b2, "会话不同必须得到不同 id");
    assert.match(a1, /^call_[0-9a-f]{10}$/, "id 形态必须是 call_ + 10 位 sha1");

    // 空值/undefined 也要稳定, 不能抛错
    assert.equal(daemon.stableCallId(), daemon.stableCallId());
    assert.equal(daemon.stableCallId(undefined, null), daemon.stableCallId("", ""));
  });

  it("② antigravity: 同一 transcript 解析两次, 会话 JSON 完全一致且无随机 call id", async () => {
    const lines = [
      createTranscriptLine("USER_INPUT", "请统计 tests/ 目录下的用例数量", { step_index: 1 }),
      createTranscriptLine("PLANNER_RESPONSE", "我先列目录再统计", {
        step_index: 2,
        tool_calls: [
          { name: "run_command", args: { CommandLine: "ls tests/" } },
          { name: "read_file", args: { Path: "tests/helpers/fixtures.mjs" } }
        ]
      }),
      createTranscriptLine("GENERIC", "context-data.js  tier1_a.test.mjs", { step_index: 3, status: "success" }),
      createTranscriptLine("PLANNER_RESPONSE", "共 1 个文件", { step_index: 4 })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const first = parse();
      const second = parse();
      assert.ok(first.turns.length > 0, "fixture 必须解析出轮次");
      assert.equal(JSON.stringify(first), JSON.stringify(second), "同一输入的会话 JSON 必须逐字节一致");
      assert.equal(LEGACY_RANDOM_ID.test(JSON.stringify(first)), false, "不得残留 Date.now()/Math.random() 生成的 call id");

      // 结构化工具调用 id 必须是确定性形态
      const steps = first.dshContext ? first.dshContext.steps : [];
      const ids = [];
      for (const step of steps) {
        for (const tc of step.toolCalls || step.calls || []) {
          if (tc && tc.id) ids.push(tc.id);
        }
      }
      for (const id of ids) {
        assert.match(id, /^call_[0-9a-f]{10}$/, "工具调用 id 必须是确定性哈希: " + id);
      }
    });
  });

  it("③ dsh: 冻结 transcript 后 parseDshSession 两次结果一致且无随机 call id", async () => {
    const HOME = process.env.HOME || "";
    const sessionsPath = path.join(HOME, ".cache/magpie/sessions.json");
    if (!fs.existsSync(sessionsPath)) {
      console.log("[Skip] 没有真实 sessions.json:", sessionsPath);
      return;
    }

    let entries = [];
    try {
      entries = Object.entries(JSON.parse(fs.readFileSync(sessionsPath, "utf8")).files || {});
    } catch (_) {
      entries = [];
    }
    const entry = entries.find(([filePath, meta]) => meta && meta.agent === "dsh" && fs.existsSync(filePath));
    if (!entry) {
      console.log("[Skip] 没有可用的真实 DSH transcript");
      return;
    }

    const [sourcePath, meta] = entry;
    const frozenPath = path.join(os.tmpdir(), "magpie-context-det-" + process.pid + ".jsonl");
    fs.copyFileSync(sourcePath, frozenPath); // 冻结输入: 活跃会话随时在追加, 直接读原文件会导致假阳性
    try {
      const daemon = await loadDaemon();
      const first = daemon.parseDshSession(frozenPath, meta, []);
      const second = daemon.parseDshSession(frozenPath, meta, []);
      const serialized = JSON.stringify(first);
      assert.equal(serialized, JSON.stringify(second), "同一冻结输入必须产出完全一致的会话 JSON");
      assert.equal(LEGACY_RANDOM_ID.test(serialized), false, "不得残留 Date.now()/Math.random() 生成的 call id");
    } finally {
      try {
        fs.rmSync(frozenPath, { force: true });
      } catch (_) {
        /* ignore */
      }
    }
  });
});
