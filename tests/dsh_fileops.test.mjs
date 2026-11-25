/**
 * tests/dsh_fileops.test.mjs
 * 覆盖 magpie-context/dsh-fileops.mjs 的全部契约要求:
 *   文件活动 (read/write/edit/grep/read_image/str_replace_editor + 嵌套调用 + 路径归一)
 *   命令执行 (bash/run_code 嵌套 + job 状态机 + 程序解析 + notable/programs)
 *   空输入 / 确定性 / 行数边界
 * 全部为纯函数断言, 不依赖真实会话文件, 不 mock 任何数据。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFileActivity,
  buildCommandActivity,
  normalizePath,
  countLines,
  countOccurrences,
  formatClock,
  parseProgram,
  parsePrograms,
  splitStatements,
  programOfStatement,
  parseStatusMarkers,
  toolKindOf,
  commandsInCode,
} from "../dsh-fileops.mjs";

const CWD = "/Users/reno/Documents/code/tools";
const HOME = "/Users/reno";
const OPTS = { cwd: CWD, home: HOME };
const T0 = 1794469443975;

function at(seconds) {
  return T0 + Math.round(seconds * 1000);
}

/** 独立实现的 HH:MM:SS, 用来交叉验证 formatClock */
function clockOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function textLines(n) {
  return Array.from({ length: n }, (_, i) => ({ number: i + 1, text: "line " + (i + 1) }));
}

// ---------------------------------------------------------------------------
// 空输入
// ---------------------------------------------------------------------------

test("空输入: 文件活动返回空数组与零值 io", () => {
  for (const input of [[], null, undefined, [null, 1, "x"]]) {
    const { fileOps, io } = buildFileActivity(input, OPTS);
    assert.deepEqual(fileOps, []);
    assert.deepEqual(io, { user: 0, read: 0, write: 0, search: 0, image: 0, mode: null });
  }
});

test("空输入: 命令活动返回空数组与空统计", () => {
  for (const input of [[], null, undefined]) {
    const result = buildCommandActivity(input, input, OPTS);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.commandStats, {});
    assert.deepEqual(result.notable, { slowest: null, mostFail: null, mostRepeat: null });
    assert.deepEqual(result.programs, []);
  }
});

// ---------------------------------------------------------------------------
// 文件活动: read
// ---------------------------------------------------------------------------

test("read: 行区间来自结果 meta", () => {
  const events = [
    {
      callId: "c1",
      nested: false,
      name: "read",
      args: { file_path: "magpie-context/page/app.js" },
      resultText: "",
      isError: false,
      turn: 2,
      step: 3,
      time: T0,
      meta: { path: "/abs/app.js", offset: 1, lines: textLines(120), totalLines: 3000 },
    },
  ];
  const { fileOps, io } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 1);
  const file = fileOps[0];
  assert.equal(file.path, "magpie-context/page/app.js");
  assert.equal(file.name, "app.js");
  assert.equal(file.op, "read");
  assert.equal(file.reads, 1);
  assert.equal(file.writes, 0);
  assert.equal(file.added, 0);
  assert.equal(file.removed, 0);
  assert.equal(file.time, clockOf(T0));
  assert.equal(file.lastTurn, 2);
  assert.equal(file.lastStep, 3);
  assert.equal(file.operations.length, 1);
  assert.equal(file.operations[0].detail, "读取 1-120 行");
  assert.equal(file.operations[0].tool, "read");
  assert.equal(file.operations[0].turn, 2);
  assert.equal(file.operations[0].time, clockOf(T0));
  assert.deepEqual(io, { user: 0, read: 1, write: 0, search: 0, image: 0, mode: null });
});

test("read: 只有 limit 时按估算标注, offset 生效", () => {
  const events = [
    { name: "read", args: { path: "a.js", limit: 200 }, turn: 1, step: 1, time: T0 },
    { name: "read", args: { path: "b.js", limit: 50, offset: 101 }, turn: 1, step: 2, time: at(1) },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 2);
  const a = fileOps.find((f) => f.path === "a.js");
  const b = fileOps.find((f) => f.path === "b.js");
  assert.equal(a.operations[0].detail, "读取 1-200 行 (估算)");
  assert.equal(b.operations[0].detail, "读取 101-150 行 (估算)");
});

// ---------------------------------------------------------------------------
// 文件活动: write / edit
// ---------------------------------------------------------------------------

test("write: overwrite 计全文, append 只计新增", () => {
  const events = [
    {
      name: "write",
      args: { file_path: "x.mjs", content: "a\nb\nc" },
      meta: { operation: "overwrite", path: "x.mjs" },
      turn: 1,
      step: 1,
      time: T0,
    },
    {
      name: "write",
      args: { file_path: "x.mjs", content: "d\ne" },
      meta: { operation: "append", path: "x.mjs" },
      turn: 1,
      step: 2,
      time: at(5),
    },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 1);
  const file = fileOps[0];
  assert.equal(file.writes, 2);
  assert.equal(file.added, 5); // 3 + 2
  assert.equal(file.removed, 0);
  assert.equal(file.op, "write");
  // 最新操作在最前
  assert.equal(file.operations[0].detail, "追加写入 (+2/-0)");
  assert.equal(file.operations[1].detail, "覆盖写入 (+3/-0)");
});

test("edit: 行数增减与替换处数", () => {
  const events = [
    {
      name: "edit",
      args: { file_path: "y.mjs", old_string: "old line", new_string: "new1\nnew2\nnew3" },
      meta: { path: "y.mjs", diffs: [{ path: "y.mjs", oldText: "old line", newText: "new1\nnew2\nnew3" }] },
      turn: 3,
      step: 1,
      time: T0,
    },
  ];
  const { fileOps, io } = buildFileActivity(events, OPTS);
  const file = fileOps[0];
  assert.equal(file.writes, 1);
  assert.equal(file.added, 3);
  assert.equal(file.removed, 1);
  assert.equal(file.operations[0].detail, "替换 1 处 (+3/-1)");
  assert.equal(io.write, 1);
});

test("edit: replace_all 用 diff 数出真实替换处数", () => {
  const oldText = "a\nTARGET\nb\nTARGET\nc\nTARGET\n";
  const events = [
    {
      name: "edit",
      args: { file_path: "z.mjs", old_string: "TARGET", new_string: "DONE", replace_all: true },
      meta: { path: "z.mjs", diffs: [{ path: "z.mjs", oldText, newText: oldText.replaceAll("TARGET", "DONE") }] },
      turn: 1,
      step: 1,
      time: T0,
    },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  assert.equal(fileOps[0].operations[0].detail, "替换 3 处 (+1/-1)");
});

test("str_replace_editor: view 判读, str_replace 判写", () => {
  const events = [
    { name: "str_replace_editor", args: { command: "view", path: "s.py", view_range: [1, 20] }, turn: 1, step: 1, time: T0 },
    {
      name: "str_replace_editor",
      args: { command: "str_replace", path: "s.py", old_str: "a\nb", new_str: "c\nd\ne" },
      turn: 1,
      step: 2,
      time: at(2),
    },
  ];
  assert.equal(toolKindOf("str_replace_editor", { command: "view" }), "read");
  assert.equal(toolKindOf("str_replace_editor", { command: "str_replace" }), "write");
  const { fileOps } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 1);
  assert.equal(fileOps[0].reads, 1);
  assert.equal(fileOps[0].writes, 1);
  assert.equal(fileOps[0].added, 3);
  assert.equal(fileOps[0].removed, 2);
});

// ---------------------------------------------------------------------------
// 文件活动: search / image
// ---------------------------------------------------------------------------

test("grep: 命中文件逐条归行并计入 searches", () => {
  const events = [
    {
      name: "grep",
      args: { pattern: "lc-fa-list", path: CWD },
      meta: {
        shape: "matches",
        truncated: false,
        files: [
          { path: "page/style.css", matches: [{ lineNumber: 1, line: "x" }, { lineNumber: 2, line: "y" }] },
          { path: "page/app.js", matches: [{ lineNumber: 9, line: "z" }] },
        ],
      },
      turn: 2,
      step: 5,
      time: T0,
    },
  ];
  const { fileOps, io } = buildFileActivity(events, OPTS);
  // 搜索根目录 (CWD 自身不在命中集合里) + 2 个命中文件
  assert.equal(fileOps.length, 3);
  const style = fileOps.find((f) => f.path === "page/style.css");
  const app = fileOps.find((f) => f.path === "page/app.js");
  assert.equal(style.searches, 1);
  assert.equal(style.operations[0].detail, "匹配 2 处");
  assert.equal(style.operations[0].hits, 2);
  assert.equal(app.operations[0].detail, "匹配 1 处");
  // 展开成 3 条文件行, 但 io 计的是"搜索调用次数" = 1
  assert.equal(io.search, 1);
  const sumSearches = fileOps.reduce((n, f) => n + f.searches, 0);
  assert.equal(sumSearches, 3);
});

test("grep: 无结果 meta 时归到显式 path", () => {
  const events = [
    { name: "grep", args: { pattern: "TODO", path: "src" }, turn: 1, step: 1, time: T0 },
    { name: "search", args: { query: "needle" }, turn: 1, step: 2, time: at(1) },
  ];
  const { fileOps, io } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 2);
  const src = fileOps.find((f) => f.path === "src");
  assert.equal(src.operations[0].detail, '搜索 "TODO"');
  assert.equal(src.searches, 1);
  assert.equal(src.key, CWD + "/src");
  // 只有 pattern 没有 path 时, 官方语义是把 pattern 记成 path 并打 pattern 标记
  const patternOnly = fileOps.find((f) => f.path === "needle");
  assert.equal(patternOnly.operations[0].pattern, true);
  assert.equal(patternOnly.operations[0].detail, '搜索 "needle"');
  assert.equal(io.search, 2);
});

test("read_image: 计入 images 与 read (官方 kind 映射), 不计行数", () => {
  const events = [
    {
      name: "read_image",
      args: { file_path: "/tmp/shot1.png" },
      resultText: "<path>/tmp/shot1.png</path>\n<type>image</type>\nimage/webp image, 1920x1200 px, 215312 bytes",
      turn: 1,
      step: 1,
      time: T0,
    },
  ];
  const { fileOps, io } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 1);
  const file = fileOps[0];
  assert.equal(file.images, 1);
  assert.equal(file.reads, 1); // 官方 Fe: read_image -> read
  assert.equal(file.added, 0);
  assert.equal(file.removed, 0);
  assert.equal(file.operations[0].detail, "读取图片 1920x1200");
  // io.read 覆盖 read_image, io.image 是其中的图片子集
  assert.deepEqual(io, { user: 0, read: 1, write: 0, search: 0, image: 1, mode: null });
});

test("嵌套调用 (nested=true) 计入并标记", () => {
  const events = [
    {
      name: "read",
      nested: true,
      callId: "call_1:ptc:1",
      parentCallId: "call_1",
      rootCallId: "call_1",
      args: { file_path: "nested.js" },
      turn: 4,
      step: 2,
      time: T0,
    },
  ];
  const { fileOps, io } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 1);
  assert.equal(fileOps[0].operations[0].nested, true);
  assert.equal(io.read, 1);
});

test("未覆盖的工具不产生文件活动", () => {
  const events = [
    { name: "bash", args: { command: "cat x.js" }, turn: 1, step: 1, time: T0 },
    { name: "subagent", args: { prompt: "hi" }, turn: 1, step: 1, time: T0 },
    { name: "skill", args: { name: "x" }, turn: 1, step: 1, time: T0 },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  assert.deepEqual(fileOps, []);
});

// ---------------------------------------------------------------------------
// 路径归一
// ---------------------------------------------------------------------------

test("路径归一: 相对 / 绝对 / ~ / .. 合并为同一文件", () => {
  const events = [
    { name: "read", args: { file_path: "magpie-context/page/app.js" }, turn: 1, step: 1, time: T0 },
    { name: "read", args: { file_path: "./magpie-context/page/app.js" }, turn: 1, step: 2, time: at(1) },
    { name: "read", args: { file_path: "  magpie-context/../magpie-context/page/app.js  " }, turn: 1, step: 3, time: at(2) },
    {
      name: "write",
      args: { file_path: CWD + "/magpie-context/page/app.js", content: "a\nb\nc" },
      meta: { operation: "overwrite" },
      turn: 2,
      step: 1,
      time: at(3),
    },
    {
      name: "edit",
      args: { file_path: "~/Documents/code/tools/magpie-context/page/app.js", old_string: "x", new_string: "y" },
      turn: 2,
      step: 2,
      time: at(4),
    },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  assert.equal(fileOps.length, 1);
  const file = fileOps[0];
  assert.equal(file.reads, 3);
  assert.equal(file.writes, 2);
  assert.equal(file.operations.length, 5);
  // 展示用原文路径: 取最短写法
  assert.equal(file.path, "magpie-context/page/app.js");
  assert.equal(file.key, CWD + "/magpie-context/page/app.js");
});

test("路径归一: 无 cwd / home 时保留可合并的相对形态", () => {
  assert.equal(normalizePath("./a/../b.js"), "b.js");
  assert.equal(normalizePath("  a/b.js  "), "a/b.js");
  assert.equal(normalizePath('"quoted.js"'), "quoted.js");
  assert.equal(normalizePath("file:///tmp/x.js"), "/tmp/x.js");
  assert.equal(normalizePath("~/x.js"), "~/x.js"); // home 未知: 不拼 cwd
  assert.equal(normalizePath("~/x.js", { home: "/Users/reno" }), "/Users/reno/x.js");
  assert.equal(normalizePath("x.js", { cwd: "/root/" }), "/root/x.js");
  assert.equal(normalizePath("../../x.js", { cwd: "/a/b/c" }), "/a/x.js");
  assert.equal(normalizePath("", {}), "");
  assert.equal(normalizePath(null, {}), "");
  assert.equal(normalizePath("a\\b\\c.js", {}), "a/b/c.js");
});

// ---------------------------------------------------------------------------
// 行数边界
// ---------------------------------------------------------------------------

test("行数边界: 全删 / 全增 / 空内容", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("\n"), 1);
  assert.equal(countLines("\n\n"), 2);

  const events = [
    // 全删: old 3 行 -> new 空
    { name: "edit", args: { file_path: "del.txt", old_string: "a\nb\nc", new_string: "" }, turn: 1, step: 1, time: T0 },
    // 全增: old 空 -> new 2 行
    { name: "edit", args: { file_path: "add.txt", old_string: "", new_string: "a\nb" }, turn: 1, step: 2, time: at(1) },
    // 空内容 write
    { name: "write", args: { file_path: "empty.txt", content: "" }, turn: 1, step: 3, time: at(2) },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  const del = fileOps.find((f) => f.path === "del.txt");
  const add = fileOps.find((f) => f.path === "add.txt");
  const empty = fileOps.find((f) => f.path === "empty.txt");
  assert.deepEqual([del.added, del.removed], [0, 3]);
  assert.equal(del.operations[0].detail, "替换 1 处 (+0/-3)");
  assert.deepEqual([add.added, add.removed], [2, 0]);
  assert.equal(add.operations[0].detail, "替换 1 处 (+2/-0)");
  assert.deepEqual([empty.added, empty.removed], [0, 0]);
  assert.equal(empty.operations[0].detail, "写入文件 (+0/-0)");
});

// ---------------------------------------------------------------------------
// 确定性
// ---------------------------------------------------------------------------

test("确定性: 同一输入两次调用 JSON 完全一致", () => {
  const fileEvents = [
    { name: "read", args: { file_path: "a.js" }, turn: 1, step: 1, time: T0 },
    { name: "write", args: { file_path: "b.js", content: "x\ny" }, turn: 1, step: 2, time: at(1) },
    { name: "grep", args: { pattern: "p", path: "a.js" }, meta: { shape: "matches", files: [{ path: "a.js", matches: [{ lineNumber: 1 }] }] }, turn: 1, step: 3, time: at(2) },
  ];
  const cmdEvents = [
    { callId: "c1", name: "bash", args: { command: "ls -la" }, turn: 1, step: 1, time: T0 },
    { callId: "c2", name: "bash", args: { command: "npm test" }, turn: 1, step: 2, time: at(3) },
  ];
  const jobs = [
    { id: "j1", callId: "c1", label: "ls -la", status: "completed", ms: 12, exitCode: 0 },
    { id: "j2", callId: "c2", label: "npm test", status: "failed", ms: 900, exitCode: 1 },
  ];
  const a1 = JSON.stringify(buildFileActivity(fileEvents, OPTS));
  const a2 = JSON.stringify(buildFileActivity(fileEvents, OPTS));
  const b1 = JSON.stringify(buildCommandActivity(cmdEvents, jobs, OPTS));
  const b2 = JSON.stringify(buildCommandActivity(cmdEvents, jobs, OPTS));
  assert.equal(a1, a2);
  assert.equal(b1, b2);
});

test("重复 callId 的事件只计一次 (会话日志重放)", () => {
  const dupRead = { callId: "call_dup", name: "read", args: { file_path: "dup.js" }, turn: 1, step: 1, time: T0 };
  const dupBash = { callId: "call_bash", name: "bash", args: { command: "ls -la" }, turn: 1, step: 2, time: at(1) };
  const fileEvents = [dupRead, { ...dupRead }];
  const { fileOps, io } = buildFileActivity(fileEvents, OPTS);
  assert.equal(fileOps.length, 1);
  assert.equal(fileOps[0].reads, 1);
  assert.equal(io.read, 1);

  const commandEvents = [dupBash, { ...dupBash }];
  const { commands } = buildCommandActivity(commandEvents, [], OPTS);
  assert.equal(commands.length, 1);
});

test("io: user / mode 来自 opts, 计数为真实次数", () => {
  const events = [
    { name: "read", args: { file_path: "a.js" }, turn: 1, step: 1, time: T0 },
    { name: "write", args: { file_path: "a.js", content: "x" }, turn: 1, step: 2, time: at(1) },
    { name: "grep", args: { pattern: "p", path: "a.js" }, turn: 1, step: 3, time: at(2) },
    { name: "read_image", args: { file_path: "a.png" }, turn: 1, step: 4, time: at(3) },
  ];
  const { io } = buildFileActivity(events, { cwd: CWD, user: 7, mode: "ptc" });
  // read 覆盖 1 次 read + 1 次 read_image (官方 kind 映射), image 是其中图片子集
  assert.deepEqual(io, { user: 7, read: 2, write: 1, search: 1, image: 1, mode: "ptc" });
});

// ---------------------------------------------------------------------------
// 命令活动: 状态 / 耗时
// ---------------------------------------------------------------------------

test("bash: job 提供 status / 耗时 / 退出码", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "npm test", description: "run tests" }, turn: 2, step: 4, time: T0, resultText: "ok\n" },
  ];
  const jobs = [
    { id: "job-1", callId: "c1", label: "npm test", status: "completed", ms: 1234, exitCode: 0, detail: "exit code: 0", time: at(1.3) },
  ];
  const { commands, commandStats, programs } = buildCommandActivity(events, jobs, OPTS);
  assert.equal(commands.length, 1);
  const cmd = commands[0];
  assert.equal(cmd.cmd, "npm test");
  assert.equal(cmd.program, "npm");
  assert.equal(cmd.status, "completed");
  assert.equal(cmd.ms, 1234);
  assert.equal(cmd.exitCode, 0);
  assert.equal(cmd.turn, 2);
  assert.equal(cmd.step, 4);
  assert.equal(cmd.time, clockOf(T0));
  assert.equal(cmd.label, "run tests");
  assert.equal(cmd.jobId, "job-1");
  assert.equal(cmd.nested, false);
  assert.equal(cmd.background, false);
  assert.deepEqual(commandStats, { npm: 1 });
  assert.deepEqual(programs, [{ name: "npm", count: 1 }]);
});

test("bash: 失败命令与 notable.mostFail", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "node a.mjs" }, turn: 1, step: 1, time: T0 },
    { callId: "c2", name: "bash", args: { command: "node b.mjs" }, turn: 1, step: 2, time: at(1) },
    { callId: "c3", name: "bash", args: { command: "ls" }, turn: 1, step: 3, time: at(2) },
  ];
  const jobs = [
    { id: "j1", callId: "c1", label: "node a.mjs", status: "failed", ms: 20, exitCode: 1, detail: "exit code: 1" },
    { id: "j2", callId: "c2", label: "node b.mjs", status: "failed", ms: 30, exitCode: 2, detail: "exit code: 2" },
    { id: "j3", callId: "c3", label: "ls", status: "completed", ms: 5, exitCode: 0, detail: "exit code: 0" },
  ];
  const { commands, notable } = buildCommandActivity(events, jobs, OPTS);
  assert.equal(commands.filter((c) => c.status === "failed").length, 2);
  assert.deepEqual(notable.mostFail, { program: "node", count: 2 });
  assert.deepEqual(notable.slowest, { program: "node", ms: 30 });
});

test("bash: 结果标记判定失败 (exit code / command not found / timeout)", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "make" }, turn: 1, step: 1, time: T0, resultText: "boom\n[exit code: 2]" },
    { callId: "c2", name: "bash", args: { command: "foo" }, turn: 1, step: 2, time: at(1), resultText: "bash: foo: command not found" },
    { callId: "c3", name: "bash", args: { command: "sleep 9" }, turn: 1, step: 3, time: at(2), resultText: "[timed out after 30000ms]" },
    { callId: "c4", name: "bash", args: { command: "true" }, turn: 1, step: 4, time: at(3), resultText: "[exit code: 0]" },
  ];
  const { commands } = buildCommandActivity(events, [], OPTS);
  assert.equal(commands[0].status, "failed");
  assert.equal(commands[0].exitCode, 2);
  assert.equal(commands[1].status, "failed");
  assert.equal(commands[1].notFound, true);
  assert.equal(commands[2].status, "failed");
  assert.equal(commands[2].timedOut, true);
  assert.equal(commands[3].status, "completed");
  assert.equal(commands[3].exitCode, 0);
});

test("bash: 后台命令判定为 background", () => {
  const events = [
    {
      callId: "c1",
      name: "bash",
      args: { command: "node server.mjs", run_in_background: true },
      turn: 1,
      step: 1,
      time: T0,
      resultText: "started background job bash-abc123",
    },
  ];
  const { commands } = buildCommandActivity(events, [], OPTS);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].status, "background");
  assert.equal(commands[0].background, true);
  assert.equal(commands[0].program, "node");
});

test("ms: 无 job 时用工具起止时间, 都没有则 0", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "node a.mjs" }, turn: 1, step: 1, time: T0, startTime: T0, endTime: T0 + 250 },
    { callId: "c2", name: "bash", args: { command: "node b.mjs" }, turn: 1, step: 2, time: T0 },
  ];
  const { commands } = buildCommandActivity(events, [], OPTS);
  assert.equal(commands[0].ms, 250);
  assert.equal(commands[1].ms, 0);
});

// ---------------------------------------------------------------------------
// 命令活动: 程序解析
// ---------------------------------------------------------------------------

test("program 解析: 去 env 赋值 / sudo / nohup / time / 引号", () => {
  assert.equal(parseProgram("FOO=1 BAR=2 node a.mjs"), "node");
  assert.equal(parseProgram("sudo -u root npm install"), "npm");
  assert.equal(parseProgram("nohup node server.mjs &"), "node");
  assert.equal(parseProgram("time npm test"), "npm");
  assert.equal(parseProgram("timeout 30 npm test"), "npm");
  assert.equal(parseProgram("env -i FOO=1 node x.js"), "node");
  assert.equal(parseProgram('"/usr/local/bin/node" x.js'), "node");
  assert.equal(parseProgram("/usr/local/bin/python3.9 x.py"), "python3.9");
  assert.equal(parseProgram("node.exe x.js"), "node");
  assert.equal(parseProgram(""), "shell");
  assert.equal(parseProgram("for f in *; do echo $f; done"), "shell");
  assert.equal(parseProgram("cat a | grep b"), "cat");
  assert.equal(parseProgram("cd /tmp && node a.mjs"), "node");
  assert.equal(parseProgram("cd /tmp"), "cd");
  assert.equal(parseProgram("ls; pwd"), "ls");
  assert.equal(parseProgram("run_code text", "run_code"), "run_code");
});

test("program 解析: 语句切分与多程序列表", () => {
  assert.deepEqual(splitStatements("cd x && node a.js | grep y; echo z"), ["cd x", "node a.js", "grep y", "echo z"]);
  assert.deepEqual(parsePrograms("cd x && node a.js | grep y"), ["node", "grep"]);
  assert.equal(programOfStatement("2>&1 node a.js"), "node");
  assert.equal(programOfStatement(""), "");
});

// ---------------------------------------------------------------------------
// 命令活动: run_code 与 job 关联
// ---------------------------------------------------------------------------

test("run_code: 与嵌套 bash 各自成条 (官方双记, 不去重)", () => {
  const events = [
    {
      callId: "call_1",
      name: "run_code",
      args: { code: "const r = await tools.bash({ description: 'x', command: 'ls -la' });" },
      turn: 1,
      step: 1,
      time: T0,
      nested: false,
    },
    {
      callId: "call_1:ptc:1",
      parentCallId: "call_1",
      rootCallId: "call_1",
      name: "bash",
      args: { command: "ls -la" },
      nested: true,
      turn: 1,
      step: 1,
      time: at(0.1),
    },
  ];
  const { commands } = buildCommandActivity(events, [], OPTS);
  // 官方 (off-index.pretty.mjs:1779-1792 + 1819-1844): run_code 的 tool/call 与程序内嵌套 bash
  // 各自产出一条 CommandRecord, 两条都保留 —— 因此这里是 2 条 (codeMode 1 + 嵌套 1)。
  assert.equal(commands.length, 2);
  const nestedCmd = commands.find((c) => c.nested === true);
  const codeCmd = commands.find((c) => c.codeMode === true);
  assert.equal(nestedCmd.cmd, "ls -la");
  assert.equal(nestedCmd.codeMode, false);
  assert.equal(codeCmd.program, "run_code");
});

test("run_code: CommandRecord.cmd = args.code (官方 :1779-1792, codeMode:true)", () => {
  const code = "const r = await tools.bash({ description: \"list\", command: \"cd /tmp && node x.mjs\" });\nawait tools.bash({ command: 'git status' });";
  assert.deepEqual(commandsInCode(code), ["cd /tmp && node x.mjs", "git status"]);
  const events = [{ callId: "call_9", name: "run_code", args: { code }, turn: 1, step: 1, time: T0 }];
  const { commands } = buildCommandActivity(events, [], OPTS);
  // 官方: 每个 run_code 的 tool/call 都建一条 CommandRecord, cmd 就是 args.code 原文
  // (程序内的嵌套 bash 由 tool/ptc-dispatch 另行记录, 两者都保留)
  assert.equal(commands.length, 1);
  assert.equal(commands[0].codeMode, true);
  assert.equal(commands[0].cmd, code);
  assert.equal(commands[0].program, "run_code");
});

test("job 匹配: callId 优先, label 文本兜底", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "ls -la" }, turn: 1, step: 1, time: T0 },
    { callId: "c2", name: "bash", args: { command: "git status" }, turn: 1, step: 2, time: at(1) },
  ];
  const jobs = [
    { id: "j1", callId: "c1", label: "ls -la", status: "completed", ms: 40, exitCode: 0 },
    { id: "j2", label: "git status", status: "completed", ms: 60, exitCode: 0 }, // 无 callId
  ];
  const { commands } = buildCommandActivity(events, jobs, OPTS);
  assert.equal(commands[0].ms, 40);
  assert.equal(commands[0].jobId, "j1");
  assert.equal(commands[1].ms, 60);
  assert.equal(commands[1].jobId, "j2");
});

test("job 兜底: 无对应工具事件的 job 用 label 还原为命令", () => {
  const jobs = [
    { id: "j9", kind: "bash", label: "git status --short", status: "completed", ms: 12, exitCode: 0, time: T0, turn: 3, step: 2 },
    { id: "j10", kind: "subagent", label: "not-a-command", status: "completed", ms: 1, time: at(1) },
  ];
  const { commands } = buildCommandActivity([], jobs, OPTS);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cmd, "git status --short");
  assert.equal(commands[0].program, "git");
  assert.equal(commands[0].fromJob, true);
  assert.equal(commands[0].ms, 12);
  assert.equal(commands[0].time, clockOf(T0));

  const disabled = buildCommandActivity([], jobs, { ...OPTS, synthesizeFromJobs: false });
  assert.deepEqual(disabled.commands, []);
});

test("commandStats / programs 按次数降序", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "ls" }, turn: 1, step: 1, time: T0 },
    { callId: "c2", name: "bash", args: { command: "ls -la" }, turn: 1, step: 2, time: at(1) },
    { callId: "c3", name: "bash", args: { command: "node x.js" }, turn: 1, step: 3, time: at(2) },
    { callId: "c4", name: "bash", args: { command: "npm test" }, turn: 1, step: 4, time: at(3) },
  ];
  const { commandStats, programs } = buildCommandActivity(events, [], OPTS);
  assert.deepEqual(commandStats, { ls: 2, node: 1, npm: 1 });
  assert.deepEqual(programs, [
    { name: "ls", count: 2 },
    { name: "node", count: 1 },
    { name: "npm", count: 1 },
  ]);
});

test("notable: 最慢程序与重复最多命令", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "cd /tmp/x && node a.mjs" }, turn: 1, step: 1, time: T0 },
    { callId: "c2", name: "bash", args: { command: "cd /tmp/x && node a.mjs" }, turn: 1, step: 2, time: at(1) },
    { callId: "c3", name: "bash", args: { command: "npm run build" }, turn: 1, step: 3, time: at(2) },
  ];
  const jobs = [
    { id: "j1", callId: "c1", label: "cd /tmp/x && node a.mjs", status: "completed", ms: 10 },
    { id: "j2", callId: "c2", label: "cd /tmp/x && node a.mjs", status: "completed", ms: 20 },
    { id: "j3", callId: "c3", label: "npm run build", status: "completed", ms: 5000 },
  ];
  const { notable } = buildCommandActivity(events, jobs, OPTS);
  assert.deepEqual(notable.slowest, { program: "npm", ms: 5000 });
  assert.deepEqual(notable.mostRepeat, { cmd: "cd /tmp/x && node a.mjs", count: 2 });
  assert.equal(notable.mostFail, null);
});

// ---------------------------------------------------------------------------
// 页面消费字段
// ---------------------------------------------------------------------------

test("fileOps 字段对齐 renderFilesCard", () => {
  const events = [
    { name: "read", args: { file_path: "a.js" }, turn: 1, step: 1, time: T0, meta: { path: "a.js", offset: 1, lines: textLines(10) } },
    { name: "write", args: { file_path: "a.js", content: "x\ny" }, turn: 1, step: 2, time: at(1) },
  ];
  const { fileOps } = buildFileActivity(events, OPTS);
  const file = fileOps[0];
  for (const key of ["path", "name", "op", "reads", "writes", "searches", "added", "removed", "time", "lastTurn", "lastStep", "images", "operations"]) {
    assert.ok(Object.hasOwn(file, key), "缺少字段 " + key);
  }
  assert.ok(Array.isArray(file.operations));
  for (const key of ["tool", "detail", "time", "turn", "step", "op"]) {
    assert.ok(Object.hasOwn(file.operations[0], key), "operation 缺少字段 " + key);
  }
  assert.equal(typeof file.added, "number");
  assert.equal(typeof file.removed, "number");
  assert.equal(file.name, "a.js");
});

test("commands 字段对齐 renderCommandsCard", () => {
  const events = [
    { callId: "c1", name: "bash", args: { command: "npm test" }, turn: 1, step: 1, time: T0, resultText: "ok" },
  ];
  const jobs = [{ id: "j1", callId: "c1", label: "npm test", status: "completed", ms: 100, exitCode: 0 }];
  const { commands } = buildCommandActivity(events, jobs, OPTS);
  const cmd = commands[0];
  for (const key of ["cmd", "program", "status", "ms", "turn", "step", "time", "seq", "background", "nested"]) {
    assert.ok(Object.hasOwn(cmd, key), "缺少字段 " + key);
  }
  assert.equal(cmd.seq, 1);
  assert.equal(cmd.outChars, 2);
  assert.equal(typeof cmd.ms, "number");
  assert.ok(["completed", "failed", "background"].includes(cmd.status));
});

// ---------------------------------------------------------------------------
// 状态标记解析
// ---------------------------------------------------------------------------

test("parseStatusMarkers: 官方标记全覆盖", () => {
  assert.deepEqual(parseStatusMarkers("[exit code: 0]"), { exitCode: 0 });
  assert.equal(parseStatusMarkers("[Command finished with exit code 3]").exitCode, 3);
  assert.equal(parseStatusMarkers("[shell exited: code 4]").exitCode, 4);
  assert.equal(parseStatusMarkers("[killed by signal: SIGKILL]").killed, true);
  assert.equal(parseStatusMarkers("[timed out after 1200ms]").timedOut, true);
  assert.equal(parseStatusMarkers("[sandbox: file access denied under workspace-write]").denied, true);
  assert.equal(parseStatusMarkers("started background job bash-1").backgroundAck, true);
  assert.equal(parseStatusMarkers("[output truncated; showing tail]").truncated, true);
  assert.equal(parseStatusMarkers("bash: foo: command not found").notFound, true);
  assert.deepEqual(parseStatusMarkers(""), {});
  assert.deepEqual(parseStatusMarkers(null), {});
});

test("formatClock / countOccurrences 基础行为", () => {
  assert.equal(formatClock(T0), clockOf(T0));
  assert.equal(formatClock(undefined), "");
  assert.equal(formatClock("x"), "");
  assert.equal(countOccurrences("aXbXc", "X"), 2);
  assert.equal(countOccurrences("aaa", "aa"), 1);
  assert.equal(countOccurrences("abc", ""), 0);
});
