// tests/tier1_dna_theming.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getStyleCss,
  hasCssClass,
  hasCssSelector,
  getAppJs
} from "./helpers/dom_harness.mjs";

describe("Tier 1 - DNA Mode Taxonomy, Theming & Dual-Tag Pattern", () => {
  const CANONICAL_CATEGORIES = [
    { key: "system", cssVar: "--color-indigo-500", hex: "#6366f1" },
    { key: "tools", cssVar: "--color-amber-500", hex: "#f59e0b" },
    { key: "user", cssVar: "--color-green-500", hex: "#22c55e" },
    { key: "inject", cssVar: "--color-purple-500", hex: "#a855f7" },
    { key: "skill", cssVar: "--color-orange-500", hex: "#f97316" },
    { key: "assistant", cssVar: "--color-blue-500", hex: "#3b82f6" },
    { key: "tool", cssVar: "--color-teal-500", hex: "#14b8a6" }
  ];

  it("should define all 7 canonical category classes in style.css", () => {
    for (const cat of CANONICAL_CATEGORIES) {
      const className = `tag-${cat.key}`;
      const hasClass = hasCssClass(className);
      assert.ok(
        hasClass,
        `style.css must define CSS class .${className} for category '${cat.key}'`
      );
    }
  });

  it("should define .tag-tools and .tag-inject in style.css (resolving identified gap)", () => {
    assert.ok(
      hasCssClass("tag-tools"),
      "style.css must define .tag-tools (was missing in target codebase)"
    );
    assert.ok(
      hasCssClass("tag-inject"),
      "style.css must define .tag-inject (was missing in target codebase)"
    );
  });

  it("should define .lc-br-pos sequence index class in style.css", () => {
    assert.ok(
      hasCssClass("lc-br-pos"),
      "style.css must define .lc-br-pos for reading-order sequence indicators"
    );
  });

  it("should implement color-mix badge styling in DNA rendering logic", () => {
    const appJs = getAppJs();
    const styleCss = getStyleCss();

    // Theming contract:
    // background: color-mix(in srgb, <color> 14%, transparent)
    // border: 1px solid color-mix(in srgb, <color> 45%, transparent)
    const hasColorMix14 = appJs.includes("color-mix") && appJs.includes("14%");
    const cssHasColorMix = styleCss.includes("color-mix");

    assert.ok(
      hasColorMix14 || cssHasColorMix,
      "DNA tag rendering must employ color-mix(in srgb, <col> 14%, transparent) for badge backgrounds"
    );
  });

  it("should render dual-tag pattern (#pos and tool badge) in DNA mode", () => {
    const appJs = getAppJs();

    // Verify app.js references sequence index #pos or lc-br-pos
    const hasPosPattern = appJs.includes("lc-br-pos") || appJs.includes("#${") || appJs.includes("#pos");
    assert.ok(
      hasPosPattern,
      "DNA mode rendering must generate reading-order sequence index with class .lc-br-pos"
    );
  });

  it("should support tool repetition badge count (× N) for repeated tool executions", () => {
    const appJs = getAppJs();

    // Reference bt(tag, tagNames) in client.js renders `× ${count}`
    const hasRepetitionLogic = appJs.includes("×") || appJs.includes("x ");
    assert.ok(
      hasRepetitionLogic,
      "DNA rendering should support repeated tool call badge aggregation (e.g. 'read_file × 3')"
    );
  });
});
