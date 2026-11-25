// tests/tier1_lazy_data_split.test.mjs
// 数据契约 v2 验收: 轻量索引 + 每会话懒加载详情 (见 CONTRACT.md 『数据契约 (v2)』)
//
// 说明: 生成物是共享状态 (page/context-data.js + page/data/*.js), 而 node --test 会并行跑多个测试文件。
// 为了不被其它测试文件的 syncContextData() 互相覆盖, 这里通过 MAGPIE_CONTEXT_PAGE_DIR 把输出目录
// 重定向到临时目录 (daemon 的测试专用出口, 默认行为不变), 另有一条集成用例检查真实 page/ 产物。
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadDaemon } from "./helpers/daemon_harness.mjs";
import { hasRealSessionData } from "./helpers/real_data.mjs";

// 数据契约 v2 的"真实产物"验收需要本机会话数据,CI 无数据时整组跳过。
const dReal = hasRealSessionData() ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REAL_PAGE_DIR = path.join(PROJECT_ROOT, "page");

// 必须在 loadDaemon() 之前设置 (daemon.mjs 在 import 时读取)
const ISOLATED_PAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-context-v2-"));
process.env.MAGPIE_CONTEXT_PAGE_DIR = ISOLATED_PAGE_DIR;

const PAGE_DIR = ISOLATED_PAGE_DIR;
const INDEX_PATH = path.join(PAGE_DIR, "context-data.js");
const DETAIL_DIR = path.join(PAGE_DIR, "data");

const INDEX_SIZE_LIMIT = 1.5 * 1024 * 1024; // 合同: 索引目标 < 1.5MB

/** 在沙箱里执行生成物, 返回 window (与浏览器一致的 ||= / 全局写法) */
function evaluateWindow(source, label) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 120000, filename: label });
  return sandbox.window;
}

function readWindowFromFile(absPath) {
  return evaluateWindow(fs.readFileSync(absPath, "utf8"), absPath);
}

/** 确定性伪随机 (固定种子), 保证测试可复现 */
function pickIndices(total, count, seed = 20261113) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const picked = new Set();
  const limit = Math.min(count, total);
  while (picked.size < limit) picked.add(Math.floor(next() * total));
  return [...picked];
}

const json = (value) => JSON.parse(JSON.stringify(value));

dReal("Tier 1 - 数据契约 v2: 轻量索引 + 每会话懒加载详情", () => {
  let daemon;
  let dataset;
  let syncStats;
  let indexSource;
  let indexWindow;
  let detailFiles;

  before(async () => {
    daemon = await loadDaemon();
    dataset = daemon.buildContextDataset();
    assert.ok(Array.isArray(dataset.sessions) && dataset.sessions.length > 0, "buildContextDataset 必须返回会话");

    // 用同一份数据集落盘, 保证「写入的内容」与「比对的内容」完全一致
    syncStats = daemon.writeContextDataset(dataset.sessions, dataset.summary);
    indexSource = fs.readFileSync(INDEX_PATH, "utf8");
    indexWindow = evaluateWindow(indexSource, "context-data.js");
    detailFiles = indexWindow.CONTEXT_DETAIL_FILES;
  });

  after(() => {
    try {
      fs.rmSync(ISOLATED_PAGE_DIR, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });

  it("① 索引体积 < 1.5MB, 不含 fullText/turns/dshContext, 且带 v2 全部全局量", () => {
    const indexBytes = fs.statSync(INDEX_PATH).size;
    assert.ok(indexBytes < INDEX_SIZE_LIMIT, "索引必须 < 1.5MB (实际 " + (indexBytes / 1024).toFixed(1) + "KB)");
    assert.ok(syncStats.indexBytes < INDEX_SIZE_LIMIT, "writeContextDataset 报告的索引体积必须 < 1.5MB");

    // 大字段必须全部下沉
    assert.equal(indexSource.includes("fullText"), false, "索引不得包含 fullText");
    assert.equal(indexSource.includes('"turns"'), false, "索引不得包含 turns");
    assert.equal(indexSource.includes('"dshContext"'), false, "索引不得包含 dshContext");
    assert.equal(indexSource.includes('"fileOps"'), false, "索引不得包含 fileOps");

    // 合同要求的全局量
    assert.equal(indexWindow.CONTEXT_DATA_VERSION, 2, "window.CONTEXT_DATA_VERSION 必须为 2");
    assert.ok(indexWindow.CONTEXT_SUMMARY, "window.CONTEXT_SUMMARY 必须存在");
    assert.ok(Array.isArray(indexWindow.CONTEXT_SESSIONS), "window.CONTEXT_SESSIONS 必须是数组");
    assert.equal(indexWindow.CONTEXT_DETAIL_DIR, "data", "window.CONTEXT_DETAIL_DIR 必须为 data");
    assert.ok(indexWindow.CONTEXT_DETAIL_FILES && typeof indexWindow.CONTEXT_DETAIL_FILES === "object", "window.CONTEXT_DETAIL_FILES 必须存在");

    // 索引条目只能包含白名单字段
    const whitelist = new Set(daemon.SESSION_INDEX_FIELDS);
    assert.ok(whitelist.size >= 20, "SESSION_INDEX_FIELDS 白名单必须完整");
    for (const field of ["id", "name", "agent", "agentName", "agentIcon", "cwd", "model", "modelLimit",
      "watermarkPercent", "peakTokens", "currentTokens", "totalInputTokens", "totalOutputTokens", "totalCacheRead",
      "cost", "startTime", "lastTime", "timeAgo", "turnsCount", "compactionCount", "bloatCount", "hasDshContext"]) {
      assert.ok(whitelist.has(field), "白名单缺少字段 " + field);
    }
    for (const session of indexWindow.CONTEXT_SESSIONS) {
      for (const key of Object.keys(session)) {
        assert.ok(whitelist.has(key), "索引条目出现白名单外字段: " + key);
      }
      for (const required of ["id", "agent", "turnsCount", "watermarkPercent", "currentTokens", "lastTime"]) {
        assert.notEqual(session[required], undefined, "索引条目缺少主页/KPI 依赖字段 " + required);
      }
    }
    assert.equal(indexWindow.CONTEXT_SESSIONS.length, dataset.sessions.length, "索引会话数必须与数据集一致");
  });

  it("② 随机 3 个会话: 索引 + 详情合并后与 buildContextDataset() 原始 session 深度相等", () => {
    const picked = pickIndices(dataset.sessions.length, 3);
    assert.equal(picked.length, 3, "必须随机取到 3 个会话");

    for (const idx of picked) {
      const original = dataset.sessions[idx];
      const id = String(original.id);
      const relPath = detailFiles[id];
      assert.ok(relPath, "缺少 " + id + " 的详情文件映射");

      const absDetailPath = path.join(PAGE_DIR, relPath);
      assert.ok(fs.existsSync(absDetailPath), "详情文件必须存在: " + relPath);

      const detailWindow = readWindowFromFile(absDetailPath);
      const detailStore = detailWindow.CONTEXT_SESSION_DETAIL;
      assert.ok(detailStore && detailStore[id], "详情文件必须以会话 id 为 key 挂载完整 session");

      // 合同: 旧属性一个都不能少
      const detail = detailStore[id];
      for (const key of ["turns", "dshContext", "id", "name", "agent", "cwd", "model"]) {
        assert.notEqual(detail[key], undefined, "详情 session 缺少字段 " + key);
      }
      const dc = detail.dshContext;
      for (const key of ["steps", "turns", "fileOps", "commands", "events", "tokenStats", "timingStats", "currentContext", "stats", "curCategories"]) {
        assert.notEqual(dc[key], undefined, "详情 dshContext 缺少字段 " + key);
      }
      assert.ok(Array.isArray(dc.steps), "dshContext.steps 必须是数组");
      const hasFullText = (detail.turns || []).some(t => (t.messages || []).some(m => typeof m.fullText === "string"));
      const originalHasFullText = (original.turns || []).some(t => (t.messages || []).some(m => typeof m.fullText === "string"));
      assert.equal(hasFullText, originalHasFullText, "turns[].messages[].fullText 必须原样保留");

      // 合并: 详情(完整) + 索引(主页新鲜字段) === 原始 session
      const indexEntry = indexWindow.CONTEXT_SESSIONS.find(s => String(s.id) === id);
      assert.ok(indexEntry, "索引里必须能找到 " + id);
      const merged = Object.assign({}, detail, indexEntry);
      assert.deepEqual(json(merged), json(original), "索引 + 详情合并后必须与原始 session 完全一致 (id=" + id + ")");
    }
  });

  it("③ id 清洗映射正确, CONTEXT_DETAIL_FILES 与会话一一对应", () => {
    // 合同: id.replace(/[^A-Za-z0-9._-]/g, "_")
    assert.equal(daemon.sanitizeSessionFileBase("session-1_2.3"), "session-1_2.3");
    assert.equal(daemon.sanitizeSessionFileBase("a/b:c d"), "a_b_c_d");
    // 路径穿越被压平; 结果以 "." 开头 → 再补 "_" 前缀, 防止写出隐藏文件
    assert.equal(daemon.sanitizeSessionFileBase("../../etc/passwd"), "_.._.._etc_passwd");
    assert.equal(daemon.sanitizeSessionFileBase("会话-测试"), "__-__");
    // 加固: 空串 / 隐藏文件前缀不会写出裸 .js 或覆盖 .gitignore
    assert.equal(daemon.sanitizeSessionFileBase(""), "_");
    assert.equal(daemon.sanitizeSessionFileBase(null), "_");
    assert.equal(daemon.sanitizeSessionFileBase(undefined), "_");
    assert.equal(daemon.sanitizeSessionFileBase(".gitignore"), "_.gitignore");
    assert.equal(daemon.sanitizeSessionFileBase(".."), "_..");

    const ids = dataset.sessions.map(s => String(s.id));
    const uniqueIds = new Set(ids);
    assert.equal(Object.keys(detailFiles).length, uniqueIds.size, "CONTEXT_DETAIL_FILES 条目数必须等于会话数");
    assert.equal(syncStats.detailFileCount, uniqueIds.size, "落盘详情文件数必须等于会话数");

    const values = Object.values(detailFiles);
    assert.equal(new Set(values).size, values.length, "CONTEXT_DETAIL_FILES 必须一一对应 (无重复路径)");

    for (const id of uniqueIds) {
      const relPath = detailFiles[id];
      assert.ok(relPath, "缺少映射: " + id);
      assert.match(relPath, /^data\/[A-Za-z0-9._-]+\.js$/, "详情路径必须是 data/<safe>.js: " + relPath);
      assert.equal(relPath, "data/" + daemon.sanitizeSessionFileBase(id) + ".js", "映射必须与 id 清洗规则一致: " + id);
      assert.ok(fs.existsSync(path.join(PAGE_DIR, relPath)), "详情文件必须真实存在: " + relPath);
    }

    // 目录里的 .js 分片必须全部是本次生成的有效详情文件
    const onDisk = fs.readdirSync(DETAIL_DIR).filter(name => name.endsWith(".js"));
    const expected = new Set(values.map(rel => path.basename(rel)));
    for (const name of onDisk) {
      assert.ok(expected.has(name), "详情目录里出现未登记的 .js 分片: " + name);
    }
    assert.equal(onDisk.length, expected.size, "详情目录 .js 分片数必须等于会话数");
  });

  it("④ 过期详情文件被清理, 且 .gitignore / README 不被误删", () => {
    const staleDetail = path.join(DETAIL_DIR, "zzz-tier1-stale-detail.js");
    const staleTmp = path.join(DETAIL_DIR, "zzz-tier1-stale-detail.js.tmp");
    const readme = path.join(DETAIL_DIR, "README.md");
    const gitignore = path.join(DETAIL_DIR, ".gitignore");

    fs.writeFileSync(staleDetail, '(window.CONTEXT_SESSION_DETAIL ||= {})["stale"] = {};\n', "utf8");
    fs.writeFileSync(staleTmp, "half written", "utf8");
    fs.writeFileSync(readme, "# tier1 cleanup guard\n", "utf8");
    // 把 .tmp 的 mtime 推到 60s 之前 (模拟崩溃残留)
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(staleTmp, old, old);

    try {
      assert.ok(fs.existsSync(gitignore), "daemon 必须自动生成 page/data/.gitignore");
      const result = daemon.writeContextDataset(dataset.sessions, dataset.summary);

      assert.equal(fs.existsSync(staleDetail), false, "过期详情文件必须被清理");
      assert.equal(fs.existsSync(staleTmp), false, "崩溃残留的 .tmp 必须被清理");
      assert.ok(result.removed.includes("zzz-tier1-stale-detail.js"), "removed 必须报告过期详情文件");
      assert.ok(result.removed.includes("zzz-tier1-stale-detail.js.tmp"), "removed 必须报告过期临时文件");

      assert.ok(fs.existsSync(readme), "README 不能被清理");
      assert.equal(fs.readFileSync(readme, "utf8"), "# tier1 cleanup guard\n", "README 内容不能被改写");
      assert.ok(fs.existsSync(gitignore), ".gitignore 不能被清理");
      assert.ok(fs.readFileSync(gitignore, "utf8").includes("*.js"), ".gitignore 内容必须保留");
    } finally {
      for (const file of [readme, staleDetail, staleTmp]) {
        try {
          fs.rmSync(file, { force: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
  });

  it("⑤ watch 模式内容未变不重写 (timeAgo 分钟进位也不触发大文件重写)", () => {
    // 先跑一次让磁盘与 manifest 对齐
    daemon.writeContextDataset(dataset.sessions, dataset.summary);

    // 取一个空闲会话 (antigravity 真实会话, 不会被并发写入) 做探针
    const probe = dataset.sessions.find(s => s.agent === "antigravity" && s.dshContext) || dataset.sessions[0];
    const probeId = String(probe.id);
    const probePath = path.join(PAGE_DIR, detailFiles[probeId]);
    assert.ok(fs.existsSync(probePath), "探针详情文件必须存在");
    const beforeStat = fs.statSync(probePath);
    const originalTimeAgo = probe.timeAgo;

    try {
      // 模拟 watch 模式下的分钟进位 (timeAgo 是纯派生字段, 索引里永远有最新值)
      probe.timeAgo = "刚刚 (模拟分钟进位)";
      const result = daemon.writeContextDataset(dataset.sessions, dataset.summary);

      const afterStat = fs.statSync(probePath);
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "内容未变的详情文件不得被重写 (mtime 变化)");
      assert.equal(afterStat.size, beforeStat.size, "内容未变的详情文件不得被重写 (size 变化)");
      assert.equal(result.written, 0, "同一份数据集重复落盘必须零写入 (written=" + result.written + ")");
      assert.equal(result.unchanged, result.sessionCount, "所有会话都必须命中 hash 跳过");
    } finally {
      probe.timeAgo = originalTimeAgo;
    }
  });

  it("⑥ 真实产物 page/context-data.js 已是 v2 轻量索引 (真实目录集成检查)", () => {
    const realIndexPath = path.join(REAL_PAGE_DIR, "context-data.js");
    assert.ok(fs.existsSync(realIndexPath), "page/context-data.js 必须已生成 (node daemon.mjs --once)");
    const realBytes = fs.statSync(realIndexPath).size;
    assert.ok(realBytes < INDEX_SIZE_LIMIT, "真实索引必须 < 1.5MB (实际 " + (realBytes / 1024).toFixed(1) + "KB)");

    const realSource = fs.readFileSync(realIndexPath, "utf8");
    assert.equal(realSource.includes("fullText"), false, "真实索引不得包含 fullText");
    assert.ok(realSource.includes("window.CONTEXT_SUMMARY"), "真实索引必须含 window.CONTEXT_SUMMARY (tier4 依赖)");
    assert.ok(realSource.includes("window.CONTEXT_SESSIONS"), "真实索引必须含 window.CONTEXT_SESSIONS (tier4 依赖)");

    const realWindow = evaluateWindow(realSource, realIndexPath);
    assert.equal(realWindow.CONTEXT_DATA_VERSION, 2, "真实索引的 CONTEXT_DATA_VERSION 必须为 2");
    assert.ok(Array.isArray(realWindow.CONTEXT_SESSIONS) && realWindow.CONTEXT_SESSIONS.length > 0);
    const mapping = realWindow.CONTEXT_DETAIL_FILES || {};
    assert.equal(Object.keys(mapping).length, realWindow.CONTEXT_SESSIONS.length, "真实索引的详情映射必须覆盖全部会话");
    for (const relPath of Object.values(mapping)) {
      assert.match(relPath, /^data\/[A-Za-z0-9._-]+\.js$/, "真实映射路径必须是 data/<safe>.js: " + relPath);
    }
  });
});
