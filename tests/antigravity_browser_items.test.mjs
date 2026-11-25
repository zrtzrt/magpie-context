// tests/antigravity_browser_items.test.mjs
// 验收: 反重力 (antigravity) 会话 ——
//   ① 上下文浏览器条目由真实消息填充 (items 不再全部为空)
//   ② DNA 条带与 items 同源逐条生成
//   ③ 子 Agent ↔ 会话映射 (sessionId / matched)
//   ④ 数据护盾: fullText ≤ 24,000, snippet ≤ 400, 无硬编码/编造内容
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadDaemon, withMockAntigravityTranscript } from "./helpers/daemon_harness.mjs";
import { createTranscriptLine } from "./helpers/fixtures.mjs";

describe("Antigravity 上下文浏览器条目 与 DNA 条带 真实消息驱动", () => {
  it("用户消息/助手消息/工具结果为真实条目, 不再为空", async () => {
    const lines = [
      createTranscriptLine("USER_INPUT", "请读取 README.md 并总结", { step_index: 0, input_tokens: 4000 }),
      createTranscriptLine("PLANNER_RESPONSE", "开始分析 README 内容...", {
        step_index: 1, input_tokens: 5200, output_tokens: 340,
        tool_calls: [{ name: "read_file", args: { Path: "README.md" } }]
      }),
      createTranscriptLine("GENERIC", "## 项目说明\n这是一个测试项目。\n\n使用说明:\n1. 安装依赖\n2. 构建", {
        step_index: 2, input_tokens: 5400, output_tokens: 0, status: "success"
      }),
    ];
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const dc = session.dshContext;
      assert.ok(dc, "dshContext must exist");
      assert.ok(dc.steps.length > 0, "must have at least one step");

      for (const step of dc.steps) {
        assert.ok(Array.isArray(step.browserCategories), "every step must have browserCategories");
        for (const cat of step.browserCategories) {
          const items = cat.items || [];
          for (const item of items) {
            assert.ok(typeof item.id === "string", "every item must have an id");
            assert.ok(typeof item.title === "string" && item.title !== "", "item must have non-empty title");
            assert.ok(typeof item.snippet === "string", "item must have snippet");
            assert.ok(typeof item.fullText === "string" && item.fullText !== "", "item must have fullText (real content)");
            assert.ok(Number(item.tokens) > 0, "item tokens must be positive");
            // 数据护盾
            assert.ok(item.fullText.length <= 24000, "fullText must be ≤ 24,000 characters");
            assert.ok(item.snippet.length <= 400, "snippet must be ≤ 400 characters");
            if (item.fullText.length === 24000) assert.ok(item.truncated === true, "truncated flag must be set when text at limit");
            // 禁止编造: 不能出现合成占位文本
            const fakePrefixes = ["[系统指令与行为准则", "[工具声明 Schema", "[模型思考与规划]", "[网关调用]"];
            for (const prefix of fakePrefixes) {
              assert.ok(!item.fullText.startsWith(prefix), "item.fullText must not contain fabricated placeholder text: " + prefix);
            }
          }
        }
      }
    });
  });

  it("DNA 条带与 items 同源逐条生成, cat 永远在 7 分类之内", async () => {
    const lines = [
      createTranscriptLine("SYSTEM_MESSAGE", "你是 AI 助手, 擅长代码审查。", { step_index: 0, input_tokens: 120 }),
      createTranscriptLine("USER_INPUT", "审查 src/app.ts", { step_index: 1, input_tokens: 2000 }),
      createTranscriptLine("PLANNER_RESPONSE", "开始审查...", {
        step_index: 2, input_tokens: 4000, output_tokens: 500,
        tool_calls: [{ name: "read_file", args: { Path: "src/app.ts" } }]
      }),
      createTranscriptLine("GENERIC", "export class App { constructor() {} }", {
        step_index: 3, input_tokens: 4500, status: "success"
      }),
      createTranscriptLine("SYSTEM_MESSAGE", "提醒: 注意检查 XSS 防护。", { step_index: 4, input_tokens: 80 }),
      createTranscriptLine("PLANNER_RESPONSE", "发现一个安全问题...", {
        step_index: 5, input_tokens: 5000, output_tokens: 600,
        tool_calls: [{ name: "edit_file", args: { Path: "src/app.ts", Content: "..." } }]
      }),
    ];
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const dc = session.dshContext;
      assert.equal(dc.steps.length, 2, "两个 PLANNER_RESPONSE → 两个 step");

      const validCats = new Set(["system", "tools", "user", "inject", "skill", "assistant", "tool"]);
      const catOrder = ["system", "tools", "user", "inject", "skill", "assistant", "tool"];

      for (const step of dc.steps) {
        const bands = step.dnaBands || [];
        const flatItems = [];
        for (const key of catOrder) {
          const cat = (step.browserCategories || []).find(c => c.key === key);
          for (const item of (cat && cat.items) || []) flatItems.push(item);
        }
        // ① items 有几条 (token > 0) → bands 就有几条 (同源, 不设假上限)
        const expected = flatItems.filter(it => Number(it.tokens) > 0);
        assert.equal(bands.length, expected.length, "DNA 条带数必须等于该步有效 items 条数 (同源)");
        // ② 逐条一一对应: key/cat/title/toolName/tokens 完全一致
        expected.forEach((item, i) => {
          const band = bands[i];
          assert.equal(band.key, item.id, "band.key 必须对应 item.id");
          assert.equal(band.cat, item.cat, "band.cat 必须对应 item.cat");
          assert.equal(band.title, item.title, "band.title 必须对应 item.title");
          assert.equal(band.toolName, item.toolName, "band.toolName 必须对应 item.toolName");
          assert.equal(band.tokens, Math.round(item.tokens), "band.tokens 必须对应 item.tokens");
          assert.equal(band.stepIdx, step.stepIdx, "band.stepIdx 必须对应 step");
          assert.equal(band.turnIdx, step.turnIdx, "band.turnIdx 必须对应 turn");
          assert.ok(validCats.has(band.cat), "band.cat 必须是 7 分类之一");
          assert.ok(typeof band.off === "number", "band 必须带累计偏移 off");
        });
        // ③ 顺序 = 读取顺序 (分类顺序 system→...→tool)
        const catRank = band => catOrder.indexOf(band.cat);
        for (let i = 1; i < bands.length; i += 1) {
          assert.ok(catRank(bands[i - 1]) <= catRank(bands[i]),
            "DNA 条带必须按分类顺序排列 (读取顺序)");
        }
      }

      // ④ 第一步: system(真实 SYSTEM_MESSAGE) / tools(真实 tool_calls) / user / assistant / tool 都有
      const step1 = dc.steps[0];
      const cats1 = step1.dnaBands.map(b => b.cat);
      for (const key of ["system", "tools", "user", "assistant", "tool"]) {
        assert.ok(cats1.includes(key), "第一步 DNA 条带必须包含 " + key + " 分类");
      }
      assert.ok(step1.dnaBands.some(b => b.cat === "tool" && b.toolName === "read_file"),
        "工具结果条带必须带真实工具名 read_file");
      // ⑤ 运行期 SYSTEM_MESSAGE 注入在「下一步」被读取
      assert.ok(dc.steps[1].dnaBands.some(b => b.cat === "inject"), "第二步必须包含 inject 注入条带");
      assert.ok(!dc.steps[0].dnaBands.some(b => b.cat === "inject"), "第一步不应提前出现注入条带");
    });
  });


  it("单步条目超过 28 条时按 token 合并『其他』(cat 仍为 7 分类之一, 总量不丢)", async () => {
    const lines = [
      createTranscriptLine("USER_INPUT", "批量读取多个文件", { step_index: 0, input_tokens: 3000 }),
      createTranscriptLine("PLANNER_RESPONSE", "批量读取中...", {
        step_index: 1, input_tokens: 5000, output_tokens: 400,
        tool_calls: [{ name: "read_file", args: { Path: "a.txt" } }]
      }),
    ];
    // 30 条真实工具结果 → 该步条目数 > 28, 必须触发「其他」合并
    for (let i = 0; i < 30; i += 1) {
      lines.push(createTranscriptLine("GENERIC", "file-" + i + " content: " + "x".repeat(i + 10), {
        step_index: 2 + i, status: "success"
      }));
    }
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const bands = session.dshContext.steps[0].dnaBands || [];
      const validCats = new Set(["system", "tools", "user", "inject", "skill", "assistant", "tool"]);
      assert.ok(bands.length <= 28, "单柱条带上限 28 (超限合并「其他」), 实际 " + bands.length);
      const other = bands.filter(b => b.key === "other");
      assert.equal(other.length, 1, "超限时必须有一条「其他」合并条带");
      assert.ok(validCats.has(other[0].cat), "「其他」的 cat 仍必须是 7 分类之一 (契约)");
      assert.ok(other[0].count >= 2, "「其他」必须合并了 ≥ 2 条");
      // 总量不丢: 条带 token 之和 = 该步所有有效条目 token 之和
      const itemTokens = (session.dshContext.steps[0].browserCategories || [])
        .flatMap(cat => (cat.items || []))
        .filter(it => Number(it.tokens) > 0)
        .reduce((acc, it) => acc + Math.round(it.tokens), 0);
      const bandTokens = bands.reduce((acc, b) => acc + b.tokens, 0);
      assert.equal(bandTokens, itemTokens, "合并「其他」后 token 总量必须与条目总和一致");
    });
  });

  it("工具定义 items 只由真实 tool_calls 汇总, 不含编造 schema 文本", async () => {
    const lines = [
      createTranscriptLine("USER_INPUT", "运行测试并写入文件", { step_index: 0, input_tokens: 1200 }),
      createTranscriptLine("PLANNER_RESPONSE", "执行中...", {
        step_index: 1, input_tokens: 4000, output_tokens: 200,
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }]
      }),
      createTranscriptLine("GENERIC", "12 tests passed", { step_index: 2, status: "success" }),
      createTranscriptLine("PLANNER_RESPONSE", "写入结果...", {
        step_index: 3, input_tokens: 4500, output_tokens: 180,
        tool_calls: [{ name: "write_file", args: { Path: "report.txt", Content: "all good" } }]
      }),
      createTranscriptLine("GENERIC", "Wrote 1 file", { step_index: 4, status: "success" }),
    ];
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const dc = session.dshContext;
      for (const step of dc.steps || []) {
        for (const cat of step.browserCategories || []) {
          if (cat.key !== "tools") continue;
          if (cat.items.length === 0) continue;
          for (const item of cat.items) {
            // 每条 tools item 的 id = "tools:<name>", title = 工具名
            assert.ok(item.id.startsWith("tools:"), "tools item id must start with tools:");
            assert.ok(typeof item.toolName === "string" && item.toolName !== "", "tools item must have toolName");
            // 正文必须包含工具名 / 调用次数 / 参数信息 (不是 mock)
            assert.ok(
              item.fullText.includes(item.toolName) &&
              item.fullText.includes("真实调用次数"),
              "tools item fullText must contain real aggregated data, not fabricated schema"
            );
          }
        }
      }
    });
  });

  it("user 消息在该轮每步都可见 (该步之前的 user 消息)", async () => {
    const userText = "请分三步完成: ① 读取配置 ② 检查兼容性 ③ 生成报告";
    const lines = [
      createTranscriptLine("USER_INPUT", userText, { step_index: 0, input_tokens: 3000 }),
      createTranscriptLine("PLANNER_RESPONSE", "第一步: 读取配置", {
        step_index: 1, input_tokens: 5000, output_tokens: 150,
        tool_calls: [{ name: "read_file", args: { Path: "config.json" } }]
      }),
      createTranscriptLine("GENERIC", '{"debug": true}', { step_index: 2, status: "success" }),
      createTranscriptLine("PLANNER_RESPONSE", "第二步: 检查兼容性", {
        step_index: 3, input_tokens: 5500, output_tokens: 200,
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --version" } }]
      }),
    ];
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const session = parse();
      const dc = session.dshContext;
      // 该轮有 2 个 assistant 消息 → 2 个 step
      assert.ok(dc.steps.length === 2, "should have exactly 2 steps");
      for (const step of dc.steps) {
        const userCat = (step.browserCategories || []).find(c => c.key === "user");
        assert.ok(userCat !== undefined, "every step must have user category");
        assert.ok(userCat.items.length >= 1, "every step must have at least one user item (该步之前的 user 消息)");
        // 用户消息正文必须包含原始文本
        const userFull = userCat.items.map(it => it.fullText).join("");
        assert.ok(userFull.includes("读取配置"), "user item must contain the original user message text");
      }
    });
  });

  describe("数据护盾", () => {
    it("snippet ≤ 400 字符", async () => {
      const longText = "A".repeat(800);
      const lines = [
        createTranscriptLine("USER_INPUT", longText, { step_index: 0, input_tokens: 8000 }),
        createTranscriptLine("PLANNER_RESPONSE", "正在处理...", { step_index: 1, input_tokens: 9000, output_tokens: 100 }),
      ];
      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        for (const step of session.dshContext.steps || []) {
          for (const cat of step.browserCategories || []) {
            for (const item of cat.items || []) {
              assert.ok(item.snippet.length <= 400, "snippet must be ≤ 400 characters (was " + item.snippet.length + ")");
            }
          }
        }
      });
    });

    it("超长正文截断并标 truncated: true", async () => {
      const hugeText = "X".repeat(25000);
      const lines = [
        createTranscriptLine("USER_INPUT", hugeText, { step_index: 0, input_tokens: 100000 }),
        createTranscriptLine("PLANNER_RESPONSE", "分析中...", { step_index: 1, input_tokens: 105000, output_tokens: 50 }),
      ];
      await withMockAntigravityTranscript(lines, async ({ parse }) => {
        const session = parse();
        for (const step of session.dshContext.steps || []) {
          for (const cat of step.browserCategories || []) {
            for (const item of cat.items || []) {
              assert.ok(item.fullText.length <= 24000, "fullText must be ≤ 24,000");
              if (item.fullText.length === 24000) {
                assert.ok(item.truncated === true, "truncated flag must be true at limit");
              }
            }
          }
        }
      });
    });
  });
});

describe("子 Agent ↔ 会话映射 (fleet)", () => {
  it("linkFleetSubagentSessions: 裸 uuid ↔ session-<uuid> ↔ 去前缀交叉匹配", async () => {
    const daemon = await loadDaemon();
    const mockSessions = [
      { id: "session-abc" },
      { id: "abc-123" },
    ];
    const scanned = new Set(["def-456", "session-def-456"]);
    // 构建一个 fleet
    mockSessions[0].dshContext = {
      fleet: {
        subagents: [
          { childId: "abc" },           // 去掉 session- → 命中 session-abc
          { childId: "xyz" },            // 无匹配
          { childId: "def-456" },       // 扫描集命中 (已加载不命中, scanned=true)
        ]
      }
    };
    mockSessions[1].dshContext = {
      fleet: {
        subagents: [
          { childId: "session-abc" },   // 反查 → 命中
        ]
      }
    };

    const result = daemon.linkFleetSubagentSessions(mockSessions, scanned);
    const subs0 = mockSessions[0].dshContext.fleet.subagents;
    assert.equal(subs0[0].sessionId, "session-abc", "bare uuid abc → session-abc");
    assert.equal(subs0[0].matched, true);
    assert.equal(subs0[1].sessionId, null, "xyz unmatched");
    assert.equal(subs0[1].matched, false);
    assert.equal(subs0[2].sessionId, null, "def-456 not in loaded sessions → sessionId null");
    assert.equal(subs0[2].matched, true, "def-456 in scanned set → matched true");
    const subs1 = mockSessions[1].dshContext.fleet.subagents;
    assert.equal(subs1[0].sessionId, "session-abc", "session-abc → session-abc");
    assert.equal(subs1[0].matched, true);
    assert.deepEqual(result, { total: 4, matched: 3, linked: 2 });
  });

  it("去前缀比较: childId=session-abc 与 sessionId=abc 双向匹配", async () => {
    const daemon = await loadDaemon();
    const sessions = [{ id: "abc" }];
    sessions[0].dshContext = { fleet: { subagents: [{ childId: "session-abc" }] } };
    daemon.linkFleetSubagentSessions(sessions, []);
    assert.equal(sessions[0].dshContext.fleet.subagents[0].sessionId, "abc");
    assert.equal(sessions[0].dshContext.fleet.subagents[0].matched, true);
  });
});

describe("真实 antigravity 会话验收 (本地 brain 目录, 单会话解析)", () => {
  // 只解析 1~3 个最小的真实会话 (不调用 buildContextDataset): 与 tier4 的全量聚合错开,
  // 避免整套测试并行时多份全量数据集同时构建把 CPU 打满。
  it("真实 transcript 解析出的 items 不再全空, 且 assistant/tool 条带同源", async () => {
    const daemon = await loadDaemon();
    const HOME = process.env.HOME || "";
    const brainRoot = path.join(HOME, ".gemini/antigravity/brain");
    if (!fs.existsSync(brainRoot)) return; // 没有真实数据时跳过

    const transcriptOf = (id) => {
      const dir = path.join(brainRoot, id, ".system_generated/logs");
      const full = path.join(dir, "transcript_full.jsonl");
      const std = path.join(dir, "transcript.jsonl");
      if (fs.existsSync(full)) return full;
      if (fs.existsSync(std)) return std;
      return "";
    };
    const candidates = fs.readdirSync(brainRoot)
      .map(id => ({ id, file: transcriptOf(id) }))
      .filter(entry => entry.file !== "")
      .map(entry => {
        try { return { id: entry.id, size: fs.statSync(entry.file).size }; } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.size - b.size)
      .slice(0, 3);
    if (candidates.length === 0) return;

    let sessionsWithItems = 0;
    for (const { id } of candidates) {
      const now = new Date().toISOString();
      const session = daemon.parseAntigravitySession(id, "", "", now, now, {}, []);
      const dc = daemon.buildDshContextPayload(session);
      let itemTotal = 0;
      for (const step of dc.steps || []) {
        const itemsOfBands = new Set();
        let stepItems = 0;
        for (const cat of step.browserCategories || []) {
          for (const item of cat.items || []) {
            stepItems += 1;
            assert.ok(item.fullText.length > 0, "item.fullText must not be empty");
            assert.ok(item.fullText.length <= 24000, "item.fullText ≤ 24,000");
            assert.ok(item.snippet.length <= 400, "item.snippet ≤ 400");
          }
        }
        itemTotal += stepItems;
        // DNA 条带必须与 items 同源: 有 items 的步, 条带数 = 有效条目数
        const expectedBands = (step.browserCategories || [])
          .flatMap(cat => (cat.items || []).filter(it => Number(it.tokens) > 0)).length;
        if (stepItems > 0) {
          assert.equal((step.dnaBands || []).length, expectedBands,
            "真实会话: DNA 条带数必须等于该步有效条目数");
          for (const band of step.dnaBands || []) itemsOfBands.add(band.key);
          for (const key of itemsOfBands) assert.ok(typeof key === "string" && key !== "");
        }
      }
      if (itemTotal > 0) sessionsWithItems += 1;
    }
    assert.ok(sessionsWithItems > 0,
      "至少一个真实 antigravity 会话必须有上下文浏览器条目 (此前 7 分类 items 全空)");
  });
});
describe("Antigravity 步 token / 当前上下文 / 耗时 一律真实计量", () => {
  const at = (t0, sec) => new Date(t0 + sec * 1000).toISOString();

  it("steps[].totalTokens = input_tokens + cache_read_tokens (真实 prompt), currentTokens = 最后一次计量", async () => {
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    const lines = [
      createTranscriptLine("USER_INPUT", "分析这个仓库", { step_index: 0, created_at: at(t0, 0) }),
      createTranscriptLine("PLANNER_RESPONSE", "第一步: 读取配置", {
        step_index: 1, created_at: at(t0, 6), input_tokens: 5000, cache_read_tokens: 10000, output_tokens: 400,
        tool_calls: [{ name: "read_file", args: { Path: "a.js" } }]
      }),
      createTranscriptLine("GENERIC", "file body", { step_index: 2, created_at: at(t0, 9) }),
      createTranscriptLine("PLANNER_RESPONSE", "第二步: 检查环境", {
        step_index: 3, created_at: at(t0, 15), input_tokens: 2000, cache_read_tokens: 16000, output_tokens: 250,
        tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }]
      }),
      createTranscriptLine("GENERIC", "a.js", { step_index: 4, created_at: at(t0, 18) })
    ];
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const dc = parse().dshContext;
      assert.equal(dc.steps.length, 2, "两个 PLANNER_RESPONSE = 两步");
      assert.equal(dc.steps[0].totalTokens, 15000, "step1 totalTokens = input 5000 + cache 10000");
      assert.equal(dc.steps[1].totalTokens, 18000, "step2 totalTokens = input 2000 + cache 16000");
      assert.equal(dc.steps[0].promptTokens, 15000);
      assert.equal(dc.steps[0].outputTokens, 400, "outputTokens 用真实 output_tokens");
      assert.equal(dc.steps[1].outputTokens, 250);
      assert.equal(dc.steps[0].inputTokens, 5000);
      assert.equal(dc.steps[0].cacheReadTokens, 10000);
      assert.ok(dc.steps[1].totalTokens > dc.steps[0].totalTokens, "上下文累积 → 步 token 递增");
      assert.equal(dc.currentContext.currentTokens, 18000, "currentTokens = 最后一次真实 prompt");
      assert.equal(dc.turns[0].totalTokens, 18000, "轮 token = 该轮最后一次请求的真实 prompt");
      const sum = dc.currentContext.categories.reduce((acc, cat) => acc + cat.tokens, 0);
      assert.equal(sum, dc.currentContext.currentTokens, "7 分类之和必须等于当前上下文");
    });
  });

  it("耗时统计全部来自真实 created_at, 速度/刻度不出现离谱量级", async () => {
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    const lines = [
      createTranscriptLine("USER_INPUT", "开始", { step_index: 0, created_at: at(t0, 0) }),
      createTranscriptLine("PLANNER_RESPONSE", "甲", {
        step_index: 1, created_at: at(t0, 6), input_tokens: 1000, cache_read_tokens: 0, output_tokens: 400
      }),
      createTranscriptLine("GENERIC", "工具输出", { step_index: 2, created_at: at(t0, 9) }),
      createTranscriptLine("PLANNER_RESPONSE", "乙", {
        step_index: 3, created_at: at(t0, 15), input_tokens: 1200, cache_read_tokens: 0, output_tokens: 250
      }),
      createTranscriptLine("GENERIC", "工具输出 2", { step_index: 4, created_at: at(t0, 18) })
    ];
    await withMockAntigravityTranscript(lines, async ({ parse }) => {
      const dc = parse().dshContext;
      const tms = dc.timingStats;
      assert.equal(tms.genMs, 12000, "模型生成 = 两条 PLANNER_RESPONSE 的真实间隔 (6s + 6s)");
      assert.equal(tms.toolsMs, 6000, "工具执行 = 两条工具结果的真实间隔 (3s + 3s)");
      assert.equal(tms.activeMs, 18000, "活跃时长 = 生成 + 工具");
      assert.equal(tms.activeDuration, "18s");
      assert.equal(tms.spanMs, 18000, "轮内跨度 = 首末事件差");
      assert.equal(dc.steps[0].genMs, 6000);
      assert.equal(dc.steps[1].genMs, 6000);
      assert.equal(dc.steps[0].durationSec, 6);
      assert.equal(tms.ruler.length, 5);
      assert.equal(tms.ruler[0], "0");
      assert.equal(tms.ruler[4], "18s");
      for (const tick of tms.ruler) {
        assert.ok(!/(\d{3,})m/.test(tick), "刻度不允许出现 3 位以上分钟的离谱量级: " + tick);
      }
      assert.equal(tms.speed, Number(((650 / 18000) * 1000).toFixed(1)));
      assert.ok(tms.speed > 0.1 && tms.speed < 1000, "speed 必须在合理区间");
      const sum = tms.categories.reduce((acc, cat) => acc + cat.percent, 0);
      assert.ok(Math.abs(sum - 100) < 0.5, "耗时桶百分比之和应为 100, 实际 " + sum);
      assert.ok(tms.categories.every(cat => cat.estimated === true), "真实可测桶需标 estimated");
    });
  });

  it("真实会话: activeMs < 30 天, speed ∈ [0.1,1000], 趋势图 Y 轴覆盖当前上下文", async () => {
    const daemon = await loadDaemon();
    const HOME = process.env.HOME || "";
    const brainRoot = path.join(HOME, ".gemini/antigravity/brain");
    if (!fs.existsSync(brainRoot)) return;
    const transcriptOf = (id) => {
      const dir = path.join(brainRoot, id, ".system_generated/logs");
      const full = path.join(dir, "transcript_full.jsonl");
      const std = path.join(dir, "transcript.jsonl");
      if (fs.existsSync(full)) return full;
      if (fs.existsSync(std)) return std;
      return "";
    };
    const candidates = fs.readdirSync(brainRoot)
      .map(id => ({ id, file: transcriptOf(id) }))
      .filter(entry => entry.file !== "")
      .map(entry => {
        try { return { id: entry.id, size: fs.statSync(entry.file).size }; } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.size - b.size)
      .slice(0, 3);
    if (candidates.length === 0) return;

    for (const { id } of candidates) {
      const now = new Date().toISOString();
      const session = daemon.parseAntigravitySession(id, "", "", now, now, {}, []);
      const dc = daemon.buildDshContextPayload(session);
      const tms = dc.timingStats;
      const cur = Number(dc.currentContext.currentTokens) || 0;
      if (cur <= 0) continue;
      const maxStep = Math.max(0, ...dc.steps.map(step => Number(step.totalTokens) || 0));

      assert.ok(Number(tms.activeMs) >= 0, "activeMs 必须是数字");
      assert.ok(Number(tms.activeMs) < 30 * 24 * 3600 * 1000, "活跃时长必须 < 30 天");
      assert.ok(Number(tms.activeMs) <= Number(tms.spanMs) + 1000, "活跃时长不应超过轮内跨度");
      assert.equal(tms.ruler.length, 5);
      assert.equal(tms.ruler[0], "0");
      for (const tick of tms.ruler) {
        assert.ok(!/(\d{3,})m/.test(tick), "刻度不允许 3 位以上分钟: " + tick);
      }
      const totalOutput = dc.steps.reduce((acc, step) => acc + (Number(step.outputTokens) || 0), 0);
      if (totalOutput > 0 && Number(tms.activeMs) > 0) {
        assert.ok(Number(tms.speed) >= 0.1 && Number(tms.speed) <= 1000,
          "speed 必须在 0.1~1000 tok/s, 实际 " + tms.speed);
      } else {
        assert.equal(Number(tms.speed), 0, "无输出/无耗时时速度必须兜底为 0");
      }
      const lastPromptStep = [...dc.steps].reverse().find(step => Number(step.promptTokens) > 0);
      if (lastPromptStep) {
        assert.equal(Number(lastPromptStep.totalTokens), cur, "最后一条真实计量 == currentTokens");
      }
      assert.ok(maxStep >= cur * 0.999,
        "Y 轴上界 (最大步 token " + maxStep + ") 必须 >= 当前上下文 (" + cur + ")");
      assert.ok(maxStep <= cur * 20, "Y 轴上界不应比当前上下文大一个数量级 (旧版 7.6k vs 184k)");
      const sortedTotals = dc.steps.map(step => Number(step.totalTokens) || 0).sort((a, b) => a - b);
      const median = sortedTotals[Math.floor(sortedTotals.length / 2)];
      assert.ok(median > 1000, "步 token 中位数应为真实 prompt 量级 (>1000), 实际 " + median);
    }
  });
});
