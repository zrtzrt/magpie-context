#!/usr/bin/env node
// magpie-context CLI — 把本机会话数据写进插件自己的 page 目录
//
// Magpie 的页面插件跑在 sandbox="allow-scripts" 的沙盒里，CSP 是 connect-src 'none'，
// 页面既读不了磁盘也发不出请求（连 fetch 都被拦）。所以实时数据只能由用户侧命令生成，
// 页面再用自己的 <script src> 加载。这正是 magpie-models-price 用的模式。
import process from "node:process";

const USAGE = [
  "",
  "  magpie-context — Magpie 上下文透视插件的本地数据同步",
  "",
  "  Usage:",
  "    magpie-context sync     生成/更新一次数据（写完即退出）",
  "    magpie-context watch    保持同步（每 5 秒一次，Ctrl-C 退出）",
  "    magpie-context doctor   检查数据源与输出是否就绪",
  "    magpie-context --help   显示本帮助",
  "",
  "  数据只写在本插件目录内，不上传、不联网。",
  ""
].join("\n");

async function loadDaemon() {
  // daemon.mjs 是唯一的解析与写盘实现；这里不复制逻辑，直接复用。
  return import("../daemon.mjs");
}

async function runSync() {
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
    console.warn("  ~/.dsh/  ·  ~/.codex/  ·  Antigravity 数据目录");
    console.warn("写出的索引是空的，页面会显示「还没有本地数据」。");
  } else {
    console.log("[magpie-context] 完成：重新打开 Magpie 的「上下文」页即可看到数据。");
  }
}

async function runWatch() {
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
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = os.homedir();
  const sources = [
    ["Magpie 用量", path.join(home, ".config/magpie/usage.jsonl")],
    ["Magpie 会话", path.join(home, ".cache/magpie/sessions.json")],
    ["DSH", path.join(home, ".dsh")],
    ["Codex", path.join(home, ".codex")]
  ];
  console.log("数据源：");
  for (const [label, p] of sources) {
    let ok = false;
    try { ok = fs.existsSync(p); } catch (e) { ok = false; }
    console.log("  " + (ok ? "✓" : "·") + " " + label.padEnd(12) + p);
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const indexPath = path.join(here, "../page/context-data.js");
  let size = 0;
  try { size = fs.statSync(indexPath).size; } catch (e) { size = 0; }
  console.log("输出：");
  console.log("  " + (size > 0 ? "✓" : "·") + " page/context-data.js " + (size ? size + " bytes" : "（尚未生成）"));
  if (!size) console.log("\n跑一次 `npx magpie-context sync` 生成索引。");
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