// tests/tier1_file_activity_dom.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getStyleCss,
  hasCssClass,
  hasContainerQuery,
  getAppJs,
  getIndexHtml
} from "./helpers/dom_harness.mjs";
import {
  withMockAntigravityTranscript
} from "./helpers/daemon_harness.mjs";
import {
  createTranscriptLine
} from "./helpers/fixtures.mjs";

describe("Tier 1 - File Activity DOM Hierarchy, CSS Rules & Extraction", () => {
  describe("File Activity CSS Rules Alignment (56 Ruleset Coverage)", () => {
    const REQUIRED_FA_CLASSES = [
      "lc-fa-card",
      "lc-fa-ctl",
      "lc-fa-search",
      "lc-fa-sort",
      "lc-fa-n",
      "lc-fa-meta",
      "lc-fa-meta-delta",
      "lc-fa-meta-tip",
      "lc-fa-list",
      "lc-fa-slot",
      "lc-fa-item",
      "lc-fa-item-on",
      "lc-fa-item-alt",
      "lc-fa-row",
      "lc-fa-toggle",
      "lc-fa-form",
      "lc-fa-lang",
      "lc-fa-path",
      "lc-fa-file",
      "lc-fa-badge",
      "lc-fa-b-read",
      "lc-fa-b-write",
      "lc-fa-b-search",
      "lc-fa-chips",
      "lc-fa-chip-read",
      "lc-fa-chip-write",
      "lc-fa-chip-search",
      "lc-fa-chip-all",
      "lc-fa-delta",
      "lc-fa-up",
      "lc-fa-down",
      "lc-fa-time",
      "lc-fa-ops",
      "lc-fa-op",
      "lc-fa-op-link",
      "lc-fa-op-meta",
      "lc-fa-op-time",
      "lc-fa-op-tool",
      "lc-fa-op-detail",
      "lc-fa-read"
    ];

    for (const cls of REQUIRED_FA_CLASSES) {
      it(`should define .${cls} in page/style.css`, () => {
        assert.ok(
          hasCssClass(cls),
          `page/style.css must define .${cls} matching reference implementation`
        );
      });
    }

    it("should implement container query @container lc-card (width <= 380px) for responsive card wrapping", () => {
      assert.ok(
        hasContainerQuery("width <= 380px") || hasContainerQuery("380px"),
        "page/style.css must define container query '@container lc-card (width <= 380px)'"
      );
    });

    it("should use .lc-fa-delta, .lc-fa-up, .lc-fa-down (not deprecated .fa-delta) in HTML/JS templates", () => {
      const html = getIndexHtml();
      const appJs = getAppJs();

      // Ensure new standard classes are present
      assert.ok(
        html.includes("lc-fa-delta") || appJs.includes("lc-fa-delta"),
        "Templates must use .lc-fa-delta"
      );
      assert.ok(
        html.includes("lc-fa-up") || appJs.includes("lc-fa-up"),
        "Templates must use .lc-fa-up"
      );
      assert.ok(
        html.includes("lc-fa-down") || appJs.includes("lc-fa-down"),
        "Templates must use .lc-fa-down"
      );
    });
  });

  describe("File Activity Nested Operations DOM Structure", () => {
    it("should render detailed .lc-fa-op list instead of static 3-line mock summary", () => {
      const appJs = getAppJs();

      // Check that app.js references .lc-fa-op and operation details
      assert.ok(
        appJs.includes("lc-fa-op") && (appJs.includes("lc-fa-op-tool") || appJs.includes("lc-fa-op-link")),
        "renderFilesCard must generate .lc-fa-op items with .lc-fa-op-tool and .lc-fa-op-detail"
      );
    });

    it("should render operation badges with <i></i> dot icon (.lc-fa-b-read/write/search)", () => {
      const appJs = getAppJs();
      assert.ok(
        appJs.includes("lc-fa-b-read") || appJs.includes("lc-fa-b-write"),
        "Operation badges must use .lc-fa-b-read and .lc-fa-b-write classes"
      );
    });

    it("should toggle item active class .lc-fa-item-on upon row expansion", () => {
      const appJs = getAppJs();
      assert.ok(
        appJs.includes("lc-fa-item-on") || appJs.includes("item-on"),
        "Expanding a file row must apply .lc-fa-item-on"
      );
    });
  });

  describe("Real File Activity Data Extraction", () => {
    it("should extract real file operations from tool calls without injecting mock fallbacks", async () => {
      const targetPath = "src/services/auth.ts";
      const lines = [
        createTranscriptLine("USER_INPUT", "Update authentication service", { step_index: 0 }),
        createTranscriptLine("PLANNER_RESPONSE", "Reading auth.ts...", {
          step_index: 1,
          tool_calls: [
            {
              name: "read_file",
              args: { AbsolutePath: `/Users/reno/project/${targetPath}`, StartLine: 1, EndLine: 50 }
            }
          ]
        }),
        createTranscriptLine("GENERIC", "// 50 lines of code...", { step_index: 2, status: "success" }),
        createTranscriptLine("PLANNER_RESPONSE", "Applying updates...", {
          step_index: 3,
          tool_calls: [
            {
              name: "replace_file_content",
              args: {
                TargetFile: `/Users/reno/project/${targetPath}`,
                TargetContent: "old",
                ReplacementContent: "new\nadded line 1\nadded line 2"
              }
            }
          ]
        }),
        createTranscriptLine("GENERIC", "Changes applied successfully.", { step_index: 4, status: "success" })
      ];

      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        assert.ok(session.dshContext, "dshContext must exist on parsed session");

        const fileOps = session.dshContext.fileOps || [];
        // The real target file should be captured
        const authFile = fileOps.find(f => f.path.includes("auth.ts"));
        assert.ok(
          authFile !== undefined,
          `fileOps must extract real touched file '${targetPath}'`
        );
        assert.ok(
          authFile.reads > 0 || authFile.writes > 0,
          "Extracted file activity must record read/write operations"
        );

        // Verify that static mock files (clean_patcher.py, apply_clean_patch.py) are NOT injected when real ops exist
        const hasMockFile = fileOps.some(f => f.path.includes("clean_patcher.py") || f.path.includes("apply_clean_patch.py"));
        assert.ok(
          !hasMockFile,
          "fileOps must not inject static mock files (e.g. clean_patcher.py) when real session operations exist"
        );
      });
    });
  });
});
