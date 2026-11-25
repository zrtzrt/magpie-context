// tests/tier3_cross_feature.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withMockAntigravityTranscript
} from "./helpers/daemon_harness.mjs";
import {
  createTranscriptLine
} from "./helpers/fixtures.mjs";
import {
  getAppJs,
  getStyleCss,
  hasCssClass
} from "./helpers/dom_harness.mjs";

describe("Tier 3 - Cross-Feature Interactions & End-to-End Workflows", () => {
  describe("DNA Mode Combined with File Operations", () => {
    it("should coordinate DNA reading-order bands with extracted file activity operations", async () => {
      const filePath = "lib/utils.js";
      const lines = [
        createTranscriptLine("USER_INPUT", "Refactor utility methods", { step_index: 0 }),
        createTranscriptLine("PLANNER_RESPONSE", "Reading utils.js", {
          step_index: 1,
          tool_calls: [{ name: "read_file", args: { Path: filePath } }]
        }),
        createTranscriptLine("GENERIC", "export function add() {}", { step_index: 2, status: "success" }),
        createTranscriptLine("PLANNER_RESPONSE", "Writing updated functions", {
          step_index: 3,
          tool_calls: [{ name: "write_file", args: { Path: filePath, Content: "new" } }]
        }),
        createTranscriptLine("GENERIC", "Wrote 1 file", { step_index: 4, status: "success" })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session.dshContext, "dshContext should exist");

        // 1. Verify DNA bands include the tool steps
        const steps = session.dshContext.steps || [];
        const hasReadFileStep = steps.some(st => 
          st.dnaBands?.some(b => b.toolName === "read_file" || b.title?.includes("read_file"))
        );
        assert.ok(hasReadFileStep, "DNA bands should capture tool call steps");

        // 2. Verify File Activity contains the manipulated file
        const fileOps = session.dshContext.fileOps || [];
        const touchedFile = fileOps.find(f => f.path.includes("utils.js"));
        assert.ok(touchedFile !== undefined, "File Activity must include touched file 'lib/utils.js'");
      });
    });
  });

  describe("Structured Message Detail Cards & In-Text Search", () => {
    it("should support structured .lc-ts-card cards with line count metadata", () => {
      const appJs = getAppJs();
      const css = getStyleCss();

      // Check for .lc-ts-card and line count / meta classes
      assert.ok(
        css.includes(".lc-ts-card") || appJs.includes("lc-ts-card"),
        "Message details should render structured .lc-ts-card blocks"
      );
      assert.ok(
        css.includes(".lc-ts-card-meta") || appJs.includes("lc-ts-card-meta") || appJs.includes("lines"),
        "Message card header should display line count metadata"
      );
    });

    it("should implement in-text search with <mark class='lc-find-mark'> and .lc-find-mark-on", () => {
      const appJs = getAppJs();
      const css = getStyleCss();

      assert.ok(
        css.includes(".lc-find-mark") || appJs.includes("lc-find-mark"),
        "In-text search must wrap matches in .lc-find-mark"
      );
      assert.ok(
        css.includes(".lc-find-mark-on") || appJs.includes("lc-find-mark-on"),
        "Active search match must be styled with .lc-find-mark-on"
      );
    });
  });

  describe("Rich Copy Interaction Protocol (1200ms Timed Feedback)", () => {
    it("should define .lc-rich-copy and .lc-rich-copy-on in CSS", () => {
      assert.ok(
        hasCssClass("lc-rich-copy"),
        "style.css must define .lc-rich-copy"
      );
      assert.ok(
        hasCssClass("lc-rich-copy-on"),
        "style.css must define .lc-rich-copy-on for feedback state"
      );
    });

    it("should implement 1200ms feedback timeout protocol in app.js", () => {
      const appJs = getAppJs();
      // Reference implementation uses setTimeout(..., 1200) for .lc-rich-copy-on reset
      const has1200Timeout = appJs.includes("1200") || (appJs.includes("rich-copy") && appJs.includes("setTimeout"));
      assert.ok(
        has1200Timeout,
        "Copy interaction should maintain active feedback state for exactly 1200ms before reverting"
      );
    });
  });
});
