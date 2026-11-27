// 插件规范一致性测试 —— 对照 Magpie 官方文档《编写插件 · 窗口里的页面》
// https://usemagpie.ai/docs/zh/plugins
//
// 这里断言的是「页面插件能不能被 magpie 正确加载」，不是业务逻辑。
// 页面在 magpie 里跑在 sandbox="allow-scripts" 的框架中，CSP 为：
//   default-src 'none'; connect-src 'none'; worker-src 'none'; object-src 'none';
//   form-action 'none'; style-src 'unsafe-inline'
// 违反这些约束的表现是「页面白屏 / 没有回应 / Script error.」，很难从现象反推，
// 所以每一条都写成测试，改动时立刻能发现。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

test("package.json: magpie 清单字段齐全且指向真实文件", () => {
  const m = pkg.magpie;
  assert.ok(m, "必须有 magpie 字段，magpie 靠它识别插件");
  assert.equal(typeof m.name, "string");
  assert.ok(m.name.length > 0, "magpie.name 是插件在插件页显示的名字");
  assert.ok(m.summary && m.summary.zh && m.summary.en, "summary 需要 zh 与 en");

  assert.ok(m.page, "页面插件必须有 magpie.page");
  assert.ok(exists(m.page.file), "magpie.page.file 必须存在: " + m.page.file);
  assert.ok(exists(m.page.icon), "magpie.page.icon 必须存在: " + m.page.icon);
  assert.ok(m.page.titles && m.page.titles.zh, "page.titles 至少要有 zh");

  // 图标必须能在包里找到：npm 包里缺图标时插件页显示破图
  assert.ok(pkg.files.includes(m.page.icon), "图标必须列入 files，否则 npm 包里没有它");
  // GitHub 发现卡片读 magpie.icon，必须是可直接渲染的 data: URI 或 http(s) 地址
  assert.match(m.icon, /^(data:image\/|https?:\/\/)/, "magpie.icon 必须是 data: URI 或外链，否则卡片显示拼图");
  assert.ok(pkg.files.includes(m.page.file), "页面文件必须列入 files");
});

// 生成物：本机跑 sync 才会写出来，仓库里没有（含真实会话数据，不能入库）。
// 它们必须列入 files（npm 包由 prepack 写入占位版），但不能要求工作区里存在。
const GENERATED_PAGE_SCRIPTS = new Set(["context-data.js"]);

test("页面只加载自己的文件，且全部随包发布", () => {
  const html = read("page", "index.html");
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length > 0, "页面必须有脚本");
  assert.ok(srcs.includes("_magpie/bridge.js"), "必须引入 magpie 的 bridge.js（由 magpie 旁侧提供）");

  for (const src of srcs) {
    if (src === "_magpie/bridge.js") continue; // magpie 注入，不在包内
    assert.ok(/^[^:]+$/.test(src), "脚本必须是插件内的相对路径，不能是绝对地址: " + src);
    assert.ok(
      pkg.files.some(f => f === "page/" + src || f.startsWith("page/") && f.endsWith(src)),
      "页面脚本必须列入 files，否则 npm 装完 404: " + src
    );
    if (GENERATED_PAGE_SCRIPTS.has(src)) continue; // 由 sync/prepack 生成
    assert.ok(exists("page", src), "源码脚本必须提交进仓库: " + src);
  }
});

test("生成物脚本缺失时页面引导，不是白屏", () => {
  // 从 GitHub 安装时 Magpie 不构建，索引脚本必然 404 —— 这条路径必须已处理
  const code = read("page", "app.js");
  assert.match(
    code,
    /if \(!Array\.isArray\(list\)\) return true;/,
    "索引未加载到必须判为「还没有本地数据」，否则显示误导性的加载失败"
  );
});

test("不违反沙盒：无内联脚本、无内联事件、无网络请求", () => {
  const html = read("page", "index.html");

  // 规范原文: 脚本必须是文件（<script src>），不能内联
  const inlineScript = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(m => m[1].trim().length > 0);
  assert.equal(inlineScript.length, 0, "页面不能有内联脚本，只能 <script src>");

  for (const attr of ["onclick", "onchange", "oninput", "onsubmit", "onload"]) {
    assert.ok(!new RegExp("<[^>]*\\s" + attr + "=", "i").test(html), "不能用内联事件处理器: " + attr);
  }

  // connect-src 'none' → fetch / XHR / WebSocket / sendBeacon 全部被拦
  for (const file of ["page/app.js", "page/icons.js", "page/context-data.js"]) {
    if (!exists(file)) continue;
    const code = read(file);
    for (const banned of ["fetch(", "XMLHttpRequest", "new WebSocket", "sendBeacon", "EventSource"]) {
      assert.ok(!code.includes(banned), file + " 不能使用 " + banned + "（页面 CSP 是 connect-src 'none'）");
    }
  }
});

test("必须调用 magpie.ready，否则窗口判定「没有回应」", () => {
  const code = read("page", "app.js");
  assert.ok(code.includes("magpieBridge.ready") || /\.ready\s*\(/.test(code),
    "页面必须在 10 秒内调用 magpie.ready");
  assert.ok(code.includes("_magpie/bridge.js") || read("page", "index.html").includes("_magpie/bridge.js"),
    "bridge.js 必须先于 app.js 加载");
});

test("permissions 只声明真正用到的读取", () => {
  const code = read("page", "app.js");
  const declared = (pkg.magpie.permissions || []);
  const used = [...code.matchAll(/magpie(?:Bridge)?\.read\(\s*["']([^"']+)["']/g)].map(m => m[1]);
  for (const perm of declared) {
    assert.ok(used.includes(perm), "声明了权限却从不读取，会被窗口当作越权: " + perm);
  }
  for (const perm of used) {
    assert.ok(declared.includes(perm), "用了未声明的读取，窗口会拒绝: " + perm);
  }
});

test("打包必须替换掉本机真实索引，绝不泄露会话数据", () => {
  assert.ok(pkg.scripts.prepack, "需要在 prepack 里写入占位索引");
  assert.ok(pkg.scripts.postpack, "需要在 postpack 里还原本机索引");
  assert.ok(pkg.files.includes("page/context-data.js"),
    "npm 包必须带 context-data.js，否则装完页面 404");
  assert.ok(!pkg.files.some(f => f.includes("page/data")),
    "每会话详情分片含真实对话，绝不能进包");

  // 占位索引本身不能含任何会话
  const placeholder = [
    "window.CONTEXT_DATA_PLACEHOLDER = true;",
    "window.CONTEXT_SESSIONS = [];",
    "window.CONTEXT_DETAIL_FILES = {};"
  ];
  const script = read("scripts", "ensure-placeholder.mjs");
  for (const line of placeholder) {
    assert.ok(script.includes(line), "占位索引必须包含: " + line);
  }
});

test("打包脚本的日志走 stderr，不污染 npm pack --json", () => {
  for (const file of ["scripts/ensure-placeholder.mjs", "scripts/restore-local.mjs"]) {
    const code = read(file);
    assert.ok(!/console\.log\(/.test(code),
      file + " 只能用 console.error：stdout 会被 npm pack --json 当成 JSON 解析");
  }
  // 打包脚本由 `node scripts/...` 调用，不需要可执行位；只有 bin 入口需要
  assert.ok(exists("scripts/ensure-placeholder.mjs") && exists("scripts/restore-local.mjs"),
    "prepack/postpack 引用的脚本必须存在");
});

test("CLI 写入的是 Magpie 实际加载的那份插件，不是 npx 临时副本", () => {
  // 用户跑 npx 时命令执行在临时目录里；Magpie 加载的是 ~/.config/magpie/plugins 里那份。
  // 若按 __dirname 写，数据会落进临时目录，magpie 那边永远是占位索引 —— 这就是"装了却看不到数据"。
  const code = read("bin", "magpie-context.mjs");
  assert.ok(code.includes("resolvePageDir"), "CLI 必须解析真正的写入目标");
  assert.ok(
    code.indexOf("MAGPIE_CONTEXT_PAGE_DIR") < code.indexOf("loadDaemon()") ||
      code.includes("process.env.MAGPIE_CONTEXT_PAGE_DIR = target.pageDir"),
    "必须在 import daemon 之前设置 MAGPIE_CONTEXT_PAGE_DIR（daemon 在模块顶层读取它）"
  );
  // bin/ 下每个模块都必须随包发布：缺一个就是运行时 ERR_MODULE_NOT_FOUND
  for (const file of fs.readdirSync(path.join(ROOT, "bin"))) {
    assert.ok(pkg.files.includes("bin/" + file), "bin/" + file + " 必须列入 files，否则装完 CLI 直接崩");
  }
});

test("CLI 入口存在且 files 收录", () => {
  assert.ok(pkg.bin && pkg.bin["magpie-context"], "需要 bin 入口让用户跑同步命令");
  const binPath = pkg.bin["magpie-context"];
  assert.ok(exists(binPath), "bin 指向的文件必须存在: " + binPath);
  assert.ok(pkg.files.includes(binPath), "bin 必须列入 files");
  const code = read(binPath);
  assert.ok(code.startsWith("#!/usr/bin/env node"), "bin 需要 shebang");
  for (const cmd of ["sync", "watch", "doctor"]) {
    assert.ok(code.includes('"' + cmd + '"'), "CLI 应支持 " + cmd);
  }
});

test("npm test 指向的文件必须随包发布", () => {
  // 曾经 .npmignore 整目录排除 tests/ 与 scripts/, 而 npm test 指向
  // scripts/run-tests.mjs —— 从 tarball 安装后跑 npm test 直接
  // MODULE_NOT_FOUND。CI 跑的是 checkout, 目录都在, 所以永远绿。
  const testScript = pkg.scripts && pkg.scripts.test;
  assert.ok(testScript, "package.json 必须有 test 脚本");
  const runner = testScript.split(/\s+/).find(tok => tok.endsWith(".mjs") || tok.endsWith(".js"));
  assert.ok(runner, "test 脚本要指向一个具体文件, 否则无从校验: " + testScript);
  assert.ok(
    pkg.files.some(f => runner === f || (f.endsWith("/") && runner.startsWith(f))),
    "test 脚本入口 " + runner + " 必须列入 files, 否则装包后 npm test 直接崩"
  );
  // 它枚举的用例目录同样要进包, 否则 runner 跑的是空集合 —— 全绿但什么都没测。
  const testsDir = runner.replace(/scripts[\\/].*$/, "tests");
  assert.ok(
    pkg.files.some(f => f.replace(/\/+$/, "") === testsDir),
    "tests 目录必须列入 files, 否则装包后测试集为空"
  );
});

test("页面在无数据时给出引导，而不是误报加载失败", () => {
  const code = read("page", "app.js");
  assert.ok(code.includes("CONTEXT_DATA_PLACEHOLDER"), "页面要识别打包占位索引");
  assert.ok(code.includes("renderNoDataState"), "需要独立的「还没有数据」态");
  assert.ok(code.includes("magpie-context sync"), "引导文案要给出真正能跑的同步命令");
});