#!/usr/bin/env node
// 打包前把 page/context-data.js 换成占位索引。
//
// 为什么需要它：
//   1. 索引是本机生成的私有数据（含会话标题、路径、模型），绝不能进 npm 包；
//   2. 但 package.json 的 files 必须包含这个文件，否则装完插件页面 <script src> 直接 404。
//
// 做法：真实索引先备份成 page/.context-data.local.js，再写入占位（带 CONTEXT_DATA_PLACEHOLDER），
// 打包结束由 postpack 的 restore-local.mjs 还原，开发机的数据不会丢。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pageDir = path.resolve(here, "../page");
const indexPath = path.join(pageDir, "context-data.js");
const backupPath = path.join(pageDir, ".context-data.local.js");

if (fs.existsSync(indexPath)) {
  const existing = fs.readFileSync(indexPath, "utf8");
  if (!existing.includes("CONTEXT_DATA_PLACEHOLDER")) {
    fs.copyFileSync(indexPath, backupPath);
    console.error("[ensure-placeholder] 已备份真实索引 → page/.context-data.local.js");
  }
}

const placeholder = [
  "// context-data.js — 打包占位（真实数据由 `npx magpie-context sync` 在本机生成）",
  "// 本文件不含任何会话内容：会话数恒为 0，页面据此显示首次使用引导。",
  "window.CONTEXT_DATA_VERSION = 2;",
  "window.CONTEXT_DATA_PLACEHOLDER = true;",
  "window.CONTEXT_SUMMARY = {",
  "  totalSessions: 0,",
  "  totalTurns: 0,",
  "  totalCompactions: 0,",
  "  maxWatermark: 0,",
  "  totalCacheRead: 0,",
  "  agents: { all: 0, antigravity: 0, dsh: 0, codex: 0, other: 0 },",
  "  updatedAt: \"\"",
  "};",
  "window.CONTEXT_SESSIONS = [];",
  "window.CONTEXT_DETAIL_DIR = \"data\";",
  "window.CONTEXT_DETAIL_FILES = {};",
  ""
].join("\n");

fs.mkdirSync(pageDir, { recursive: true });
fs.writeFileSync(indexPath, placeholder, "utf8");
console.error("[ensure-placeholder] 打包用占位索引已就位");