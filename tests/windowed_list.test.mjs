// tests/windowed_list.test.mjs
// 回归测试: 弹窗内的大列表必须窗口化渲染。
//
// 背景: 命令卡原来一次性 innerHTML 全量渲染 (最大会话 8383 条 → 108,979 个
// DOM 节点, 整个弹窗 143,886 节点 / 渲染 1057ms, 4x CPU 降速下 3612ms)。
// 现在改为首屏一页 + 滚动/按钮续页, 这里直接执行 app.js 里的真实实现来验证
// 行为, 而不是断言字符串存在 —— 字符串断言无法发现「又改回全量渲染」。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getAppJs } from "./helpers/dom_harness.mjs";

/** 从 app.js 源码中按大括号配对截取一个函数定义 (含函数体) */
function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("未找到函数 " + name);
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("函数 " + name + " 大括号不配对");
}

/** 极简容器: 只实现 mountWindowedList 用到的那几个 DOM 方法 */
function makeContainer() {
  const listeners = {};
  const container = {
    _html: "",
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 10000,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    insertAdjacentHTML(_pos, html) { this._html += html; },
    querySelector() { return null; },
    dispatch(type, ev) { (listeners[type] || []).forEach(fn => fn(ev)); },
    listenerCount(type) { return (listeners[type] || []).length; }
  };
  return container;
}

function loadMountWindowedList() {
  const src = getAppJs();
  const fnSrc = extractFunction(src, "mountWindowedList");
  const ctx = { LIST_PAGE_SIZE: 80 };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + "\n;globalThis.__mount = mountWindowedList;", ctx);
  return ctx.__mount;
}

describe("弹窗列表窗口化渲染", () => {
  it("首屏只渲染一页, 而不是全部条目", () => {
    const mount = loadMountWindowedList();
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const container = makeContainer();
    mount(container, { items, renderItem: (n) => `<div class="row">${n}</div>`, pageSize: 80 });
    const rendered = (container.innerHTML.match(/class="row"/g) || []).length;
    assert.equal(rendered, 80, "首屏应恰好渲染一页 (80 条), 实际 " + rendered);
    assert.ok(container.innerHTML.includes("加载更多"), "未渲染完时必须给出「加载更多」入口");
    assert.ok(container.innerHTML.includes("920"), "脚注应显示剩余条数");
  });

  it("点击加载更多追加下一页, 不重复渲染已有条目", () => {
    const mount = loadMountWindowedList();
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const container = makeContainer();
    mount(container, { items, renderItem: (n) => `<div class="row">${n}</div>`, pageSize: 80 });
    // 模拟点击「加载更多」: 事件委托按 .lc-list-more 命中
    container.dispatch("click", { target: { closest: (sel) => (sel === ".lc-list-more" ? {} : null) } });
    const rendered = (container.innerHTML.match(/class="row"/g) || []).length;
    assert.equal(rendered, 160, "追加一页后应为 160 条, 实际 " + rendered);
  });

  it("全部渲染完后脚注切换为已全部显示, 不再重复追加", () => {
    const mount = loadMountWindowedList();
    const items = Array.from({ length: 100 }, (_, i) => i);
    const container = makeContainer();
    mount(container, { items, renderItem: (n) => `<div class="row">${n}</div>`, pageSize: 80 });
    container.dispatch("click", { target: { closest: (sel) => (sel === ".lc-list-more" ? {} : null) } });
    const rendered = (container.innerHTML.match(/class="row"/g) || []).length;
    assert.equal(rendered, 100, "应渲染全部 100 条");
    assert.ok(container.innerHTML.includes("已全部显示"), "渲染完应提示已全部显示");
    container.dispatch("click", { target: { closest: (sel) => (sel === ".lc-list-more" ? {} : null) } });
    assert.equal((container.innerHTML.match(/class="row"/g) || []).length, 100, "渲染完后再次触发不应重复追加");
  });

  it("事件监听器只绑一次 (委托), 与条目数量无关", () => {
    const mount = loadMountWindowedList();
    const items = Array.from({ length: 500 }, (_, i) => i);
    const container = makeContainer();
    mount(container, { items, renderItem: (n) => `<div class="row">${n}</div>`, pageSize: 80 });
    mount(container, { items, renderItem: (n) => `<div class="row">${n}</div>`, pageSize: 80 });
    assert.equal(container.listenerCount("click"), 1, "click 监听器应只有 1 个");
    assert.equal(container.listenerCount("scroll"), 1, "scroll 监听器应只有 1 个");
  });

  it("空列表渲染空态, 不渲染任何条目", () => {
    const mount = loadMountWindowedList();
    const container = makeContainer();
    mount(container, { items: [], renderItem: (n) => `<div class="row">${n}</div>`, emptyHtml: "<div class=empty>无</div>" });
    assert.ok(container.innerHTML.includes("empty"));
    assert.equal((container.innerHTML.match(/class="row"/g) || []).length, 0);
  });
});
