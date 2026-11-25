// tests/tier2_boundary_corner_cases.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withMockAntigravityTranscript,
  referenceVo
} from "./helpers/daemon_harness.mjs";
import {
  createTranscriptLine,
  SHELL_OUTPUT_SAMPLES,
  UNICODE_SAMPLES
} from "./helpers/fixtures.mjs";

describe("Tier 2 - Boundary Conditions & Adversarial Corner Cases", () => {
  describe("Extreme Session Length & Multi-Megabyte Transcripts", () => {
    it("should process 100k+ character session transcripts without buffer overflow or crashing", async () => {
      // Create a 120k char user prompt
      const chunk = "Extensive codebase context analysis with deep dependency tree scanning. \n";
      const hugePrompt = chunk.repeat(Math.ceil(120000 / chunk.length));
      assert.ok(hugePrompt.length >= 120000);

      // Create a 150k char tool output
      const toolChunk = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n";
      const hugeToolOutput = toolChunk.repeat(Math.ceil(150000 / toolChunk.length));
      assert.ok(hugeToolOutput.length >= 150000);

      const lines = [
        createTranscriptLine("USER_INPUT", hugePrompt, { step_index: 0 }),
        createTranscriptLine("PLANNER_RESPONSE", "Processing huge input...", { step_index: 1 }),
        createTranscriptLine("GENERIC", hugeToolOutput, { step_index: 2, status: "success" })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session, "Session must parse without throwing");
        assert.ok(session.turns?.length > 0, "Turn should be created");

        const turn = session.turns[0];
        const userMsg = turn.messages.find(m => m.role === "user");
        const toolMsg = turn.messages.find(m => m.role === "tool_result" || m.role === "tool");

        assert.ok(userMsg, "User message must exist");
        assert.ok(toolMsg, "Tool message must exist");

        // Verify full retention without crash or slice
        assert.equal(userMsg.fullText.length, hugePrompt.length, "Huge prompt must be preserved completely");
        assert.equal(toolMsg.fullText.length, hugeToolOutput.length, "Huge tool output must be preserved completely");
      });
    });
  });

  describe("Empty Sessions & Zero File Operations", () => {
    it("should handle an empty transcript file gracefully without exceptions", async () => {
      const lines = []; // 0 lines

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session, "Empty session should return a valid session object");
        assert.ok(Array.isArray(session.turns), "session.turns must be an array");
        assert.ok(typeof session.watermarkPercent === "number", "Watermark should be a valid number");
        assert.ok(!Number.isNaN(session.watermarkPercent), "Watermark must not be NaN");
      });
    });

    it("should handle session with zero file operations cleanly without breaking dshContext", async () => {
      const lines = [
        createTranscriptLine("USER_INPUT", "What is the capital of France?", { step_index: 0 }),
        createTranscriptLine("PLANNER_RESPONSE", "The capital of France is Paris.", { step_index: 1 })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session, "Session parsed");
        assert.ok(session.dshContext, "dshContext generated");

        const fileOps = session.dshContext.fileOps || [];
        // Zero file ops should not crash and should be an array
        assert.ok(Array.isArray(fileOps), "fileOps must be an array");
      });
    });
  });

  describe("Missing Optional Fields in Transcript Steps", () => {
    it("should handle steps with missing thinking, tool_calls, tokens, and timestamps", async () => {
      // Step missing optional fields
      const minimalLine = JSON.stringify({
        type: "PLANNER_RESPONSE",
        content: "Minimal step without optional metadata"
      });

      const lines = [
        createTranscriptLine("USER_INPUT", "Hello", { step_index: 0 }),
        minimalLine
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session, "Must parse minimal steps");
        const turn = session.turns[0];
        const asstMsg = turn.messages.find(m => m.role === "assistant");
        assert.ok(asstMsg, "Assistant message created");
        assert.ok(typeof asstMsg.tokens === "number", "Tokens should fallback to estimated number");
      });
    });
  });

  describe("Shell Termination Exit Code Regex Parsing (Vo / Ho Inference)", () => {
    for (const sample of SHELL_OUTPUT_SAMPLES) {
      it(`should correctly evaluate: ${sample.name}`, () => {
        const result = referenceVo(sample.raw);
        assert.equal(
          result.fail,
          sample.expectedFail,
          `Expected fail=${sample.expectedFail} for '${sample.name}', got ${result.fail}`
        );
        assert.equal(
          result.exit,
          sample.expectedExit,
          `Expected exit=${sample.expectedExit} for '${sample.name}', got ${result.exit}`
        );
      });
    }
  });

  describe("Unicode, Escaped JSON Strings & Line Break Integrity", () => {
    it("should preserve CJK, emoji, and special typography without corrupting encoding", async () => {
      const complexText = `${UNICODE_SAMPLES.cjk} | ${UNICODE_SAMPLES.emoji}`;

      const lines = [
        createTranscriptLine("USER_INPUT", complexText, { step_index: 0 }),
        createTranscriptLine("PLANNER_RESPONSE", `Echo: ${complexText}`, { step_index: 1 })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        const turn = session.turns[0];
        const userMsg = turn.messages.find(m => m.role === "user");

        assert.equal(userMsg.fullText, complexText, "Unicode text must match character-for-character");
      });
    });

    it("should preserve escaped JSON strings and backslashes in tool outputs", async () => {
      const jsonPayload = UNICODE_SAMPLES.escapedJson;

      const lines = [
        createTranscriptLine("USER_INPUT", "Generate JSON", { step_index: 0 }),
        createTranscriptLine("GENERIC", jsonPayload, { step_index: 1, status: "success" })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        const turn = session.turns[0];
        const toolMsg = turn.messages.find(m => m.role === "tool_result" || m.role === "tool");

        assert.equal(toolMsg.fullText, jsonPayload, "Escaped JSON content must not unescape or mutate");
      });
    });

    it("should preserve exact line breaks (CRLF, LF, multiple blanks) in preformatted outputs", async () => {
      const multiline = UNICODE_SAMPLES.multilineToolOutput;

      const lines = [
        createTranscriptLine("USER_INPUT", "Run multiline script", { step_index: 0 }),
        createTranscriptLine("GENERIC", multiline, { step_index: 1, status: "success" })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        const turn = session.turns[0];
        const toolMsg = turn.messages.find(m => m.role === "tool_result" || m.role === "tool");

        assert.equal(toolMsg.fullText, multiline, "Line breaks must be preserved verbatim");
      });
    });
  });
});
