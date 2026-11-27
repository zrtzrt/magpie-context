// Magpie page plugin service: keeps page/data fresh in the background.
//
// This module is imported by Magpie's Bun plugin host. It must have zero import-time
// side effects: the watcher/server only start when Magpie calls server(input, options).
// syncContextData() walks several GB of session logs, so it runs in a child process,
// never on the plugin host's event loop.
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 3457;
const SERVICE_HOST = "127.0.0.1";
const CLI_PATH = path.join(__dirname, "bin", "magpie-context.mjs");
const IS_BUN = Boolean(process.versions && process.versions.bun);

let started = false;
let currentPort = DEFAULT_PORT;
let watcher = null;
let server = null;

function resolvePort(options) {
  const value = Number(options && options.port);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
}

function startWatcher() {
  if (process.env.MAGPIE_CONTEXT_SERVICE_DISABLE === "1") return;
  if (watcher && watcher.exitCode === null && !watcher.killed) return;
  const args = IS_BUN
    ? ["run", CLI_PATH, "watch", "--interval=60000", "--quiet=30000"]
    : [CLI_PATH, "watch", "--interval=60000", "--quiet=30000"];
  try {
    watcher = spawn(process.execPath, args, {
      cwd: __dirname,
      env: Object.assign({}, process.env, { MAGPIE_CONTEXT_SERVICE: "1" }),
      stdio: "ignore"
    });
    watcher.on("exit", () => {
      if (!started) return;
      watcher = null;
      setTimeout(() => { if (started) startWatcher(); }, 5000).unref?.();
    });
    watcher.on("error", (error) => {
      console.error("[magpie-context] service watcher failed:", error.message);
      watcher = null;
    });
  } catch (error) {
    console.error("[magpie-context] cannot start sync watcher:", error.message);
    watcher = null;
  }
}

function stopWatcher() {
  if (watcher && watcher.exitCode === null) {
    try { watcher.kill("SIGTERM"); } catch (_) { /* already gone */ }
  }
  watcher = null;
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
  return {
    ok: true,
    service: "magpie-context",
    watcher: Boolean(watcher && watcher.exitCode === null),
    pid: process.pid,
    port: currentPort,
    cache: stats
  };
}

function startHealthServer(port) {
  if (process.env.MAGPIE_CONTEXT_SERVICE_DISABLE === "1") return Promise.resolve({ ok: true, port });
  return new Promise((resolve) => {
    try {
      server = http.createServer((req, res) => {
        if (req.method === "GET" && (req.url === "/" || req.url === "/health" || req.url === "/healthz" || req.url === "/status" || req.url === "/api/health")) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(healthPayload()));
          return;
        }
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
      });
      server.on("error", (error) => {
        // A stale instance may own the port; the watcher is still useful.
        console.error("[magpie-context] service port " + port + " unavailable:", error.message);
        server = null;
        resolve({ ok: false, reused: true, port });
      });
      server.listen(port, SERVICE_HOST, () => resolve({ ok: true, port }));
    } catch (error) {
      console.error("[magpie-context] cannot start service:", error.message);
      server = null;
      resolve({ ok: false, error: error.message, port });
    }
  });
}

function shutdown() {
  started = false;
  stopWatcher();
  if (server) {
    try { server.close(); } catch (_) { /* ignore */ }
    server = null;
  }
}

async function MagpieContextPlugin(_input, options) {
  if (started) return { ok: true, port: currentPort };
  started = true;
  currentPort = resolvePort(options);
  startWatcher();
  process.once("exit", shutdown);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      shutdown();
      process.exit(0);
    });
  }
  return startHealthServer(currentPort);
}

module.exports = MagpieContextPlugin;
module.exports.default = { id: "context", server: MagpieContextPlugin };
module.exports.server = MagpieContextPlugin;
module.exports.MagpieContextPlugin = MagpieContextPlugin;
module.exports.__service = { DEFAULT_PORT, healthPayload, stopWatcher };
