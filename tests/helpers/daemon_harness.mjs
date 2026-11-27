// tests/helpers/daemon_harness.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DAEMON_PATH = path.join(PROJECT_ROOT, "daemon.mjs");
const EXPORTED_WRAPPER_PATH = path.join(__dirname, ".daemon_exports.mjs");

/**
 * Ensures the exported daemon module wrapper exists and returns the loaded module.
 * Never modifies daemon.mjs itself.
 */
let cachedDaemon = null;

/** 原子写文件 (写同目录临时文件后 rename, 避免并发进程读到截断的中间态) */
function writeFileAtomic(targetPath, content) {
  const tmpPath = targetPath + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, targetPath);
}

export async function loadDaemon() {
  if (cachedDaemon) return cachedDaemon;

  const daemonCode = fs.readFileSync(DAEMON_PATH, "utf8");

  // In daemon.mjs, buildDshContextPayload and formatK are declared inside buildContextDataset.
  // We lift them to module scope in our test wrapper so tests can call them directly.
  let wrapperCode;
  const idxK = daemonCode.indexOf("function formatK(n) {");
  const idxEnd = daemonCode.indexOf("\n  // 为所有会话附加完整的 dsh-context 数据载荷");

  if (idxK !== -1 && idxEnd !== -1) {
    const payloadCode = daemonCode.slice(idxK, idxEnd);
    wrapperCode = daemonCode.slice(0, idxK) + 
      daemonCode.slice(idxEnd) + 
      "\n\n" + 
      payloadCode + 
      `\nexport { parseAntigravitySession, parseDshSession, buildDshContextPayload, estimateTokens, getModelLimit, formatK, trimDetailPayloadInPlace };\n`;
  } else {
    wrapperCode = daemonCode + `\nexport { parseAntigravitySession, parseDshSession, estimateTokens, getModelLimit };\n`;
  }

  // Always keep wrapper in sync with daemon.mjs
  // 注意: node --test 并行跑多个测试文件时, 多个进程会同时写同一个包装文件;
  // 直接 writeFileSync 会留下「已截断但未写完」的中间态, 另一个进程 import 到的就是空模块
  // (表现为 daemon.parseAntigravitySession is not a function)。这里改成「写临时文件 + 原子 rename」。
  writeFileAtomic(EXPORTED_WRAPPER_PATH, wrapperCode);

  // daemon.mjs 现在会 import 同目录的 ESM 兄弟模块 (dsh-events.mjs / dsh-fileops.mjs);
  // 包装文件位于 tests/helpers/, 因此需要把这些依赖镜像过来, 否则相对 import 解析失败。
  for (const dep of ["dsh-events.mjs", "dsh-fileops.mjs"]) {
    const src = path.join(PROJECT_ROOT, dep);
    const dst = path.join(__dirname, dep);
    if (!fs.existsSync(src)) continue;
    const code = fs.readFileSync(src, "utf8");
    if (!fs.existsSync(dst) || fs.readFileSync(dst, "utf8") !== code) {
      writeFileAtomic(dst, code);
    }
  }

  // Windows 上不能直接 import 绝对路径: 盘符会被 ESM 当成 URL scheme,
  // 报 ERR_UNSUPPORTED_ESM_URL_SCHEME (Received protocol 'd:')。
  // 必须先转成 file:// URL —— 这一步在 POSIX 上同样正确。
  cachedDaemon = await import(pathToFileURL(EXPORTED_WRAPPER_PATH).href);
  return cachedDaemon;
}

/**
 * Executes a callback with a temporary Antigravity transcript.jsonl fixture.
 * Automatically cleans up upon completion.
 */
export async function withMockAntigravityTranscript(transcriptLines, fn) {
  const HOME = process.env.HOME || "";
  const testSessionId = `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const brainDir = path.join(HOME, `.gemini/antigravity/brain/${testSessionId}/.system_generated/logs`);
  const transcriptPath = path.join(brainDir, "transcript.jsonl");

  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(transcriptPath, transcriptLines.join("\n") + "\n", "utf8");

  try {
    const daemon = await loadDaemon();
    return await fn({
      sessionId: testSessionId,
      transcriptPath,
      daemon,
      parse: (meta = {}, usageReqs = []) => {
        const session = daemon.parseAntigravitySession(
          testSessionId,
          PROJECT_ROOT,
          "E2E Test Session",
          new Date().toISOString(),
          new Date().toISOString(),
          meta,
          usageReqs
        );
        if (daemon.buildDshContextPayload) {
          session.dshContext = daemon.buildDshContextPayload(session);
        }
        return session;
      }
    });
  } finally {
    try {
      const topBrainDir = path.join(HOME, `.gemini/antigravity/brain/${testSessionId}`);
      if (fs.existsSync(topBrainDir)) {
        fs.rmSync(topBrainDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

/**
 * Executes a callback with a temporary mock file path.
 */
export async function withTempFile(content, extension, fn) {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `e2e-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`);
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    return await fn(tmpPath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

/**
 * Reference Vo / Ho exit code regex evaluator from dsh-context spec_report §3.1.4 and client.js:369143
 */
export function referenceVo(rawText) {
  if (typeof rawText !== "string") return { fail: false, exit: null };
  const trimmed = rawText.trimEnd();

  // Pattern 1: Shell exit / signal with potential exit code prefix
  const r1 = /\[(shell killed by signal: [^\]\n]+|shell exited(?:: code \d+)?)\]$/.exec(trimmed);
  if (r1 !== null) {
    const exitMatch = /\[exit code:\s*(\d+)\]\s*$/.exec(trimmed.slice(0, r1.index));
    if (exitMatch !== null) return { fail: true, exit: Number(exitMatch[1]) };
    const codeMatch = /: code (\d+)$/.exec(r1[1]);
    if (codeMatch === null) {
      return { fail: r1[1].startsWith("shell killed"), exit: null };
    }
    return { fail: codeMatch[1] !== "0", exit: codeMatch[1] === "0" ? null : Number(codeMatch[1]) };
  }

  // Pattern 2: Standalone [exit code: N]
  const r2 = /\[exit code:\s*(\d+)\]$/.exec(trimmed);
  if (r2 !== null) return { fail: true, exit: Number(r2[1]) };

  // Pattern 3: Killed by signal or status killed/failed
  if (/\[killed by signal: [^\]\n]+\]$/.test(trimmed) || /\[status: (?:killed|failed)(?:, [^\]\n]*)?\]$/.test(trimmed)) {
    return { fail: true, exit: null };
  }

  return { fail: false, exit: null };
}
