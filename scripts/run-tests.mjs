#!/usr/bin/env node
// 跨平台测试入口。
//
// 为什么不直接在 package.json 里写 `node --test tests/*.test.mjs`:
//   - Windows 的 cmd / PowerShell 不展开 glob, 原样把字面量传给 node, 直接失败;
//   - `node --test tests/` 这种目录形式只在较新的 Node 上被当成目录, Node 22/24
//     会报 `Cannot find module '.../tests'`;
//   - bash 展开 glob 的行为又依赖 shell 选项 (nullglob / globstar)。
// 三种写法都至少在一个平台上不成立, 所以这里自己枚举文件, 把确定的文件列表
// 交给 node --test —— 与 shell 和 Node 版本都无关。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(ROOT, "tests");

/** 递归收集 *.test.mjs (跳过 helpers / 隐藏目录) */
function collect(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "helpers" || entry.name === "node_modules") continue;
      collect(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(TESTS_DIR).sort();
if (files.length === 0) {
  console.error("[run-tests] tests/ 下没有找到任何 *.test.mjs");
  process.exit(1);
}

console.log("[run-tests] " + files.length + " 个测试文件, Node " + process.version + " (" + process.platform + ")");

const args = ["--test", "--test-concurrency=1", ...files];
const child = spawn(process.execPath, args, { stdio: "inherit", cwd: ROOT });
child.on("exit", (code, signal) => {
  if (signal) {
    console.error("[run-tests] 被信号中断: " + signal);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
child.on("error", (error) => {
  console.error("[run-tests] 无法启动测试进程: " + error.message);
  process.exit(1);
});
