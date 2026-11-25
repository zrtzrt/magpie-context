// tests/tier1_lossless_parsing.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withMockAntigravityTranscript
} from "./helpers/daemon_harness.mjs";
import {
  createTranscriptLine,
  generateLongUserPrompt,
  generateLongAssistantResponse,
  generateLongToolOutput
} from "./helpers/fixtures.mjs";

describe("Tier 1 - Lossless Transcript Parsing & Arguments Retention", () => {
  it("should preserve user prompts > 5,000 characters without truncation or truncation markers", async () => {
    const longPrompt = generateLongUserPrompt(10000);
    assert.equal(longPrompt.length, 10000, "Fixture length should be 10,000 chars");

    const lines = [
      createTranscriptLine("USER_INPUT", longPrompt, { step_index: 0 })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      assert.ok(session, "Session should be parsed");
      assert.ok(session.turns?.length > 0, "Session should contain at least 1 turn");

      const firstTurn = session.turns[0];
      assert.ok(firstTurn.messages?.length > 0, "First turn should contain messages");

      const userMsg = firstTurn.messages.find(m => m.role === "user");
      assert.ok(userMsg, "Turn should contain a user message");

      // Authoritative Requirement R1: 100% full text preserved without truncation marker
      assert.ok(
        !userMsg.fullText.includes("[超长用户指令已截断显示]"),
        "fullText must NOT contain truncation notice '[超长用户指令已截断显示]'"
      );
      assert.ok(
        !userMsg.fullText.includes("... ["),
        "fullText must NOT be sliced with ellipsis truncation marker"
      );
      assert.equal(
        userMsg.fullText.length,
        10000,
        `fullText length must be exactly 10000 chars, got ${userMsg.fullText.length}`
      );
      assert.equal(userMsg.fullText, longPrompt, "fullText must exactly match original input prompt");
    });
  });

  it("should preserve assistant responses > 8,000 characters (including thinking) without slicing", async () => {
    const { thinking, content } = generateLongAssistantResponse(12000, 2000);
    const totalExpectedChars = thinking.length + content.length;
    assert.ok(totalExpectedChars >= 14000, "Assistant response total size should exceed 14,000 chars");

    const lines = [
      createTranscriptLine("USER_INPUT", "Hello model", { step_index: 0 }),
      createTranscriptLine("PLANNER_RESPONSE", content, {
        step_index: 1,
        thinking,
        output_tokens: 3500
      })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const firstTurn = session.turns[0];
      const asstMsg = firstTurn.messages.find(m => m.role === "assistant");
      assert.ok(asstMsg, "Turn should contain an assistant message");

      // Authoritative Requirement R1: Must retain content > 8,000 chars
      assert.ok(
        asstMsg.fullText.length > 8000,
        `Assistant fullText length must exceed 8,000 characters, got ${asstMsg.fullText.length}`
      );
      assert.ok(
        asstMsg.fullText.includes(content),
        "Assistant fullText must include the entire generated content without slicing"
      );
      assert.ok(
        asstMsg.fullText.includes(thinking) || asstMsg.thinking?.includes(thinking),
        "Assistant message must retain the complete thinking process"
      );
    });
  });

  it("should preserve tool execution outputs > 8,000 characters without truncation marker", async () => {
    const longOutput = generateLongToolOutput(25000);
    assert.equal(longOutput.length, 25000, "Fixture tool output length should be 25,000 chars");

    const lines = [
      createTranscriptLine("USER_INPUT", "Run diagnostic", { step_index: 0 }),
      createTranscriptLine("PLANNER_RESPONSE", "Executing diagnostic...", {
        step_index: 1,
        tool_calls: [{ name: "run_command", args: { CommandLine: "diagnostic.sh" } }]
      }),
      createTranscriptLine("GENERIC", longOutput, { step_index: 2, status: "success" })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const firstTurn = session.turns[0];
      const toolMsg = firstTurn.messages.find(m => m.role === "tool_result" || m.role === "tool");
      assert.ok(toolMsg, "Turn should contain a tool result message");

      // Authoritative Requirement R1: Output must not be truncated
      assert.ok(
        !toolMsg.fullText.includes("[超长工具执行输出已截断显示]"),
        "Tool fullText must NOT contain '[超长工具执行输出已截断显示]'"
      );
      assert.equal(
        toolMsg.fullText.length,
        25000,
        `Tool fullText length must be 25,000 chars, got ${toolMsg.fullText.length}`
      );
      assert.equal(toolMsg.fullText, longOutput, "Tool fullText must match verbatim output");
    });
  });

  it("should retain tool_calls arguments even when respText is non-empty", async () => {
    const targetFile = "/workspace/src/server.ts";
    const replacementCode = "export function startServer() { return true; }";
    const toolArgs = {
      TargetFile: targetFile,
      ReplacementContent: replacementCode,
      Instruction: "Export startServer function"
    };

    const lines = [
      createTranscriptLine("USER_INPUT", "Refactor server.ts", { step_index: 0 }),
      createTranscriptLine("PLANNER_RESPONSE", "I have refactored server.ts with the requested function.", {
        step_index: 1,
        tool_calls: [
          {
            name: "replace_file_content",
            args: toolArgs,
            arguments: toolArgs,
            id: "call_abc123"
          }
        ]
      })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const firstTurn = session.turns[0];
      const asstMsg = firstTurn.messages.find(m => m.role === "assistant");
      assert.ok(asstMsg, "Assistant message must exist");

      // Bug check: (respText || JSON.stringify(step.tool_calls)) dropped tool_calls args
      assert.ok(
        asstMsg.fullText.includes(targetFile) || JSON.stringify(asstMsg).includes(targetFile),
        `Tool call argument '${targetFile}' must be preserved in assistant message payload`
      );
      assert.ok(
        asstMsg.fullText.includes("replace_file_content") || asstMsg.toolCalls?.includes("replace_file_content"),
        "Tool name 'replace_file_content' must be recorded"
      );
    });
  });

  it("should capture SYSTEM_MESSAGE events from transcript into session structure", async () => {
    const systemInstruction = "Operating mode: STRICT_SECURITY. Network access disabled.";

    const lines = [
      createTranscriptLine("SYSTEM_MESSAGE", systemInstruction, { step_index: 0 }),
      createTranscriptLine("USER_INPUT", "Check security policy", { step_index: 1 }),
      createTranscriptLine("PLANNER_RESPONSE", "Security policy is strict.", { step_index: 2 })
    ];

    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      assert.ok(session.turns?.length > 0, "Session turns should exist");

      // Verify that SYSTEM_MESSAGE was captured
      const allMessages = session.turns.flatMap(t => t.messages || []);
      const systemMsg = allMessages.find(m => m.role === "system" && m.fullText.includes(systemInstruction));
      
      assert.ok(
        systemMsg !== undefined,
        "SYSTEM_MESSAGE content must be captured in session messages with role 'system'"
      );
      assert.ok(
        systemMsg.fullText.includes(systemInstruction),
        "System message fullText must preserve the instruction"
      );
    });
  });
});
