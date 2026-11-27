#!/usr/bin/env node
// magpie-context CLI — 把本机会话数据写进 Magpie 实际加载的那份插件目录
//
// 为什么要有这个命令：Magpie 的页面插件跑在 sandbox="allow-scripts" 的沙盒里，
// CSP 是 connect-src 'none' —— 页面读不了磁盘，也发不出任何请求（连同源 fetch 都被拦）。
// 只有页面的插件不会启动插件宿主，所以没有后台进程能替它生成数据。
// 数据只能由这条命令在本机写进 page/，页面再用自己的 <script src> 加载。
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePageDir, magpiePluginsDir, SELF_ROOT } from "./target.mjs";

const USAGE = [
  "",
  "  magpie-context — Magpie 上下文透视插件的本地数据同步",
  "",
  "  Usage:",
  "    magpie-context sync     生成/更新一次数据（写完即退出）",
  "    magpie-context watch    保持同步（轮询变化，安静后自动刷新；Ctrl-C 退出）",
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

// watch 的同步判定: 抽成纯函数, 因为它有一个不写测试就看不出来的坑 ——
// 只看「安静」的话, 用户正在使用 agent 时会话文件一直在写, 安静期永远凑不满,
// 数据在活跃使用期间永不刷新。所以除了安静期, 还要有最大陈旧兜底。
export function shouldSync(state) {
  const {
    signature,
    observed,
    lastSynced,
    stableSince,
    lastSyncAt,
    quietMs,
    maxStaleMs,
    now
  } = state;
  // 数据源还在变化: 只重置安静计时, 不在这里同步（交给下一次 tick 判定）。
  if (signature !== observed) return { action: "reset" };
  // 变化过但还没同步过: 安静期满或陈旧超时就同步。
  if (signature !== lastSynced) {
    const quiet = now - stableSince >= quietMs;
    const stale = now - lastSyncAt >= maxStaleMs;
    if (quiet) return { action: "sync", reason: "quiet" };
    if (stale) return { action: "sync", reason: "stale" };
    return { action: "wait" };
  }
  return { action: "idle" };
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function acquireWatchLock() {
  const dataDir = path.join(target.pageDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".watch.lock");
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (current && current.pid && current.pid !== process.pid && isProcessAlive(current.pid)) return null;
  } catch (_) { /* 无锁或锁损坏: 继续 */ }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return {
    path: lockPath,
    release() {
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (current && current.pid === process.pid) fs.unlinkSync(lockPath);
      } catch (_) { /* already gone */ }
    }
  };
}

function numberArg(name, fallback) {
  const prefix = "--" + name + "=";
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  const value = Number(found.slice(prefix.length));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function runWatch() {
  reportTarget();
  const lock = acquireWatchLock();
  if (!lock) {
    console.error("[magpie-context] 已有另一个 watch 进程在运行，本进程退出（避免重复扫描和写盘）。");
    return;
  }
  const daemon = await loadDaemon();
  const intervalMs = numberArg("interval", 15000);
  const quietMs = numberArg("quiet", 30000);
  // 只在「安静」后同步会有一个致命副作用: 用户正在用 agent 时, 会话文件一直在写,
  // 签名每次都变, 安静期永远凑不满, 数据就永远不刷新 —— 而「正在用」恰恰是最想看
  // 上下文演进的时候。因此再加一条最大陈旧兜底: 超过这个时间即使仍在写入也同步一次。
  //
  // 阈值取 5 分钟而不是更短: 本机一次增量同步实测 67–182 秒（取决于多少会话变了）,
  // 兜底定得太小会让「同步→立刻又过期」连成一片, 占掉一个核。而只要用户停下来,
  // 安静 30 秒那条路径会立刻刷新 —— 兜底只负责「别永远不刷新」, 不需要高频。
  const maxStaleMs = numberArg("max-stale", 300000);
  let stopped = false;
  let timer = null;
  let running = false;
  let lastSynced = "";
  let observed = "";
  let lastSyncAt = Date.now();

  const syncNow = () => {
    if (stopped || running) return;
    running = true;
    try {
      const stats = daemon.syncContextData();
      if (stats) lastSynced = daemon.getDataSourceSignature();
      lastSyncAt = Date.now();
    } finally {
      running = false;
    }
  };

  // 先同步一次: 首次安装或插件更新后 page/data 为空, 必须立即生成。
  syncNow();
  observed = lastSynced;

  let stableSince = Date.now();
  const tick = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      try {
        const now = Date.now();
        const signature = daemon.getDataSourceSignature();
        const decision = shouldSync({
          signature,
          observed,
          lastSynced,
          stableSince,
          lastSyncAt,
          quietMs,
          maxStaleMs,
          now
        });
        if (decision.action === "reset") {
          // 还有文件在写: 重置安静计时, 等用户停止操作后再解析。
          observed = signature;
          stableSince = now;
        } else if (decision.action === "sync") {
          syncNow();
        }
      } catch (error) {
        console.error("[magpie-context] 检查数据源失败:", error.message);
      } finally {
        tick();
      }
    }, intervalMs);
  };
  tick();

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    lock.release();
    console.log("\n[magpie-context] 已停止同步。");
    process.exit(0);
  };
  process.on("exit", lock.release);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("[magpie-context] 正在监视（每 " + Math.round(intervalMs / 1000) + " 秒检查，安静 "
    + Math.round(quietMs / 1000) + " 秒后同步；持续写入时最多 " + Math.round(maxStaleMs / 1000) + " 秒也会同步一次）。Ctrl-C 退出。");
}

/** 与 daemon.mjs 的 resolveHomeDir() 同源逻辑: HOME 缺失时回退 USERPROFILE / os.homedir() */
function resolveHomeDir() {
  const candidates = [process.env.HOME, process.env.USERPROFILE];
  try {
    candidates.push(os.homedir());
  } catch (_) {
    /* ignore */
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const resolved = path.resolve(candidate.trim());
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch (_) {
      /* 继续尝试下一个 */
    }
  }
  return "";
}

async function runDoctor() {
  const home = resolveHomeDir();
  if (home === "") {
    console.log("数据源：");
    console.log("  ✗ 无法确定用户主目录（HOME / USERPROFILE 均不可用），无法定位任何数据源。");
    return;
  }
  if (process.env.HOME !== home) {
    console.log("主目录：\n  " + home + "（HOME 未设置，由 USERPROFILE / os.homedir() 推断）");
  }
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

// 只有被直接执行时才跑 CLI: 否则测试 import 本模块拿 shouldSync 会顺带触发一次
// 全量同步（几十秒 + 写盘），既慢又会污染断言。
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch (_) {
    return false;
  }
})();

const command = process.argv[2] || "sync";
if (invokedDirectly) switch (command) {
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