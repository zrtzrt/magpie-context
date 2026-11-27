// 页面插件 service 声明与入口契约: 防止发版时漏掉 main/service 字段。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("package.json 声明 page.service 与 main 入口", () => {
  assert.equal(pkg.main, "index.js");
  assert.equal(pkg.magpie.page.service.port, 3457);
  assert.equal(pkg.magpie.page.service.option, "port");
  assert.equal(pkg.magpie.options.port, 3457);
  assert.ok(pkg.files.includes("index.js"));
});

test("index.js 导出插件函数并兼容 default/server 两种加载方式", () => {
  const service = require(path.join(ROOT, "index.js"));
  assert.equal(typeof service, "function");
  assert.equal(service.default.server, service);
  assert.equal(service.server, service);
  assert.equal(service.__service.DEFAULT_PORT, 3457);
});

test("MAGPIE_CONTEXT_SERVICE_DISABLE=1 时调用不启动子进程或端口", async () => {
  const old = process.env.MAGPIE_CONTEXT_SERVICE_DISABLE;
  process.env.MAGPIE_CONTEXT_SERVICE_DISABLE = "1";
  try {
    const service = require(path.join(ROOT, "index.js"));
    const result = await service({}, {});
    assert.equal(result.ok, true);
    assert.equal(result.port, 3457);
    const health = service.__service.healthPayload();
    assert.equal(health.ok, true);
    assert.equal(health.service, "magpie-context");
    assert.equal(health.watcher, false);
  } finally {
    if (old === undefined) delete process.env.MAGPIE_CONTEXT_SERVICE_DISABLE;
    else process.env.MAGPIE_CONTEXT_SERVICE_DISABLE = old;
  }
});
