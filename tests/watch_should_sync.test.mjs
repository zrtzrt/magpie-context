// watch 的同步判定: 这里有个不写测试就看不出来的坑。
// 旧实现只有「安静 quietMs 后才同步」一条路径, 而用户正在使用 agent 时会话文件
// 一直在写, 签名每次 tick 都变 → stableSince 永远重置 → 数据在活跃使用期间永不刷新。
// 实测: 宿主服务健康、watcher 存活, 但 cache.updatedAt 停在 13:57 不再前进。
import test from "node:test";
import assert from "node:assert/strict";

const { shouldSync } = await import("../bin/magpie-context.mjs");

const QUIET = 30000;
const STALE = 120000;
const NOW = 1_000_000;

function state(overrides) {
  return Object.assign({
    signature: "sig-a",
    observed: "sig-a",
    lastSynced: "sig-a",
    stableSince: NOW,
    lastSyncAt: NOW,
    quietMs: QUIET,
    maxStaleMs: STALE,
    now: NOW
  }, overrides);
}

test("数据源还在变化时只重置安静计时, 不同步", () => {
  const decision = shouldSync(state({ signature: "sig-b", observed: "sig-a" }));
  assert.equal(decision.action, "reset");
});

test("变化已停止且安静期满才同步", () => {
  const decision = shouldSync(state({
    signature: "sig-b",
    observed: "sig-b",
    lastSynced: "sig-a",
    stableSince: NOW - QUIET
  }));
  assert.equal(decision.action, "sync");
  assert.equal(decision.reason, "quiet");
});

test("变化未停止、安静期未满时先等待", () => {
  const decision = shouldSync(state({
    signature: "sig-b",
    observed: "sig-b",
    lastSynced: "sig-a",
    stableSince: NOW - 1000
  }));
  assert.equal(decision.action, "wait");
});

// 这条是本次修复的核心: 持续写入时也必须刷新, 否则「正在用 agent」恰恰看不到数据。
test("持续写入时超过最大陈旧时间也会同步", () => {
  const decision = shouldSync(state({
    signature: "sig-b",
    observed: "sig-b",
    lastSynced: "sig-a",
    // 安静期永远凑不满: 刚刚才变过
    stableSince: NOW - 100,
    // 但距上次同步已超过 maxStaleMs
    lastSyncAt: NOW - STALE
  }));
  assert.equal(decision.action, "sync", "持续写入时必须靠陈旧兜底刷新");
  assert.equal(decision.reason, "stale");
});

test("没有变化时什么都不做", () => {
  const decision = shouldSync(state({}));
  assert.equal(decision.action, "idle");
});

test("CLI 被 import 时不得执行命令", async () => {
  // 上面已经 import 过: 若没有直接执行守卫, 那次 import 会真的跑一次全量同步。
  assert.equal(typeof shouldSync, "function");
  const cli = await import("../bin/magpie-context.mjs");
  assert.deepEqual(Object.keys(cli), ["shouldSync"], "除 shouldSync 外不应有其它导出");
});
