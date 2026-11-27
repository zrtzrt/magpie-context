// service 生命周期: 宿主会重复 require 插件并反复调用 server()。
// 每次调用都 listen 同一端口会得到 EADDRINUSE → ok:false → 宿主重试, 形成重启风暴
// (实测 app.log 里 800+ 条 "service port 3457 unavailable", 宿主当天重启 1296 次)。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.MAGPIE_CONTEXT_WATCH_DISABLE = "1";
const service = require(path.join(ROOT, "index.js"));

function listenOn(port, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); });
}

// 每个用例用不同端口, 且基址按 pid 派生: 并发跑测试（CI 矩阵、本地后台作业）
// 时两个进程若用同一基址会互相占用端口, 表现为「第一次调用就 ok:false」。
const BASE = 20000 + (process.pid % 400) * 25;
let nextPort = BASE;
function takePort() { nextPort += 1; return nextPort; }

test.afterEach(() => { service.__service.resetState(); });

test("同一进程内重复调用 server() 只监听一次, 第二次直接复用", async () => {
  const port = takePort();
  const first = await service({}, { port });
  assert.equal(first.ok, true);
  assert.equal(first.port, port);
  assert.equal(first.owning, true);

  const second = await service({}, { port });
  assert.equal(second.ok, true, "重复调用不得报失败");
  assert.equal(second.port, port);
  assert.equal(second.reused, true);

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.service, "magpie-context");
});

test("端口被外部程序占用时自动换端口, 而不是报失败让宿主重试", async () => {
  const port = takePort();
  const squatter = await listenOn(port, (_req, res) => { res.writeHead(200); res.end("not-magpie"); });
  try {
    const result = await service({}, { port });
    assert.equal(result.ok, true, "外部占用不应导致 ok:false");
    assert.equal(result.port, port + 1, "应顺延到下一个端口");
    const health = await fetch(`http://127.0.0.1:${result.port}/health`).then((r) => r.json());
    assert.equal(health.service, "magpie-context");
  } finally {
    await closeServer(squatter);
  }
});

test("端口上已是本插件自己的服务时复用, 不再监听", async () => {
  const port = takePort();
  const twin = await listenOn(port, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "magpie-context", watcher: true }));
  });
  try {
    const result = await service({}, { port });
    assert.equal(result.ok, true);
    assert.equal(result.port, port, "应复用已有实例的端口");
    assert.equal(result.owning, false, "复用方不拥有服务, 不应再起 watcher");
  } finally {
    await closeServer(twin);
  }
});
// 回归: watcher 子进程崩溃（含向已结束的日志流写入）不得把宿主一起带走。
// 旧实现用 createWriteStream + pipe, 子进程退出后仍写入已 end 的流会抛
// "write after end" 未捕获错误, 直接崩掉整个插件宿主。
test("watcher 子进程立刻崩溃不会让宿主抛错", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-cli-"));
  const fakeCli = path.join(dir, "crash.mjs");
  fs.writeFileSync(fakeCli, [
    "process.stdout.write(\"partial line without newline\");",
    "process.stderr.write(\"boom\\n\");",
    "process.exit(3);"
  ].join("\n"));

  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);

  process.env.MAGPIE_CONTEXT_CLI_PATH = fakeCli;
  delete process.env.MAGPIE_CONTEXT_WATCH_DISABLE;
  service.__service.resetState();
  const port = takePort();
  try {
    const result = await service({}, { port });
    assert.equal(result.ok, true);
    // 给子进程时间退出并把可能的写入错误暴露出来。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(uncaught, [], "子进程崩溃不得产生未捕获异常");
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.service, "magpie-context", "宿主服务必须仍然存活");
  } finally {
    process.off("uncaughtException", onUncaught);
    delete process.env.MAGPIE_CONTEXT_CLI_PATH;
    process.env.MAGPIE_CONTEXT_WATCH_DISABLE = "1";
    service.__service.resetState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// 回归: watcher 是 detached 的, 会跨宿主生命周期存活。
// 旧实现只看自己的子进程, 于是宿主每次重启都再 spawn 一个, 新进程立刻以
// 「已有另一个 watch 在运行」退出; health 同时谎报 watcher:false。
test("锁里已有存活 watcher 时不再重复 spawn, 且 health 如实报告", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");

  const port = takePort();
  service.__service.resetState();
  delete process.env.MAGPIE_CONTEXT_WATCH_DISABLE;

  const dataDir = path.join(ROOT, "page", "data");
  const lockPath = path.join(dataDir, ".watch.lock");
  const previousLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;

  // 一个真实存活的「上一次宿主留下的」watcher 进程。
  const survivor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", detached: true });
  survivor.unref();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: survivor.pid, startedAt: new Date().toISOString() }));
  // 日志是跨进程累积的, 必须先清空, 否则断言会读到历史噪音而不是本次行为。
  const logPath = path.join(dataDir, ".service.log");
  const previousLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : null;
  fs.writeFileSync(logPath, "");

  try {
    const result = await service({}, { port });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.watcher, true, "锁里那个 watcher 还活着, 就必须报 true");
    assert.equal(health.watcherPid, survivor.pid, "应报告真实维护数据的 pid");

    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    assert.ok(!log.includes("已有另一个 watch"), "不得再 spawn 一个注定立刻退出的 watcher");
  } finally {
    try { survivor.kill("SIGKILL"); } catch (_) { /* ignore */ }
    if (previousLock === null) { try { fs.unlinkSync(lockPath); } catch (_) { /* ignore */ } }
    else fs.writeFileSync(lockPath, previousLock);
    if (previousLog === null) { try { fs.unlinkSync(logPath); } catch (_) { /* ignore */ } }
    else fs.writeFileSync(logPath, previousLog);
    process.env.MAGPIE_CONTEXT_WATCH_DISABLE = "1";
    service.__service.resetState();
  }
});
