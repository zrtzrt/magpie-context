// tests/helpers/fixtures.mjs
// Test fixtures for E2E and unit test suites (opaque-box testing)

/**
 * Generates a mock Antigravity transcript line (JSON string)
 */
export function createTranscriptLine(type, content, extra = {}) {
  const lineObj = {
    step_index: extra.step_index ?? 1,
    created_at: extra.created_at ?? new Date().toISOString(),
    source: extra.source ?? (type === "USER_INPUT" ? "USER" : (type === "PLANNER_RESPONSE" ? "MODEL" : "SYSTEM")),
    type,
    content,
    ...extra
  };
  return JSON.stringify(lineObj);
}

/**
 * 10,000-character user prompt fixture
 */
export function generateLongUserPrompt(charCount = 10000) {
  const base = "Please analyze the complete codebase architecture and identify all bottlenecks. ";
  const repeatCount = Math.ceil(charCount / base.length);
  const full = base.repeat(repeatCount).slice(0, charCount);
  return full;
}

/**
 * 12,000-character assistant response fixture with thinking
 */
export function generateLongAssistantResponse(charCount = 12000, thinkingCount = 2000) {
  const thinkBase = "Evaluating system constraints, memory thresholds, and execution pathways. ";
  const thinking = thinkBase.repeat(Math.ceil(thinkingCount / thinkBase.length)).slice(0, thinkingCount);

  const respBase = "Here is the detailed architectural breakdown and code transformation plan:\n";
  const content = respBase + "const x = 1;\n".repeat(Math.ceil(charCount / 13)).slice(0, charCount);

  return { thinking, content };
}

/**
 * 20,000-character tool output fixture
 */
export function generateLongToolOutput(charCount = 20000) {
  const rowBase = "2026-11-12 14:00:00 [INFO] Worker pool initialized with 16 threads. Status: OK\n";
  return rowBase.repeat(Math.ceil(charCount / rowBase.length)).slice(0, charCount);
}

/**
 * Shell output samples with termination markers for Vo / Ho testing (per client.js:369143)
 */
export const SHELL_OUTPUT_SAMPLES = [
  {
    name: "Shell exited code 0",
    raw: "Build finished\n[shell exited: code 0]",
    expectedFail: false,
    expectedExit: null
  },
  {
    name: "Shell exited code 2",
    raw: "Build failed\n[shell exited: code 2]",
    expectedFail: true,
    expectedExit: 2
  },
  {
    name: "Exit code 1 standard error",
    raw: "Error: cannot find module 'express'\n[exit code: 1]",
    expectedFail: true,
    expectedExit: 1
  },
  {
    name: "Exit code 127 command not found",
    raw: "bash: line 1: zstd: command not found\n[exit code: 127]",
    expectedFail: true,
    expectedExit: 127
  },
  {
    name: "Killed by signal SIGKILL",
    raw: "Process terminated\n[shell killed by signal: SIGKILL]",
    expectedFail: true,
    expectedExit: null
  },
  {
    name: "Status killed with timeout",
    raw: "Execution exceeded timeout\n[status: killed, timeout after 30s]",
    expectedFail: true,
    expectedExit: null
  },
  {
    name: "Status failed",
    raw: "Operation failed\n[status: failed]",
    expectedFail: true,
    expectedExit: null
  },
  {
    name: "Normal output without exit markers",
    raw: "All 42 tests passed.",
    expectedFail: false,
    expectedExit: null
  }
];

/**
 * Unicode and escaping stress test samples
 */
export const UNICODE_SAMPLES = {
  cjk: "这是一个包含中文字符和特殊标点符号的测试指令：『测试』、“引号”、——破折号。",
  emoji: "🚀 🧬 🧪 📦 🏗️ ⚙️ 📝 📊 📕 🗜️ 🎬 🗄️",
  escapedJson: "{\"key\": \"value with \\\"quotes\\\" and \\n newlines and \\\\ backslashes\"}",
  htmlChars: "<script>alert('xss')</script><div class=\"test\">&amp;</div>",
  multilineToolOutput: "line 1\r\nline 2\r\n\r\nline 4\nline 5\n"
};
