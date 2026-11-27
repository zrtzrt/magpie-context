// 增量解析缓存: 首次全量、无变化命中、源文件变化失效、缓存损坏回退。
// 关键保证: 缓存命中的输出必须与全量解析一致 (timeAgo 除外, 它是纯派生字段)。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDaemon } from "./helpers/daemon_harness.mjs";
import { createTranscriptLine } from "./helpers/fixtures.mjs";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-parse-cache-"));
const pageDir = path.join(tmpHome, "page");
const sessionId = "cache-test-session";
const logDir = path.join(tmpHome, ".gemini/antigravity/brain", sessionId, ".system_generated/logs");
const transcriptPath = path.join(logDir, "transcript.jsonl");
const detailPath = path.join(pageDir, "data", `${sessionId}.js`);
const cachePath = path.join(pageDir, "data", ".parse-cache.json");

fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(
  transcriptPath,
  [
    createTranscriptLine("USER_INPUT", "<USER_REQUEST>cache test</USER_REQUEST>", { step_index: 1 }),
    createTranscriptLine("PLANNER_RESPONSE", "cache test response", { step_index: 2 })
  ].join("\n") + "\n",
  "utf8"
);

process.env.HOME = tmpHome;
process.env.MAGPIE_CONTEXT_PAGE_DIR = pageDir;
const daemon = await loadDaemon();

function readCache() {
  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

function readDetailSession() {
  const text = fs.readFileSync(detailPath, "utf8");
  const start = text.indexOf(" = ");
  const end = text.lastIndexOf(";");
  return JSON.parse(text.slice(start + 3, end));
}

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("首次 sync 全量解析并写入 parse-cache", () => {
  const stats = daemon.syncContextData();
  assert.ok(stats, "syncContextData should return stats");
  assert.equal(stats.sessionCount, 1);
  const cache = readCache();
  assert.equal(cache.version, 1);
  const keys = Object.keys(cache.entries).filter((key) => key.startsWith("antigravity:"));
  assert.equal(keys.length, 1, "should cache the antigravity session");
  assert.match(cache.entries[keys[0]].fingerprint, /^[0-9a-f]{40}$/);
});

test("源文件未变化时全量命中且详情分片不重写", () => {
  const before = fs.readFileSync(detailPath, "utf8");
  const dataset = daemon.buildContextDataset();
  assert.deepEqual(dataset.cacheStats, { hits: 1, misses: 0 });
  const stats = daemon.writeContextDataset(dataset.sessions, dataset.summary);
  assert.equal(stats.written, 0);
  assert.equal(stats.unchanged, 1);
  assert.equal(fs.readFileSync(detailPath, "utf8"), before);
});

test("缓存命中的会话内容与全量解析一致 (timeAgo 除外)", () => {
  const cached = daemon.buildContextDataset();
  const cachedSession = cached.sessions.find((session) => session.id === sessionId);
  assert.ok(cachedSession);
  const normalizedCached = Object.assign({}, cachedSession, { timeAgo: "" });
  // start/last 必须与建缓存时用的值一致, 否则这个用例在跨秒边界上会偶发失败 ——
  // startTime/lastTime 是 formatTime(start)/formatTime(last) 的直接派生,
  // 用 new Date() 现场取时间, 缓存里存的是上一秒, 两者必然不等 (CI 上真实发生过:
  // ubuntu/Windows + Node 22 报 07:31:02 vs 07:31:01, 与代码正确性无关)。
  // 直接从缓存里的 "YYYY-MM-DD HH:MM:SS" 还原本地时间, 保证 formatTime 得到同一个值。
  const fromClockText = (text) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text || ""));
    if (!m) return new Date(1794469443975).toISOString();
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
  };
  const cachedStart = cachedSession.startTime;
  const cachedLast = cachedSession.lastTime;
  const fullSession = daemon.parseAntigravitySession(
    sessionId,
    "",
    "cache test",
    fromClockText(cachedStart),
    fromClockText(cachedLast),
    { agent: "antigravity", id: sessionId },
    []
  );
  if (!fullSession.dshContext && daemon.buildDshContextPayload) {
    fullSession.dshContext = daemon.buildDshContextPayload(fullSession);
  }
  if (daemon.linkFleetSubagentSessions) {
    daemon.linkFleetSubagentSessions([fullSession], new Set([sessionId]));
  }
  const normalizedFull = Object.assign({}, fullSession, { timeAgo: "" });
  assert.equal(JSON.stringify(normalizedCached), JSON.stringify(normalizedFull));
});

test("源文件变化后缓存失效并重新解析", () => {
  fs.appendFileSync(
    transcriptPath,
    createTranscriptLine("USER_INPUT", "<USER_REQUEST>second turn</USER_REQUEST>", { step_index: 3 }) + "\n",
    "utf8"
  );
  const dataset = daemon.buildContextDataset();
  assert.deepEqual(dataset.cacheStats, { hits: 0, misses: 1 });
  // 重新 sync 应刷新缓存
  const stats = daemon.syncContextData();
  assert.equal(stats.sessionCount, 1);
  const cache = readCache();
  const keys = Object.keys(cache.entries).filter((key) => key.startsWith("antigravity:"));
  assert.equal(keys.length, 1);
  assert.equal(fs.readFileSync(detailPath, "utf8").includes("second turn"), true);
});

test("parse-cache 损坏时回退全量解析", () => {
  fs.writeFileSync(cachePath, "{broken", "utf8");
  const dataset = daemon.buildContextDataset();
  assert.deepEqual(dataset.cacheStats, { hits: 0, misses: 1 });
});
