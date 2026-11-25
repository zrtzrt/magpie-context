// tests/tier1_loading_skeleton.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getStyleCss,
  getIndexHtml,
  getAppJs,
  hasKeyframes
} from "./helpers/dom_harness.mjs";

describe("Tier 1 - Loading Skeleton & Shimmer Animation Experience", () => {
  it("should define skeleton loading keyframe animation (e.g. shimmer or pulse) in style.css", () => {
    const css = getStyleCss();
    const hasShimmerKeyframes = hasKeyframes("shimmer") || hasKeyframes("skeleton-shimmer") || hasKeyframes("pulse");
    const hasShimmerRule = css.includes("@keyframes") && (css.includes("shimmer") || css.includes("skeleton"));

    assert.ok(
      hasShimmerKeyframes || hasShimmerRule,
      "style.css must define @keyframes shimmer/skeleton animation for smooth loading experience"
    );
  });

  it("should define skeleton classes (e.g. .lc-skeleton or .skeleton) in style.css", () => {
    const css = getStyleCss();
    const hasSkeletonClass = css.includes(".lc-skeleton") || css.includes(".skeleton") || css.includes(".loading-shimmer");

    assert.ok(
      hasSkeletonClass,
      "style.css must define skeleton placeholder styles"
    );
  });

  it("should provide skeleton placeholders or loading containers in index.html or app.js", () => {
    const html = getIndexHtml();
    const appJs = getAppJs();

    const hasLoadingPlaceholder = 
      html.includes("skeleton") || 
      html.includes("lc-loading") || 
      appJs.includes("renderSkeleton") || 
      appJs.includes("skeleton");

    assert.ok(
      hasLoadingPlaceholder,
      "Dashboard must support skeleton placeholders during initial load and view transitions"
    );
  });

  it("should handle session switching gracefully without layout breakdown", () => {
    const appJs = getAppJs();
    // Verify that session switching cleans up previous state or shows loading transition
    assert.ok(
      appJs.includes("activeModalSessionId") || appJs.includes("openModal"),
      "app.js must implement session modal state management"
    );
  });
});
