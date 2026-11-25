#!/usr/bin/env node
// magpie-context CLI — 把本机会话数据写进 Magpie 实际加载的那份插件目录
//
// 为什么要有这个命令：Magpie 的页面插件跑在 sandbox="allow-scripts" 的沙盒里，
// CSP 是 connect-src 'none' —— 页面读不了磁盘，也发不出任何请求（连同源 fetch 都被拦）。
// 只有页面的插件不会启动插件宿主，所以没有后台进程能替它生成数据。
// 数据只能由这条命令在本机写进 page/，页面再用自己的 <script src> 加载。
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { resolvePageDir, magpiePluginsDir, SELF_ROOT } from "./target.mjs";

const USAGE = [
  "",
  "  magpie-context — Magpie 上下文透视插件的本地数据同步",
  "",
  "  Usage:",
  "    magpie-context sync     生成/更新一次数据（写完即退出）",
  "    magpie-context watch    保持同步（每 5 秒一次，Ctrl-C 退出）",
  "    magpie-context doctor   检查数据源、输出位置与写入目标",
  "    magpie-context --help   显示本帮助",
  "",
  "  数据只写在本机的插件目录内，不上传、不联网。",
  ""
].join("\n");

// daemon.mjs 在模块顶层读取 MAGPIE_CONTEXT_PAGE_DIR，必须 import 之前设好
const target = resolvePageDir();
process.env.MAGPIE_CONTEXT_PAGE_DIR = target.pageDir;

const indexPath = path.join(target.pageDir, "context-data.js");

async function loadDaemon() {
  // daemon.mjs 是唯一的解析与写盘实现，这里不复制逻辑
  return import("../daemon.mjs");
}

function reportTarget() {
  console.log("[magpie-context] 写入目标：" + target.pageDir + "（" + target.source + "）");
}

async function runSync() {
  reportTarget();
  const daemon = await loadDaemon();
  const stats = daemon.syncContextData();
  if (!stats) {
    console.error("[magpie-context] 同步失败，详见上面的错误信息。");
    process.exitCode = 1;
    return;
  }
  if (stats.sessionCount === 0) {
    console.warn("[magpie-context] 没有读到任何会话。确认这些路径里有日志：");
    console.warn("  ~/.config/magpie/usage.jsonl");
    console.warn("  ~/.cache/magpie/sessions.json");
    console.warn("  ~/.dsh/ · ~/.codex/ · ~/.gemini/antigravity/");
    console.warn("索引已写出但为空，页面会显示「还没有本地数据」。");
    return;
  }
  console.log("[magpie-context] 完成。「上下文」页里点右上角刷新（或重开页面）即可看到数据。");
}

async function runWatch() {
  reportTarget();
  const daemon = await loadDaemon();
  daemon.syncContextData();
  const timer = setInterval(() => daemon.syncContextData(), 5000);
  const stop = () => {
    clearInterval(timer);
    console.log("\n[magpie-context] 已停止同步。");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("[magpie-context] 正在同步（每 5 秒）。Ctrl-C 退出。");
}

async function runDoctor() {
  const home = process.env.HOME || "";
  const sources = [
    ["Magpie 用量", path.join(home, ".config/magpie/usage.jsonl")],
    ["Magpie 会话", path.join(home, ".cache/magpie/sessions.json")],
    ["DSH", path.join(home, ".dsh")],
    ["Codex", path.join(home, ".codex")],
    ["Antigravity", path.join(home, ".gemini/antigravity")]
  ];
  console.log("数据源：");
  for (const [label, p] of sources) {
    let ok = false;
    try { ok = fs.existsSync(p); } catch { ok = false; }
    console.log("  " + (ok ? "✓" : "·") + " " + label.padEnd(12) + p);
  }

  console.log("写入目标：");
  console.log("  " + target.pageDir + "（" + target.source + "）");
  console.log("  当前命令所在：" + SELF_ROOT);
  if (target.source === "当前插件目录" && fs.existsSync(magpiePluginsDir())) {
    console.log("  ! Magpie 插件目录里也有一份：" + magpiePluginsDir());
    console.log("    如果那份才是 magpie 实际加载的，用 MAGPIE_CONTEXT_PAGE_DIR 指过去。");
  }

  let size = 0;
  try { size = fs.statSync(indexPath).size; } catch { size = 0; }
  let placeholder = false;
  if (size > 0) {
    try { placeholder = fs.readFileSync(indexPath, "utf8").includes("CONTEXT_DATA_PLACEHOLDER"); } catch { placeholder = false; }
  }
  console.log("输出：");
  if (size === 0) {
    console.log("  · context-data.js 尚未生成");
    console.log("\n跑一次 `npx magpie-context sync` 生成索引。");
  } else if (placeholder) {
    console.log("  · context-data.js " + size + " bytes（占位索引，还没有本地数据）");
    console.log("\n跑一次 `npx magpie-context sync` 生成真实索引。");
  } else {
    console.log("  ✓ context-data.js " + size + " bytes（真实索引）");
    let details = 0;
    try {
      const dir = path.join(target.pageDir, "data");
      details = fs.readdirSync(dir).filter(f => f.endsWith(".js")).length;
    } catch { details = 0; }
    console.log("  " + (details > 0 ? "✓" : "·") + " page/data/ " + details + " 个会话详情分片");
  }
}

const command = process.argv[2] || "sync";
switch (command) {
  case "sync":
  case "--once":
    await runSync();
    break;
  case "watch":
    await runWatch();
    break;
  case "doctor":
    await runDoctor();
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(USAGE);
    break;
  default:
    console.error("未知命令：" + command);
    console.log(USAGE);
    process.exitCode = 1;
}