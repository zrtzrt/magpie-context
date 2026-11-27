// Magpie page plugin service: keeps page/data fresh in the background.
//
// This module is imported by Magpie's Bun plugin host. It must have zero import-time
// side effects: the watcher/server only start when Magpie calls server(input, options).
// syncContextData() walks several GB of session logs, so it runs in a child process,
// never on the plugin host's event loop.
//
// The host may require this module more than once (it reloads plugins after edits and
// keeps one entry per install path). Module-level state therefore cannot be the guard:
// a second instance would call listen() on the same port, get EADDRINUSE, report
// ok:false, and the host would retry forever. State lives on globalThis so every
// instance in this process shares one server and one watcher.
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 3457;
const PORT_SCAN_LIMIT = 10;
const SERVICE_HOST = "127.0.0.1";
const SERVICE_ID = "magpie-context";
// 测试可覆盖: 用一个立刻退出的假 CLI 验证 watcher 崩溃不会波及宿主。
const CLI_PATH = process.env.MAGPIE_CONTEXT_CLI_PATH || path.join(__dirname, "bin", "magpie-context.mjs");
const IS_BUN = Boolean(process.versions && process.versions.bun);
const STATE_KEY = Symbol.for("magpie-context.service-state");
const LOG_MAX_BYTES = 512 * 1024;

function serviceState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = { started: false, port: null, watcher: null, server: null, signalsBound: false };
  }
  return globalThis[STATE_KEY];
}

function resolvePort(options) {
  const value = Number(options && options.port);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
}

// 子进程输出必须落盘: 页面插件没有终端, stdio:"ignore" 会让「为什么没有新数据」
// 变成无解的谜题。日志按大小轮转, 避免长期运行后无限增长。
//
// 用文件描述符而不是 createWriteStream + pipe: 宿主日志里 719 条
// "write after end" (internal:streams/readable onerror) 全部出现在 pipe 版本
// 运行期间, 每次都是未捕获错误直接崩掉插件宿主。fd 由内核直接写入, 插件进程
// 不参与搬运, 也就不存在「目标流已 end 后仍有数据到达」这条路径。
function openWatcherLogFd() {
  try {
    const fs = require("node:fs");
    const dir = path.join(__dirname, "page", "data");
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, ".service.log");
    try {
      if (fs.statSync(logPath).size > LOG_MAX_BYTES) fs.truncateSync(logPath, 0);
    } catch (_) { /* 不存在即可 */ }
    return fs.openSync(logPath, "a");
  } catch (_) {
    return null;
  }
}

// watcher 是 detached 的, 可能比插件宿主活得更久, 因此「是否已有 watcher」不能只看
// 自己的子进程, 必须看锁文件里那个 pid 是否还活着。否则宿主每次重启都会再 spawn
// 一个, 新进程立刻以「已有另一个 watch 在运行」退出, 纯属噪音。
function lockWatcherPid() {
  try {
    const lockPath = path.join(__dirname, "page", "data", ".watch.lock");
    const parsed = JSON.parse(require("node:fs").readFileSync(lockPath, "utf8"));
    const pid = Number(parsed && parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (error) {
      // EPERM 说明进程存在但不属于我们; ESRCH 才是真的没了。
      return error && error.code === "EPERM" ? pid : null;
    }
  } catch (_) {
    return null;
  }
}

function startWatcher() {
  if (process.env.MAGPIE_CONTEXT_SERVICE_DISABLE === "1") return;
  // 测试与调试用: 只起 health 服务、不扫描会话数据。
  if (process.env.MAGPIE_CONTEXT_WATCH_DISABLE === "1") return;
  const state = serviceState();
  if (state.watcher && state.watcher.exitCode === null && !state.watcher.killed) return;
  if (lockWatcherPid() !== null) return;
  const args = IS_BUN
    ? ["run", CLI_PATH, "watch", "--interval=60000", "--quiet=30000"]
    : [CLI_PATH, "watch", "--interval=60000", "--quiet=30000"];
  const logFd = openWatcherLogFd();
  try {
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: Object.assign({}, process.env, { MAGPIE_CONTEXT_SERVICE: "1" }),
      // 用 fd 而不是 pipe: 内核直接写文件, 插件进程不参与搬运, 不会出现
      // "write after end"; 子进程死了也不会把错误冒到宿主。
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      // 必须 detached: 一次全量同步要 11–46 秒, 而插件宿主会被其他插件
      // 的错误反复重启（实测每几秒一次）。watcher 若跟着宿主退出, 就永远
      // 同步不完, 表现为「服务健康但数据一直是旧的」。脱离父进程后由
      // .watch.lock 保证全局只有一份。
      detached: true
    });
    state.watcher = child;
    // 父进程不等待它, 也不因它的退出而留下句柄。
    child.unref?.();
    // 子进程已继承一份, 父进程这份必须关掉, 否则每次重启泄漏一个句柄。
    if (logFd !== null) {
      try { require("node:fs").closeSync(logFd); } catch (_) { /* ignore */ }
    }
    child.on("exit", (code) => {
      if (!state.started) return;
      state.watcher = null;
      // 退出码 0 通常是「已有另一个 watch 在跑」, 不必重启。
      if (code === 0) return;
      setTimeout(() => { if (state.started) startWatcher(); }, 5000).unref?.();
    });
    child.on("error", (error) => {
      console.error("[magpie-context] service watcher failed:", error.message);
      state.watcher = null;
    });
  } catch (error) {
    console.error("[magpie-context] cannot start sync watcher:", error.message);
    state.watcher = null;
  }
}

function stopWatcher() {
  const state = serviceState();
  if (state.watcher && state.watcher.exitCode === null) {
    try { state.watcher.kill("SIGTERM"); } catch (_) { /* already gone */ }
  }
  state.watcher = null;
}

function healthPayload() {
  let stats = null;
  try {
    const cachePath = path.join(__dirname, "page", "data", ".parse-cache.json");
    const parsed = JSON.parse(require("node:fs").readFileSync(cachePath, "utf8"));
    stats = { entries: Object.keys(parsed.entries || {}).length, updatedAt: parsed.updatedAt || null };
  } catch (_) {
    stats = null;
  }
  const state = serviceState();
  const ownChild = Boolean(state.watcher && state.watcher.exitCode === null);
  const lockPid = lockWatcherPid();
  return {
    ok: true,
    service: SERVICE_ID,
    // detached 的 watcher 可能是上一次宿主生命周期留下的, 只要锁里那个 pid
    // 还活着, 数据就在被维护 —— 只报自己的子进程会谎报 false。
    watcher: ownChild || lockPid !== null,
    watcherPid: ownChild ? state.watcher.pid : lockPid,
    pid: process.pid,
    port: state.port || DEFAULT_PORT,
    cache: stats
  };
}

// 端口被占时必须区分「是我自己」和「别人」: 前者应复用而不是报失败, 否则宿主会
// 把一次正常的重复加载当成启动失败并无限重试。
function probeOwnService(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: SERVICE_HOST, port, path: "/health", timeout: 800 },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            resolve(Boolean(payload && payload.service === SERVICE_ID));
          } catch (_) {
            resolve(false);
          }
        });
      }
    );
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

function listenOnce(port) {
  return new Promise((resolve) => {
    const state = serviceState();
    const candidate = http.createServer((req, res) => {
      const url = req.url || "";
      const healthPaths = ["/", "/health", "/healthz", "/status", "/api/health"];
      if (req.method === "GET" && healthPaths.includes(url)) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(healthPayload()));
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    candidate.on("error", (error) => {
      candidate.close?.();
      resolve({ ok: false, code: error && error.code, port });
    });
    candidate.listen(port, SERVICE_HOST, () => {
      state.server = candidate;
      resolve({ ok: true, port, server: candidate });
    });
  });
}

// 依次尝试端口: 自己人 → 复用; 外部占用 → 换下一个, 最多扫 PORT_SCAN_LIMIT 个。
async function startHealthServer(preferredPort) {
  if (process.env.MAGPIE_CONTEXT_SERVICE_DISABLE === "1") return { ok: true, port: preferredPort, owning: false };
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65535) break;
    const result = await listenOnce(port);
    if (result.ok) return { ok: true, port, owning: true };
    if (result.code !== "EADDRINUSE") {
      console.error("[magpie-context] cannot start service on " + port + ":", result.code || "unknown");
      continue;
    }
    if (await probeOwnService(port)) {
      // 本进程的旧实例或另一个插件副本已经在这个端口上提供服务, 复用它。
      return { ok: true, port, owning: false, reused: true };
    }
  }
  console.error("[magpie-context] no free port in " + preferredPort + ".." + (preferredPort + PORT_SCAN_LIMIT - 1));
  return { ok: false, port: preferredPort, owning: false };
}

// 注意: 这里**不**杀 watcher。watcher 是 detached 的, 它的职责就是比宿主活得久
// —— 一次全量同步要 11–46 秒, 而宿主会被别的插件反复重启, 跟着一起死就永远同步
// 不完。全局唯一由 .watch.lock 保证, 不靠父进程收尾。需要主动停止时用
// __service.stopWatcher()。
function shutdown() {
  const state = serviceState();
  state.started = false;
  state.watcher = null;
  if (state.server) {
    try { state.server.close(); } catch (_) { /* ignore */ }
    state.server = null;
  }
}

function bindSignals() {
  const state = serviceState();
  if (state.signalsBound) return;
  state.signalsBound = true;
  process.once("exit", shutdown);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      shutdown();
      process.exit(0);
    });
  }
}

async function MagpieContextPlugin(_input, options) {
  const state = serviceState();
  const preferred = resolvePort(options);
  if (process.env.MAGPIE_CONTEXT_SERVICE_DISABLE === "1") return { ok: true, port: preferred, owning: false };
  // 同一进程内的重复调用: 直接复用, 不再 listen、不再 spawn。
  if (state.started) return { ok: true, port: state.port || preferred, reused: true, owning: Boolean(state.server) };
  state.started = true;
  state.port = preferred;
  bindSignals();
  const result = await startHealthServer(preferred);
  if (!result.ok) {
    // 端口全被外部占用: 复位以便宿主下一次调用还能重试, 而不是谎报复用成功。
    state.started = false;
    return result;
  }
  state.port = result.port;
  if (result.owning) startWatcher();
  return result;
}

module.exports = MagpieContextPlugin;
module.exports.default = { id: "context", server: MagpieContextPlugin };
module.exports.server = MagpieContextPlugin;
module.exports.MagpieContextPlugin = MagpieContextPlugin;
module.exports.__service = {
  DEFAULT_PORT,
  healthPayload,
  stopWatcher,
  shutdown,
  probeOwnService,
  resetState: () => { shutdown(); delete globalThis[STATE_KEY]; }
};
