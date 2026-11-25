// tests/helpers/dom_harness.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const HTML_PATH = path.join(PROJECT_ROOT, "page/index.html");
const CSS_PATH = path.join(PROJECT_ROOT, "page/style.css");
const APP_JS_PATH = path.join(PROJECT_ROOT, "page/app.js");

/**
 * Loads and caches index.html content
 */
let cachedHtml = null;
export function getIndexHtml() {
  if (!cachedHtml) {
    cachedHtml = fs.readFileSync(HTML_PATH, "utf8");
  }
  return cachedHtml;
}

/**
 * Loads and caches style.css content
 */
let cachedCss = null;
export function getStyleCss() {
  if (!cachedCss) {
    cachedCss = fs.readFileSync(CSS_PATH, "utf8");
  }
  return cachedCss;
}

/**
 * Loads and caches app.js content
 */
let cachedAppJs = null;
export function getAppJs() {
  if (!cachedAppJs) {
    cachedAppJs = fs.readFileSync(APP_JS_PATH, "utf8");
  }
  return cachedAppJs;
}

/**
 * Checks if a CSS selector is defined in style.css
 */
export function hasCssSelector(selector) {
  const css = getStyleCss();
  // Escape regex special chars except dot, hash, colon, hyphen, etc.
  const escaped = selector.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const regex = new RegExp(`(^|[,}\\s])${escaped}(\\s*[,{])`, "m");
  return regex.test(css) || css.includes(selector);
}

/**
 * Checks if a class name is present in style.css
 */
export function hasCssClass(className) {
  const css = getStyleCss();
  const cleanName = className.startsWith(".") ? className.slice(1) : className;
  const regex = new RegExp(`\\.${cleanName}(?:[\\s,:{.#\\[>]|$)`, "m");
  return regex.test(css);
}

/**
 * Checks if a container query is present in style.css
 */
export function hasContainerQuery(querySnippet) {
  const css = getStyleCss();
  return css.includes("@container") && css.includes(querySnippet);
}

/**
 * Checks if a keyframes animation is defined in style.css
 */
export function hasKeyframes(name) {
  const css = getStyleCss();
  const regex = new RegExp(`@keyframes\\s+${name}`, "m");
  return regex.test(css);
}

/**
 * Extracts all CSS custom property declarations (--variable: value)
 */
export function extractCssVariables() {
  const css = getStyleCss();
  const vars = new Map();
  const regex = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    vars.set(match[1], match[2].trim());
  }
  return vars;
}

/**
 * Validates whether an HTML string contains specified classes or tags
 */
export function containsHtmlElement(html, tagName, className = null) {
  if (!className) {
    const tagRegex = new RegExp(`<${tagName}\\b`, "i");
    return tagRegex.test(html);
  }
  const elementRegex = new RegExp(`<${tagName}\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["']`, "i");
  return elementRegex.test(html);
}
