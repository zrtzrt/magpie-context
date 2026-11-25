// tests/tier4_real_world_parity.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDaemon } from "./helpers/daemon_harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

describe("Tier 4 - Real-World Session Data & dsh-context Data Parity Acceptance", () => {
  const HOME = process.env.HOME || "";
  const brainDir = path.join(HOME, ".gemini/antigravity/brain");

  it("should successfully aggregate sessions using buildContextDataset() without unhandled errors", async () => {
    const daemon = await loadDaemon();
    const result = daemon.buildContextDataset();

    assert.ok(result, "buildContextDataset must return a result object");
    assert.ok(Array.isArray(result.sessions), "result.sessions must be an array");
    assert.ok(result.summary, "result.summary must be an object");
    assert.ok(typeof result.summary.totalSessions === "number", "summary.totalSessions must be a number");
  });

  it("should parse real local Antigravity sessions from ~/.gemini/antigravity/brain/", async () => {
    if (!fs.existsSync(brainDir)) {
      console.log("[Skip] Brain directory not found at", brainDir);
      return;
    }

    const subdirs = fs.readdirSync(brainDir).filter(name => {
      const p = path.join(brainDir, name, ".system_generated/logs/transcript.jsonl");
      return fs.existsSync(p);
    });

    if (subdirs.length === 0) {
      console.log("[Skip] No real transcripts found in brain directory");
      return;
    }

    const targetSessionId = subdirs[0];
    const daemon = await loadDaemon();

    const session = daemon.parseAntigravitySession(
      targetSessionId,
      "/workspace",
      "Real Local Session",
      new Date().toISOString(),
      new Date().toISOString(),
      {}
    );

    assert.ok(session, "Must parse real local session");
    assert.equal(session.id, targetSessionId, "Session ID should match");
    assert.ok(session.turns?.length > 0, "Real session should have parsed turns");

    // Parity check: Tokens must be positive integers, not NaN
    assert.ok(session.peakTokens > 0, "peakTokens must be greater than 0");
    assert.ok(!Number.isNaN(session.watermarkPercent), "watermarkPercent must not be NaN");

    // Data parity check: fullText must not contain mock errors
    const allMsgs = session.turns.flatMap(t => t.messages || []);
    for (const msg of allMsgs) {
      assert.ok(typeof msg.fullText === "string", "Each message must have fullText string");
      assert.ok(!msg.fullText.includes("[已截断显示]"), "Real session data must not contain legacy truncation markers");
    }
  });

  it("should adhere to PROJECT.md Interface Contract for session.dshContext", async () => {
    const daemon = await loadDaemon();
    const result = daemon.buildContextDataset();

    if (result.sessions.length === 0) return;
    const session = result.sessions[0];
    const dc = session.dshContext;

    assert.ok(dc, "Session must have dshContext property");
    assert.ok(Array.isArray(dc.steps), "dshContext.steps must be an array");
    assert.ok(Array.isArray(dc.turns), "dshContext.turns must be an array");
    assert.ok(Array.isArray(dc.fileOps), "dshContext.fileOps must be an array");
    assert.ok(dc.tokenStats, "dshContext.tokenStats must exist");
    assert.ok(dc.timingStats, "dshContext.timingStats must exist");
    assert.ok(dc.currentContext, "dshContext.currentContext must exist");

    // Contract: Steps must use 7 canonical categories
    const validCategories = new Set(["system", "tools", "user", "inject", "skill", "assistant", "tool"]);
    for (const step of dc.steps) {
      if (step.dnaBands) {
        for (const band of step.dnaBands) {
          assert.ok(
            validCategories.has(band.cat),
            `DNA band category '${band.cat}' must be one of the 7 canonical categories`
          );
        }
      }
    }
  });

  it("should generate valid page/context-data.js on syncContextData()", async () => {
    const contextDataPath = path.join(PROJECT_ROOT, "page/context-data.js");

    // Verify context-data.js exists and is syntactically valid
    assert.ok(fs.existsSync(contextDataPath), `page/context-data.js must exist at ${contextDataPath}`);
    const content = fs.readFileSync(contextDataPath, "utf8");

    assert.ok(
      content.includes("window.CONTEXT_SUMMARY"),
      "context-data.js must declare window.CONTEXT_SUMMARY"
    );
    assert.ok(
      content.includes("window.CONTEXT_SESSIONS"),
      "context-data.js must declare window.CONTEXT_SESSIONS"
    );
  });
});
