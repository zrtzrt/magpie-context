// tests/empirical_stress_boundary.test.mjs
// Adversarial Empirical Challenge Suite: Stress Testing, Boundary Edge Cases, Parity Verification
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  loadDaemon,
  withMockAntigravityTranscript
} from "./helpers/daemon_harness.mjs";
import { createTranscriptLine } from "./helpers/fixtures.mjs";
import { hasRealSessionData } from "./helpers/real_data.mjs";

// 第二个 describe("syncContextData() Memory & Buffer") 依赖本机真实会话数据,
// CI 无数据时跳过; 第一个合成压力测试不依赖真实数据, 照常运行。
const dReal = hasRealSessionData() ? describe : describe.skip;

describe("Empirical Challenge - Stress Testing & Extreme Boundary Conditions", () => {
  describe("1. Massive Tool Outputs & High-Turn Session Stress", () => {
    it("should process a 15-turn session with massive tool outputs (>100KB each, total >1.5MB) without buffer overflow", async () => {
      const lines = [];
      const turnCount = 15;
      const toolOutputChunk = "LOG_ENTRY: " + "A".repeat(1024) + "\n"; // ~1KB line
      const toolOutput = toolOutputChunk.repeat(120); // ~120KB per turn

      for (let t = 1; t <= turnCount; t++) {
        lines.push(createTranscriptLine("USER_INPUT", `Turn ${t}: Execute high-throughput data dump task`, { step_index: t * 3 - 2 }));
        lines.push(createTranscriptLine("PLANNER_RESPONSE", `Starting high-throughput step ${t}`, {
          step_index: t * 3 - 1,
          tool_calls: [
            {
              name: "run_command",
              args: { CommandLine: `dump_data --turn=${t}` },
              id: `call_${t}`
            }
          ]
        }));
        lines.push(createTranscriptLine("GENERIC", toolOutput, {
          step_index: t * 3,
          status: "success"
        }));
      }

      await withMockAntigravityTranscript(lines, async ({ parse, daemon }) => {
        const startMem = process.memoryUsage().heapUsed;
        const startTime = Date.now();

        const session = parse();
        assert.ok(session, "Session parsed successfully");
        assert.equal(session.turns.length, turnCount, `Must contain ${turnCount} turns`);

        // Check each turn preserves lossless tool output
        for (let t = 0; t < turnCount; t++) {
          const turn = session.turns[t];
          const toolMsg = turn.messages.find(m => m.role === "tool_result" || m.role === "tool");
          assert.ok(toolMsg, `Turn ${t + 1} must have tool result message`);
          assert.equal(toolMsg.fullText.length, toolOutput.length, `Tool message in turn ${t + 1} must be 100% lossless`);
        }

        // Generate DSH context payload
        assert.ok(session.dshContext, "dshContext payload must be generated");
        assert.ok(session.dshContext.steps.length > 0, "Steps must be generated");

        // Verify JSON stringification without ERR_STRING_TOO_LONG
        const serialized = JSON.stringify(session);
        assert.ok(serialized.length > 1000000, `Serialized payload should be > 1MB (actual: ${serialized.length} bytes)`);

        const duration = Date.now() - startTime;
        const memDiffMB = (process.memoryUsage().heapUsed - startMem) / 1024 / 1024;

        // Ensure reasonable execution performance (< 3000ms for 1.8MB transcript)
        assert.ok(duration < 5000, `Processing 1.8MB transcript should complete within 5000ms (took ${duration}ms)`);
      });
    });
  });

  dReal("2. syncContextData() Memory & Buffer Limit Verification", () => {
    it("should execute syncContextData() cleanly and generate an evaluatable v2 index + per-session detail files without ERR_STRING_TOO_LONG", async () => {
      const daemon = await loadDaemon();
      assert.ok(typeof daemon.syncContextData === "function", "syncContextData must be exported");

      // Execute syncContextData()
      daemon.syncContextData();

      const contextDataJsPath = path.resolve(import.meta.dirname, "../page/context-data.js");
      assert.ok(fs.existsSync(contextDataJsPath), "page/context-data.js must exist");

      const fileStats = fs.statSync(contextDataJsPath);
      assert.ok(fileStats.size > 1000, `context-data.js must not be empty (actual: ${fileStats.size} bytes)`);

      // Evaluate the generated file in a sandboxed V8 context
      const fileContent = fs.readFileSync(contextDataJsPath, "utf8");
      const sandbox = { window: {} };
      const ctx = vm.createContext(sandbox);

      assert.doesNotThrow(() => {
        vm.runInContext(fileContent, ctx);
      }, "context-data.js must evaluate in V8 without syntax or runtime error");

      assert.ok(sandbox.window.CONTEXT_SUMMARY, "window.CONTEXT_SUMMARY must be defined");
      assert.ok(sandbox.window.CONTEXT_SESSIONS, "window.CONTEXT_SESSIONS must be defined");
      assert.ok(Array.isArray(sandbox.window.CONTEXT_SESSIONS), "window.CONTEXT_SESSIONS must be an array");

      // 数据契约 v2: dshContext / turns 已下沉到 page/data/<safe>.js, 索引不再内联
      assert.equal(sandbox.window.CONTEXT_DATA_VERSION, 2, "window.CONTEXT_DATA_VERSION must be 2");
      assert.ok(sandbox.window.CONTEXT_DETAIL_FILES, "window.CONTEXT_DETAIL_FILES must be defined");
      const pageDir = path.resolve(import.meta.dirname, "../page");

      for (const s of sandbox.window.CONTEXT_SESSIONS) {
        assert.ok(s.id, "Session must have an ID");
        assert.ok(s.turnsCount >= 0, "turnsCount must be non-negative");
        assert.equal(s.dshContext, undefined, "v2 index must not inline dshContext");
        const relPath = sandbox.window.CONTEXT_DETAIL_FILES[s.id];
        assert.ok(relPath, "Every index session must map to a detail file: " + s.id);
        assert.ok(fs.existsSync(path.resolve(pageDir, relPath)), "Detail file must exist: " + relPath);
      }

      // 抽样(最小的 2 个详情)验证详情里 dshContext 仍完整
      const samples = sandbox.window.CONTEXT_SESSIONS
        .map(s => ({ s, size: fs.statSync(path.resolve(pageDir, sandbox.window.CONTEXT_DETAIL_FILES[s.id])).size }))
        .sort((a, b) => a.size - b.size)
        .slice(0, 2);

      for (const { s } of samples) {
        const detailSandbox = { window: {} };
        vm.runInContext(
          fs.readFileSync(path.resolve(pageDir, sandbox.window.CONTEXT_DETAIL_FILES[s.id]), "utf8"),
          vm.createContext(detailSandbox)
        );
        const detail = detailSandbox.window.CONTEXT_SESSION_DETAIL[s.id];
        assert.ok(detail, "Detail payload must be keyed by session id: " + s.id);
        assert.ok(detail.dshContext, "Session must have dshContext payload");
        assert.ok(Array.isArray(detail.dshContext.curCategories), "curCategories must be an array");
        assert.equal(detail.dshContext.curCategories.length, 7, "curCategories must contain all 7 canonical categories");
      }
    });
  });

  describe("3. Corrupted JSONL Lines & Boundary Malformations", () => {
    it("should gracefully survive syntax errors, truncated JSON lines, binary noise, and null bytes in transcript", async () => {
      const validPrompt = "Valid user prompt after corruption";
      const validResponse = "Valid assistant response after corruption";

      const lines = [
        "", // empty line
        "   ", // whitespace line
        "NOT_JSON_AT_ALL", // completely invalid text
        "{\"type\": \"USER_INPUT\", \"content\": \"truncated unclosed json...", // syntax error: unclosed JSON
        "{\"type\": \"USER_INPUT\", \"content\": \"with\\0null\\0bytes\"}", // null bytes in string
        "null", // JSON literal null
        "123456", // JSON literal number
        "true", // JSON literal boolean
        "[]", // JSON array instead of object
        "{\"foo\": \"bar\"}", // object missing type field
        createTranscriptLine("USER_INPUT", validPrompt, { step_index: 1 }),
        "{\"type\": \"PLANNER_RESPONSE\", \"content\": null, \"tool_calls\": null, \"thinking\": null}", // null fields
        "{\"type\": \"GENERIC\", \"content\": null, \"status\": \"UNKNOWN_STATUS\"}", // null content generic
        createTranscriptLine("PLANNER_RESPONSE", validResponse, { step_index: 2 })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session, "Session parser must not crash on malformed lines");
        assert.ok(session.turns.length > 0, "Valid turns should still be extracted");

        const turn = session.turns[0];
        const userMsg = turn.messages.find(m => m.role === "user");
        assert.ok(userMsg, "Valid user message must be extracted");
        assert.equal(userMsg.fullText, validPrompt, "Valid prompt must match");
      });
    });

    it("should gracefully handle missing optional fields in transcript events without producing NaN or crashes", async () => {
      const lines = [
        JSON.stringify({ type: "SYSTEM_MESSAGE" }), // missing content, created_at
        JSON.stringify({ type: "USER_INPUT" }), // missing content, created_at, step_index
        JSON.stringify({ type: "PLANNER_RESPONSE" }), // missing content, tool_calls, thinking, tokens
        JSON.stringify({ type: "GENERIC" }) // missing content, status
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session, "Session parsed with completely empty fields");
        assert.ok(typeof session.watermarkPercent === "number", "Watermark should be a number");
        assert.ok(!Number.isNaN(session.watermarkPercent), "Watermark must not be NaN");

        if (session.dshContext) {
          assert.ok(Array.isArray(session.dshContext.steps), "Steps must be an array");
          for (const step of session.dshContext.steps) {
            assert.ok(!Number.isNaN(step.totalTokens), "step.totalTokens must not be NaN");
            assert.ok(!Number.isNaN(step.tokenDelta), "step.tokenDelta must not be NaN");
          }
        }
      });
    });
  });

  describe("4. Complex Nested JSON Arguments & Non-Standard Tool Call Invocations", () => {
    it("should accurately extract file operations and details from complex nested arguments and varied parameter namings", async () => {
      const daemon = await loadDaemon();
      const extract = daemon.extractFileOpsFromToolCall;
      assert.ok(typeof extract === "function", "extractFileOpsFromToolCall must be exported");

      // Case A: view_file with string line numbers and AbsolutePath
      const opA = extract("view_file", { AbsolutePath: "/project/src/index.ts", StartLine: "10", EndLine: "50" }, "line1\nline2\n", 1, "12:00:00", 1, "/project");
      assert.equal(opA.length, 1);
      assert.equal(opA[0].kind, "read");
      assert.equal(opA[0].path, "/project/src/index.ts");
      assert.equal(opA[0].detail, "L10-50");
      assert.equal(opA[0].readLines, 41);

      // Case B: edit_file with TargetContent and ReplacementContent (multiline diff)
      const opB = extract("edit_file", {
        TargetFile: "/project/src/util.ts",
        TargetContent: "function oldUtil() {\n  return false;\n}\n",
        ReplacementContent: "function newUtil() {\n  return true;\n  // new line\n  // another\n}\n",
        Instruction: "Refactor oldUtil"
      }, "Replaced successfully", 2, "12:01:00", 2, "/project");
      assert.equal(opB.length, 1);
      assert.equal(opB[0].kind, "write");
      assert.equal(opB[0].path, "/project/src/util.ts");
      assert.equal(opB[0].removed, 4);
      assert.equal(opB[0].added, 6);
      assert.equal(opB[0].detail, "Refactor oldUtil");

      // Case C: run_command with complex pipe and cat
      const opC = extract("run_command", {
        CommandLine: "cat /project/package.json | grep version"
      }, "  \"version\": \"1.0.0\",\n", 3, "12:02:00", 3, "/project");
      assert.equal(opC.length, 1);
      assert.equal(opC[0].kind, "read");
      assert.equal(opC[0].path, "/project/package.json");
      assert.equal(opC[0].readLines, 2);

      // Case D: tool call with deeply nested arguments
      const nestedArgs = {
        meta: {
          config: {
            deep: {
              TargetFile: "nested/config.json",
              content: "{\"nested\": true}"
            }
          }
        },
        TargetFile: "actual/config.json",
        Content: "{\n  \"key\": \"value\"\n}"
      };
      const opD = extract("write_to_file", nestedArgs, "File created", 4, "12:03:00", 4, "/project");
      assert.equal(opD.length, 1);
      assert.equal(opD[0].kind, "write");
      assert.equal(opD[0].path, "/project/actual/config.json");
      assert.equal(opD[0].added, 3);
    });
  });

  describe("5. Parity & Resilience on Real Transcripts in the Environment", () => {
    it("should parse the massive real 4.8MB Antigravity transcript cleanly and completely", async () => {
      const daemon = await loadDaemon();
      const largeSessionId = "d46cf712-6efe-4d49-b383-129955b5f8f8";
      const transcriptPath = path.join(process.env.HOME, `.gemini/antigravity/brain/${largeSessionId}/.system_generated/logs/transcript.jsonl`);

      if (!fs.existsSync(transcriptPath)) {
        console.warn(`[Skip] Large transcript file not found at ${transcriptPath}`);
        return;
      }

      const stats = fs.statSync(transcriptPath);
      assert.ok(stats.size > 4000000, `Expected >4MB transcript (actual: ${stats.size} bytes)`);

      const startTime = Date.now();
      const session = daemon.parseAntigravitySession(
        largeSessionId,
        "/Users/reno/Documents/code/tools",
        "Real 4.8MB Session",
        new Date().toISOString(),
        new Date().toISOString(),
        { input: 100000, output: 20000, cwd: "/Users/reno/Documents/code/tools" },
        []
      );

      const dshPayload = daemon.buildDshContextPayload(session);
      const parseDuration = Date.now() - startTime;

      assert.ok(session, "Must parse real 4.8MB session");
      assert.ok(session.turns.length > 0, "Must extract real turns");
      assert.ok(dshPayload, "Must build dshPayload for real session");
      assert.ok(dshPayload.steps.length > 0, "Steps must be generated");

      // Verify no NaN values in steps or turns
      for (const st of dshPayload.steps) {
        assert.ok(!Number.isNaN(st.totalTokens), "step.totalTokens must not be NaN");
        assert.ok(!Number.isNaN(st.tokenDelta), "step.tokenDelta must not be NaN");
        assert.ok(typeof st.durationSec === "number" && !Number.isNaN(st.durationSec), "durationSec must be valid");
      }

      // Check serialization survives
      const jsonStr = JSON.stringify({ session, dshPayload });
      assert.ok(jsonStr.length > 100000, `Serialized payload should be substantial`);
      assert.ok(parseDuration < 10000, `Parsing 4.8MB transcript took ${parseDuration}ms (must be under 10s)`);
    });

    it("should parse the real parent session (orchestrator session) cleanly", async () => {
      const daemon = await loadDaemon();
      const parentSessionId = "adade1d9-a7bc-4343-8865-4b7fa8bc8f1f";
      const transcriptPath = path.join(process.env.HOME, `.gemini/antigravity/brain/${parentSessionId}/.system_generated/logs/transcript.jsonl`);

      if (!fs.existsSync(transcriptPath)) {
        console.warn(`[Skip] Parent transcript file not found at ${transcriptPath}`);
        return;
      }

      const session = daemon.parseAntigravitySession(
        parentSessionId,
        "/Users/reno/Documents/code/tools",
        "Parent Orchestrator Session",
        new Date().toISOString(),
        new Date().toISOString(),
        { cwd: "/Users/reno/Documents/code/tools" },
        []
      );

      assert.ok(session, "Parent session must parse");
      assert.ok(session.turns.length > 0, "Parent session must have turns");
      const dshPayload = daemon.buildDshContextPayload(session);
      assert.ok(dshPayload, "dshPayload must exist");
      assert.ok(dshPayload.fileOps.length >= 0, "fileOps array must exist");
    });
  });
});
