// tests/cross_platform.test.mjs
// 跨平台回归: 这三类缺陷在 ubuntu-latest 的 CI 上永远不会暴露, 只有在
// HOME 缺失 (Windows / CI 容器) 或 Windows 路径下才会显形。
//
//   1. HOME 缺失时所有数据源路径退化成相对路径 → 0 会话 → 分片被当成过期全部删除
//   2. parseDshSession 依赖 `zstd -dc | grep -E` 两个外部命令 → Windows 上正文退化为 [网关调用]
//   3. 盘符/UNC 路径被当成相对路径拼上 cwd → 同一文件被拆成多个 key
//
// 全部用合成数据, 不依赖本机会话。
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { loadDaemon } from "./helpers/daemon_harness.mjs";

const ISOLATED_PAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-context-xplat-"));
process.env.MAGPIE_CONTEXT_PAGE_DIR = ISOLATED_PAGE_DIR;

const DETAIL_DIR = path.join(ISOLATED_PAGE_DIR, "data");

/** 造一个只有 1 个会话的合法数据集, 用来验证 writeContextDataset 的写入与清理 */
function makeSession(id) {
  return {
    id,
    name: "合成会话 " + id,
    agent: "dsh",
    agentName: "DSH",
    cwd: "/tmp",
    model: "deepseek-chat",
    modelLimit: 131072,
    currentTokens: 100,
    peakTokens: 100,
    turnsCount: 1,
    turns: [
      {
        turnIdx: 1,
        time: 1794469443975,
        timestamp: "12:00:00",
        userText: "hello",
        totalTokens: 100,
        tokenDelta: 0,
        breakdown: { systemTokens: 10, toolsTokens: 10, userTokens: 10, assistantTokens: 70, toolResultTokens: 0 },
        isCompaction: false,
        isBloat: false,
        messages: []
      }
    ]
  };
}

function makeSummary() {
  return {
    totalSessions: 1,
    totalTurns: 1,
    totalTokens: 100,
    agents: { antigravity: 0, dsh: 1, codex: 0, other: 0 }
  };
}

describe("跨平台: 空数据集不得删除已有详情分片", () => {
  let daemon;
  before(async () => {
    daemon = await loadDaemon();
  });

  it("① 先写入 1 个会话, 分片文件真实存在", () => {
    const stats = daemon.writeContextDataset([makeSession("xplat-a")], makeSummary());
    assert.equal(stats.sessionCount, 1);
    const files = fs.readdirSync(DETAIL_DIR).filter((f) => f.endsWith(".js"));
    assert.equal(files.length, 1, "应写出 1 个分片, 实际: " + JSON.stringify(files));
  });

  it("② 空数据集 (数据源不可读) 不删除任何分片", () => {
    const stats = daemon.writeContextDataset([], {
      totalSessions: 0,
      totalTurns: 0,
      totalTokens: 0,
      agents: { antigravity: 0, dsh: 0, codex: 0, other: 0 }
    });
    assert.deepEqual(stats.removed, [], "空数据集必须不清理任何分片");
    const files = fs.readdirSync(DETAIL_DIR).filter((f) => f.endsWith(".js"));
    assert.equal(files.length, 1, "上一次写入的分片必须还在, 实际: " + JSON.stringify(files));
  });

  it("③ 有数据集时过期分片仍会被清理 (安全阀不误伤正常清理)", () => {
    const stats = daemon.writeContextDataset([makeSession("xplat-b")], makeSummary());
    const files = fs.readdirSync(DETAIL_DIR).filter((f) => f.endsWith(".js"));
    assert.equal(files.length, 1, "旧分片应被清理, 只剩新的: " + JSON.stringify(files));
    assert.equal(stats.removed.length, 1, "应报告清理了 1 个过期分片");
  });
});

describe("跨平台: DSH 正文解析不依赖 zstd/grep 外部命令", () => {
  let daemon;
  before(async () => {
    daemon = await loadDaemon();
  });

  /** 构造一个真实结构的 session.v4.jsonl.zstd (node:zlib 压缩) */
  function writeDshSession(dir, lines) {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "session.v4.jsonl.zstd");
    const jsonl = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    fs.writeFileSync(filePath, zlib.zstdCompressSync(Buffer.from(jsonl, "utf8")));
    return filePath;
  }

  it("④ 压缩会话能解析出真实正文, 不退化为 [网关调用]", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-xplat-dsh-"));
    const userText = "请把这份账单按月份归类, 并统计每月的总支出金额";
    const filePath = writeDshSession(dir, [
      { type: "session/title", time: 1794469443000, data: { title: "账单归类" } },
      { type: "system/message", time: 1794469443100, data: { message: { content: "You are DSH." } } },
      { type: "turn/start", time: 1794469443200, data: { turn: 1 } },
      { type: "user/message", time: 1794469443300, data: { content: userText } },
      { type: "assistant/message", time: 1794469443400, data: { content: "好的" } },
      // 这条不含关注的事件类型, 必须被过滤掉 (与原 grep 行为一致)
      { type: "debug/noise", time: 1794469443500, data: { content: "should be filtered" } },
      { type: "step/end", time: 1794469443600, data: {} }
    ]);

    const session = daemon.parseDshSession(filePath, { id: "xplat-dsh", cwd: "/tmp" }, []);
    assert.ok(Array.isArray(session.turns) && session.turns.length >= 1, "必须解析出轮次");
    const joined = session.turns.map((t) => t.userText || "").join("\n");
    assert.ok(joined.includes("账单"), "正文必须包含真实用户文本, 实际: " + JSON.stringify(joined.slice(0, 200)));
    assert.ok(!joined.includes("[网关调用]"), "正文不得退化为 [网关调用]");
    assert.ok(!joined.includes("should be filtered"), "非关注事件必须被过滤");
  });

  it("⑤ 损坏的 zstd 文件不抛错, 且不退化为假正文", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-xplat-bad-"));
    const filePath = path.join(dir, "session.v4.jsonl.zstd");
    fs.writeFileSync(filePath, Buffer.from("this is not zstd at all", "utf8"));
    let threw = false;
    let session = null;
    try {
      session = daemon.parseDshSession(filePath, { id: "xplat-bad", cwd: "/tmp" }, []);
    } catch (_) {
      threw = true;
    }
    assert.equal(threw, false, "损坏文件不得让整个解析抛错");
    assert.equal(Array.isArray(session.turns), true);
    // daemon.mjs 有既有的「兜底合成」: turns 为空时补一轮, 目的是让卡片不留空。
    // 这里断言的是它仍然只补一轮、且不带任何来自文件的正文 —— 即解压失败没有被
    // 误当成「解析到内容」。真实 token 统计另有 dsh-events 的折叠结果负责。
    assert.equal(session.turns.length, 1, "兜底只应合成一轮, 实际: " + session.turns.length);
    assert.equal(session.turns[0].userText, "", "损坏文件不得产出任何用户正文");
    assert.equal(session.currentTokens, 0, "损坏文件的真实上下文 token 必须是 0, 实际: " + session.currentTokens);
  });
});
