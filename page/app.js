// app.js - 上下文 (Context) · 工作区会话列表 + 原版 dsh-context 交互大盘 (每步柱状图、DNA指纹、全量/增量、比前步/比前轮)

(() => {
  const $ = (id) => document.getElementById(id);

  // ==========================================================================
  // 0. Magpie 桥接握手 (官方规范: 页面必须在 10 秒内调用 magpie.ready,
  //    否则窗口把它标记为「没有回应」并显示「此页面已停止工作」)。
  //    bridge.js 由 magpie 在页面旁侧提供; 直接用浏览器打开本文件时
  //    window.magpie 不存在, 因此全部做存在性判断, 页面照常可用。
  // ==========================================================================
  const magpieBridge = (typeof window !== "undefined" && window.magpie) ? window.magpie : null;

  /** 窗口主题 → <html data-theme>/lang (bridge 也会设置, 这里保证 CSS 变量同步) */
  function applyWindowTheme(theme) {
    try {
      const root = document.documentElement;
      if (!root || !theme) return;
      if (typeof theme.dark === "boolean") {
        root.dataset.theme = theme.dark ? "dark" : "light";
        root.style.colorScheme = theme.dark ? "dark" : "light";
      }
      if (theme.lang) root.setAttribute("lang", theme.lang);
    } catch (e) { /* 主题同步失败不影响数据渲染 */ }
  }

  /**
   * 与窗口握手。返回的 promise 永不 reject, 也不阻塞首屏渲染 ——
   * 数据脚本先到先画, 主题到达后再补一次重绘由 bridge 的 CSS 变量自动生效。
   */
  const bridgeReady = (async () => {
    if (!magpieBridge || typeof magpieBridge.ready !== "function") return null;
    try {
      const theme = await magpieBridge.ready();
      applyWindowTheme(theme);
      if (typeof magpieBridge.onTheme === "function") magpieBridge.onTheme(applyWindowTheme);
      return theme;
    } catch (err) {
      try { console.warn("[context] magpie.ready 失败:", (err && err.message) || err); } catch (e) { /* 忽略 */ }
      return null;
    }
  })();

  // ==========================================================================
  // 0. 全局错误兜底 (绝不白屏 / 绝不静默失败)
  //    任何未捕获异常 / 未处理的 Promise 拒绝 → 页面顶部一条可关闭的红色提示条
  //    (纯内联样式, 不依赖 style.css), 最多同时 3 条, 超出丢弃最旧的一条。
  //    兜底自身再出错也只 console.error, 绝不二次抛出。
  // ==========================================================================
  const MAX_ERROR_BANNERS = 3;

  function showErrorBanner(message) {
    try {
      const host = document.body || document.documentElement;
      if (!host) return;
      let layer = document.getElementById("lcErrorLayer");
      if (!layer) {
        layer = document.createElement("div");
        layer.id = "lcErrorLayer";
        layer.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:flex;flex-direction:column;gap:6px;padding:8px 10px;pointer-events:none;";
        host.appendChild(layer);
      }
      while (layer.children.length >= MAX_ERROR_BANNERS) layer.removeChild(layer.firstChild);
      const bar = document.createElement("div");
      bar.setAttribute("role", "alert");
      bar.style.cssText = "pointer-events:auto;display:flex;align-items:flex-start;gap:8px;background:#dc2626;color:#ffffff;font:12px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;padding:8px 10px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.28);";
      const text = document.createElement("div");
      text.style.cssText = "flex:1 1 auto;min-width:0;word-break:break-word;white-space:pre-wrap;";
      text.textContent = "页面脚本异常：" + String(message == null ? "未知错误" : message).slice(0, 400);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "✕";
      close.setAttribute("aria-label", "关闭错误提示");
      close.style.cssText = "flex:0 0 auto;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:rgba(255,255,255,0.18);color:#ffffff;font-size:12px;line-height:1;cursor:pointer;";
      close.addEventListener("click", () => {
        try {
          bar.remove();
          if (layer && layer.children.length === 0) layer.remove();
        } catch (e) { /* 忽略 */ }
      });
      bar.appendChild(text);
      bar.appendChild(close);
      layer.appendChild(bar);
    } catch (e) {
      try { console.error("[context] 错误提示条渲染失败", e); } catch (e2) { /* 忽略 */ }
    }
  }

  window.addEventListener("error", (event) => {
    const message = (event && (event.message || (event.error && event.error.message))) || "脚本错误";
    showErrorBanner(message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    const message = (reason && (reason.message || String(reason))) || "未处理的 Promise 拒绝";
    showErrorBanner(message);
  });

  // 1. 全局数据与响应式状态
  // 数据契约 v2: window.CONTEXT_SESSIONS 只是轻量索引 (白名单字段), 会话详情按需懒加载到
  // window.CONTEXT_SESSION_DETAIL[id] (由 window.CONTEXT_DETAIL_FILES[id] 指向的 <script> 注入)。
  // 主页 (KPI + 工作区列表) 只允许依赖索引字段; turns / dshContext / fileOps / commands / events 只能从详情取。
  let rawSessions = Array.isArray(window.CONTEXT_SESSIONS) ? [...window.CONTEXT_SESSIONS] : [];
  let summary = window.CONTEXT_SUMMARY || {};

  // 详情懒加载运行时状态
  // 兜底链: ① <script src> 注入 (script-src 'self') → ② fetch + 内联执行 (connect-src 'self' + script-src 'unsafe-inline')
  //         → ③ 弹窗内错误态 + 重试。任一层成功即止, 绝不白屏。
  const DETAIL_SCRIPT_TIMEOUT_MS = 6000; // ① <script src> 注入超时
  const INDEX_SCRIPT_TIMEOUT_MS = 15000; // 索引脚本刷新超时 (脚本层 / fetch 层各自计时)
  const DETAIL_MAX_CONCURRENCY = 3;    // 预取并发上限 (指针悬停预取)
  const detailLoads = new Map();       // sessionId -> { promise } 在途/已完成的详情加载
  const prefetchSeen = new Set();      // 已入队预取的会话 (去重)
  const prefetchQueue = [];            // 预取等待队列
  let prefetchActive = 0;              // 当前在途预取数
  let modalSkeletonTimer = null;       // 弹窗骨架屏淡出定时器
  let isRefreshing = false;            // 刷新按钮防抖

  let activeModalSessionId = null; // 当前在 Modal 弹窗中打开的会话 ID
  let activeStepIdx = null;        // 当前在弹窗中选中的步骤序号 (null 表示 live 当前末尾请求)
  let activeTurnIdx = null;        // 当前在弹窗中选中的轮次序号
  let activeAgentFilter = "all";   // 主页面 Agent 筛选 ("all" | "antigravity" | "dsh" | "codex" | "other")
  let searchQuery = "";            // 主页面搜索关键字
  let collapsedFolders = new Set(); // 被收起的工作区路径集合 (默认全部展开)

  // 弹窗内交互控制开关状态 (100% 对齐原版 dsh-context 源码)
  let isDnaMode = false;
  let isAdaptive = true;
  let showDurationCurve = true;
  let isOverview = false;
  let trendGranularity = "step"; // "step" (步骤) | "turn" (轮次)
  let trendMode = "total";        // "total" (全量) | "delta" (增量)
  let diffMode = "step";          // "step" (比前步，默认) | "turn" (比前轮)，严格二选一单选
  let openedAccordionKeys = new Set(["system", "tools", "user", "assistant", "tool"]); // 默认全部分类展开

  // 2. 主页面 DOM 节点引用
  const elAgentSegs = $("agentSegs");
  const elSessQ = $("sessQ");
  const elBtnRefresh = $("btnRefresh");
  const elWorkspaceTree = $("workspaceTree");
  const elToast = $("toast");

  // 主页面 KPI 概览条
  const elKpiTotalSess = $("kpiTotalSess");
  const elKpiPeakWatermark = $("kpiPeakWatermark");
  const elKpiPeakWatermarkSub = $("kpiPeakWatermarkSub");
  const elKpiTotalTurns = $("kpiTotalTurns");
  const elKpiTotalCompactions = $("kpiTotalCompactions");
  const elKpiCacheRead = $("kpiCacheRead");

  // Agent 分段徽标
  const elBadgeAll = $("badge-all");
  const elBadgeAntigravity = $("badge-antigravity");
  const elBadgeDsh = $("badge-dsh");
  const elBadgeCodex = $("badge-codex");
  const elBadgeOther = $("badge-other");

  // 3. 会话详情弹窗 DOM 节点引用
  const elDshContextModal = $("dshContextModal");
  const elBtnModalClose = $("btnModalClose");
  const elModalAgentIcon = $("modalAgentIcon");
  const elModalSessionTitle = $("modalSessionTitle");
  const elModalSessionSub = $("modalSessionSub");
  const elModalWatermarkText = $("modalWatermarkText");
  const elModalLimitText = $("modalLimitText");
  const elModalWatermarkFill = $("modalWatermarkFill");

  // 弹窗第一行：统计节点 (已去除广告与插件信息，占满整行)
  const elStatTurns = $("statTurns");
  const elStatSteps = $("statSteps");
  const elStatSkills = $("statSkills");
  const elStatAnswers = $("statAnswers");
  const elStatEvents = $("statEvents");
  const elCntIO = $("cntIO");
  const elPillsIO = $("pillsIO");
  const elCntTools = $("cntTools");
  const elPillsTools = $("pillsTools");
  const elCntCmds = $("cntCmds");
  const elPillsCmds = $("pillsCmds");
  const elFleetAgent = $("fleetAgent");
  const elFleetSub = $("fleetSub");
  const elFleetRow = $("fleetRow");
  const elFleetPanel = $("fleetPanel");

  // 弹窗第二行：Donut 图表与明细节点 (官方 .lc-donut: svg 轨道+分段 + .lc-donut-center)
  const elDonutToken = $("donutToken");
  const elDonutTokenSvg = $("donutTokenSvg");
  const elDonutTokenVal = $("donutTokenVal");
  const elTokenCacheHitRate = $("tokenCacheHitRate");
  const elTokenDetailsGrid = $("tokenDetailsGrid");

  const elDonutTiming = $("donutTiming");
  const elDonutTimingSvg = $("donutTimingSvg");
  const elDonutTimingVal = $("donutTimingVal");
  const elTimingSpeed = $("timingSpeed");
  const elTimingDetailsGrid = $("timingDetailsGrid");
  const elTimingTimelineBar = $("timingTimelineBar");
  const elTimingMilestones = $("timingMilestones");
  const elTimingTrackBar = $("timingTrackBar");

  // 弹窗第三行：左列当前上下文与趋势
  const elCtxModelBadge = $("ctxModelBadge");
  const elCtxTokensText = $("ctxTokensText");
  const elCtxLimitText = $("ctxLimitText");
  const elCtxWatermarkText = $("ctxWatermarkText");
  const elCtxStackedBar = $("ctxStackedBar");
  const elCtxLegendGrid = $("ctxLegendGrid");

  const elBtnDnaMode = $("btnDnaMode");
  const elBtnAdaptive = $("btnAdaptive");
  const elBtnDurationCurve = $("btnDurationCurve");
  const elBtnOverview = $("btnOverview");
  const elGranularitySegs = $("granularitySegs");
  const elModeSegs = $("modeSegs");

  const elTrendChartWrap = $("trendChartWrap");
  const elTrendChartScroll = $("trendChartScroll");
  const elTrendChart = $("trendChart");
  const elTrendBarsContainer = $("trendBarsContainer");
  const elTrendDurationSvg = $("trendDurationSvg");
  const elTrendTurnsStrip = $("trendTurnsStrip");
  const elTrendChartTip = $("trendChartTip");

  const elBriefStepTitle = $("briefStepTitle");
  const elBriefTime = $("briefTime");
  const elBriefMetrics = $("briefMetrics");
  const elBriefRows = $("briefRows");
  const elBriefStacked = $("briefStacked");
  const elBriefLegend = $("briefLegend");

  // 弹窗第三行：右列上下文浏览器
  const elBtnToggleAllAccordions = $("btnToggleAllAccordions");
  const elBtnBrowserDna = $("btnBrowserDna");
  const elBtnDiffStep = $("btnDiffStep");
  const elBtnDiffTurn = $("btnDiffTurn");
  const elBrowserStepDropdown = $("browserStepDropdown");
  const elBrowserSelectedLabel = $("browserSelectedLabel");
  const elBrowserEstimateTok = $("browserEstimateTok");
  const elBrowserActualTok = $("browserActualTok");
  const elBrowserColorBar = $("browserColorBar");
  const elBrowserAccordionTree = $("browserAccordionTree");
  const elBrowserFlatTree = $("browserFlatTree");
  const elBrowserScroll = $("browserScroll");
  const elBrowserTreemap = $("browserTreemap");
  const elBtnLayoutToggle = $("btnLayoutToggle");

  // 弹窗第四行：上下文事件卡片
  const elEventsKindChips = $("eventsKindChips");
  const elChipInjectCount = $("chipInjectCount");
  const elChipCompactCount = $("chipCompactCount");
  const elChipPruneCount = $("chipPruneCount");
  const elEventsListContainer = $("eventsListContainer");

  // 弹窗第四行：文件活动卡片
  const elFaFilesCount = $("faFilesCount");
  const elFaDeltaSpan = $("faDeltaSpan");
  const elFaKindChips = $("faKindChips");
  const elFaChipAll = $("faChipAll");
  const elFaChipRead = $("faChipRead");
  const elFaChipWrite = $("faChipWrite");
  const elFaChipSearch = $("faChipSearch");
  const elFaChipImage = $("faChipImage");
  const elInputFaFilter = $("inputFaFilter");
  const elFaSortChips = $("faSortChips");
  const elFaListContainer = $("faListContainer");

  // 弹窗第五行：命令执行卡片
  const elCmdFilterChips = $("cmdFilterChips");
  const elCmdChipAll = $("cmdChipAll");
  const elCmdChipFailed = $("cmdChipFailed");
  const elCmdChipSlow = $("cmdChipSlow");
  const elCmdChipBg = $("cmdChipBg");
  const elCmdSortChips = $("cmdSortChips");
  const elCmdKpiRuns = $("cmdKpiRuns");
  const elCmdKpiTime = $("cmdKpiTime");
  const elCmdKpiFail = $("cmdKpiFail");
  const elCmdKpiBg = $("cmdKpiBg");
  const elCmdSlowestText = $("cmdSlowestText");
  const elCmdMostFailText = $("cmdMostFailText");
  const elCmdMostRepeatText = $("cmdMostRepeatText");
  const elCmdProgsContainer = $("cmdProgsContainer");
  const elInputCmdSearch = $("inputCmdSearch");
  const elCmdListContainer = $("cmdListContainer");

  let isTreemapMode = false;
  let eventsKindFilter = "all";
  let faOpFilter = "all";
  let faSort = "lines";
  let faSearchQ = "";
  let cmdFilter = "all";
  let cmdSort = "latest";
  let cmdSearchQ = "";
  let cmdProgramFilter = null;

  // 辅助函数
  function showToast(msg) {
    if (!elToast) return;
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(elToast._timer);
    elToast._timer = setTimeout(() => {
      elToast.hidden = true;
    }, 1800);
  }

  function formatNumber(n) {
    if (!n && n !== 0) return "0";
    return Number(n).toLocaleString("en-US");
  }

  function formatK(n) {
    if (!n && n !== 0) return "0";
    if (n >= 1e6) return `≈${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `≈${(n / 1e3).toFixed(1)}k`;
    return `≈${n}`;
  }

  /** 时间戳 → HH:MM:SS (数据侧 time 多为裸 epoch ms, 直接显示会是一长串数字) */
  function formatClock(v) {
    if (v == null || v === "") return "";
    const str = String(v);
    if (/^\d{10,13}$/.test(str)) {
      const ms = str.length > 10 ? Number(str) : Number(str) * 1000;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        const p = (n) => String(n).padStart(2, "0");
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      }
      return "";
    }
    return str;
  }

  function formatWatermark(wm) {
    if (wm === undefined || wm === null || isNaN(wm)) return "0%";
    if (wm > 0 && wm < 1) return `${wm.toFixed(1)}%`;
    return `${Math.round(wm)}%`;
  }

  function baseName(p) {
    if (!p) return "";
    const clean = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const segs = clean.split("/");
    return segs[segs.length - 1] || p;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // --------------------------------------------------------------------------
  // 会话数据访问层: 索引 (必有) + 详情 (懒加载)
  // --------------------------------------------------------------------------

  function detailFiles() {
    const map = window.CONTEXT_DETAIL_FILES;
    return map && typeof map === "object" ? map : {};
  }

  function detailStore() {
    if (!window.CONTEXT_SESSION_DETAIL || typeof window.CONTEXT_SESSION_DETAIL !== "object") {
      window.CONTEXT_SESSION_DETAIL = {};
    }
    return window.CONTEXT_SESSION_DETAIL;
  }

  /** 同步读取已缓存的详情 (未加载返回 null) */
  function readCachedDetail(sessionId) {
    if (!sessionId) return null;
    const store = window.CONTEXT_SESSION_DETAIL;
    const hit = store && store[sessionId];
    return hit && typeof hit === "object" ? hit : null;
  }

  /** 老版全量内联数据 (无 CONTEXT_DETAIL_FILES) 兼容判断 */
  function isFullSession(s) {
    return !!(s && (s.dshContext || s.turns));
  }

  function getSessionIndexById(id) {
    return rawSessions.find(s => s.id === id) || null;
  }

  /**
   * 统一会话读取入口: 只有索引时也返回对象 (顶栏/列表可用), 详情已缓存时返回索引+详情合并对象。
   */
  function getSessionById(id) {
    if (!id) return null;
    const idx = getSessionIndexById(id);
    const det = readCachedDetail(id);
    if (!idx) return det;
    if (!det) return idx;
    return Object.assign({}, idx, det);
  }

  /**
   * 需要详情 (turns/dshContext/fileOps/...) 才能渲染的地方统一走这里:
   * 详情已缓存 → 直接返回; 未缓存 → 触发 ensureSessionDetail 并在到达后重绘弹窗, 本次返回 null。
   */
  function getSessionDetailOrIndex(id) {
    const det = readCachedDetail(id);
    if (det) return det;
    if (!id) return null;
    ensureSessionDetail(id)
      .then(() => {
        if (activeModalSessionId === id && readCachedDetail(id)) finishModalLoad(id);
      })
      .catch(() => { /* 弹窗自身有错误态 + 重试, 这里静默 */ });
    return null;
  }

  /** ① 注入 <script src> 加载 (成功 resolve, onerror/超时 reject) */
  function injectScriptTag(src, timeoutMs, detailSessionId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      if (detailSessionId) script.setAttribute("data-detail-session", detailSessionId);

      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error("SCRIPT_TIMEOUT")), timeoutMs);

      script.onload = () => finish(resolve, true);
      script.onerror = () => finish(reject, new Error("SCRIPT_ERROR"));
      try {
        document.head.appendChild(script);
      } catch (err) {
        // CSP 直接拒绝 script-src 时 appendChild 也可能抛错 → 交给 fetch 兜底
        finish(reject, err instanceof Error ? err : new Error("SCRIPT_BLOCKED"));
      }
    });
  }

  /**
   * 确保会话详情就绪 (三级兜底, 绝不白屏)。
   * 1) 命中 window.CONTEXT_SESSION_DETAIL[id] → 直接 resolve;
   * 2) 兼容老版全量内联数据 → 直接 resolve;
   * 3) ① 注入 <script src=window.CONTEXT_DETAIL_FILES[id]> → onload 解析;
   * 4) ① 失败 (onerror / 6s 超时 / CSP 拒绝) → ② fetch 同源文本 + 内联执行;
   * 5) ② 也失败 → reject("DETAIL_UNAVAILABLE"), 调用方展示弹窗内错误态 + 重试。
   */
  function ensureSessionDetail(sessionId) {
    if (!sessionId) return Promise.reject(new Error("EMPTY_SESSION_ID"));

    const cached = readCachedDetail(sessionId);
    if (cached) return Promise.resolve(cached);

    // 在途请求直接复用; 已结算的旧条目 (缓存被刷新清空后) 丢弃重来
    const pending = detailLoads.get(sessionId);
    if (pending && !pending.settled) return pending.promise;
    if (pending) detailLoads.delete(sessionId);

    const idxEntry = getSessionIndexById(sessionId);
    if (isFullSession(idxEntry)) {
      detailStore()[sessionId] = idxEntry;
      return Promise.resolve(idxEntry);
    }

    const src = detailFiles()[sessionId];
    if (!src) return Promise.reject(new Error("DETAIL_NOT_FOUND"));

    const promise = (async () => {
      // Magpie 页面沙盒的 CSP 是 connect-src 'none' 且禁止内联脚本,
      // 因此 fetch / 内联执行都不可能成功 —— 唯一合规路径是注入自己的 <script src>。
      try {
        await injectScriptTag(src, DETAIL_SCRIPT_TIMEOUT_MS, sessionId);
        const full = readCachedDetail(sessionId);
        if (full) return full;
      } catch (err) {
        throw new Error("DETAIL_UNAVAILABLE");
      }
      throw new Error("DETAIL_UNAVAILABLE");
    })();

    const entry = { promise, settled: false };
    detailLoads.set(sessionId, entry);
    // 结算即出表: 之后靠 CONTEXT_SESSION_DETAIL 缓存短路, 避免"过期 promise 挡住重新加载"
    promise.then(
      () => { entry.settled = true; detailLoads.delete(sessionId); },
      () => { entry.settled = true; detailLoads.delete(sessionId); prefetchSeen.delete(sessionId); }
    );
    return promise;
  }

  /** 行悬停/按下预取详情 (去重, 并发 ≤ 3, 失败静默) */
  function prefetchSessionDetail(sessionId) {
    if (!sessionId || prefetchSeen.has(sessionId) || detailLoads.has(sessionId)) return;
    if (readCachedDetail(sessionId)) return;
    if (isFullSession(getSessionIndexById(sessionId))) return;
    if (!detailFiles()[sessionId]) return;
    prefetchSeen.add(sessionId);
    prefetchQueue.push(sessionId);
    drainPrefetchQueue();
  }

  function drainPrefetchQueue() {
    while (prefetchActive < DETAIL_MAX_CONCURRENCY && prefetchQueue.length > 0) {
      const sessionId = prefetchQueue.shift();
      prefetchActive += 1;
      ensureSessionDetail(sessionId)
        .catch(() => { /* 预取失败静默, 点击时会重试并展示错误态 */ })
        .then(() => {
          prefetchActive -= 1;
          drainPrefetchQueue();
        });
    }
  }

  // --------------------------------------------------------------------------
  // 索引刷新 (不整页 reload): 重新拉取 context-data.js (cache-bust) 并重渲染
  // --------------------------------------------------------------------------

  /** 重新拉取索引脚本 (cache-bust): 同样走 ① <script src> → ② fetch + 内联执行 的兜底链 */
  function reloadIndexScript() {
    const src = `context-data.js?ts=${Date.now()}`;
    return injectScriptTag(src, INDEX_SCRIPT_TIMEOUT_MS).catch(() => fetchAndInlineExecute(src, INDEX_SCRIPT_TIMEOUT_MS));
  }

  /** 索引更新后重新读取全局数据, 丢弃可能过期的详情缓存并重渲染主页 */
  function applyIndexData() {
    rawSessions = Array.isArray(window.CONTEXT_SESSIONS) ? [...window.CONTEXT_SESSIONS] : [];
    summary = window.CONTEXT_SUMMARY || {};
    window.CONTEXT_SESSION_DETAIL = {};
    detailLoads.clear();
    prefetchSeen.clear();
    prefetchQueue.length = 0;
    prefetchActive = 0;
    renderMainStats();
    renderWorkspaceTree();
  }

  function refreshIndexData() {
    if (isRefreshing) return;
    isRefreshing = true;
    showToast("正在重新拉取索引...");
    if (elBtnRefresh) {
      elBtnRefresh.disabled = true;
      elBtnRefresh.classList.add("is-busy");
    }
    reloadIndexScript()
      .then(() => {
        applyIndexData();
        showToast("索引已更新");
        // 弹窗打开中: 详情可能已过期, 重新懒加载并重绘
        if (activeModalSessionId) {
          renderSkeleton(true);
          loadModalDetail(activeModalSessionId);
        }
      })
      .catch(() => {
        showToast("索引更新失败, 请稍后重试");
      })
      .then(() => {
        isRefreshing = false;
        if (elBtnRefresh) {
          elBtnRefresh.disabled = false;
          elBtnRefresh.classList.remove("is-busy");
        }
      });
  }

  function getFileLangGlyph(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const map = {
      py: { text: "PY", bg: "rgba(59, 130, 246, 0.2)", color: "#60a5fa" },
      js: { text: "JS", bg: "rgba(234, 179, 8, 0.2)", color: "#facc15" },
      mjs: { text: "JS", bg: "rgba(234, 179, 8, 0.2)", color: "#facc15" },
      ts: { text: "TS", bg: "rgba(59, 130, 246, 0.2)", color: "#60a5fa" },
      c: { text: "C", bg: "rgba(6, 182, 212, 0.2)", color: "#22d3ee" },
      cpp: { text: "C++", bg: "rgba(6, 182, 212, 0.2)", color: "#22d3ee" },
      h: { text: "H", bg: "rgba(6, 182, 212, 0.2)", color: "#22d3ee" },
      json: { text: "{}", bg: "rgba(249, 115, 22, 0.2)", color: "#fb923c" },
      md: { text: "MD", bg: "rgba(168, 85, 247, 0.2)", color: "#c084fc" },
      css: { text: "CSS", bg: "rgba(236, 72, 153, 0.2)", color: "#f472b6" },
      html: { text: "<>", bg: "rgba(239, 68, 68, 0.2)", color: "#f87171" },
      sh: { text: "SH", bg: "rgba(16, 185, 129, 0.2)", color: "#34d399" }
    };
    return map[ext] || { text: ext.slice(0, 3).toUpperCase() || "FILE", bg: "rgba(255,255,255,0.08)", color: "var(--fg-2)" };
  }

  function formatDurationSeconds(sec) {
    if (!sec || sec < 60) return `${sec || 0}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM > 0 ? `${h}h${remM}m` : `${h}h`;
  }

  // ==========================================================================
  // 骨架屏 (类名严格对齐 dsh-context 官方: .lc-skel-rows / .lc-skel-bar / .lc-skel-plot / .lc-skel-donut)
  // 视觉样式 (shimmer 动画等) 由 page/style.css 提供, 这里只产出结构 + 必要几何内联样式
  // ==========================================================================

  function skelBar(style) {
    return `<span class="lc-skel-bar"${style ? ` style="${style}"` : ""}></span>`;
  }

  function skelBars(count, style) {
    return new Array(count).fill(skelBar(style)).join("");
  }

  function skelRows(count, rowStyle, barStyle) {
    return `<div class="lc-skel-rows"${rowStyle ? ` style="${rowStyle}"` : ""}>${skelBars(count, barStyle)}</div>`;
  }

  function skelPlot(count, style) {
    return `<div class="lc-skel-plot"${style ? ` style="${style}"` : ""}>${skelBars(count || 14)}</div>`;
  }

  /** 弹窗详情骨架屏: 4 块占位 (统计行 / 双环图 / 趋势 / 上下文浏览器), 直接作为 #modalLoadingSkeleton 的 flex 子项 */
  function buildModalSkeletonHtml() {
    return [
      // ① 上下文统计行
      skelRows(3),
      // ② 双环图
      `<div class="lc-skel-rows modal-skel-donuts"><span class="lc-skel-donut"></span><span class="lc-skel-donut"></span></div>`,
      // ③ 趋势柱状图
      skelPlot(14),
      // ④ 上下文浏览器
      skelRows(5)
    ].join("");
  }

  /** 首次打开弹窗时把 4 块占位渲染进 #modalLoadingSkeleton (之后复用) */
  function renderModalSkeleton() {
    const skel = $("modalLoadingSkeleton");
    if (!skel) return null;
    if (!skel.dataset.built) {
      skel.innerHTML = buildModalSkeletonHtml();
      skel.dataset.built = "1";
    }
    return skel;
  }

  /** 弹窗骨架屏开关: show=true 立即显示; show=false 用 160ms 淡出后显示真实内容 */
  function renderSkeleton(show = true) {
    const skel = $("modalLoadingSkeleton");
    const body = document.querySelector(".modal-body.dsh-dashboard-body");
    const err = $("modalLoadError");
    if (modalSkeletonTimer) { clearTimeout(modalSkeletonTimer); modalSkeletonTimer = null; }

    if (show) {
      if (err) { err.hidden = true; err.style.display = "none"; }
      if (body) { body.style.display = "none"; body.style.opacity = ""; }
      if (skel) { skel.style.display = "flex"; skel.style.opacity = "1"; skel.style.transition = ""; }
      return;
    }

    if (skel) {
      skel.style.transition = "opacity 160ms ease";
      skel.style.opacity = "0";
    }
    modalSkeletonTimer = setTimeout(() => {
      modalSkeletonTimer = null;
      if (skel) { skel.style.display = "none"; skel.style.opacity = ""; }
      if (body) body.style.display = "flex";
    }, 160);
  }

  /**
   * 渲染异常兜底: 不隐藏已渲染内容 (其余模块仍可用), 只在弹窗内叠加可读错误态。
   * 复用 #modalLoadError 结构 (index.html 已有的错误态容器), 绝不白屏、绝不抛到全局。
   */
  function showModalRenderError(err) {
    try {
      const skel = $("modalLoadingSkeleton");
      if (modalSkeletonTimer) { clearTimeout(modalSkeletonTimer); modalSkeletonTimer = null; }
      if (skel) { skel.style.display = "none"; skel.style.opacity = ""; skel.style.transition = ""; }
      const body = document.querySelector(".modal-body.dsh-dashboard-body");
      if (body) { body.style.display = "flex"; body.style.opacity = ""; } // 已渲染出的模块保持可见
      const box = $("modalLoadError");
      if (!box) return;
      const boxTitle = box.querySelector("div");
      if (boxTitle) boxTitle.textContent = "部分内容渲染失败";
      const detail = (err && (err.message || String(err))) || "未知错误";
      const msg = $("modalLoadErrorMsg");
      if (msg) msg.textContent = `页面渲染出错（${String(detail).slice(0, 200)}），已跳过异常模块，其余内容仍可正常使用；可点下方「重试」重新渲染。`;
      box.hidden = false;
      box.style.display = "flex";
    } catch (e) {
      console.error("[context] 渲染错误态展示失败", e);
    }
  }

  /** 详情加载失败: 隐藏骨架屏与主体, 显示可读错误态 + 重试按钮 (绝不白屏) */
  function showModalLoadError(err) {
    const skel = $("modalLoadingSkeleton");
    const body = document.querySelector(".modal-body.dsh-dashboard-body");
    const box = $("modalLoadError");
    if (modalSkeletonTimer) { clearTimeout(modalSkeletonTimer); modalSkeletonTimer = null; }
    if (skel) { skel.style.display = "none"; skel.style.opacity = ""; skel.style.transition = ""; }
    if (body) body.style.display = "none";
    if (!box) return;
    const code = (err && err.message) || "DETAIL_UNAVAILABLE";
    const reason = code === "DETAIL_NOT_FOUND"
      ? "缺少该会话的详情数据文件"
      : code === "DETAIL_EMPTY"
        ? "该会话详情数据为空"
        : "详情数据缺失";
    const msg = $("modalLoadErrorMsg");
    if (msg) msg.textContent = `${reason}，请点右上角「刷新」重新同步后重试，或直接点击下方「重试」。`;
    const boxTitle = box.querySelector("div");
    if (boxTitle) boxTitle.textContent = "详情加载失败";
    box.hidden = false;
    box.style.display = "flex"; // .lc-empty 为 flex 容器: 用内联 display 控制显隐, 避免 [hidden] 被 .lc-empty 覆盖
  }

  /** 首屏骨架屏: 静态 HTML 已存在则直接可见; 缺失时兜底生成 */
  function renderPageSkeleton() {
    let skel = $("pageSkeleton");
    if (!skel) {
      skel = document.createElement("div");
      skel.id = "pageSkeleton";
      skel.className = "lc-skel";
      skel.setAttribute("aria-busy", "true");
      const groupHtml = new Array(3).fill(
        `<div class="sm-skel-group">`
        + `<span class="lc-skel-bar sm-skel-folder" style="height:16px;margin-bottom:6px"></span>`
        + `<div class="sm-skel-row" style="height:44px;border-radius:8px;margin-top:8px"></div>`
        + `<div class="sm-skel-row" style="height:44px;border-radius:8px;margin-top:8px"></div>`
        + `</div>`
      ).join("");
      skel.innerHTML =
        `<div class="lc-skel-rows page-skel-kpis" style="flex-direction:row;gap:12px">`
        + new Array(4).fill('<span class="lc-skel-bar sm-skel-kpi" style="flex:1 1 0;height:64px"></span>').join("")
        + `</div><div class="page-skel-groups">${groupHtml}</div>`;
      const header = document.querySelector("header.sess-tools");
      if (header && header.parentNode) header.parentNode.insertBefore(skel, header.nextSibling);
      else document.body.insertBefore(skel, document.body.firstChild);
    }
    skel.style.display = "";
    skel.style.opacity = "1";
    skel.style.transition = "";
    skel.setAttribute("aria-busy", "true");
    skel.removeAttribute("aria-hidden");
    return skel;
  }

  /** 索引脚本彻底加载失败时的可读空态 (替代"未找到匹配的会话记录"的误导文案) */
  function renderIndexErrorState() {
    if (!elWorkspaceTree) return;
    elWorkspaceTree.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; color: var(--muted);">
        <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
        <div>索引数据加载失败</div>
        <div style="font-size: 11.5px; margin-top: 4px; color: var(--faint);">点击右上角「刷新」重新拉取索引</div>
      </div>
    `;
  }

  /**
   * 数据集是否为「尚未生成」的占位。
   * npm 安装后 page/context-data.js 是打包时写入的空索引 (window.CONTEXT_DATA_PLACEHOLDER),
   * 用户跑过一次同步命令才会被真实数据覆盖。
   */
  function isPlaceholderDataset() {
    if (window.CONTEXT_DATA_PLACEHOLDER === true) return true;
    const list = window.CONTEXT_SESSIONS;
    if (!Array.isArray(list)) return false;
    return list.length === 0 && Object.keys(detailFiles()).length === 0;
  }

  /**
   * 尚未生成本地数据时的引导态。
   * 这是 npm 安装后的正常首屏 —— 页面插件跑在自己的沙盒里 (connect-src 'none'),
   * 读不了磁盘也发不出请求, 数据必须由用户在插件目录里跑同步命令生成。
   */
  function renderNoDataState() {
    if (!elWorkspaceTree) return;
    elWorkspaceTree.innerHTML = `
      <div style="padding: 36px 20px; text-align: center; color: var(--muted); max-width: 640px; margin: 0 auto;">
        <div style="font-size: 24px; margin-bottom: 8px;">🗂️</div>
        <div style="font-size: 14px; color: var(--fg); margin-bottom: 6px;">还没有本地数据</div>
        <div style="font-size: 12px; line-height: 1.7; color: var(--faint);">
          这个页面只读本机日志（Magpie / DSH / Antigravity / Codex），不联网、也不上传任何内容。<br>
          安装后需要先跑一次同步命令，把索引写进插件自己的 page 目录：
        </div>
        <div style="margin: 14px 0 10px; padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,0.12); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); user-select: all; word-break: break-all;">
          npx magpie-context sync
        </div>
        <div style="font-size: 11.5px; line-height: 1.7; color: var(--faint);">
          想保持实时就再跑 <code style="font-family: inherit;">npx magpie-context watch</code>，然后重新打开本页。<br>
          同步只写本地文件，页面按 <code style="font-family: inherit;">&lt;script src&gt;</code> 加载，符合 Magpie 的页面沙盒策略。
        </div>
      </div>
    `;
  }

  /** 首屏真实内容 (KPI + 工作区树) 显示 */
  function revealPageContent() {
    const stats = $("pageStats");
    const main = $("pageMain");
    if (stats) stats.style.display = "";
    if (main) main.style.display = "";
  }

  /**
   * 首屏骨架屏淡出 (180ms)。
   * 关键: 开始淡出前先把骨架「冻结当前几何 + 移出文档流」(position:absolute), 真实内容立即在同一位置补上,
   * 骨架覆盖式淡出 → 不会出现「骨架 + 真实内容同时占位」的双份内容/布局跳动。
   */
  function hidePageSkeleton() {
    const skel = $("pageSkeleton");
    if (!skel || skel.dataset.hidden === "1") return;
    skel.dataset.hidden = "1";

    // 1) 冻结几何并脱离文档流 (纯内联样式, 不改 style.css)
    const rect = skel.getBoundingClientRect();
    skel.style.position = "absolute";
    skel.style.top = `${Math.round(rect.top + (window.pageYOffset || 0))}px`;
    skel.style.left = `${Math.round(rect.left + (window.pageXOffset || 0))}px`;
    skel.style.width = `${Math.round(rect.width)}px`;
    skel.style.margin = "0";
    skel.style.pointerEvents = "none";
    skel.style.zIndex = "20";
    skel.setAttribute("aria-busy", "false");
    skel.setAttribute("aria-hidden", "true");

    // 2) 下一帧开始淡出, 淡出结束后彻底移除
    requestAnimationFrame(() => {
      skel.classList.add("is-fading"); // css-layout 提供的淡出类
      skel.style.transition = "opacity 180ms ease";
      skel.style.opacity = "0";
      setTimeout(() => {
        skel.style.display = "none";
        skel.style.opacity = "";
        skel.style.transition = "";
        skel.style.position = "";
        skel.style.top = "";
        skel.style.left = "";
        skel.style.width = "";
        skel.style.zIndex = "";
      }, 180);
    });
  }

  // ==========================================================================
  // 主页面：渲染统计概览与工作区会话折叠树
  // ==========================================================================

  function renderMainStats() {
    const totalSess = rawSessions.length;
    let peakWatermark = 0;
    let peakWatermarkSess = null;
    let totalTurns = 0;
    let totalCompactions = 0;
    let totalCacheRead = summary.totalCacheRead || 0;

    let cntAntigravity = 0;
    let cntDsh = 0;
    let cntCodex = 0;
    let cntOther = 0;

    rawSessions.forEach(s => {
      if ((s.watermarkPercent || 0) > peakWatermark) {
        peakWatermark = s.watermarkPercent;
        peakWatermarkSess = s;
      }
      totalTurns += (s.turnsCount || 1);
      totalCompactions += (s.compactionCount || 0);

      const ag = (s.agent || "").toLowerCase();
      if (ag === "antigravity") cntAntigravity++;
      else if (ag === "dsh") cntDsh++;
      else if (ag === "codex") cntCodex++;
      else cntOther++;
    });

    if (elKpiTotalSess) elKpiTotalSess.textContent = formatNumber(totalSess);
    if (elKpiPeakWatermark) {
      elKpiPeakWatermark.textContent = formatWatermark(peakWatermark);
      elKpiPeakWatermark.style.color = peakWatermark > 80 ? "var(--red)" : (peakWatermark > 50 ? "var(--amber)" : "var(--green)");
    }
    if (elKpiPeakWatermarkSub) {
      elKpiPeakWatermarkSub.textContent = peakWatermarkSess ? `${peakWatermarkSess.name || peakWatermarkSess.id}` : "最高单轮占用占比";
    }
    if (elKpiTotalTurns) elKpiTotalTurns.textContent = formatNumber(totalTurns);
    if (elKpiTotalCompactions) elKpiTotalCompactions.textContent = formatNumber(totalCompactions);
    if (elKpiCacheRead) elKpiCacheRead.textContent = formatK(totalCacheRead).replace("≈", "");

    // 更新分段按钮徽标
    if (elBadgeAll) elBadgeAll.textContent = String(totalSess);
    if (elBadgeAntigravity) elBadgeAntigravity.textContent = String(cntAntigravity);
    if (elBadgeDsh) elBadgeDsh.textContent = String(cntDsh);
    if (elBadgeCodex) elBadgeCodex.textContent = String(cntCodex);
    if (elBadgeOther) elBadgeOther.textContent = String(cntOther);
  }

  function renderWorkspaceTree() {
    if (!elWorkspaceTree) return;
    elWorkspaceTree.innerHTML = "";

    // 1. 过滤会话
    const filtered = rawSessions.filter(s => {
      if (activeAgentFilter !== "all" && s.agent !== activeAgentFilter) return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const mTitle = (s.name || "").toLowerCase().includes(q);
        const mCwd = (s.cwd || "").toLowerCase().includes(q);
        const mModel = (s.model || "").toLowerCase().includes(q);
        const mId = (s.id || "").toLowerCase().includes(q);
        if (!mTitle && !mCwd && !mModel && !mId) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      elWorkspaceTree.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: var(--muted);">
          <div style="font-size: 24px; margin-bottom: 8px;">🔍</div>
          <div>未找到匹配的会话记录</div>
          <div style="font-size: 11.5px; margin-top: 4px; color: var(--faint);">尝试更换搜索关键词或 Agent 筛选</div>
        </div>
      `;
      return;
    }

    // 2. 按工作区 (cwd) 分组
    const groups = new Map();
    filtered.forEach(s => {
      const key = s.cwd || "GW";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });

    // 3. 渲染各个分组
    for (const [cwdKey, list] of groups.entries()) {
      const isGateway = cwdKey === "GW";
      const folderName = isGateway ? "经网关看到的会话" : baseName(cwdKey);
      const folderPath = isGateway ? "网关直连与无绑定目录会话" : cwdKey;
      const isCollapsed = collapsedFolders.has(cwdKey);

      const groupEl = document.createElement("div");
      groupEl.className = `sm-group ${isCollapsed ? "" : "open"}`;

      const folderRow = document.createElement("div");
      folderRow.className = "row sm-folder";
      folderRow.setAttribute("aria-expanded", String(!isCollapsed));

      folderRow.innerHTML = `
        <button type="button" class="fold" title="点击展开/收起该工作区">
          <svg class="sm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 12 10 8 6 4"/>
          </svg>
          <span class="sm-fwords">
            <span class="sm-fline">
              <span class="name">${escapeHtml(folderName)}</span>
              <span class="sm-path">${escapeHtml(folderPath)}</span>
            </span>
            <span class="sm-latest">最新交互: ${escapeHtml(list[0]?.timeAgo || list[0]?.lastTime || '最近')}</span>
          </span>
        </button>
        <span class="sm-when">
          <span class="note">${list.length} 个会话</span>
        </span>
      `;

      const foldBtn = folderRow.querySelector(".fold");
      foldBtn.addEventListener("click", () => {
        if (collapsedFolders.has(cwdKey)) {
          collapsedFolders.delete(cwdKey);
          groupEl.classList.add("open");
          folderRow.setAttribute("aria-expanded", "true");
        } else {
          collapsedFolders.add(cwdKey);
          groupEl.classList.remove("open");
          folderRow.setAttribute("aria-expanded", "false");
        }
      });

      groupEl.appendChild(folderRow);

      const itemsContainer = document.createElement("div");
      itemsContainer.className = "sm-items-container";

      list.forEach(s => {
        const sessRow = document.createElement("div");
        sessRow.className = "row sess sm-sess";
        sessRow.dataset.id = s.id;
        // 悬停/按下即预取该会话详情 (去重 + 并发 ≤3 + 失败静默), 让点击弹窗几乎瞬时
        sessRow.addEventListener("pointerenter", () => prefetchSessionDetail(s.id), { passive: true });
        sessRow.addEventListener("pointerdown", () => prefetchSessionDetail(s.id), { passive: true });
        sessRow.addEventListener("focus", () => prefetchSessionDetail(s.id));

        const iconSvg = window.getIconSvg ? window.getIconSvg(s.agent) : `
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <circle cx="8" cy="8" r="6"/>
          </svg>
        `;

        const compactionBadge = (s.compactionCount && s.compactionCount > 0)
          ? `<span class="compaction-tag" title="发生过 ${s.compactionCount} 次压缩事件">✂ ${s.compactionCount}</span>`
          : "";

        sessRow.innerHTML = `
          <div class="ag-handle" title="${escapeHtml(s.agentName || s.agent)}">
            ${iconSvg}
          </div>
          <div class="who">
            <div class="name">${escapeHtml(s.name || '(未命名会话)')}</div>
            <div class="sub">
              <span>${escapeHtml(s.model || 'default-model')}</span>
              <span>·</span>
              <span>${s.turnsCount || 1} 轮</span>
              <span>·</span>
              <span>${escapeHtml(s.timeAgo || s.lastTime || '')}</span>
            </div>
          </div>
          <div class="num">
            <b>${formatNumber(s.currentTokens)} tok</b>
            <small style="color: ${s.watermarkPercent > 80 ? 'var(--red)' : (s.watermarkPercent > 50 ? 'var(--amber)' : 'var(--green)')};">
              ${formatWatermark(s.watermarkPercent)} 水位
            </small>
            ${compactionBadge}
          </div>
          <svg class="sess-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 12 10 8 6 4"/>
          </svg>
        `;

        sessRow.addEventListener("click", () => {
          openSessionModal(s.id);
        });

        itemsContainer.appendChild(sessRow);
      });

      groupEl.appendChild(itemsContainer);
      elWorkspaceTree.appendChild(groupEl);
    }
  }

  // ==========================================================================
  // 弹窗控制：打开/关闭会话详情弹窗 (Modal)
  // ==========================================================================

  function openSessionModal(sessionId) {
    // 整段渲染兜底: 任何异常都转成弹窗内的可读错误态, 绝不抛到全局把整个页面带挂
    try {
      openSessionModalInner(sessionId);
    } catch (err) {
      console.error("[context] 打开会话弹窗失败", err);
      try {
        if (elDshContextModal) {
          elDshContextModal.classList.add("open");
          document.body.style.overflow = "hidden";
        }
        showModalRenderError(err);
      } catch (e2) {
        console.error("[context] 弹窗错误态兜底失败", e2);
      }
    }
  }

  function openSessionModalInner(sessionId) {
    const s = getSessionById(sessionId);
    if (!s) {
      showToast("未找到会话数据");
      return;
    }

    activeModalSessionId = sessionId;
    activeStepIdx = null; // 默认展示当前最新一步
    activeTurnIdx = null;

    // 1. 填充弹窗顶栏元信息
    if (elModalAgentIcon) {
      elModalAgentIcon.innerHTML = window.getIconSvg ? window.getIconSvg(s.agent) : "";
    }
    if (elModalSessionTitle) {
      elModalSessionTitle.textContent = s.name || '(未命名会话)';
    }
    if (elModalSessionSub) {
      elModalSessionSub.innerHTML = `
        <span>Agent: <b>${escapeHtml(s.agentName || s.agent)}</b></span>
        <span>·</span>
        <span>模型: <b>${escapeHtml(s.model)}</b></span>
        <span>·</span>
        <span>工作区: <b>${escapeHtml(baseName(s.cwd) || '网关')}</b></span>
        <span>·</span>
        <span>最新交互: <b>${escapeHtml(s.lastTime || s.timeAgo || '最近')}</b></span>
      `;
    }

    // 2. 水位指示槽 (精准显示格式化水位)
    const wm = s.watermarkPercent || 0;
    const limit = s.modelLimit || 1000000;
    if (elModalWatermarkText) {
      elModalWatermarkText.textContent = `${formatWatermark(wm)} 水位`;
      elModalWatermarkText.style.color = wm > 80 ? "var(--red)" : (wm > 50 ? "var(--amber)" : "var(--green)");
    }
    if (elModalLimitText) {
      elModalLimitText.textContent = `/ ${formatK(limit)} tokens`;
    }
    if (elModalWatermarkFill) {
      elModalWatermarkFill.style.width = `${Math.min(100, Math.max(1, wm))}%`;
      elModalWatermarkFill.style.backgroundColor = wm > 80 ? "var(--red)" : (wm > 50 ? "var(--amber)" : "var(--green)");
    }

    // 3. 确保对比基线按钮状态与当前 diffMode 一致
    if (elBtnDiffStep) elBtnDiffStep.classList.toggle("on", diffMode === "step");
    if (elBtnDiffTurn) elBtnDiffTurn.classList.toggle("on", diffMode === "turn");

    // 4. 立即打开弹窗并展示详情骨架屏 (顶栏/水位已用索引字段渲染完毕, 不等详情)
    renderModalSkeleton();
    renderSkeleton(true);
    if (elDshContextModal) {
      elDshContextModal.classList.add("open");
      document.body.style.overflow = "hidden";
    }

    // 5. 详情懒加载: 命中 window.CONTEXT_SESSION_DETAIL 直接渲染, 否则注入详情 <script>,
    //    到达后渲染并 160ms 淡出骨架屏; 失败/超时则展示弹窗内错误态 + 重试。
    loadModalDetail(sessionId);
  }

  /** 拉取并渲染当前弹窗会话详情 (错误态 + 重试由 showModalLoadError 兜底) */
  function loadModalDetail(sessionId) {
    if (!sessionId) return;
    ensureSessionDetail(sessionId)
      .then(() => {
        if (activeModalSessionId !== sessionId) return; // 期间已切换到其它会话
        finishModalLoad(sessionId);
      })
      .catch((err) => {
        if (activeModalSessionId !== sessionId) return;
        showModalLoadError(err);
      });
  }

  /** 详情就绪: 下一帧渲染全部卡片并淡出骨架屏 (确保 Modal 尺寸已就绪再画图表) */
  function finishModalLoad(sessionId) {
    const s = getSessionById(sessionId);
    if (!s) return;
    requestAnimationFrame(() => {
      if (activeModalSessionId !== sessionId) return;
      try {
        renderModalAllViews(s);
      } catch (err) {
        console.error("[context] 弹窗详情渲染失败", err);
        showModalRenderError(err);
      }
      try {
        renderSkeleton(false);
      } catch (err) {
        console.error("[context] 骨架屏切换失败", err);
      }
    });
  }

  function closeSessionModal() {
    if (!elDshContextModal) return;
    elDshContextModal.classList.remove("open");
    document.body.style.overflow = "";
    activeModalSessionId = null;
    if (modalSkeletonTimer) { clearTimeout(modalSkeletonTimer); modalSkeletonTimer = null; }
    const err = $("modalLoadError");
    if (err) { err.hidden = true; err.style.display = "none"; }
  }

  // ==========================================================================
  // 弹窗内部：100% 对齐 dsh-context 官方视觉规范的数据渲染引擎
  // ==========================================================================

  function renderModalAllViews(s) {
    if (!s) return;
    const dc = s.dshContext || {};

    // 整段渲染兜底: 每个模块独立 try/catch, 单块异常只跳过该块 (其余模块照常渲染),
    // 并在弹窗内展示可读错误态 —— 绝不白屏、绝不把异常抛到全局。
    const sections = [
      ["统计", () => renderTopStats(dc.stats || {}, s)],
      ["Token", () => renderTokenStats(dc.tokenStats || {}, s)],
      ["耗时", () => renderTimingStats(dc.timingStats || {}, s)],
      ["当前上下文", () => renderCurrentContext(dc.currentContext || {}, s)],
      ["趋势图", () => renderTrendBarsAndChart(s)],
      ["步骤摘要", () => renderStepBrief(s)],
      ["上下文浏览器", () => renderContextBrowser(s)],
      ["事件", () => renderEventsCard(s)],
      ["文件", () => renderFilesCard(s)],
      ["命令", () => renderCommandsCard(s)]
    ];

    const failed = [];
    for (const [label, run] of sections) {
      try {
        run();
      } catch (err) {
        failed.push(label);
        console.error(`[context] 模块「${label}」渲染失败`, err);
      }
    }
    if (failed.length > 0) {
      showModalRenderError(new Error(`模块 ${failed.join("、")} 渲染失败`));
    }
  }

  // 1. 第一行：上下文统计 (清爽无广告，占满整行)
  function renderTopStats(st, s) {
    if (elStatTurns) elStatTurns.textContent = String(st.turnsCount || s.turnsCount || 1);
    if (elStatSteps) elStatSteps.textContent = String(s.dshContext?.steps?.length || st.stepsCount || 0);
    if (elStatSkills) elStatSkills.textContent = String(st.skillsCount || 0);
    if (elStatAnswers) elStatAnswers.textContent = String(st.answersCount || 0);

    const ev = st.events || {};
    if (elStatEvents) {
      elStatEvents.textContent = `注入 ${ev.inject || 0} / 压缩 ${ev.compact || s.compactionCount || 0} / 剪枝 ${ev.prune || 0}`;
    }

    const io = st.io || {};
    const totalIO = (io.user || 0) + (io.read || 0) + (io.write || 0) + (io.search || 0) + (io.image || 0);
    if (elCntIO) elCntIO.textContent = String(totalIO);
    if (elPillsIO) {
      elPillsIO.innerHTML = `
        <span class="pill-badge user">■ 用户 ${io.user || 0}</span>
        <span class="pill-badge read">■ 读取 ${io.read || 0}</span>
        <span class="pill-badge write">■ 写入 ${io.write || 0}</span>
        <span class="pill-badge search">■ 搜索 ${io.search || 0}</span>
        <span class="pill-badge image">■ 图片 ${io.image || 0}</span>
      `;
    }

    const tc = st.toolCalls || {};
    const totalTools = (tc.bash || 0) + (tc.read || 0) + (tc.edit || 0) + (tc.other || 0);
    if (elCntTools) elCntTools.textContent = String(totalTools);
    if (elPillsTools) {
      elPillsTools.innerHTML = `
        <span class="pill-badge tool-bash">■ bash ${tc.bash || 0}</span>
        <span class="pill-badge tool-read">■ read ${tc.read || 0}</span>
        <span class="pill-badge tool-valid">■ validate_action ${tc.edit || 0}</span>
        <span class="pill-badge tool-other">■ 其他 +${tc.other || 0}</span>
      `;
    }

    const cmd = st.commands || {};
    const totalCmds = (cmd.head || 0) + (cmd.grep || 0) + (cmd.echo || 0) + (cmd.other || 0);
    if (elCntCmds) elCntCmds.textContent = String(totalCmds);
    if (elPillsCmds) {
      elPillsCmds.innerHTML = `
        <span class="pill-badge cmd-head">■ head ${cmd.head || 0}</span>
        <span class="pill-badge cmd-grep">■ grep ${cmd.grep || 0}</span>
        <span class="pill-badge cmd-echo">■ echo ${cmd.echo || 0}</span>
        <span class="pill-badge cmd-other">■ 其他 +${cmd.other || 0}</span>
      `;
    }

    const fl = st.fleet || {};
    // 编队: 真实子 Agent / 任务 计数 (数据侧 dshContext.fleet + stats.fleet)
    const fleetDetail = (s && s.dshContext && s.dshContext.fleet) || {};
    const subList = Array.isArray(fleetDetail.subagents) ? fleetDetail.subagents : [];
    const taskList = Array.isArray(fleetDetail.tasks) ? fleetDetail.tasks : [];
    const subCount = fl.subCount != null ? fl.subCount : subList.length;
    const taskCount = fl.taskCount != null ? fl.taskCount : taskList.length;
    if (elFleetAgent) elFleetAgent.textContent = `当前 Agent ${fl.current || formatK(s.totalInputTokens || s.currentTokens || 0)}`;
    if (elFleetSub) elFleetSub.textContent = `子 Agent ×${subCount} · 任务 ${taskCount}`;
    renderFleetPanel(s, { subCount, taskCount });
    bindFleetToggle();
  }

  /**
   * 编队面板 (统计卡内部内联展开, 不做浮层库):
   *   子 Agent: name / label / mode / childId 前 8 位
   *   任务:     title / status / assignee
   * 无数据时显示「无子 Agent」/「无任务」。
   */
  function renderFleetPanel(s, counts) {
    if (!elFleetPanel) return;
    const fleet = (s && s.dshContext && s.dshContext.fleet) || {};
    const subs = Array.isArray(fleet.subagents) ? fleet.subagents : [];
    const tasks = Array.isArray(fleet.tasks) ? fleet.tasks : [];
    const c = counts || {};
    const subN = c.subCount != null ? c.subCount : subs.length;
    const taskN = c.taskCount != null ? c.taskCount : tasks.length;
    const disabled = (fleet.teamEnabled === false) ? " · 编队未启用" : "";

    const subsHtml = subs.length === 0
      ? `<div class="fleet-empty">无子 Agent</div>`
      : subs.map(function (sa, si) {
          const cid = String(sa.childId || sa.id || "");
          const nm = sa.name || sa.label || "agent";
          const sid = sa.sessionId ? String(sa.sessionId) : "";
          const matched = sa.matched === true;
          let jump;
          if (sid) {
            jump = `<button type="button" class="fleet-open-sess" data-sess-id="${escapeHtml(sid)}" title="打开子会话 ${escapeHtml(sid)}">打开会话</button>`;
          } else if (matched) {
            jump = `<span class="fleet-tag-miss" title="已匹配到子 Agent, 但该会话尚未加载">未加载</span>`;
          } else {
            jump = `<span class="fleet-dash">—</span>`;
          }
          const rowTitle = `子 Agent #${si + 1} · ${nm} · childId ${cid || "—"}${sid ? " · 子会话已加载, 点击右侧按钮跳转" : (matched ? " · 子会话未加载" : " · 未匹配到子会话")}`;
          return `<div class="fleet-item" data-fleet-cid="${escapeHtml(cid)}" title="${escapeHtml(rowTitle)}">
            <span class="fleet-name">${escapeHtml(nm)}</span>
            <span class="fleet-label">${escapeHtml(sa.label || "")}</span>
            <span class="fleet-mode">${escapeHtml(sa.mode || "—")}</span>
            <code class="fleet-cid" title="${escapeHtml(cid)}">${escapeHtml(cid.slice(0, 8) || "—")}</code>
            ${jump}
          </div>`;
        }).join("");

    const tasksHtml = tasks.length === 0
      ? `<div class="fleet-empty">无任务</div>`
      : tasks.map(function (t) {
          return `<div class="fleet-item">
            <span class="fleet-name">${escapeHtml(t.title || t.id || "任务")}</span>
            <span class="fleet-mode">${escapeHtml(t.status || "—")}</span>
            <span class="fleet-label">${escapeHtml(t.assignee || "")}</span>
          </div>`;
        }).join("");

    elFleetPanel.innerHTML =
      `<div class="fleet-panel-head">子 Agent ×${subN} · 任务 ${taskN}${disabled}</div>`
      + `<div class="fleet-sub-head">子 Agent</div>` + subsHtml
      + `<div class="fleet-sub-head">任务</div>` + tasksHtml;
    bindFleetSessionJump();
  }

  /** 子 Agent 行「打开会话」跳转 (事件委托, 只绑一次) */
  function bindFleetSessionJump() {
    if (!elFleetPanel || elFleetPanel.getAttribute("data-jump-bound") === "1") return;
    elFleetPanel.setAttribute("data-jump-bound", "1");
    elFleetPanel.addEventListener("click", function (ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest(".fleet-open-sess") : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const sid = btn.getAttribute("data-sess-id") || "";
      if (!sid) return;
      const loaded = rawSessions.some(function (x) { return x && x.id === sid; });
      if (!loaded) { showToast("该会话未加载"); return; }
      closeSessionModal();
      openSessionModal(sid);
      showToast("已跳转到子会话 " + sid.slice(0, 8));
    });
  }

  /** 编队行点击 (Enter/Space 亦可) 展开/收起面板, 只绑定一次 */
  function bindFleetToggle() {
    if (!elFleetRow || elFleetRow.getAttribute("data-bound") === "1") return;
    elFleetRow.setAttribute("data-bound", "1");
    const toggle = function () {
      if (!elFleetPanel) return;
      const willOpen = elFleetPanel.hasAttribute("hidden");
      if (willOpen) elFleetPanel.removeAttribute("hidden");
      else elFleetPanel.setAttribute("hidden", "");
      elFleetRow.setAttribute("aria-expanded", willOpen ? "true" : "false");
      elFleetRow.classList.toggle("open", willOpen);
    };
    elFleetRow.addEventListener("click", toggle);
    elFleetRow.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  }

  // ==========================================================================
  // 官方 dsh-context v0.84.0 图表原语 (donut / slice legend / stacked / chip legend)
  //   donut  : .lc-donut > svg(viewBox 0 0 42 42, r=15.9155, stroke-width 4) + .lc-donut-center
  //   legend : .lc-sl > .lc-sl-row > .lc-sl-main(.lc-sl-dot/.lc-sl-label/.lc-sl-pct) + .lc-sl-sub
  //   stacked: .lc-stacked-wrap > .lc-stacked > .lc-stacked-seg[--lc-i] (+ .lc-stacked-free)
  //   chips  : .lc-legend > .lc-chip > i + .lc-chip-label + 迷你条 + .lc-chip-nums(em 百分比)
  // ==========================================================================
  const SVG_NS = "http://www.w3.org/2000/svg";

  // 官方 $u()/eu() 环形图: 分段间隙 + 12 点钟方向顺时针
  function buildDonutArcs(segments) {
    const list = (segments || []).filter(function (s) { return Number.isFinite(s.value) && s.value > 0; });
    let total = 0;
    for (const s of list) total += s.value;
    const arcs = [];
    let acc = 0;
    if (total > 0) {
      for (const s of list) {
        const len = (s.value / total) * 100;
        // 圆周 = 2πr = 100 (r = 15.9155) → dasharray 单位即百分比; offset = 100 - 累计 + 25 (25 = 12 点钟)
        arcs.push({ key: s.key, color: s.color, len: len, offset: 100 - acc + 25 });
        acc += len;
      }
    }
    if (arcs.length > 1) {
      // 分段之间留缺口: 每段各缩 min(0.5/2, len/4) → 约 2~3px 的可见暗色缝隙
      for (const a of arcs) {
        const gap = Math.min(0.5 / 2, a.len / 4);
        a.len -= gap * 2;
        a.offset -= gap;
      }
    }
    return { arcs: arcs, total: total };
  }

  function renderDonut(donutEl, svgEl, opts) {
    if (!donutEl || !svgEl) return;
    const size = opts.size || 96;
    const built = buildDonutArcs(opts.segments);
    const arcs = built.arcs;
    const hoverKey = opts.hoverKey;
    const isDim = hoverKey !== null && hoverKey !== undefined && arcs.some(function (a) { return a.key === hoverKey; });

    donutEl.style.width = size + "px";
    donutEl.style.height = size + "px";
    donutEl.classList.toggle("lc-donut-dim", isDim);
    svgEl.setAttribute("viewBox", "0 0 42 42");
    svgEl.setAttribute("width", String(size));
    svgEl.setAttribute("height", String(size));
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    if (arcs.length === 0) {
      const track = document.createElementNS(SVG_NS, "circle");
      track.setAttribute("class", "lc-donut-track");
      track.setAttribute("cx", "21");
      track.setAttribute("cy", "21");
      track.setAttribute("r", "15.9155");
      track.setAttribute("fill", "none");
      track.setAttribute("stroke-width", "4");
      svgEl.appendChild(track);
    } else {
      arcs.forEach(function (a, i) {
        const seg = document.createElementNS(SVG_NS, "circle");
        seg.setAttribute("class", "lc-donut-seg animate-lc-donut-in" + (hoverKey === a.key ? " lc-donut-seg-on" : ""));
        seg.setAttribute("cx", "21");
        seg.setAttribute("cy", "21");
        seg.setAttribute("r", "15.9155");
        seg.setAttribute("fill", "none");
        seg.setAttribute("stroke-width", "4");
        seg.setAttribute("stroke-linecap", "butt");
        seg.setAttribute("stroke-dasharray", String(a.len) + " " + String(100 - a.len));
        seg.setAttribute("stroke-dashoffset", String(a.offset));
        seg.style.setProperty("--lc-i", String(i));
        seg.style.stroke = a.color;
        seg.addEventListener("mouseenter", function () { if (opts.onHoverKey) opts.onHoverKey(a.key); });
        svgEl.appendChild(seg);
      });
    }

    const centerB = donutEl.querySelector(".lc-donut-center b");
    if (centerB && opts.centerTop !== undefined && opts.centerTop !== null) {
      centerB.textContent = String(opts.centerTop);
      centerB.style.fontSize = Math.max(11, Math.round(size * 0.13)) + "px";
    }
    const centerSpan = donutEl.querySelector(".lc-donut-center span");
    if (centerSpan && opts.centerSub !== undefined && opts.centerSub !== null) {
      centerSpan.textContent = String(opts.centerSub);
      centerSpan.style.fontSize = Math.max(9, Math.round(size * 0.105)) + "px";
    }
  }

  // 官方 cu(): .lc-sl 两行图例 (dot + label + pct / sub 数值)
  function renderSliceLegend(listEl, cats, opts) {
    if (!listEl) return;
    listEl.innerHTML = "";
    const hoverKey = opts.hoverKey;
    (cats || []).forEach(function (c) {
      const valueText = c[opts.valueKey || "formatted"];
      const row = document.createElement("div");
      row.className = "lc-sl-row"
        + (hoverKey && hoverKey !== c.key ? " lc-sl-row-dim" : "")
        + (hoverKey === c.key ? " lc-sl-row-on" : "");
      row.dataset.cat = c.key;
      row.setAttribute("title", (c.label || c.key) + ": " + (c.percent || 0) + "%" + (valueText ? " (" + valueText + ")" : ""));

      const main = document.createElement("div");
      main.className = "lc-sl-main";
      const dot = document.createElement("i");
      dot.className = "lc-sl-dot";
      dot.style.background = c.color;
      const label = document.createElement("span");
      label.className = "lc-sl-label";
      label.setAttribute("title", c.label || c.key);
      label.textContent = c.label || c.key;
      const pct = document.createElement("span");
      pct.className = "lc-sl-pct";
      pct.textContent = String(c.percent || 0) + "%";
      main.appendChild(dot);
      main.appendChild(label);
      main.appendChild(pct);
      row.appendChild(main);

      const subText = valueText === undefined || valueText === null || valueText === "" ? "—" : String(valueText);
      const sub = document.createElement("div");
      sub.className = "lc-sl-sub";
      sub.setAttribute("title", subText);
      sub.textContent = subText;
      row.appendChild(sub);

      row.addEventListener("mouseenter", function () { if (opts.onHoverKey) opts.onHoverKey(c.key); });
      row.addEventListener("mouseleave", function () { if (opts.onHoverKey) opts.onHoverKey(null); });
      listEl.appendChild(row);
    });
  }

  // 环形图卡片状态 (hover 联动: 扇形高亮 + 图例行高亮)
  const donutCards = { token: { hover: null, cats: [], paint: null }, timing: { hover: null, cats: [], paint: null } };

  function paintDonutCard(kind) {
    const card = donutCards[kind];
    if (!card || !card.paint) return;
    card.paint();
  }

  function renderDonutCard(kind, cfg, cats) {
    const card = donutCards[kind];
    card.cats = cats || [];
    const paint = function () {
      renderDonut(cfg.donutEl, cfg.svgEl, {
        size: cfg.size || 96,
        segments: card.cats.map(function (c) {
          const raw = c.value !== undefined && c.value !== null ? c.value : (c.tokens !== undefined && c.tokens !== null ? c.tokens : c.ms);
          return { key: c.key, color: c.color, value: Number(raw) || 0 };
        }),
        centerTop: cfg.centerTop,
        centerSub: cfg.centerSub,
        hoverKey: card.hover,
        onHoverKey: function (key) {
          card.hover = key;
          paintDonutCard(kind);
        }
      });
      renderSliceLegend(cfg.listEl, card.cats, {
        valueKey: cfg.valueKey || "formatted",
        hoverKey: card.hover,
        onHoverKey: function (key) {
          card.hover = key;
          paintDonutCard(kind);
        }
      });
    };
    card.paint = paint;
    paint();
  }

  // 3. 第二行左侧：Token 统计 (官方 .lc-donut-row: donut(96) + .lc-sl)
  function renderTokenStats(ts, s) {
    const centerTop = ts.totalUsageFormatted || formatK(s.totalInputTokens || s.currentTokens || 0);
    if (elDonutTokenVal) elDonutTokenVal.textContent = centerTop;
    if (elTokenCacheHitRate) elTokenCacheHitRate.textContent = "缓存命中 " + (ts.cacheHitRate !== undefined && ts.cacheHitRate !== null ? ts.cacheHitRate + "%" : "—");
    renderDonutCard("token", {
      donutEl: elDonutToken,
      svgEl: elDonutTokenSvg,
      listEl: elTokenDetailsGrid,
      size: 96,
      centerTop: centerTop,
      centerSub: "总用量",
      valueKey: "formatted"
    }, ts.categories || []);
  }

  // 4. 第二行右侧：耗时统计 (官方 donut + .lc-sl + .lc-stacked 耗时轨)
  function renderTimingStats(tms, s) {
    const centerTop = tms.activeDuration || "—";
    if (elDonutTimingVal) elDonutTimingVal.textContent = centerTop;
    if (elTimingSpeed) elTimingSpeed.textContent = "输出速度 " + (tms.speed !== undefined && tms.speed !== null ? tms.speed + " tok/s" : "—");
    const cats = tms.categories || [];
    renderDonutCard("timing", {
      donutEl: elDonutTiming,
      svgEl: elDonutTimingSvg,
      listEl: elTimingDetailsGrid,
      size: 96,
      centerTop: centerTop,
      centerSub: "活跃时长",
      valueKey: "detail"
    }, cats);

    // 官方 .lc-stacked 耗时轨: 每类一段, 宽度 = percent%
    if (elTimingTrackBar) {
      elTimingTrackBar.innerHTML = "";
      elTimingTrackBar.classList.remove("lc-stacked-dim");
      cats.forEach(function (c, i) {
        const pct = Number(c.percent) || 0;
        if (pct <= 0) return;
        const seg = document.createElement("div");
        seg.className = "lc-stacked-seg animate-lc-stacked-in";
        seg.dataset.cat = c.key;
        seg.style.width = pct + "%";
        seg.style.backgroundColor = c.color;
        seg.style.setProperty("--lc-i", String(Math.min(i, 8)));
        seg.setAttribute("title", (c.label || c.key) + ": " + pct + "%" + (c.detail ? " (" + c.detail + ")" : ""));
        seg.addEventListener("mouseenter", function () {
          elTimingTrackBar.classList.add("lc-stacked-dim");
          seg.classList.add("lc-stacked-seg-on");
        });
        seg.addEventListener("mouseleave", function () {
          elTimingTrackBar.classList.remove("lc-stacked-dim");
          seg.classList.remove("lc-stacked-seg-on");
        });
        elTimingTrackBar.appendChild(seg);
      });
    }

    // 官方里程碑刻度 (timingStats.ruler: 0 / 1/4 / 1/2 / 3/4 / 全长)
    if (elTimingMilestones) {
      const ruler = tms.ruler || [];
      elTimingMilestones.innerHTML = "";
      ruler.forEach(function (tick) {
        const span = document.createElement("span");
        span.textContent = String(tick);
        elTimingMilestones.appendChild(span);
      });
    }
  }

  // 官方 Fc(): .lc-legend > .lc-chip (色点 + 类名 + 迷你条 + 数值 + 百分比)
  function renderChipLegend(container, parts, opts) {
    if (!container) return;
    const options = opts || {};
    container.innerHTML = "";
    let sum = 0;
    (parts || []).forEach(function (p) {
      const raw = p.raw !== undefined && p.raw !== null ? p.raw : p.value;
      sum += Math.abs(Number(raw) || 0);
    });
    (parts || []).forEach(function (p) {
      const rawNum = Number(p.raw !== undefined && p.raw !== null ? p.raw : p.value) || 0;
      const absVal = Math.abs(rawNum);
      const pct = sum > 0 ? Math.round((absVal / sum) * 100) : 0;
      const isOn = options.hoverKey !== undefined && options.hoverKey !== null && options.hoverKey === p.key;

      const chip = document.createElement("span");
      chip.className = "lc-chip" + (isOn ? " lc-chip-on" : "");
      chip.dataset.cat = p.key;
      chip.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;padding:1px 6px;border-radius:6px";

      const dot = document.createElement("i");
      dot.style.cssText = "width:8px;height:8px;border-radius:2px;flex:none;display:inline-block;background:" + (p.color || "currentColor");
      chip.appendChild(dot);

      const label = document.createElement("span");
      label.className = "lc-chip-label";
      label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;font-weight:600";
      label.setAttribute("title", p.label || p.key);
      label.textContent = p.label || p.key;
      chip.appendChild(label);

      // 迷你条 (官方截图中 chip 内的占比条)
      const bar = document.createElement("span");
      bar.className = "lc-chip-bar";
      bar.style.cssText = "position:relative;flex:none;width:52px;height:3px;border-radius:2px;overflow:hidden;background:color-mix(in srgb, var(--color-neutral-500) 22%, transparent)";
      const fill = document.createElement("span");
      fill.className = "lc-chip-bar-fill";
      fill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:" + Math.max(0, Math.min(100, pct)) + "%;background:" + (p.color || "currentColor");
      bar.appendChild(fill);
      chip.appendChild(bar);

      const nums = document.createElement("span");
      nums.className = "lc-chip-nums"
        + (options.delta === true && rawNum !== 0 ? (rawNum > 0 ? " lc-chip-nums-up" : " lc-chip-nums-down") : "");
      nums.style.cssText = "white-space:nowrap;flex:none;display:inline-flex;align-items:baseline;gap:6px;margin-left:auto;font-variant-numeric:tabular-nums";
      const valueText = (options.delta === true && rawNum > 0 ? "+" : (options.delta === true ? (rawNum < 0 ? "-" : "") : "≈")) + formatK(absVal).replace("≈", "");
      nums.appendChild(document.createTextNode(valueText));
      const em = document.createElement("em");
      em.style.cssText = "font-style:normal;color:var(--dsw-alias-label-secondary, var(--muted));";
      em.textContent = pct + "%";
      nums.appendChild(em);
      chip.appendChild(nums);

      if (options.onHoverKey) {
        chip.addEventListener("mouseenter", function () { options.onHoverKey(p.key); });
        chip.addEventListener("mouseleave", function () { options.onHoverKey(null); });
      }
      container.appendChild(chip);
    });
  }

  // 5. 第三行左上：当前上下文 (官方 .lc-stacked 分段条 + .lc-legend chips)
  let ctxHoverKey = null;

  function renderCurrentContext(cc, s) {
    if (elCtxModelBadge) elCtxModelBadge.textContent = cc.modelInfo || (s.agent + " · " + s.model);
    if (elCtxTokensText) elCtxTokensText.textContent = formatK(cc.currentTokens || s.currentTokens || 0).replace("≈", "");
    if (elCtxLimitText) elCtxLimitText.textContent = "/ " + formatK(cc.limitTokens || s.modelLimit || 0).replace("≈", "") + " tokens";
    if (elCtxWatermarkText) elCtxWatermarkText.textContent = formatWatermark(cc.watermark !== undefined ? cc.watermark : s.watermarkPercent) + " 上下文已用";

    const cats = cc.categories || [];
    const limit = Number(cc.limitTokens || s.modelLimit || 0);
    const toPctOfWindow = function (tokens) {
      if (!(limit > 0)) return 0;
      return Math.max(0, Math.min(100, (Number(tokens) || 0) / limit * 100));
    };

    if (elCtxStackedBar) {
      elCtxStackedBar.innerHTML = "";
      elCtxStackedBar.classList.remove("lc-stacked-dim");
      let usedTokens = 0;
      cats.forEach(function (c, i) {
        const tok = Number(c.tokens) || 0;
        usedTokens += tok;
        const width = toPctOfWindow(tok);
        if (width <= 0) return;
        const seg = document.createElement("div");
        seg.className = "lc-stacked-seg animate-lc-stacked-in";
        seg.dataset.cat = c.key;
        seg.style.width = width + "%";
        seg.style.backgroundColor = c.color;
        seg.style.setProperty("--lc-i", String(Math.min(i, 8)));
        seg.setAttribute("title", (c.label || c.key) + ": " + (c.formatted || "") + " (" + (c.percent || 0) + "%)");
        seg.addEventListener("mouseenter", function () {
          elCtxStackedBar.classList.add("lc-stacked-dim");
          seg.classList.add("lc-stacked-seg-on");
          ctxHoverKey = c.key;
          renderCtxLegend(cats, usedTokens);
        });
        seg.addEventListener("mouseleave", function () {
          elCtxStackedBar.classList.remove("lc-stacked-dim");
          seg.classList.remove("lc-stacked-seg-on");
          ctxHoverKey = null;
          renderCtxLegend(cats, usedTokens);
        });
        elCtxStackedBar.appendChild(seg);
      });

      // 预留区 (窗口内未使用部分): 官方 .lc-stacked-free, 加斜纹以体现"预留"
      const freeWidth = Math.max(0, 100 - toPctOfWindow(usedTokens));
      if (freeWidth > 0) {
        const free = document.createElement("div");
        free.className = "lc-stacked-free animate-lc-stacked-in";
        free.style.width = freeWidth + "%";
        free.style.setProperty("--lc-i", String(Math.min(cats.length, 9)));
        free.style.backgroundImage = "repeating-linear-gradient(45deg, color-mix(in srgb, var(--color-neutral-500) 20%, transparent) 0 5px, transparent 5px 10px)";
        free.setAttribute("title", "预留空间: " + formatK(Math.max(0, limit - usedTokens)));
        free.addEventListener("mouseenter", function () { free.classList.add("lc-stacked-free-on"); });
        free.addEventListener("mouseleave", function () { free.classList.remove("lc-stacked-free-on"); });
        elCtxStackedBar.appendChild(free);
      }
    }

    renderCtxLegend(cats, cats.reduce(function (acc, c) { return acc + (Number(c.tokens) || 0); }, 0));
  }

  function renderCtxLegend(cats, usedTokens) {
    renderChipLegend(elCtxLegendGrid, (cats || []).map(function (c) {
      return { key: c.key, label: c.label, color: c.color, value: Number(c.tokens) || 0 };
    }), {
      hoverKey: ctxHoverKey,
      onHoverKey: function (key) {
        ctxHoverKey = key;
        if (elCtxStackedBar) {
          elCtxStackedBar.classList.toggle("lc-stacked-dim", key !== null);
          elCtxStackedBar.querySelectorAll(".lc-stacked-seg").forEach(function (seg) {
            seg.classList.toggle("lc-stacked-seg-on", seg.dataset.cat === key);
          });
        }
        renderCtxLegend(cats, usedTokens);
      }
    });
  }

  function formatDuration(sec) {
    if (!sec || sec < 0) return "0s";
    if (sec < 60) return `${sec.toFixed(1)}s`.replace(".0s", "s");
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m${s}s`;
  }

  function getStepDnaBands(it) {
    if (it.dnaBands && it.dnaBands.length > 0) return it.dnaBands;

    // Fallback: 若旧数据未直接包含 dnaBands，根据 breakdown 动态构造消息与工具真实交替条带
    const bd = it.breakdown || {};
    const tot = it.totalTokens || 8000;
    const bands = [];
    let curOff = 0;

    const push = (key, cat, color, title, tokens, snippet, fullText) => {
      if (!tokens || tokens <= 0) return;
      const b = {
        key,
        cat,
        color,
        title,
        tokens: Math.round(tokens),
        off: curOff,
        snippet: snippet || title,
        fullText: fullText || snippet || title
      };
      curOff += b.tokens;
      bands.push(b);
    };

    const sysTok = bd.system || 4500;
    const toolsTok = bd.tools || 3000;
    push("sys", "system", "#a855f7", "系统提示词与运行准则", sysTok, "基础系统身份、能力约束与环境规范");
    push("tool:run_command", "tools", "#eab308", "工具定义: run_command", Math.round(toolsTok * 0.4), "Execute shell command in workspace");
    push("tool:read_file", "tools", "#eab308", "工具定义: read_file", Math.round(toolsTok * 0.35), "Read file contents in workspace");
    push("tool:edit_file", "tools", "#eab308", "工具定义: edit_file", Math.max(10, toolsTok - Math.round(toolsTok * 0.75)), "Single block file edit");

    if (bd.inject) push("inject:workspace", "inject", "#c026d3", "环境注入: 工作区配置", bd.inject, "Workspace configuration & shell rules");
    if (bd.skill) push("skill:context", "skill", "#f97316", "技能加载: 上下文协议", bd.skill, "Context observability protocol");

    // 消息与工具严格交替
    const rounds = Math.max(1, it.turnIdx || 1);
    const userEach = Math.max(20, Math.round((bd.user || 400) / rounds));
    const asstEach = Math.max(25, Math.round((bd.assistant || 2000) / rounds));
    const toolEach = Math.max(20, Math.round((bd.tool || 1500) / rounds));

    for (let r = 1; r <= rounds; r++) {
      push(`user-t${r}`, "user", "#10b981", `第 ${r} 轮用户消息`, userEach, `第 ${r} 轮用户提出的问题或执行指令`);
      push(`asst-t${r}-s1`, "assistant", "#3b82f6", `第 ${r} 轮助手回复`, asstEach, `模型规划与思考回复内容`);
      push(`tool-t${r}-s1`, "tool", "#06b6d4", `第 ${r} 轮工具执行结果`, toolEach, `[工具返回的标准输出内容]`);
    }

    return bands;
  }

  function getDnaGradientFromBands(bands, tot) {
    if (!bands || bands.length === 0) return "#38bdf8";
    const total = tot || bands.reduce((acc, b) => acc + b.tokens, 0) || 1;
    const stops = [];
    for (const b of bands) {
      if (b.tokens <= 0) continue;
      const p1 = Math.max(0, (b.off / total) * 100).toFixed(1);
      const p2 = Math.min(100, ((b.off + b.tokens) / total) * 100).toFixed(1);
      stops.push(`${b.color} ${p1}%, ${b.color} ${p2}%`);
    }
    return stops.length > 0 ? `linear-gradient(to top, ${stops.join(", ")})` : "#38bdf8";
  }

  function getDnaGradient(it) {
    const bands = getStepDnaBands(it);
    return getDnaGradientFromBands(bands, it.totalTokens);
  }

  // 官方原版 $i 算法：计算两步之间的 DNA 条带增量 (新增 up 与 消除 down)
  function getDnaDelta(curBands, prevBands) {
    const prevMap = new Map((prevBands || []).map(b => [b.key, b.tokens]));
    const curMap = new Map((curBands || []).map(b => [b.key, b.tokens]));
    const up = [];
    const down = [];

    for (const b of (curBands || [])) {
      const diff = b.tokens - (prevMap.get(b.key) || 0);
      if (diff > 0) {
        up.push({ ...b, tokens: diff, off: 0, deltaType: "up" });
      }
    }
    for (const b of (prevBands || [])) {
      const diff = (curMap.get(b.key) || 0) - b.tokens;
      if (diff < 0) {
        down.push({ ...b, tokens: Math.abs(diff), off: 0, deltaType: "down" });
      }
    }

    let dOff = 0;
    for (const b of down) { b.off = dOff; dOff += b.tokens; }
    let uOff = 0;
    for (const b of up) { b.off = uOff; uOff += b.tokens; }

    return { up, down, upTotal: uOff, downTotal: dOff };
  }

  // 官方原版 $m 渐变生成器：底部为消除条带 (down)，上部为新增条带 (up)
  function buildDnaDeltaGradient(d, r) {
    if (r <= 0) return "#38bdf8";
    const stops = [];
    let cur = 0;

    for (const b of (d.down || [])) {
      if (b.tokens <= 0) continue;
      const p1 = Math.max(0, (cur / r) * 100).toFixed(1);
      const p2 = Math.min(100, ((cur + b.tokens) / r) * 100).toFixed(1);
      stops.push(`${b.color} ${p1}%, ${b.color} ${p2}%`);
      cur += b.tokens;
    }

    for (const b of (d.up || [])) {
      if (b.tokens <= 0) continue;
      const p1 = Math.max(0, (cur / r) * 100).toFixed(1);
      const p2 = Math.min(100, ((cur + b.tokens) / r) * 100).toFixed(1);
      stops.push(`${b.color} ${p1}%, ${b.color} ${p2}%`);
      cur += b.tokens;
    }

    return stops.length > 0 ? `linear-gradient(to top, ${stops.join(", ")})` : "#38bdf8";
  }

  // 精确定位到具体某条消息/工具条目 (对标原版 onPickBand 与 nodeFocus)
  function locateBrowserItem(s, stepIdx, turnIdx, band) {
    if (!band) return;

    activeStepIdx = stepIdx;
    activeTurnIdx = turnIdx;

    renderTrendBarsAndChart(s);
    renderStepBrief(s);
    renderContextBrowser(s);

    setTimeout(() => {
      const itemKey = band.key;

      // 1. 如果在 7 大分类手风琴模式下，自动展开目标分类
      if (!isDnaMode && elBrowserAccordionTree) {
        const catNode = elBrowserAccordionTree.querySelector(`.cat-node[data-cat="${band.cat}"]`);
        if (catNode && !catNode.classList.contains("open")) {
          catNode.classList.add("open");
          catNode.setAttribute("data-open", "true");
          openedAccordionKeys.add(band.cat);
        }
      }

      // 2. 查找目标 DOM 元素 (按 data-item-key 精准匹配)
      const targetEl = document.querySelector(`[data-item-key="${itemKey}"]`)
        || document.querySelector(`[data-item-key*="${itemKey}"]`)
        || document.querySelector(`[data-cat="${band.cat}"] .cat-item-row`);

      if (targetEl) {
        // 平滑滚动居中
        targetEl.scrollIntoView({ behavior: "smooth", block: "center" });

        // 展开该条目详情
        targetEl.classList.add("expanded");
        const btnToggle = targetEl.querySelector(".btn-item-toggle");
        if (btnToggle) btnToggle.textContent = "收起 ▴";

        // 高亮流光聚焦动效 (持续 2.5 秒)
        document.querySelectorAll(".band-highlight").forEach(el => el.classList.remove("band-highlight"));
        targetEl.classList.add("band-highlight");
        setTimeout(() => targetEl.classList.remove("band-highlight"), 2500);

        showToast(`已定位: ${band.title}`);
      } else {
        showToast(`已选中: 步骤 #${stepIdx} · ${band.title}`);
      }
    }, 60);
  }

  // ==========================================================================
  // 6. 第三行左下：上下文趋势 (官方 dsh-context lc-chartrow / lc-bar / lc-turn / lc-duration)
  //   .lc-chart 内部: 5 条 .lc-grid + 每项一个 .lc-bar(14px, flex 子元素) + .lc-duration SVG
  // ==========================================================================
  const DSH_CATEGORIES = [
    { key: "system", name: "系统提示词", color: "#6366f1" },
    { key: "tools", name: "工具定义", color: "#f59e0b" },
    { key: "user", name: "用户消息", color: "#22c55e" },
    { key: "inject", name: "注入内容", color: "#a855f7" },
    { key: "skill", name: "技能注入", color: "#f97316" },
    { key: "assistant", name: "助手消息", color: "#3b82f6" },
    { key: "tool", name: "工具结果", color: "#14b8a6" }
  ];

  // 官方 trendChart.css 几何常量
  const LC_BAR_W = 14;          // .lc-bar width
  const LC_BAR_GAP = 2;         // .lc-chart gap
  const LC_UNIT_W = 16;         // 单元步进 = 柱宽 + 间隙
  const LC_PLOT_H = 112;        // .lc-chart 130 - padding-top 18
  const LC_BAR_CENTER = 7;      // 柱心 x 偏移 (官方 x = idx*16+7)
  const LC_TURN_BG = [
    "color-mix(in srgb, var(--color-neutral-500) 12%, transparent)",
    "color-mix(in srgb, var(--color-neutral-500) 26%, transparent)"
  ];

  function lcCatValue(it, key) {
    if (!it) return 0;
    if (it[key] !== undefined && it[key] !== null) return Number(it[key]) || 0;
    if (it.breakdown && it.breakdown[key] !== undefined && it.breakdown[key] !== null) return Number(it.breakdown[key]) || 0;
    if (Array.isArray(it.browserCategories)) {
      const hit = it.browserCategories.find(function (c) { return c.key === key; });
      if (hit) return Number(hit.tokens) || 0;
    }
    return 0;
  }

  // 官方 Ba(e,t) 差量: 与上一项比较, 正为增长(up) 负为减少(down)
  function lcComputeDeltas(items) {
    items.forEach(function (it, idx) {
      const prev = idx > 0 ? items[idx - 1] : null;
      const deltas = {};
      let up = 0, down = 0, net = 0;
      DSH_CATEGORIES.forEach(function (c) {
        const cur = lcCatValue(it, c.key);
        const before = prev ? lcCatValue(prev, c.key) : cur;
        const diff = prev ? (cur - before) : 0;
        deltas[c.key] = diff;
        if (diff > 0) up += diff;
        else if (diff < 0) down += Math.abs(diff);
        net += diff;
      });
      it._deltas = deltas;
      it._upTokens = up;
      it._downTokens = down;
      it._netTokens = net;
    });
  }

  function lcVisibleRange(scrollEl, count) {
    const last = Math.max(0, count - 1);
    if (!scrollEl || count <= 0) return { from: 0, to: last };
    const left = scrollEl.scrollLeft || 0;
    const width = scrollEl.clientWidth || 0;
    if (!(width > 0)) return { from: 0, to: last };
    // 切换粒度后旧 scrollLeft 会远超新条目数 → 双向钳制, 避免越界
    const from = Math.min(last, Math.max(0, Math.floor(left / LC_UNIT_W)));
    const to = Math.min(last, Math.ceil((left + width) / LC_UNIT_W));
    return { from: from, to: Math.max(from, to) };
  }

  function lcAxisText(value) {
    return formatK(Math.round(Number(value) || 0)).replace("≈", "");
  }

  function lcSetText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  // 官方左轴/右轴: 5 个 .lc-axis-* span (top / q3 / mid / q1 / bot)
  function lcUpdateAxes(isDelta, maxTotal, maxUp, maxDur) {
    if (isDelta) {
      lcSetText("axisTokTop", "+" + lcAxisText(maxUp));
      lcSetText("axisTokQ3", "+" + lcAxisText(maxUp * 0.75));
      lcSetText("axisTokMid", "+" + lcAxisText(maxUp * 0.5));
      lcSetText("axisTokQ1", "+" + lcAxisText(maxUp * 0.25));
    } else {
      lcSetText("axisTokTop", lcAxisText(maxTotal));
      lcSetText("axisTokQ3", lcAxisText(maxTotal * 0.75));
      lcSetText("axisTokMid", lcAxisText(maxTotal * 0.5));
      lcSetText("axisTokQ1", lcAxisText(maxTotal * 0.25));
    }
    lcSetText("axisTokBot", "0");

    const elRight = $("trendAxisRight");
    if (elRight) elRight.style.display = showDurationCurve ? "" : "none";
    if (showDurationCurve) {
      lcSetText("axisDurTop", formatDuration(maxDur));
      lcSetText("axisDurQ3", formatDuration(maxDur * 0.75));
      lcSetText("axisDurMid", formatDuration(maxDur * 0.5));
      lcSetText("axisDurQ1", formatDuration(maxDur * 0.25));
      lcSetText("axisDurBot", "0");
    }
  }

  function lcEnsureScrollBinding(elChartScroll) {
    if (!elChartScroll || elChartScroll.dataset.lcScrollBound === "1") return;
    elChartScroll.dataset.lcScrollBound = "1";
    elChartScroll.addEventListener("scroll", function () {
      if (!isOverview) lcScrollMemo = elChartScroll.scrollLeft;   // 记住手动滚动位置, 供模式切换还原
      if (!isAdaptive || isOverview) return;
      if (elChartScroll._lcRaf) return;
      const raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
      elChartScroll._lcRaf = raf(function () {
        elChartScroll._lcRaf = null;
        const sess = getSessionDetailOrIndex(activeModalSessionId);
        if (sess) renderTrendBarsAndChart(sess);
        else lcPositionTurnLabels();
      });
    });
  }

  let lcPinnedRight = false;
  let lcPinnedKey = "";
  // 图表选中/滚动记忆 (跨「总览 ↔ 滚动」「DNA 开/关」切换保持位置与高亮):
  // 重建柱子时浏览器会把 scrollLeft 夹回 0, 必须显式还原 —— 否则从总览/DNA 切回来会停在会话开头,
  // 前几十步 totalTokens 还很小, DNA 柱看着就「几乎全平」、x 轴步标退化成 5/10/15…。
  let lcScrollMemo = null;          // 上一次「滚动模式」下的 scrollLeft (跨模式切换记忆)
  let lcMemoSessionId = null;       // 上述记忆所属会话 (换会话即失效)
  let lcLastRenderMode = "";        // 上一次渲染的模式: ""(首次) / "scroll" / "overview"
  let lcSelectedBucketIdx = null;   // 总览: 选中桶在 barUnits 中的下标 (null = 未选)
  let lcSelectedBucketText = "";    // 总览: 选中桶的区间标签 (「步骤 a–b」)
  let lcHoverBandKey = null;        // DNA: 当前悬停条带的 key (stepIdx|cat|itemKey), 用于避免重复重绘

  // 官方 be(): 轮次标签在可视区内定位 (宽 chip 中把标签平移到可见位置, 重叠则隐藏)
  function lcPositionTurnLabels() {
    const strip = $("trendTurnsStrip");
    const scrollEl = $("trendChartScroll");
    if (!strip || !scrollEl) return;
    const turnEls = strip.querySelectorAll(".lc-turn");
    const viewLeft = scrollEl.scrollLeft || 0;
    const viewRight = viewLeft + (scrollEl.clientWidth || 0);
    let lastRight = -Infinity;
    Array.prototype.forEach.call(turnEls, function (turnEl) {
      const label = turnEl.querySelector(".lc-turn-label");
      if (!label) return;
      const left = turnEl.offsetLeft;
      const width = turnEl.offsetWidth;
      const labelW = label.offsetWidth;
      let transform = "";
      let visibility = "";
      if (left + width + 48 > viewLeft && left - 48 < viewRight) {
        const visLeft = Math.max(left, viewLeft);
        const visRight = Math.min(left + width, viewRight);
        if (visRight > visLeft && labelW < width) {
          const centerInChip = (visLeft + visRight) / 2 - left;
          const shift = Math.min(Math.max(centerInChip, labelW / 2), width - labelW / 2) - width / 2;
          const absLeft = left + width / 2 + shift - labelW / 2;
          if (absLeft < lastRight) visibility = "hidden";
          lastRight = absLeft + labelW + 2;
          transform = "translateX(" + Math.round(shift) + "px)";
        }
      }
      if (label.style.transform !== transform) label.style.transform = transform;
      if (label.style.visibility !== visibility) label.style.visibility = visibility;
    });
  }

  // 官方「避让」策略: 相邻标签最小间距 LC_TURN_LABEL_GAP (18px), 冲突则跳过中间标签,
  // 但首尾轮次必须显示 —— 保证「轮次条起点/终点」永远可读, 中间只做稀疏化。
  function lcAvoidLabelOverlap(xs, widths, minGap) {
    const n = Math.min(xs.length, widths.length);
    const keep = new Array(xs.length);
    for (let i = 0; i < xs.length; i += 1) keep[i] = false;
    if (n === 0) return keep;
    if (n === 1) { keep[0] = true; return keep; }
    keep[0] = true;
    keep[n - 1] = true;
    let lastRight = xs[0] + widths[0];
    for (let i = 1; i < n - 1; i += 1) {
      if (xs[i] < lastRight + minGap) continue;                 // 与前一个已显示标签冲突 → 跳过
      if (xs[i] + widths[i] + minGap > xs[n - 1]) continue;      // 与「必须显示」的末标签冲突 → 跳过
      keep[i] = true;
      lastRight = xs[i] + widths[i];
    }
    return keep;
  }

  // 真实条目序列 → 轮次 run [{turnIdx, firstItem, firstBucket, count, item}]
  // (itemBucket[i] = 第 i 个条目落在哪个桶; 缺失记 -1, 调用方必须当「不可渲染」处理)
  function lcTurnRunsFromItems(items, itemBucket) {
    const runs = [];
    if (!items || !items.length) return runs;
    for (let i = 0; i < items.length; i += 1) {
      const t = (items[i] && items[i].turnIdx) ? items[i].turnIdx : 1;
      const b = (itemBucket && itemBucket[i] !== undefined && itemBucket[i] !== null) ? Number(itemBucket[i]) : -1;
      const last = runs[runs.length - 1];
      if (!last || last.turnIdx !== t) {
        runs.push({ turnIdx: t, firstItem: i, firstBucket: b, count: 0, item: items[i] });
      }
      runs[runs.length - 1].count += 1;
    }
    return runs;
  }

  // ===== 图表区: DNA 逐条交错条带 + 总览像素桶聚合 =====
  // DNA 条带: 直接由 browserCategories[].items[] 现场构造, 阅读顺序 = 逐项交错:
  // 把每个类目 (分类顺序 system → tools → user → inject → skill → assistant → tool) 的 items
  // 序列按「该类目内第 n 条」分轮合并 (同轮内按分类顺序), 即模型逐项读取的先后顺序 ——
  // 这样 system/tools 只有 1 条时会落在第 1 轮, 而 user/inject/assistant/tool 会逐轮交错出现;
  // 相邻同类条目合并成一条 (保留交错感又控制 DOM), 单柱上限 LC_DNA_MAX_BANDS 条,
  // 超限时把最小的若干条合并成一条「其他」(总量不丢)。
  const LC_DNA_MAX_BANDS = 28;         // 单柱条带上限
  const LC_DNA_MAX_STEPS = 400;        // 步数 > 400 时只给最后 400 步渲染逐条条带 (其余降级为分类带)
  const LC_DNA_OVERVIEW_BANDS = 12;    // 总览聚合桶内的条带上限 (桶多, 压 DOM 规模)
  const LC_DNA_NEUTRAL = "#94a3b8";    // 「其他 / 未细分」中性色

  function lcDnaItemBands(it, maxBands) {
    const cats = it && Array.isArray(it.browserCategories) ? it.browserCategories : null;
    if (!cats || cats.length === 0) return null;
    const limit = Math.max(2, Number(maxBands) || LC_DNA_MAX_BANDS);
    const orderIdx = {};
    const meta = {};
    DSH_CATEGORIES.forEach(function (c, i) { orderIdx[c.key] = i; meta[c.key] = c; });

    // 1. 逐项交错展开 (按类目内序号分轮, 同轮内按分类顺序)
    const ordered = cats.slice().sort(function (a, b) {
      const ai = orderIdx[a.key] === undefined ? 99 : orderIdx[a.key];
      const bi = orderIdx[b.key] === undefined ? 99 : orderIdx[b.key];
      return ai - bi;
    });
    const streams = ordered.map(function (cat) {
      return {
        cat: cat,
        meta: meta[cat.key] || { key: cat.key, name: cat.name || cat.label || cat.key, color: LC_DNA_NEUTRAL },
        items: Array.isArray(cat.items) ? cat.items : []
      };
    });
    const maxLen = streams.reduce(function (a, st) { return Math.max(a, st.items.length); }, 0);
    const flat = [];
    for (let round = 0; round < maxLen; round += 1) {
      streams.forEach(function (st) {
        const item = st.items[round];
        if (!item) return;
        const tokens = Math.max(0, Number(item.tokens) || 0);
        if (tokens <= 0) return;
        const itemId = (item.id === undefined || item.id === null)
          ? (st.cat.key + ":" + (item.idx === undefined || item.idx === null ? flat.length : item.idx))
          : String(item.id);
        flat.push({
          cat: st.cat.key,
          key: itemId,
          title: String(item.title || item.toolName || st.meta.name || st.cat.key),
          color: st.meta.color,
          tokens: tokens,
          count: 1
        });
      });
    }
    if (flat.length === 0) return null;

    // 2. 相邻同类合并 (交错感保留, 同时压 DOM)
    const merged = [];
    flat.forEach(function (b) {
      const last = merged[merged.length - 1];
      if (last && last.cat === b.cat) { last.tokens += b.tokens; last.count += 1; return; }
      merged.push({ cat: b.cat, key: b.key, title: b.title, color: b.color, tokens: b.tokens, count: 1 });
    });

    // 3. 上限: 最小的若干条并入「其他」放在最早出现的位置, 总量不丢
    let bands = merged;
    if (bands.length > limit) {
      const keep = limit - 1;
      const byTokens = bands.map(function (b, i) { return i; }).sort(function (a, b) { return bands[a].tokens - bands[b].tokens; });
      const drop = {};
      byTokens.slice(0, bands.length - keep).forEach(function (i) { drop[i] = true; });
      const out = [];
      let other = null;
      bands.forEach(function (b, i) {
        if (!drop[i]) { out.push(b); return; }
        if (!other) {
          other = { cat: "other", key: "other", title: "其他条目", color: LC_DNA_NEUTRAL, tokens: 0, count: 0 };
          out.push(other);
        }
        other.tokens += b.tokens;
        other.count += b.count;
      });
      bands = out;
    }

    // 4. 从下往上累计偏移 (bands[0] 在最底部)
    let off = 0;
    bands.forEach(function (b) { b.off = off; off += b.tokens; });
    const stepTokens = Math.max(0, Number(it.totalTokens) || 0);
    return { bands: bands, total: off, stepTokens: stepTokens };
  }

  // 条带像素: 柱高 = totalTokens / maxTotal * LC_PLOT_H (与其它柱共尺度, 跨柱可比);
  // 柱内各条带按 tokens 占比铺满柱高 (等价于旧版 getDnaGradientFromBands 的「拉伸铺满」语义:
  // browserCategories[].items[] 只覆盖该步的一部分 tokens, 不拉伸会让 DNA 柱明显变矮而误导总量)。
  function lcDnaBandPixels(data, maxTotal) {
    const denom = Math.max(1, Number(maxTotal) || 0);
    const barH = Math.max(1, Math.round((Number(data.stepTokens) || 0) / denom * LC_PLOT_H));
    const denomTok = Math.max(1, Number(data.total) || 0);
    const raw = [];
    let accTok = 0;
    let accPx = 0;
    data.bands.forEach(function (b, i) {
      accTok += Math.max(0, b.tokens);
      const isLast = (i === data.bands.length - 1);
      const to = isLast ? barH : Math.round(accTok / denomTok * barH);
      const px = Math.max(1, to - accPx);
      raw.push({ band: b, from: accPx, to: accPx + px, px: px });
      accPx += px;
    });
    return { list: raw, total: accPx, barH: barH };
  }

  // ===== 总览: 按像素桶聚合 =====
  // 桶数 = max(60, floor(可用宽 / 4)); 每桶一根柱 (宽 = 桶宽 - 1px);
  // 高度取桶内峰值步的 totalTokens (堆叠按该步分类比例);
  // 耗时曲线取桶内最大值 (均值会抹掉卡顿尖峰, 故取 max, 见 lcOverviewBuckets 的 durationSec)。
  const LC_OVERVIEW_MIN_BUCKETS = 60;
  const LC_OVERVIEW_MAX_BUCKETS = 240;
  const LC_OVERVIEW_BUCKET_PX = 4;
  const LC_OVERVIEW_BAR_GAP = 2;      // .lc-chart 的 gap (CSS/inline 提供), 与柱宽相加 = 桶距
  const LC_TURN_LABEL_GAP = 18;       // 轮次标签最小间距 (官方「避让」阈值)

  function lcOverviewBuckets(items, availW) {
    const width = Math.max(1, Math.floor(Number(availW) || 0));
    // 桶数只由容器可见宽决定: max(60, min(240, floor(W/4))) —— 不再被条目数压成 1px,
    // 也不因条目多而溢出容器 (总览的核心约束: 桶数×桶距 == 容器宽)。
    const want = Math.max(
      LC_OVERVIEW_MIN_BUCKETS,
      Math.min(LC_OVERVIEW_MAX_BUCKETS, Math.floor(width / LC_OVERVIEW_BUCKET_PX))
    );
    // 桶数上限再加一层: 不超过真实条目数 (轮次粒度只有 12 轮时, 没必要硬造 139 个重复桶)
    const count = Math.max(1, Math.min(want, Math.max(1, items.length)));
    const bucketPx = width / count;                                        // 桶距 (整格, 含 gap)
    const barW = Math.max(2, Math.floor(bucketPx) - LC_OVERVIEW_BAR_GAP);  // 柱宽; 2px gap 由 CSS 提供
    const contentW = Math.round(count * bucketPx * 100) / 100;             // .lc-chart 精确宽度 (= W)
    // 柱左缘步进: 余量由 space-between 均摊到 count-1 个间隙, 保证首尾柱贴住容器两侧
    const stepPx = count > 1 ? (contentW - barW) / (count - 1) : contentW;
    const xAtBucket = function (b) {
      const i = Math.max(0, Math.min(count - 1, Math.round(Number(b) || 0)));
      return count > 1 ? i * stepPx : 0;
    };
    const bars = [];
    for (let b = 0; b < count; b += 1) {
      const from = Math.floor(b * items.length / count);
      const to = Math.max(from, Math.floor((b + 1) * items.length / count) - 1);
      let peak = null;
      let peakTokens = -1;
      let sum = 0;
      let n = 0;
      let maxDur = 0;
      let upMax = 0;
      let compactions = 0;
      for (let i = from; i <= to; i += 1) {
        const it = items[i];
        if (!it) continue;
        const tok = Number(it.totalTokens) || 0;
        n += 1;
        sum += tok;
        if (tok > peakTokens) { peakTokens = tok; peak = it; }
        const dur = Number(it.durationSec);
        if (dur > maxDur) maxDur = dur;
        const up = Number(it._upTokens) || 0;
        if (up > upMax) upMax = up;
        if (it.compaction || it.compactionCount) compactions += 1;
      }
      if (!peak) continue;
      // 把「桶」伪装成一步, 复用既有柱/堆叠/tooltip/点选代码; 高度与配色取桶内峰值步
      bars.push({
        stepIdx: peak.stepIdx,
        turnIdx: peak.turnIdx,
        totalTokens: Math.max(0, peakTokens),
        durationSec: maxDur,
        outputTokens: peak.outputTokens,
        timestamp: peak.timestamp,
        breakdown: peak.breakdown,
        browserCategories: peak.browserCategories,
        compactionCount: compactions || peak.compactionCount,
        _upTokens: upMax,
        _deltas: peak._deltas,
        _bucket: {
          fromIdx: from,
          toIdx: to,
          count: n,
          peakTokens: Math.max(0, peakTokens),
          avgTokens: n ? sum / n : 0,
          firstStepIdx: (items[from] && items[from].stepIdx !== undefined) ? items[from].stepIdx : peak.stepIdx,
          lastStepIdx: (items[to] && items[to].stepIdx !== undefined) ? items[to].stepIdx : peak.stepIdx
        }
      });
    }
    return {
      bars: bars,
      count: count,          // 桶数 (柱数)
      bucketPx: bucketPx,    // 桶距 = width / count
      barW: barW,            // 柱宽 = max(2, floor(bucketPx) - 2)
      gap: LC_OVERVIEW_BAR_GAP,
      width: width,          // 可见宽 W
      contentW: contentW,    // .lc-chart 精确宽度 = count * bucketPx
      stepPx: stepPx,        // 柱左缘步进
      pitch: stepPx,         // 兼容旧调用方
      xAtBucket: xAtBucket,  // 桶索引 → 柱左缘 x
      xAtCenter: function (b) { return xAtBucket(b) + barW / 2; } // 桶索引 → 柱心 x (耗时折线)
    };
  }

  // 条带点选: 模块级变量 + 自定义事件 (浏览器卡片侧监听 lc-pick-item 定位条目; 本文件不改浏览器函数)
  let lcPickedItem = null;
  function lcPickDnaBand(stepIdx, turnIdx, band) {
    lcPickedItem = {
      stepIdx: stepIdx,
      turnIdx: turnIdx,
      catKey: band ? band.cat : null,
      itemKey: band ? band.key : null,
      title: band ? band.title : null,
      tokens: band ? band.tokens : 0,
      at: Date.now()
    };
    try { if (typeof window !== "undefined") window.__lcPickedItem = lcPickedItem; } catch (err) { /* 非浏览器环境 */ }
    try {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("lc-pick-item", {
          detail: { stepIdx: stepIdx, turnIdx: turnIdx, catKey: lcPickedItem.catKey, itemKey: lcPickedItem.itemKey }
        }));
      }
    } catch (err) { /* 无 CustomEvent 环境: 仅保留模块级变量 */ }
    return lcPickedItem;
  }

  // ===== 图表选中标记: 总览「竖直选择线」 / DNA「条带横线」 =====
  // 标记统一用 .lc-pick-overlay 作为绝对定位浮层追加进 #trendChart (随图表一起横向滚动),
  // 每次重绘时由 lcClearSelectionOverlays 统一清理, 不会残留。
  function lcClearSelectionOverlays(elChart) {
    if (!elChart || !elChart.querySelectorAll) return;
    Array.prototype.forEach.call(elChart.querySelectorAll(".lc-pick-overlay"), function (n) {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  }

  // 总览: 选中桶 → 2px 竖直高亮线 (图表顶部到底部) + 顶部「步骤 a–b」区间标签
  function lcPaintBucketGuide(elChart, bucketIdx, text) {
    if (!elChart || bucketIdx === null || bucketIdx === undefined) return false;
    const bars = elChart.querySelectorAll(".lc-bar");
    if (!bars.length) return false;
    const bar = bars[Math.max(0, Math.min(bars.length - 1, Number(bucketIdx) || 0))];
    if (!bar) return false;
    const cx = bar.offsetLeft + bar.offsetWidth / 2;
    const chartW = elChart.clientWidth || elChart.offsetWidth || 0;
    const line = document.createElement("div");
    line.className = "lc-pick-overlay lc-bucket-guide";
    line.dataset.bucketIdx = String(bucketIdx);
    line.style.cssText = "position:absolute;top:18px;bottom:0;left:" + (Math.round(cx * 100) / 100 - 1) + "px;"
      + "width:2px;border-radius:1px;z-index:6;pointer-events:none;"
      + "background:color-mix(in srgb, var(--dsw-alias-label-primary, #e5e7eb) 60%, transparent)";
    elChart.appendChild(line);

    const lbl = document.createElement("span");
    lbl.className = "lc-pick-overlay lc-bucket-guide-label";
    lbl.textContent = String(text || "");
    lbl.style.cssText = "position:absolute;top:0;left:0;z-index:6;pointer-events:none;font-weight:600;"
      + "font-size:9px;line-height:1;padding:2px 5px;border-radius:3px;white-space:nowrap;"
      + "background:var(--dsw-alias-bg-layer-1, rgba(17,24,39,.88));color:var(--dsw-alias-label-primary, #e5e7eb);"
      + "border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #e5e7eb) 45%, transparent)";
    elChart.appendChild(lbl);
    const lw = lbl.offsetWidth || 0;
    const left = Math.max(2, Math.min(cx - lw / 2, Math.max(2, chartW - lw - 2)));
    lbl.style.left = Math.round(left) + "px";
    lbl.dataset.centerX = String(Math.round(cx * 100) / 100);
    return true;
  }

  // DNA: 选中柱内被点选的条带 → 该条带上下边界各一条 2px 横线 + 左侧「条带名 ≈tokens」
  // 未选中条带 (lcPickedItem 为空或不属于该柱) 时什么都不画。
  function lcPaintBandPick(elChart, pick) {
    if (!elChart || !pick) return false;
    const step = String(Number(pick.stepIdx) || 0);
    const bars = elChart.querySelectorAll(".lc-bar");
    let bar = null;
    for (let i = 0; i < bars.length; i += 1) {
      if (bars[i].dataset && bars[i].dataset.seq === step) { bar = bars[i]; break; }
    }
    if (!bar) return false;
    const dnaEl = bar.querySelector(".lc-bar-dna");
    if (!dnaEl) return false;
    const bandEls = Array.prototype.filter.call(dnaEl.children, function (el) {
      return el && el.dataset && el.dataset.itemKey !== undefined;
    });
    if (!bandEls.length) return false;
    let band = null;
    for (let i = 0; i < bandEls.length; i += 1) {
      if (String(bandEls[i].dataset.itemKey) === String(pick.itemKey)
        && String(bandEls[i].dataset.cat) === String(pick.catKey)) { band = bandEls[i]; break; }
    }
    if (!band) return false;

    const cr = elChart.getBoundingClientRect();
    const br = band.getBoundingClientRect();
    const top = Math.round((br.top - cr.top) * 100) / 100;
    const bottom = Math.round((top + br.height) * 100) / 100;
    const x0 = Math.max(0, Math.round(bar.offsetLeft - 6));
    const w = Math.round(bar.offsetWidth + 12);
    [[top, "top"], [bottom, "bottom"]].forEach(function (pair) {
      const line = document.createElement("div");
      line.className = "lc-pick-overlay lc-band-pick-line";
      line.dataset.edge = pair[1];
      line.style.cssText = "position:absolute;left:" + x0 + "px;width:" + w + "px;height:2px;"
        + "top:" + (pair[0] - 1) + "px;border-radius:1px;z-index:7;pointer-events:none;"
        + "background:color-mix(in srgb, var(--dsw-alias-brand-primary, #4f8cff) 92%, transparent)";
      elChart.appendChild(line);
    });

    const lbl = document.createElement("span");
    lbl.className = "lc-pick-overlay lc-band-pick-label";
    lbl.textContent = String(pick.title || pick.catKey || "条带") + " ≈" + lcAxisText(pick.tokens || 0);
    lbl.style.cssText = "position:absolute;left:0;z-index:7;pointer-events:none;transform:translate(0,-50%);"
      + "font-size:9px;line-height:1;padding:2px 4px;border-radius:3px;white-space:nowrap;"
      + "background:var(--dsw-alias-bg-layer-1, rgba(17,24,39,.9));color:var(--dsw-alias-label-primary, #e5e7eb);"
      + "border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f8cff) 55%, transparent)";
    lbl.style.top = (Math.round((top + bottom) / 2 * 100) / 100) + "px";
    elChart.appendChild(lbl);
    const lw = lbl.offsetWidth || 0;
    let lx = x0 - lw - 4;                                            // 默认放在柱子左侧
    if (lx < 2) lx = Math.max(2, x0 + w + 4);                        // 左侧空间不够 → 翻到右侧
    lbl.style.left = Math.round(Math.max(2, lx)) + "px";
    return true;
  }

  // 统一入口: 先清旧标记, 再按当前模式画 (总览竖线 / DNA 横线)
  function lcPaintChartSelection(ctx) {
    const elChart = ctx && ctx.elChart;
    if (!elChart) return;
    lcHoverBandKey = null;                      // 重新渲染后悬停态失效
    lcClearSelectionOverlays(elChart);
    if (ctx.isOverview && lcSelectedBucketIdx !== null) {
      lcPaintBucketGuide(elChart, lcSelectedBucketIdx, lcSelectedBucketText);
    }
    if (ctx.isDnaMode && !ctx.isDelta && lcPickedItem && lcPickedItem.stepIdx !== undefined) {
      lcPaintBandPick(elChart, lcPickedItem);
    }
  }

  function renderTrendBarsAndChart(s) {
    const isStepGran = (trendGranularity === "step");
    const dc = s.dshContext || {};
    const items = (isStepGran ? (dc.steps || []) : (dc.turns || []));
    const elChart = $("trendChart");
    const elChartScroll = $("trendChartScroll");
    const elDurationSvg = $("trendDurationSvg");
    const elChartTip = $("trendChartTip");
    if (!elChart || !elChartScroll) return;

    // 0. 清理上一版柱子 (保留 5 条 .lc-grid 与 .lc-duration)
    Array.from(elChart.children).forEach(function (node) {
      if (node.classList && node.classList.contains("lc-grid")) return;
      if (node.id === "trendDurationSvg") return;
      node.remove();
    });
    if (elChartTip) { elChartTip.style.display = "none"; elChartTip.innerHTML = ""; }
    if (items.length === 0) {
      if (elDurationSvg) { elDurationSvg.innerHTML = ""; elDurationSvg.style.display = "none"; }
      const turnsEmpty = $("trendTurnsStrip");
      if (turnsEmpty) turnsEmpty.innerHTML = "";
      return;
    }

    lcEnsureScrollBinding(elChartScroll);

    // 0.5 记住本次渲染前的滚动位置与模式 (必须在下面「总览几何」把 scrollLeft 归零之前读取):
    //     柱子重建会把 scrollLeft 夹到 0, 不还原就会跳回会话开头。
    const prevRenderMode = lcLastRenderMode;                     // ""(首次) / "scroll" / "overview"
    const prevScrollLeft = elChartScroll.scrollLeft || 0;
    if (!isOverview && prevRenderMode !== "overview") lcScrollMemo = prevScrollLeft;
    if (lcMemoSessionId !== activeModalSessionId) {
      lcMemoSessionId = activeModalSessionId;                    // 换会话: 旧的滚动位置/桶选中一律失效
      lcScrollMemo = null;
      lcSelectedBucketIdx = null;
      lcSelectedBucketText = "";
    }

    // 1. 差量 (增量模式 / DNA 增量都要用)
    lcComputeDeltas(items);

    // 1.1 总览: 按像素桶聚合 (桶数 = max(60, floor(可用宽/4)), 每桶一根柱), 不再被 flex 压成 1px;
    //     桶数跟随容器宽度, 窗口缩放由既有 ResizeObserver(rAF 合并 + 尺寸去重) 触发重算
    let overviewAgg = null;
    let overviewGeom = null;
    if (isOverview) {
      // 可见宽 W: 外层 wrap 宽度 (不受横向滚动条出现/消失影响), 保证桶数首帧就稳定, 不会因滚动条抖动而反复重算。
      // 总览下 .lc-chart 左右 padding 归零 (见下方几何设置), 所以这里不再扣留白 ——
      // 柱子总宽 + 间隙必须恰好吃满这 W 像素, 一格不多一格不少。
      const wrapEl = $("trendChartWrap");
      const availW = Math.max(1, (wrapEl && wrapEl.clientWidth) || elChartScroll.clientWidth || 0);
      overviewAgg = lcOverviewBuckets(items, availW);

      // 真实条目索引 → 桶索引: 轮次条与轮次标线都用它换算出左偏移, 保证与柱子逐像素对齐
      const itemCount = items.length;
      const itemBucket = new Array(itemCount);
      for (let i = 0; i < itemCount; i += 1) itemBucket[i] = -1;
      for (let b = 0; b < overviewAgg.bars.length; b += 1) {
        const bk = overviewAgg.bars[b] && overviewAgg.bars[b]._bucket;
        if (!bk) continue;
        for (let i = Math.max(0, bk.fromIdx); i <= bk.toIdx && i < itemCount; i += 1) {
          if (itemBucket[i] < 0) itemBucket[i] = b;
        }
      }
      for (let i = 0; i < itemCount; i += 1) if (itemBucket[i] < 0) itemBucket[i] = 0;

      // 真实轮次 run: (起始条目 → 起始桶) 供轮次标签 / .lc-turn-marker 定位
      const turnRuns = [];
      for (let i = 0; i < itemCount; i += 1) {
        const t = (items[i] && items[i].turnIdx) ? items[i].turnIdx : 1;
        const last = turnRuns[turnRuns.length - 1];
        if (!last || last.turnIdx !== t) {
          turnRuns.push({ turnIdx: t, firstItem: i, firstBucket: itemBucket[i], count: 0, item: items[i] });
        }
        turnRuns[turnRuns.length - 1].count += 1;
      }
      overviewGeom = overviewAgg;
      overviewGeom.itemBucket = itemBucket;
      overviewGeom.turnRuns = turnRuns;
      overviewGeom.stepCount = itemCount;
    }
    const barUnits = overviewAgg ? overviewAgg.bars : items;

    const isDelta = (trendMode === "delta");
    const maxUp = Math.max(1, barUnits.reduce(function (acc, it) { return Math.max(acc, it._upTokens || 0); }, 0));
    const maxDur = Math.max(1, barUnits.reduce(function (acc, it) { return Math.max(acc, it.durationSec || 0); }, 0));

    // 2. 尺度: 自适应 = 可见窗口极值 (滚动即重算), 否则全量极值
    const range = (isAdaptive && !isOverview) ? lcVisibleRange(elChartScroll, items.length) : { from: 0, to: barUnits.length - 1 };
    let maxTotal = 1;
    for (let i = range.from; i <= range.to; i++) {
      if (!barUnits[i]) continue;
      const total = Number(barUnits[i].totalTokens) || 0;
      if (total > maxTotal) maxTotal = total;
    }
    const deltaScale = LC_PLOT_H / Math.max(1, maxUp);

    // 3. 双轴刻度
    lcUpdateAxes(isDelta, maxTotal, maxUp, maxDur);

    // 4. 总览 / 滚动 两种轨道几何
    if (isOverview) {
      elChartScroll.classList.add("lc-chart-fit");
      // 几何铁律: .lc-chart 宽度 = bucketCount * bucketPx (= 可见宽 W), gap = 2px (由 CSS 提供),
      // 柱宽 = max(2, floor(bucketPx) - 2) → 柱总宽 + 间隙 == 容器宽, 既不溢出也不留空。
      // 余量 (< gap*1) 由 space-between 均摊到各间隙, 保证首柱贴左、末柱贴右。
      elChart.style.boxSizing = "border-box";
      elChart.style.width = overviewGeom && overviewGeom.contentW > 0
        ? (overviewGeom.contentW + "px")
        : "100%";
      elChart.style.minWidth = "0";
      elChart.style.maxWidth = "none";
      elChart.style.padding = "18px 0 0";
      elChart.style.gap = LC_OVERVIEW_BAR_GAP + "px";
      elChart.style.justifyContent = "space-between";
      elChartScroll.style.overflowX = "hidden";
      // 聚合视图内容宽度 == 容器宽度, 复位残留横向滚动 (否则前几根柱会被左轴遮挡, 且不可点)
      if (elChartScroll.scrollLeft !== 0) elChartScroll.scrollLeft = 0;
    } else {
      elChartScroll.classList.remove("lc-chart-fit");
      elChart.style.width = "max-content";
      elChart.style.minWidth = "100%";
      elChart.style.maxWidth = "";
      elChart.style.padding = "18px 2px 0";
      elChart.style.gap = "2px";
      elChart.style.justifyContent = "";
      elChartScroll.style.overflowX = "";
    }

    const curSelectedId = isStepGran
      ? (activeStepIdx === null ? items[items.length - 1].stepIdx : activeStepIdx)
      : (activeTurnIdx === null ? items[items.length - 1].turnIdx : activeTurnIdx);
    const focusTurn = activeTurnIdx;
    elChartScroll.classList.toggle("lc-chart-dim", focusTurn !== null);

    // 5. 柱子: 直接作为 .lc-chart 的 flex 子元素
    const frag = document.createDocumentFragment();
    const lastIdx = barUnits.length - 1;
    const enterBase = Math.max(0, barUnits.length - 200);
    // 步数过多时只给最后 LC_DNA_MAX_STEPS 步渲染逐条 DNA 条带 (其余降级为分类带), 控制单次渲染耗时
    const dnaRenderFrom = Math.max(0, barUnits.length - LC_DNA_MAX_STEPS);

    barUnits.forEach(function (it, idx) {
      const seqId = isStepGran ? it.stepIdx : it.turnIdx;
      const isSelected = seqId === curSelectedId;
      const inTurn = focusTurn !== null && (it.turnIdx || 0) === focusTurn;

      const bar = document.createElement("div");
      bar.className = "lc-bar";
      // 总览下选中高亮改用「2px 竖直选择线」(见 5.0), 不再叠白色描边 —— 避免两套选中样式打架
      if (isSelected && !isOverview) bar.classList.add("lc-bar-selected");
      if (isSelected && isOverview) bar.classList.add("lc-bar-bucket-selected");
      if (inTurn) bar.classList.add("lc-bar-in-turn");
      bar.dataset.seq = String(seqId);
      bar.setAttribute("role", "button");
      bar.tabIndex = 0;
      bar.style.width = LC_BAR_W + "px";
      bar.style.flex = "0 0 " + LC_BAR_W + "px";
      bar.style.setProperty("--lc-i", String(Math.min(Math.max(0, idx - enterBase), 20)));
      if (isOverview) {
        // 聚合桶柱: 固定 px 宽 = max(2, floor(bucketPx) - 2); 绝不参与 flex 缩放/拉伸
        const bucketW = (overviewAgg && overviewAgg.barW) || 2;
        bar.style.width = bucketW + "px";
        bar.style.flex = "0 0 " + bucketW + "px";
        bar.style.minWidth = bucketW + "px";
        bar.style.maxWidth = bucketW + "px";
      }
      if (it._bucket) {
        bar.dataset.bucket = it._bucket.fromIdx + "-" + it._bucket.toIdx;
        bar.setAttribute("aria-label", "步骤 " + it._bucket.firstStepIdx + "–" + it._bucket.lastStepIdx
          + "(共 " + it._bucket.count + " 步) · 峰值 " + lcAxisText(it._bucket.peakTokens)
          + " · 平均 " + lcAxisText(Math.round(it._bucket.avgTokens)));
      } else {
        bar.setAttribute("aria-label", "第 " + (it.turnIdx || 1) + " 轮 · " + lcAxisText(it.totalTokens) + " tokens");
      }

      // 官方 lc-trend-flag: 每 5 步一个刻度标
      if (!isOverview && isStepGran && (idx + 1) % 5 === 0) {
        const flag = document.createElement("span");
        flag.className = "lc-trend-flag";
        flag.setAttribute("aria-hidden", "true");
        const flagLabel = document.createElement("span");
        flagLabel.className = "lc-trend-flag-label";
        // 用「真实步号」而非数组下标: 切换 DNA/总览再切回来, x 轴 flag 必须仍是真实步号
        flagLabel.textContent = String(Number(it.stepIdx) || (idx + 1));
        flag.dataset.step = String(seqId);
        flag.appendChild(flagLabel);
        bar.appendChild(flag);
      }

      // 官方 lc-bar-marker: 上下文压缩标记
      if (it.compaction || it.compactionCount) {
        const marker = document.createElement("span");
        marker.className = "lc-bar-marker";
        marker.textContent = "✂";
        marker.title = "发生了上下文压缩/剪枝";
        bar.appendChild(marker);
      }

      let dnaEl = null;
      let getHitBand = null;

      if (isDnaMode && isDelta) {
        // DNA 增量: 消除条带向下, 新增条带向上, 0 轴贯穿
        if (idx === 0) {
          const zero = document.createElement("div");
          zero.style.cssText = "position:absolute;left:0;width:100%;height:2px;bottom:" + Math.round(LC_PLOT_H) + "px;background:color-mix(in srgb, var(--color-neutral-500) 50%, transparent)";
          bar.appendChild(zero);
        } else {
          let deltas = null;
          try { deltas = getDnaDelta(getStepDnaBands(it), getStepDnaBands(items[idx - 1])); } catch (err) { deltas = null; }
          const span = deltas ? (deltas.upTotal + deltas.downTotal) : 0;
          if (!deltas || span <= 0) {
            const zero = document.createElement("div");
            zero.style.cssText = "position:absolute;left:0;width:100%;height:1px;bottom:" + Math.round(LC_PLOT_H) + "px;background:color-mix(in srgb, var(--color-neutral-500) 35%, transparent)";
            bar.appendChild(zero);
          } else {
            const height = Math.max(2, Math.round(span * deltaScale));
            dnaEl = document.createElement("div");
            dnaEl.className = "lc-bar-dna";
            dnaEl.style.position = "absolute";
            dnaEl.style.left = "0";
            dnaEl.style.bottom = "0";
            dnaEl.style.height = height + "px";
            dnaEl.style.width = "100%";
            dnaEl.style.background = buildDnaDeltaGradient(deltas, span);
            dnaEl.style.setProperty("--lc-i", String(Math.min(Math.max(0, idx - enterBase), 20)));
            bar.appendChild(dnaEl);
            getHitBand = function (ev) {
              const rect = dnaEl.getBoundingClientRect();
              if (rect.height <= 0) return deltas.up[0] || deltas.down[0] || null;
              const ratio = Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height));
              const tokenAt = ratio * span;
              if (tokenAt < deltas.downTotal) {
                for (const band of deltas.down) {
                  if (tokenAt >= band.off && tokenAt <= band.off + band.tokens) return Object.assign({}, band, { deltaType: "down" });
                }
                return deltas.down[0] ? Object.assign({}, deltas.down[0], { deltaType: "down" }) : null;
              }
              const upToken = tokenAt - deltas.downTotal;
              for (const band of deltas.up) {
                if (upToken >= band.off && upToken <= band.off + band.tokens) return Object.assign({}, band, { deltaType: "up" });
              }
              return deltas.up[0] ? Object.assign({}, deltas.up[0], { deltaType: "up" }) : null;
            };
          }
        }
      } else if (isDnaMode) {
        // DNA 全量: 逐条交错条带 —— .lc-bar > .lc-bar-dna > div
        //   每条颜色 = 分类色, 高度 = tokens/maxTotal*112, 从下往上按阅读顺序堆叠
        // 数据兜底: 部分 agent (如 antigravity) 的 steps 可能缺 browserCategories / dnaBands,
        // 或字段结构异常 —— 一律降级到「7 类分类带渐变」, 不抛错、不留空柱。
        let dnaData = null;
        if (idx >= dnaRenderFrom) {
          try {
            dnaData = lcDnaItemBands(it, overviewAgg ? LC_DNA_OVERVIEW_BANDS : LC_DNA_MAX_BANDS);
          } catch (err) {
            dnaData = null;
          }
        }
        if (dnaData) {
          const px = lcDnaBandPixels(dnaData, maxTotal);
          dnaEl = document.createElement("div");
          dnaEl.className = "lc-bar-dna";
          dnaEl.style.position = "absolute";
          dnaEl.style.left = "0";
          dnaEl.style.bottom = "0";
          dnaEl.style.width = "100%";
          // 容器高 = 该步 totalTokens 折算的柱高; 条带不足 1px 时按 1px 兜底, 超出部分由 overflow:hidden 裁掉
          dnaEl.style.height = px.barH + "px";
          dnaEl.style.display = "flex";
          dnaEl.style.flexDirection = "column-reverse";
          dnaEl.style.overflow = "hidden";
          dnaEl.style.borderRadius = "2px";
          dnaEl.style.setProperty("--lc-i", String(Math.min(Math.max(0, idx - enterBase), 20)));
          const bandEls = [];
          px.list.forEach(function (seg) {
            const bandEl = document.createElement("div");
            bandEl.dataset.cat = seg.band.cat;
            bandEl.dataset.itemKey = seg.band.key;
            bandEl.style.width = "100%";
            bandEl.style.flex = "0 0 " + seg.px + "px";
            bandEl.style.height = seg.px + "px";
            bandEl.style.background = seg.band.color;
            dnaEl.appendChild(bandEl);
            bandEls.push(bandEl);
          });
          bar.appendChild(dnaEl);
          getHitBand = function (ev) {
            const rect = dnaEl.getBoundingClientRect();
            if (rect.height <= 0) return px.list.length ? px.list[0].band : null;
            // column-reverse: 列表第 0 条在底部; 归一化到像素累计区间再命中
            const fromBottom = Math.max(0, Math.min(rect.height, rect.bottom - ev.clientY));
            const atPx = fromBottom * (px.total / rect.height);
            let target = px.list.length ? px.list[0].band : null;
            for (let k = 0; k < px.list.length; k += 1) {
              const seg = px.list[k];
              target = seg.band;
              if (atPx <= seg.to) break;
            }
            return target;
          };
        } else {
          // 降级: 缺 browserCategories (或超出逐条渲染预算) 的步仍用 7 条分类带渐变,
          // 保证长会话吞吐; bands 为空时兜一条中性带, 绝不出现「空柱」。
          let bands = null;
          try { bands = getStepDnaBands(it); } catch (err) { bands = null; }
          if (!bands || !bands.length) {
            bands = [{
              key: "all", cat: "system", color: LC_DNA_NEUTRAL, title: "未细分",
              tokens: Math.max(1, Number(it.totalTokens) || 1), off: 0
            }];
          }
          const height = Math.max(1, Math.round((Number(it.totalTokens) || 0) / maxTotal * LC_PLOT_H));
          dnaEl = document.createElement("div");
          dnaEl.className = "lc-bar-dna";
          dnaEl.style.height = height + "px";
          dnaEl.style.width = "100%";
          dnaEl.style.background = getDnaGradientFromBands(bands, it.totalTokens) || LC_DNA_NEUTRAL;
          dnaEl.style.setProperty("--lc-i", String(Math.min(Math.max(0, idx - enterBase), 20)));
          bar.appendChild(dnaEl);
          getHitBand = function (ev) {
            const rect = dnaEl.getBoundingClientRect();
            if (rect.height <= 0) return bands[0] || null;
            const ratio = Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height));
            const tokenAt = ratio * (Number(it.totalTokens) || 1);
            let target = bands[0] || null;
            for (const band of bands) {
              if (band.off > tokenAt) break;
              if (band.tokens > 0) target = band;
            }
            return target;
          };
        }
      } else if (isDelta) {
        // 官方增量: .lc-bar-up (只堆叠正增量, 底部对齐)
        if (it._upTokens > 0) {
          const upEl = document.createElement("div");
          upEl.className = "lc-bar-up";
          upEl.style.bottom = "0";
          DSH_CATEGORIES.forEach(function (c) {
            const diff = it._deltas[c.key] || 0;
            if (diff <= 0) return;
            const seg = document.createElement("div");
            seg.className = "lc-cat-seg";
            seg.dataset.cat = c.key;
            seg.style.height = Math.max(1, Math.round(diff * deltaScale)) + "px";
            seg.style.background = c.color;
            upEl.appendChild(seg);
          });
          bar.appendChild(upEl);
        }
      } else {
        // 全量: .lc-bar-stack (7 类累积堆叠, px 高度基于 112)
        const stackEl = document.createElement("div");
        stackEl.className = "lc-bar-stack";
        stackEl.style.setProperty("--lc-i", String(Math.min(Math.max(0, idx - enterBase), 20)));
        DSH_CATEGORIES.forEach(function (c) {
          const val = lcCatValue(it, c.key);
          if (val <= 0) return;
          const seg = document.createElement("div");
          seg.className = "lc-cat-seg";
          seg.dataset.cat = c.key;
          seg.style.height = Math.max(1, Math.round(val / maxTotal * LC_PLOT_H)) + "px";
          seg.style.background = c.color;
          stackEl.appendChild(seg);
        });
        bar.appendChild(stackEl);
      }

      // DNA 命中条带: 悬停 → 该条带上下边界横线 + 左侧「条带名 ≈tokens」(与点选状态并存, 移出即回到点选态)
      if (getHitBand) {
        bar.addEventListener("mousemove", function (ev) {
          const hit0 = getHitBand(ev);
          if (hit0) {
            const hoverKey = String(it.stepIdx) + "|" + String(hit0.cat || "") + "|" + String(hit0.key || "");
            if (hoverKey !== lcHoverBandKey) {
              lcHoverBandKey = hoverKey;
              lcClearSelectionOverlays(elChart);
              lcPaintBandPick(elChart, {
                stepIdx: it.stepIdx, catKey: hit0.cat, itemKey: hit0.key,
                title: hit0.title, tokens: hit0.tokens
              });
            }
          }
          if (!elChartTip || elChartTip.style.display === "none") return;
          const hit = getHitBand(ev);
          if (!hit) return;
          let hitTip = elChartTip.querySelector(".lc-dna-hit-tip");
          const tagText = hit.deltaType === "down" ? "【剪枝/消除】" : (hit.deltaType === "up" ? "【新增】" : "");
          const mergedTag = (hit.count > 1) ? (" · 合并 " + hit.count + " 条") : "";
          const html = '<span class="lc-dna-hit-tip" style="color:var(--dsw-alias-state-warn-primary,#facc15)">▶ '
            + tagText + escapeHtml(hit.title || "") + " · ≈" + lcAxisText(hit.tokens) + mergedTag
            + " · 第 " + (it.turnIdx || 1) + " 轮 · 步骤 #" + (it.stepIdx || 1) + "</span>";
          if (hitTip) hitTip.outerHTML = html;
          else elChartTip.insertAdjacentHTML("beforeend", html);
        });
        bar.addEventListener("mouseleave", function () {
          if (!lcHoverBandKey) return;
          lcHoverBandKey = null;
          lcClearSelectionOverlays(elChart);
          if (lcPickedItem) lcPaintBandPick(elChart, lcPickedItem);   // 回到已点选的条带
        });
      }

      // 浮窗跟手: 以 clientX/clientY 相对 .lc-chart-wrap 定位, 距光标 12px; 右/下越界自动翻转, 且钳在容器内
      const lcTipPos = function (ev) {
        if (!elChartTip || elChartTip.style.display === "none") return;
        const wrap = elChartTip.parentElement || $("trendChartWrap");
        if (!wrap || typeof wrap.getBoundingClientRect !== "function") return;
        const wr = wrap.getBoundingClientRect();
        const tipW = elChartTip.offsetWidth || 0;
        const tipH = elChartTip.offsetHeight || 0;
        const px = (Number(ev && ev.clientX) || 0) - wr.left;
        const py = (Number(ev && ev.clientY) || 0) - wr.top;
        let x = px + 12;                                    // 默认落在光标右下 12px
        let y = py + 12;
        if (x + tipW > wr.width - 2) x = px - tipW - 12;     // 右越界 → 翻到光标左侧
        if (y + tipH > wr.height - 2) y = py - tipH - 12;    // 下越界 → 翻到光标上方
        x = Math.max(2, Math.min(x, Math.max(2, wr.width - tipW - 2)));
        y = Math.max(2, Math.min(y, Math.max(2, wr.height - tipH - 2)));
        elChartTip.style.left = Math.round(x) + "px";
        elChartTip.style.top = Math.round(y) + "px";
        elChartTip.style.right = "auto";
        elChartTip.style.bottom = "auto";
        elChartTip.style.transform = "none";
      };

      // hover: 官方 .lc-chart-tip (内容随柱/桶/条带变化, 位置跟随光标)
      bar.addEventListener("mouseenter", function (ev) {
        if (!elChartTip) return;
        if (it._bucket) {
          // 总览聚合桶: 步骤 a–b(共 N 步) · 峰值 ≈X · 平均 ≈Y
          const bk = it._bucket;
          elChartTip.innerHTML = ''
            + '<span style="font-weight:700">' + escapeHtml("步骤 " + bk.firstStepIdx + "–" + bk.lastStepIdx + "(共 " + bk.count + " 步)") + "</span>"
            + '<span>' + escapeHtml("峰值 ≈" + lcAxisText(bk.peakTokens) + " · 平均 ≈" + lcAxisText(Math.round(bk.avgTokens))) + "</span>"
            + '<span>' + escapeHtml("第 " + (it.turnIdx || 1) + " 轮 · 桶 " + (idx + 1) + "/" + barUnits.length) + "</span>"
            + '<span>' + escapeHtml("耗时峰值 " + formatDuration(it.durationSec || 0)) + "</span>";
          elChartTip.style.display = "flex";
          lcTipPos(ev);
          return;
        }
        const titleText = isStepGran
          ? ("第 " + (it.turnIdx || 1) + " 轮 · 步骤 #" + (it.stepIdx || 1))
          : ("第 " + (it.turnIdx || 1) + " 轮 (共 " + (it.stepsCount || 1) + " 步)");
        const tokenText = isDelta
          ? (idx === 0 ? ("初始上下文: " + lcAxisText(it.totalTokens) + " (起点)") : ("净增量: " + (it._netTokens >= 0 ? "+" : "") + lcAxisText(it._netTokens) + " (新增 +" + lcAxisText(it._upTokens) + ", 减少 -" + lcAxisText(it._downTokens) + ")"))
          : ("总用量: " + lcAxisText(it.totalTokens));
        elChartTip.innerHTML = ''
          + '<span style="font-weight:700">' + escapeHtml(titleText) + "</span>"
          + '<span>' + escapeHtml(it.timestamp || "") + "</span>"
          + '<span>' + escapeHtml(tokenText) + "</span>"
          + '<span>耗时 ' + formatDuration(it.durationSec || 0) + " · 输出 " + lcAxisText(it.outputTokens || 0) + "</span>";
        elChartTip.style.display = "flex";
        lcTipPos(ev);
      });
      bar.addEventListener("mousemove", lcTipPos);
      bar.addEventListener("mouseleave", function () {
        if (elChartTip) elChartTip.style.display = "none";
      });

      // 点击: DNA 模式下精确定位条目, 否则选中该步/轮
      bar.addEventListener("click", function (ev) {
        if (isDnaMode && getHitBand) {
          const hit = getHitBand(ev);
          if (hit) {
            // 先广播点选事件给浏览器卡片 (模块级变量 lcPickedItem 同步可读), 再复用既有定位逻辑
            lcPickDnaBand(it.stepIdx, it.turnIdx, hit);
            locateBrowserItem(s, it.stepIdx, it.turnIdx, hit);
            // 选中条带 → 立刻画该条带上下边界横线 + 左侧名称/≈tokens (无需整图重绘)
            lcPaintChartSelection({ elChart: elChart, isOverview: false, isDnaMode: true, isDelta: isDelta });
            return;
          }
        }
        if (it._bucket) {
          // 总览: 记录选中桶 → 竖直选择线 + 顶部「步骤 a–b」区间标签 (见 5.0)
          lcSelectedBucketIdx = idx;
          lcSelectedBucketText = "步骤 " + it._bucket.firstStepIdx + "–" + it._bucket.lastStepIdx;
        }
        if (isStepGran) {
          activeStepIdx = it.stepIdx;
          activeTurnIdx = it.turnIdx;
        } else {
          activeTurnIdx = it.turnIdx;
        }
        renderTrendBarsAndChart(s);
        renderStepBrief(s);
        renderContextBrowser(s);
      });

      frag.appendChild(bar);
    });

    if (elDurationSvg && elDurationSvg.parentElement === elChart) elChart.insertBefore(frag, elDurationSvg);
    else elChart.appendChild(frag);

    // 5.0 选中标记 (必须在柱子入 DOM 之后: 需要真实像素坐标)
    //     · 总览: 选中桶 → 2px 竖直选择线 + 顶部「步骤 a–b」
    //     · DNA : 选中条带 → 上下边界 2px 横线 + 左侧「条带名 ≈tokens」
    lcPaintChartSelection({ elChart: elChart, isOverview: isOverview, isDnaMode: isDnaMode, isDelta: isDelta });

    // 5.1 总览轮次标线: 轮次边界处画 .lc-turn-marker 竖线 + 轮号小标签
    //     (总览下步数动辄数百, 步标无意义; 轮次边界才是可读刻度)
    if (isOverview && overviewGeom) {
      try {
        const g = overviewGeom;
        // 标线不依赖上游 turnRuns: 缺失时用 items + itemBucket 现场重算, 保证「总览必有轮次分隔标记」
        const runs = (Array.isArray(g.turnRuns) && g.turnRuns.length)
          ? g.turnRuns
          : lcTurnRunsFromItems(items, g.itemBucket);
        const marks = [];
        runs.forEach(function (run) {
          const bIdx = Number(run.firstBucket);
          // 桶索引缺失 / 越界 → 该轮不画标线 (绝不出现负坐标)
          if (!isFinite(bIdx) || bIdx < 0 || bIdx >= g.count) return;
          const x = Math.min(g.contentW, Math.max(0, g.xAtBucket(bIdx)));
          const mark = document.createElement("span");
          mark.className = "lc-turn-marker";
          mark.dataset.turn = String(run.turnIdx);
          mark.dataset.bucket = String(bIdx);
          mark.style.cssText = "position:absolute;top:18px;bottom:0;left:" + (Math.round(x * 100) / 100) + "px;"
            + "width:0;border-left:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary, currentColor) 20%, transparent);"
            + "z-index:3;pointer-events:none";
          const lbl = document.createElement("span");
          lbl.className = "lc-turn-marker-label";
          lbl.textContent = "T" + run.turnIdx;
          lbl.style.cssText = "position:absolute;left:2px;top:-16px;box-sizing:border-box;white-space:nowrap;"
            + "font-size:9px;font-weight:600;line-height:1;padding:1px 2px;border-radius:3px;"
            + "background:var(--dsw-alias-bg-layer-1, rgba(17,24,39,.85));"
            + "color:var(--dsw-alias-label-secondary, inherit);"
            + "border:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary, currentColor) 20%, transparent)";
          mark.appendChild(lbl);
          elChart.appendChild(mark);
          marks.push({ x: x, lbl: lbl });
        });
        const xs = [];
        const ws = [];
        marks.forEach(function (m) {
          const w = m.lbl.offsetWidth || 16;
          if (m.x + 2 + w > g.contentW) {
            // 右边界: 标签翻到竖线左侧, 且绝对坐标钳制 >= 0
            const abs = Math.max(0, m.x - w - 2);
            m.lbl.style.left = (abs - m.x) + "px";
          }
          xs.push(m.x);
          ws.push(w);
        });
        const keep = lcAvoidLabelOverlap(xs, ws, LC_TURN_LABEL_GAP);
        marks.forEach(function (m, i) { if (!keep[i]) m.lbl.style.display = "none"; });
      } catch (err) {
        // 标线失败不影响柱子/轴/轮次条
        if (typeof console !== "undefined") console.error("[context] 轮次标线渲染失败", err);
      }
    }

    // 6. 选中项滚动到可视区 (点击选中/定位; 不打断用户滚动位置)
    const hasExplicitPick = (activeStepIdx !== null || activeTurnIdx !== null);
    if (!isOverview && hasExplicitPick) {
      const selectedBar = elChart.querySelector(".lc-bar-selected");
      if (selectedBar) {
        const barLeft = selectedBar.offsetLeft;
        const barW = selectedBar.offsetWidth;
        const viewLeft = elChartScroll.scrollLeft;
        const viewW = elChartScroll.clientWidth;
        if (barLeft < viewLeft || barLeft + barW > viewLeft + viewW) {
          elChartScroll.scrollLeft = Math.max(0, barLeft - viewW / 2 + barW / 2);
        }
      }
    }

    // 6.1 官方起始窗口: 未显式选中时钉在最新 (最右); 用户一旦点选就不再自动跟随
    const pinKey = String(items.length) + ":" + trendGranularity + ":" + trendMode;
    if (pinKey !== lcPinnedKey) { lcPinnedKey = pinKey; lcPinnedRight = false; }
    let justPinned = false;
    if (!isOverview && !lcPinnedRight && activeStepIdx === null && activeTurnIdx === null && elChartScroll.clientWidth > 0) {
      elChartScroll.scrollLeft = elChartScroll.scrollWidth;
      lcPinnedRight = true;
      justPinned = true;
    }

    // 6.2 还原滚动位置: 重建柱子 / 总览↔滚动 / DNA 开/关都会把 scrollLeft 夹回 0, 必须显式还原
    //     —— 否则柱子停在会话开头(前几十步 totalTokens 很小), DNA 柱看着「几乎全平」, x 轴步标退化成 5/10/15…。
    //     总览模式固定贴左, 不还原; 有显式选中时以「6. 选中柱可见」为准, 也不覆盖。
    if (!isOverview && !justPinned) {
      const maxLeft = Math.max(0, elChartScroll.scrollWidth - elChartScroll.clientWidth);
      const backFromOverview = (prevRenderMode === "overview");
      let wanted = prevScrollLeft;
      if (backFromOverview) wanted = (lcScrollMemo === null || lcScrollMemo === undefined) ? maxLeft : lcScrollMemo;
      if (!hasExplicitPick) {
        const target2 = Math.max(0, Math.min(Math.round(wanted), maxLeft));
        if (Math.abs(elChartScroll.scrollLeft - target2) >= 1) elChartScroll.scrollLeft = target2;
      }
    }
    if (!isOverview) lcScrollMemo = elChartScroll.scrollLeft;
    lcLastRenderMode = isOverview ? "overview" : "scroll";

    // 7. 耗时折线 + 轮次条
    renderDurationCurveSvg(barUnits, maxDur, {
      overview: isOverview,
      pitch: overviewAgg ? overviewAgg.pitch : 0,
      buckets: !!overviewAgg,
      geom: overviewGeom,
      width: overviewGeom ? overviewGeom.contentW : 0,
      xAt: overviewGeom ? overviewGeom.xAtCenter : null
    });
    renderTurnsStripView(s, barUnits, {
      overview: !!overviewAgg,
      bucketCount: overviewAgg ? overviewAgg.count : 0,
      pitch: overviewAgg ? overviewAgg.pitch : 0,
      realItems: items,
      geom: overviewGeom
    });
    // 总览的标签位置由桶几何直接算出 (绝对定位到起始桶左缘), 不再走官方「可视区平移」逻辑
    if (!isOverview) lcPositionTurnLabels();

    // 8. 几何快照 (CDP / 自动化校验用; 不参与 UI)
    try {
      if (typeof window !== "undefined") {
        const barEls = elChart.querySelectorAll(".lc-bar");
        let spanW = 0;
        if (barEls.length) {
          const a = barEls[0];
          const z = barEls[barEls.length - 1];
          spanW = (z.offsetLeft + z.offsetWidth) - a.offsetLeft;
        }
        const stripEl = $("trendTurnsStrip");
        const turnEls = stripEl ? stripEl.querySelectorAll(".lc-turn") : [];
        let turnVisible = 0;
        for (let i = 0; i < turnEls.length; i += 1) {
          if (turnEls[i].style.display !== "none") turnVisible += 1;
        }
        const labelXs = [];
        const turnLabels = [];
        for (let i = 0; i < turnEls.length; i += 1) {
          const el = turnEls[i];
          const abs = el.style.position === "absolute";
          // 隐藏元素的 offsetLeft 恒为 0, 故绝对定位时读 inline left
          const x = abs ? Math.round((parseFloat(el.style.left) || 0) * 100) / 100 : Math.round(el.offsetLeft);
          labelXs.push(x);
          turnLabels.push({
            turn: el.textContent,
            left: x,
            visible: el.style.display !== "none",
            bucket: (el.dataset && el.dataset.bucket !== undefined) ? Number(el.dataset.bucket) : null
          });
        }
        window.__lcChartDebug = {
          mode: isOverview ? "overview" : "scroll",
          granularity: trendGranularity,
          dna: !!isDnaMode,
          delta: isDelta,
          containerW: Math.round(elChartScroll.clientWidth),
          chartW: Math.round(elChart.getBoundingClientRect().width * 100) / 100,
          gapPx: parseFloat(getComputedStyle(elChart).columnGap || getComputedStyle(elChart).gap || "0") || 0,
          bucketCount: overviewGeom ? overviewGeom.count : 0,
          bucketPx: overviewGeom ? Math.round(overviewGeom.bucketPx * 1000) / 1000 : 0,
          barW: barEls.length ? Math.round(barEls[0].getBoundingClientRect().width * 100) / 100 : 0,
          barCount: barEls.length,
          barSpanW: Math.round(spanW * 100) / 100,
          stepCount: overviewGeom ? overviewGeom.stepCount : items.length,
          turnCount: (overviewGeom && overviewGeom.turnRuns) ? overviewGeom.turnRuns.length : 0,
          turnLabelCount: turnEls.length,
          turnLabelVisible: turnVisible,
          turnLabelLefts: labelXs,
          turnLabels: turnLabels,
          turnMarkers: elChart.querySelectorAll(".lc-turn-marker").length,
          turnMarkersVisible: (function () {
            const ms = elChart.querySelectorAll(".lc-turn-marker");
            let c = 0;
            for (let i = 0; i < ms.length; i += 1) {
              const l = ms[i].querySelector(".lc-turn-marker-label");
              if (l && l.style.display !== "none") c += 1;
            }
            return c;
          })(),
          overflowX: elChartScroll.scrollWidth - elChartScroll.clientWidth,
          scrollLeft: Math.round(elChartScroll.scrollLeft),
          scrollMemo: lcScrollMemo,
          lastRenderMode: lcLastRenderMode,
          prevRenderMode: prevRenderMode,
          selectedBucketIdx: lcSelectedBucketIdx,
          selectedBucketText: lcSelectedBucketText,
          bucketGuides: elChart.querySelectorAll(".lc-bucket-guide").length,
          pickLines: elChart.querySelectorAll(".lc-band-pick-line").length,
          pickLabels: elChart.querySelectorAll(".lc-band-pick-label").length,
          pickedItem: lcPickedItem ? { stepIdx: lcPickedItem.stepIdx, catKey: lcPickedItem.catKey, itemKey: lcPickedItem.itemKey, title: lcPickedItem.title, tokens: lcPickedItem.tokens } : null
        };
      }
    } catch (err) { /* 快照失败不影响渲染 */ }
  }

  // 官方 Gh(): .lc-duration > polyline(.lc-dur-halo) + polyline + circle(.lc-dur-halo) + circle
  function renderDurationCurveSvg(items, maxDur, opts) {
    const svg = $("trendDurationSvg");
    if (!svg) return;
    const overview = !!(opts && opts.overview);
    if (!showDurationCurve || !items || items.length === 0) {
      svg.innerHTML = "";
      svg.style.display = "none";
      return;
    }
    svg.style.display = "block";
    const scrollEl = $("trendChartScroll");
    const fullWidth = items.length * LC_UNIT_W - LC_BAR_GAP;
    // 总览: SVG 宽度严格等于 .lc-chart 的精确宽度 (= bucketCount * bucketPx), 折点按桶心 x 对齐柱子
    const geom = (opts && opts.geom) || null;
    const width = overview
      ? Math.max(1, Number(opts && opts.width) || (geom && geom.contentW) || (scrollEl ? scrollEl.clientWidth : fullWidth))
      : fullWidth;
    if (overview) {
      svg.style.left = "0px"; // 总览下 .lc-chart 左右 padding 归零, SVG 与柱区同起点
      svg.style.top = "18px";
    } else {
      svg.style.left = "2px";
    }
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(LC_PLOT_H));
    if (overview) {
      svg.setAttribute("viewBox", "0 0 " + width + " " + LC_PLOT_H);
      svg.setAttribute("preserveAspectRatio", "none");
    } else {
      svg.removeAttribute("viewBox");
      svg.removeAttribute("preserveAspectRatio");
    }
    const yMax = Math.max(1, maxDur || 0);
    const bucketPitch = Number(opts && opts.pitch) || 0;
    const xAt = function (i) {
      if (!overview) return i * LC_UNIT_W + LC_BAR_CENTER;
      // 总览: 折点 = 对应桶柱的柱心 (与 bar 的 offsetLeft + barW/2 完全一致)
      if (opts && typeof opts.xAt === "function") return opts.xAt(i);
      if (bucketPitch > 0) return (i + 0.5) * bucketPitch;
      if (items.length <= 1) return width / 2;
      return (i / (items.length - 1)) * width;
    };
    const yAt = function (value) {
      const y = LC_PLOT_H - (Math.max(0, Number(value) || 0) / yMax) * LC_PLOT_H;
      return Math.round(Math.max(1, Math.min(LC_PLOT_H - 1, y)) * 100) / 100;
    };

    const runs = [];
    const dots = [];
    let cur = [];
    const flush = function () {
      if (cur.length >= 2) runs.push(cur);
      else if (cur.length === 1) dots.push(cur[0]);
      cur = [];
    };
    items.forEach(function (it, i) {
      const dur = it.durationSec;
      if (dur === undefined || dur === null) { flush(); return; }
      cur.push([xAt(i), yAt(dur)]);
    });
    flush();

    let html = "";
    runs.forEach(function (run) {
      const pts = run.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
      html += '<polyline class="lc-dur-halo" points="' + pts + '"/>';
      html += '<polyline points="' + pts + '"/>';
    });
    dots.forEach(function (p) {
      html += '<circle class="lc-dur-halo" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2"/>';
      html += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="1.2"/>';
    });
    svg.setAttribute("stroke-width", "1.25");
    svg.innerHTML = html;
  }

  // 官方 .lc-turns > .lc-turn (宽度: 轮次粒度 14px / 步骤粒度 = 步数*16-2)
  // 总览聚合模式: 用真实步骤索引 → 桶索引映射, 轮次条仍按真实轮次边界切分, 宽度对齐聚合柱
  function renderTurnsStripView(s, items, opts) {
    const elTurnsStrip = $("trendTurnsStrip");
    if (!elTurnsStrip) return;
    elTurnsStrip.innerHTML = "";
    if (!items || items.length === 0) return;
    const isStepGran = (trendGranularity === "step");
    const overviewAgg = !!(opts && opts.overview);
    const bucketPitch = Number(opts && opts.pitch) || 0;
    const bucketCount = Number(opts && opts.bucketCount) || 0;
    const realItems = (opts && Array.isArray(opts.realItems) && opts.realItems.length) ? opts.realItems : null;
    const geom = (opts && opts.geom) || null;
    // 总览: 每个真实轮次的「起始桶」由 renderTrendBarsAndChart 预先算好 (geom.turnRuns),
    // 标签用绝对定位直接落在该桶柱的左缘 —— 与柱子逐像素一致, 不再靠 flex 累加宽度 (会漂移)。
    const useAbsolute = !!(overviewAgg && geom && geom.contentW > 0
      && typeof geom.xAtBucket === "function");
    if (useAbsolute) {
      elTurnsStrip.style.position = "relative";
      elTurnsStrip.style.display = "block";
      elTurnsStrip.style.gap = "0";
      elTurnsStrip.style.width = geom.contentW + "px";
      elTurnsStrip.style.minWidth = "0";
      elTurnsStrip.style.padding = "0";
      elTurnsStrip.style.height = "14px";
      elTurnsStrip.style.marginTop = "4px";
      elTurnsStrip.style.overflow = "hidden";
    } else {
      elTurnsStrip.style.position = "";
      elTurnsStrip.style.display = "";
      elTurnsStrip.style.gap = overviewAgg ? "0px" : "";
      elTurnsStrip.style.width = "";
      elTurnsStrip.style.minWidth = "";
      elTurnsStrip.style.padding = "";
      elTurnsStrip.style.height = "";
      elTurnsStrip.style.overflow = "";
    }
    const groups = [];
    if (useAbsolute) {
      // 轮次 run 与柱子同一套映射; 上游缺失时现场重算 (数据无关兜底)
      const runs = (Array.isArray(geom.turnRuns) && geom.turnRuns.length)
        ? geom.turnRuns
        : lcTurnRunsFromItems(realItems || items, geom.itemBucket);
      runs.forEach(function (run) {
        groups.push({
          turnIdx: run.turnIdx,
          span: 0,
          count: run.count,
          firstItem: run.item,
          firstBucket: run.firstBucket
        });
      });
    } else if (overviewAgg && realItems && bucketCount > 0) {
      const byTurn = {};
      const order = [];
      realItems.forEach(function (it, i) {
        const turnNo = it.turnIdx || 1;
        const b = Math.min(bucketCount - 1, Math.floor(i * bucketCount / realItems.length));
        let g = byTurn[turnNo];
        if (!g) {
          g = { turnIdx: turnNo, span: 0, count: 0, firstItem: it, firstBucket: b, lastBucket: b };
          byTurn[turnNo] = g;
          order.push(g);
        }
        if (b > g.lastBucket) g.lastBucket = b;
        g.count += 1;
      });
      order.forEach(function (g) {
        g.span = g.lastBucket - g.firstBucket + 1;
        groups.push(g);
      });
    } else {
      items.forEach(function (it) {
        const turnNo = it.turnIdx || 1;
        let group = groups[groups.length - 1];
        if (!group || group.turnIdx !== turnNo) {
          group = { turnIdx: turnNo, span: 0, count: 0, firstItem: it };
          groups.push(group);
        }
        group.span += 1;
        group.count += 1;
      });
    }

    groups.forEach(function (group, i) {
      const turnEl = document.createElement("span");
      turnEl.className = "lc-turn";
      const isOn = activeTurnIdx !== null && group.turnIdx === activeTurnIdx;
      if (isOn) turnEl.classList.add("lc-turn-on");
      if (useAbsolute) {
        // 绝对定位到「起始桶柱左缘」: 与 .lc-bar 的 offsetLeft 完全一致 (逐像素对齐)
        // 桶索引缺失 / 越界 → 该轮标签不渲染 (宁缺勿负坐标)
        const bIdx = Number(group.firstBucket);
        if (!isFinite(bIdx) || bIdx < 0 || bIdx >= geom.count) return;
        const x = Math.max(0, Math.min(geom.contentW - 2, Math.round(geom.xAtBucket(bIdx) * 100) / 100));
        turnEl.dataset.bucket = String(bIdx);
        turnEl.style.position = "absolute";
        turnEl.style.left = x + "px";
        turnEl.style.top = "0";
        turnEl.style.width = "auto";
        turnEl.style.minWidth = "0";
        turnEl.style.flex = "none";
        turnEl.style.padding = "0 2px";
        turnEl.style.boxSizing = "border-box";
      } else if (overviewAgg && bucketPitch > 0) {
        // 覆盖的桶数 * 桶宽 - 1px, 与聚合柱位置一致
        const w = Math.max(1, Math.round(group.span * bucketPitch) - 1);
        turnEl.style.width = w + "px";
        turnEl.style.flex = "0 0 " + w + "px";
        turnEl.style.minWidth = w + "px";
      } else if (isOverview) {
        turnEl.style.width = "auto";
        turnEl.style.flex = String(group.count);
        turnEl.style.minWidth = "0";
      } else {
        const width = isStepGran ? Math.max(LC_BAR_W, group.span * LC_UNIT_W - LC_BAR_GAP) : LC_BAR_W;
        turnEl.style.width = width + "px";
        turnEl.style.flex = "none";
      }
      turnEl.style.background = LC_TURN_BG[i % LC_TURN_BG.length];
      turnEl.setAttribute("title", "T" + group.turnIdx + " (共 " + group.count + " 步)");
      turnEl.setAttribute("role", "button");
      turnEl.tabIndex = 0;
      turnEl.setAttribute("aria-label", "第 " + group.turnIdx + " 轮");
      const labelEl = document.createElement("span");
      labelEl.className = "lc-turn-label";
      labelEl.textContent = String(group.turnIdx);
      turnEl.appendChild(labelEl);
      const pick = function () {
        activeTurnIdx = group.turnIdx;
        if (isStepGran && group.firstItem && group.firstItem.stepIdx !== undefined) activeStepIdx = group.firstItem.stepIdx;
        renderTrendBarsAndChart(s);
        renderStepBrief(s);
        renderContextBrowser(s);
      };
      turnEl.addEventListener("click", pick);
      turnEl.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); }
      });
      elTurnsStrip.appendChild(turnEl);
    });

    // 总览: 全部轮次都渲染进 DOM, 再按实测宽度做「避让」(相邻最小 LC_TURN_LABEL_GAP, 冲突跳过中间标签,
    // 首尾轮次强制显示) —— 标签不会互相压叠, 也不会因为过度稀疏而丢掉首尾。
    if (useAbsolute) {
      const turnEls = Array.prototype.slice.call(elTurnsStrip.querySelectorAll(".lc-turn"));
      const xs = [];
      const ws = [];
      turnEls.forEach(function (el) {
        const w = el.offsetWidth || 14;
        let x = parseFloat(el.style.left) || 0;
        if (x + w > geom.contentW) {
          x = Math.max(0, geom.contentW - w);
          el.style.left = (Math.round(x * 100) / 100) + "px";
        }
        xs.push(x);
        ws.push(w);
      });
      const keep = lcAvoidLabelOverlap(xs, ws, LC_TURN_LABEL_GAP);
      turnEls.forEach(function (el, i) { el.style.display = keep[i] ? "" : "none"; });
    }
  }

  // 7. 第三行左下：步骤透视摘要 (官方 .lc-detail > head 胶囊 + .lc-brief 行 + 细 .lc-stacked + .lc-legend)
  let briefHoverKey = null;

  function lcDetailPill(text) {
    const pill = document.createElement("span");
    pill.className = "lc-detail-metric";
    pill.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600;font-size:12px;padding:2px 8px;border-radius:6px;background:color-mix(in srgb, var(--color-neutral-500) 16%, transparent);color:inherit";
    pill.textContent = text;
    return pill;
  }

  function lcBriefRow(tagText, children) {
    const row = document.createElement("div");
    row.className = "lc-brief-row";
    row.style.cssText = "box-sizing:border-box;display:flex;align-items:center;gap:8px;min-width:0;min-height:27px;margin:0 -6px;padding:3px 6px;border-radius:6px;font-size:12px;line-height:1.5";
    const tag = document.createElement("span");
    tag.className = "lc-brief-tag";
    tag.style.cssText = "box-sizing:border-box;flex:none;min-width:56px;text-align:center;padding:0 6px;border-radius:4px;font-size:11px;background:color-mix(in srgb, var(--color-neutral-500) 14%, transparent);border:1px solid color-mix(in srgb, var(--color-neutral-500) 30%, transparent);color:var(--dsw-alias-label-secondary, var(--muted))";
    tag.textContent = tagText;
    row.appendChild(tag);
    (children || []).forEach(function (node) { row.appendChild(node); });
    return row;
  }

  function lcBriefText(text, isCode) {
    const span = document.createElement("span");
    span.className = "lc-brief-text";
    span.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" + (isCode ? ";font-family:var(--code);font-size:11.5px" : "");
    span.textContent = text;
    span.title = text;
    return span;
  }

  function lcBriefEmpty(text) {
    const span = document.createElement("span");
    span.className = "lc-brief-empty";
    span.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary, var(--muted))";
    span.textContent = text;
    return span;
  }

  function lcBriefFact(text) {
    const span = document.createElement("span");
    span.className = "lc-brief-fact";
    span.style.cssText = "box-sizing:border-box;flex:none;max-width:160px;padding:0 6px;border-radius:4px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:color-mix(in srgb, var(--color-neutral-500) 14%, transparent);border:1px solid color-mix(in srgb, var(--color-neutral-500) 26%, transparent);color:var(--dsw-alias-label-secondary, var(--muted))";
    span.textContent = text;
    return span;
  }

  function lcBriefChip(tagText, text) {
    const chip = document.createElement("span");
    chip.className = "lc-brief-chip lc-brief-chip-grow";
    chip.style.cssText = "display:inline-flex;align-items:center;gap:5px;min-width:0;padding:0 7px;border-radius:5px;font-size:12px;overflow:hidden;background:color-mix(in srgb, var(--color-neutral-500) 10%, transparent);border:1px solid color-mix(in srgb, var(--color-neutral-500) 22%, transparent)";
    if (tagText) {
      const tag = document.createElement("span");
      tag.className = "lc-brief-chip-tag";
      tag.style.cssText = "flex:none;padding:0 6px;border-radius:4px;font-size:11px;background:color-mix(in srgb, var(--color-neutral-500) 16%, transparent);border:1px solid color-mix(in srgb, var(--color-neutral-500) 26%, transparent);color:var(--dsw-alias-label-secondary, var(--muted))";
      tag.textContent = tagText;
      chip.appendChild(tag);
    }
    const textEl = document.createElement("span");
    textEl.className = "lc-brief-chip-text";
    textEl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    textEl.textContent = text;
    chip.appendChild(textEl);
    return chip;
  }

  function renderStepBrief(s) {
    const isStep = (trendGranularity === "step");
    const dc = s.dshContext || {};
    const items = (isStep ? (dc.steps || []) : (dc.turns || []));
    if (items.length === 0) return;
    const curSelectedId = isStep
      ? (activeStepIdx === null ? items[items.length - 1].stepIdx : activeStepIdx)
      : (activeTurnIdx === null ? items[items.length - 1].turnIdx : activeTurnIdx);
    let curIdx = -1;
    items.forEach(function (it, i) { if ((isStep ? it.stepIdx : it.turnIdx) === curSelectedId) curIdx = i; });
    if (curIdx < 0) curIdx = items.length - 1;
    const it = items[curIdx] || {};

    // ---- head: b 标题 + .lc-detail-time + .lc-detail-metrics 胶囊 ----
    if (elBriefStepTitle) {
      elBriefStepTitle.textContent = isStep
        ? ("第 " + (it.turnIdx || 1) + " 轮 · 第 " + (it.stepInTurn || it.stepIdx || 1) + " 步 (共 " + (it.totalStepsInTurn || items.length) + " 步)")
        : ("第 " + (it.turnIdx || 1) + " 轮 (共 " + (it.stepsCount || 1) + " 步)");
    }
    if (elBriefTime) elBriefTime.textContent = it.timestamp || "";
    if (elBriefMetrics) {
      elBriefMetrics.innerHTML = "";
      elBriefMetrics.appendChild(lcDetailPill("实际 " + lcAxisText(it.totalTokens || 0)));
      if (it.outputTokens !== undefined && it.outputTokens !== null) {
        elBriefMetrics.appendChild(lcDetailPill("输出 " + lcAxisText(it.outputTokens || 0)));
      }
      if (it.cacheHit !== undefined && it.cacheHit !== null) {
        elBriefMetrics.appendChild(lcDetailPill("缓存 " + it.cacheHit + "%"));
      }
    }

    // ---- .lc-brief: 多行 (用户 / 输入 / 工具 / 回复) ----
    if (elBriefRows) {
      elBriefRows.innerHTML = "";
      const userText = it.userSnippet || "";
      elBriefRows.appendChild(userText
        ? lcBriefRow("用户", [lcBriefText(userText)])
        : lcBriefRow("用户", [lcBriefEmpty("无用户输入")]));

      const inputText = it.inputSnippet || "";
      if (inputText) elBriefRows.appendChild(lcBriefRow("输入", [lcBriefChip("", inputText)]));
      else elBriefRows.appendChild(lcBriefRow("输入", [lcBriefEmpty("本轮无新增上下文节点")]));

      const toolNames = Array.isArray(it.toolCalls) ? it.toolCalls.filter(Boolean) : [];
      if (toolNames.length > 0) elBriefRows.appendChild(lcBriefRow("工具", [lcBriefFact(toolNames.join(" › "))]));

      const replyText = it.thinking || "";
      if (replyText) elBriefRows.appendChild(lcBriefRow("回复", [lcBriefText(replyText)]));
      else if (toolNames.length > 0) elBriefRows.appendChild(lcBriefRow("回复", [lcBriefText(toolNames.join(" › "))]));
    }

    // ---- 本步 7 类构成: 细 .lc-stacked + .lc-legend chips ----
    const parts = DSH_CATEGORIES.map(function (c) {
      return { key: c.key, label: c.name, color: c.color, value: lcCatValue(it, c.key) };
    }).filter(function (p) { return p.value > 0; });
    let partsTotal = 0;
    parts.forEach(function (p) { partsTotal += p.value; });

    if (elBriefStacked) {
      elBriefStacked.innerHTML = "";
      elBriefStacked.classList.remove("lc-stacked-dim");
      parts.forEach(function (p, i) {
        const seg = document.createElement("div");
        seg.className = "lc-stacked-seg animate-lc-stacked-in";
        seg.dataset.cat = p.key;
        seg.style.width = (partsTotal > 0 ? (p.value / partsTotal) * 100 : 0) + "%";
        seg.style.backgroundColor = p.color;
        seg.style.setProperty("--lc-i", String(Math.min(i, 8)));
        seg.setAttribute("title", p.label + ": " + lcAxisText(p.value));
        seg.addEventListener("mouseenter", function () { briefHoverKey = p.key; renderBriefLegend(parts); });
        seg.addEventListener("mouseleave", function () { briefHoverKey = null; renderBriefLegend(parts); });
        elBriefStacked.appendChild(seg);
      });
    }
    renderBriefLegend(parts);
  }

  function renderBriefLegend(parts) {
    if (!elBriefLegend) return;
    renderChipLegend(elBriefLegend, parts, {
      hoverKey: briefHoverKey,
      onHoverKey: function (key) {
        briefHoverKey = key;
        if (elBriefStacked) {
          elBriefStacked.classList.toggle("lc-stacked-dim", key !== null);
          elBriefStacked.querySelectorAll(".lc-stacked-seg").forEach(function (seg) {
            seg.classList.toggle("lc-stacked-seg-on", seg.dataset.cat === key);
          });
        }
        renderBriefLegend(parts);
      }
    });
  }

  // 官方 lc-map 块状占比地图 (Treemap: 对标原版 ec 与 Bs 算法)
  /* ---------- 空间占比地图: squarified treemap (真·面积瓦片图) ---------- */

  /** 一行瓦片在给定短边下的最差长宽比 (越接近 1 越方正) */
  function lcTreemapWorst(row, side) {
    const sum = row.reduce(function (a, b) { return a + b.area; }, 0);
    if (!(sum > 0) || !(side > 0)) return Infinity;
    let mx = 0;
    let mn = Infinity;
    for (let i = 0; i < row.length; i += 1) {
      const a = row[i].area;
      if (a > mx) mx = a;
      if (a < mn) mn = a;
    }
    if (!(mn > 0)) return Infinity;
    const s2 = sum * sum;
    const l2 = side * side;
    return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
  }

  /**
   * squarified 布局核心: 每次沿当前区域的短边切一条(row), 逐项加入直到最差长宽比变差。
   * areas 必须已归一化到 px² 且按面积降序, 返回 [{ v, x, y, w, h }]。
   */
  function lcSquarify(list, x0, y0, w0, h0, out) {
    const res = out || [];
    let rest = list;
    let cx = x0;
    let cy = y0;
    let cw = w0;
    let ch = h0;
    while (rest.length && cw > 0.4 && ch > 0.4) {
      // 沿较长边铺行: 行的长度 = 当前区域的较长边 (标准 squarified 用该长度算最差长宽比)
      const side = Math.max(cw, ch);
      let row = [rest[0]];
      let best = lcTreemapWorst(row, side);
      let k = 1;
      while (k < rest.length) {
        const trial = row.concat([rest[k]]);
        const wr = lcTreemapWorst(trial, side);
        if (wr > best) break;
        row = trial;
        best = wr;
        k += 1;
      }
      const tail = rest.slice(row.length);
      let rowSum = 0;
      for (let i = 0; i < row.length; i += 1) rowSum += row[i].area;
      let remain = rowSum;
      for (let i = 0; i < tail.length; i += 1) remain += tail[i].area;
      const frac = remain > 0 ? rowSum / remain : 1;
      if (cw <= ch) {
        const colW = cw * frac;
        let oy = cy;
        for (let i = 0; i < row.length; i += 1) {
          const hh = rowSum > 0 ? (row[i].area / rowSum) * ch : 0;
          res.push({ v: row[i].v, x: cx, y: oy, w: colW, h: hh });
          oy += hh;
        }
        cx += colW;
        cw -= colW;
      } else {
        const rowH = ch * frac;
        let ox = cx;
        for (let i = 0; i < row.length; i += 1) {
          const ww = rowSum > 0 ? (row[i].area / rowSum) * cw : 0;
          res.push({ v: row[i].v, x: ox, y: cy, w: ww, h: rowH });
          ox += ww;
        }
        cy += rowH;
        ch -= rowH;
      }
      rest = tail;
    }
    return res;
  }

  /** 入口: 任意量纲的 area → 归一化到 w×h 的像素矩形 */
  function lcTreemapLayout(entries, x, y, w, h) {
    if (!(w > 0) || !(h > 0) || !entries.length) return [];
    let total = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const a = Number(entries[i].area);
      if (a > 0) total += a;
    }
    if (!(total > 0)) return [];
    const k = (w * h) / total;
    const items = [];
    for (let i = 0; i < entries.length; i += 1) {
      const a = Number(entries[i].area);
      if (a > 0) items.push({ v: entries[i].v, area: a * k });
    }
    items.sort(function (a, b) { return b.area - a.area; });
    return lcSquarify(items, x, y, w, h, []);
  }

  /** 像素 → 百分比 (容器自适应, 窗口缩放后仍铺满) */
  function lcTreemapPct(v, base) {
    if (!(base > 0)) return "0%";
    return ((v / base) * 100).toFixed(4) + "%";
  }

  const LC_TREEMAP_CAT_LABEL_H = 15; // 分类标签条高度(px)
  const LC_TREEMAP_MAX_ITEMS = 60;   // 单分类最多渲染的 item 瓦片数, 其余合并为「其他 N 项」
  const LC_TREEMAP_H = 220;          // 与 #browserTreemap 的固定高度保持一致

  /** 瓦片点击 (委托绑定一次): 分类瓦片 → 退出地图并展开分类; item 瓦片 → 退出并定位条目 */
  function bindTreemapEvents() {
    if (!elBrowserTreemap || elBrowserTreemap.getAttribute("data-tm-bound") === "1") return;
    elBrowserTreemap.setAttribute("data-tm-bound", "1");
    elBrowserTreemap.addEventListener("click", function (ev) {
      const tile = ev.target && ev.target.closest ? ev.target.closest("[data-tm-cat]") : null;
      if (!tile) return;
      const catKey = tile.getAttribute("data-tm-cat") || "";
      const itemKey = tile.getAttribute("data-tm-item") || "";
      const turnRaw = elBrowserTreemap.getAttribute("data-tm-turn");
      const stepRaw = elBrowserTreemap.getAttribute("data-tm-step");
      const turnIdx = (turnRaw === null || turnRaw === "") ? null : Number(turnRaw);
      const stepIdx = (stepRaw === null || stepRaw === "") ? null : Number(stepRaw);
      const s = browserSessionRef || getSessionDetailOrIndex(activeModalSessionId);
      // 退出地图 → 回到条目列表模式
      isTreemapMode = false;
      if (elBtnLayoutToggle) elBtnLayoutToggle.classList.remove("on");
      elBrowserTreemap.style.display = "none";
      if (catKey) openedAccordionKeys.add(catKey);
      if (s) renderContextBrowser(s);
      if (itemKey) {
        // 条目瓦片: 复用图表 DNA 联动通道 → 展开该条目 (ensureItemCard) + scrollIntoView + 高亮
        try {
          window.dispatchEvent(new CustomEvent("lc-pick-item", {
            detail: { turnIdx: turnIdx, stepIdx: stepIdx, catKey: catKey, itemKey: itemKey },
          }));
        } catch (e) {
          showToast("该条目未在列表中加载");
        }
      } else if (catKey) {
        // 分类瓦片: 展开该分类并滚动到位 (沿用原有交互)
        setTimeout(function () {
          const tree = elBrowserAccordionTree;
          if (!tree) return;
          let node = null;
          try { node = tree.querySelector('.cat-node[data-cat="' + catKey + '"]'); } catch (e) { node = null; }
          if (!node) {
            try { node = tree.querySelector('.lc-cat-node[data-cat="' + catKey + '"]'); } catch (e) { node = null; }
          }
          if (node) {
            node.classList.add("open");
            flashBrowserRow(node);
          }
        }, 60);
      }
    });
  }

  /**
   * 空间占比地图 (squarified treemap):
   * 顶层按分类 tokens 面积切分, 分类矩形内再按 item tokens 切子瓦片 (分类色不同明度)。
   */
  function renderTreemap(s, st) {
    if (!elBrowserTreemap) return;
    const cats = (st && Array.isArray(st.browserCategories)) ? st.browserCategories : [];
    const visible = cats.filter(function (c) { return (Number(c.tokens) || 0) > 0; });
    elBrowserTreemap.innerHTML = "";
    bindTreemapEvents();
    if (!visible.length) {
      elBrowserTreemap.innerHTML = '<div class="lc-map-empty">暂无块状占比数据</div>';
      return;
    }
    let catTotal = 0;
    for (let i = 0; i < visible.length; i += 1) catTotal += Math.max(0, Number(visible[i].tokens) || 0);
    const W = Math.max(240, elBrowserTreemap.clientWidth || 720);
    const H = LC_TREEMAP_H;

    // 供点击委托使用 (当前 step 坐标)
    elBrowserTreemap.setAttribute("data-tm-turn", st && st.turnIdx != null ? String(st.turnIdx) : "");
    elBrowserTreemap.setAttribute("data-tm-step", st && st.stepIdx != null ? String(st.stepIdx) : "");

    const catRectList = lcTreemapLayout(
      visible.map(function (c) { return { area: Number(c.tokens) || 0, v: c }; }),
      0, 0, W, H
    );

    const frag = document.createDocumentFragment();
    catRectList.forEach(function (rect) {
      const c = rect.v;
      const color = c.color || CANONICAL_COLORS[c.key] || "#6366f1";
      const tok = Math.max(0, Number(c.tokens) || 0);
      const pct = catTotal > 0 ? (tok / catTotal) * 100 : 0;
      const items = Array.isArray(c.items) ? c.items : [];

      const catEl = document.createElement("div");
      catEl.className = "lc-map-tile lc-map-cat";
      catEl.setAttribute("data-tm-cat", String(c.key || ""));
      catEl.setAttribute("title",
        (c.name || c.key || "分类") + " · " + formatK(tok) + " tokens · " + pct.toFixed(1) + "% · " + items.length + " 条");
      catEl.style.cssText = "left:" + lcTreemapPct(rect.x, W)
        + ";top:" + lcTreemapPct(rect.y, H)
        + ";width:" + lcTreemapPct(rect.w, W)
        + ";height:" + lcTreemapPct(rect.h, H)
        + ";background:color-mix(in srgb, " + color + " 13%, #14151a)";

      // 分类标签: 仅占比 ≥18% 才显示「分类名 + 百分比」
      let labelH = 0;
      if (pct >= 18 && rect.w >= 54 && rect.h >= 20) {
        const lab = document.createElement("div");
        lab.className = "lc-map-cat-label";
        lab.textContent = (c.name || c.key || "分类") + " " + pct.toFixed(1) + "%";
        catEl.appendChild(lab);
        if (rect.h >= 44 && rect.w >= 88) labelH = LC_TREEMAP_CAT_LABEL_H;
      }

      // 分类内子瓦片: 按 item tokens 再切 (超 60 条合并为「其他 N 项」)
      const desc = items
        .map(function (it) {
          const t = Math.max(0, Number(it && it.tokens) || 0);
          return {
            tokens: t,
            title: (it && (it.title || it.snippet || it.toolName)) || "条目",
            id: (it && (it.id || it.key)) ? String(it.id || it.key) : "",
            merged: false,
            n: 1,
          };
        })
        .filter(function (d) { return d.tokens > 0; })
        .sort(function (a, b) { return b.tokens - a.tokens; });
      if (desc.length > LC_TREEMAP_MAX_ITEMS) {
        const tail = desc.slice(LC_TREEMAP_MAX_ITEMS);
        desc.length = LC_TREEMAP_MAX_ITEMS;
        let restTok = 0;
        for (let i = 0; i < tail.length; i += 1) restTok += tail[i].tokens;
        desc.push({ tokens: restTok, title: "其他 " + tail.length + " 项", id: "", merged: true, n: tail.length });
      }

      const innerW = rect.w - 2;
      const innerH = rect.h - labelH - 2;
      if (desc.length && innerW > 4 && innerH > 4) {
        const itemRects = lcTreemapLayout(
          desc.map(function (d) { return { area: d.tokens, v: d }; }),
          0, 0, innerW, innerH
        );
        itemRects.forEach(function (r, ri) {
          const d = r.v;
          const shade = 18 + ((ri * 3) % 23); // 18 ~ 40: 子瓦片明度随序号变化
          const tile = document.createElement("div");
          tile.className = "lc-map-tile lc-map-item";
          tile.setAttribute("data-tm-cat", String(c.key || ""));
          if (!d.merged && d.id) tile.setAttribute("data-tm-item", d.id);
          tile.setAttribute("title",
            d.merged
              ? (d.title + " · " + formatK(d.tokens) + " tokens（合并 " + d.n + " 条）")
              : (d.title + " · " + formatK(d.tokens) + " tokens"));
          tile.style.cssText = "left:" + lcTreemapPct(r.x + 1, rect.w)
            + ";top:" + lcTreemapPct(r.y + labelH + 1, rect.h)
            + ";width:" + lcTreemapPct(r.w, rect.w)
            + ";height:" + lcTreemapPct(r.h, rect.h)
            + ";background:color-mix(in srgb, " + color + " " + shade + "%, #14151a)";
          if (r.w >= 70 && r.h >= 26) {
            const labelEl = document.createElement("span");
            labelEl.className = "lc-map-item-label";
            const titleEl = document.createElement("span");
            titleEl.className = "lc-map-item-title";
            titleEl.textContent = d.title;
            const tokEl = document.createElement("span");
            tokEl.className = "lc-map-item-tok";
            tokEl.textContent = formatK(d.tokens);
            labelEl.appendChild(titleEl);
            labelEl.appendChild(tokEl);
            tile.appendChild(labelEl);
          }
          catEl.appendChild(tile);
        });
      }
      frag.appendChild(catEl);
    });

    elBrowserTreemap.appendChild(frag);
  }

  const CANONICAL_COLORS = {
    system: "#6366f1",
    tools: "#f59e0b",
    user: "#22c55e",
    inject: "#a855f7",
    skill: "#f97316",
    assistant: "#3b82f6",
    tool: "#14b8a6"
  };

  function getBandFullText(it, s) {
    if (it.fullText && it.fullText.length > 0 && !it.fullText.startsWith("[")) {
      return it.fullText;
    }
    if (!s || !s.turns) return it.fullText || it.snippet || it.title || "";

    const targetTurnIdx = it.turnIdx || 1;
    const tn = s.turns.find(t => t.turnIdx === targetTurnIdx) || s.turns[targetTurnIdx - 1];
    if (tn && tn.messages) {
      if (it.cat === "user") {
        const uMsg = tn.messages.find(m => m.role === "user");
        if (uMsg?.fullText) return uMsg.fullText;
        if (tn.userText) return tn.userText;
      }
      if (it.cat === "assistant") {
        const aMsgs = tn.messages.filter(m => m.role === "assistant");
        const idx = (it.stepIdx ? it.stepIdx - 1 : 0);
        const aMsg = aMsgs[idx] || aMsgs[aMsgs.length - 1];
        if (aMsg?.fullText) return aMsg.fullText;
      }
      if (it.cat === "tool") {
        const tMsgs = tn.messages.filter(m => m.role === "tool_result" || m.role === "tool");
        const idx = (it.stepIdx ? it.stepIdx - 1 : 0);
        const tMsg = tMsgs[idx] || tMsgs[tMsgs.length - 1];
        if (tMsg?.fullText) return tMsg.fullText;
      }
      if (it.cat === "system") {
        const sMsg = tn.messages.find(m => m.role === "system");
        if (sMsg?.fullText) return sMsg.fullText;
      }
    }
    return it.fullText || it.snippet || it.title || "";
  }

  /**
   * 正文清洗: 去掉首尾空行 (正文常以 \n 开头 → 旧版详情卡首行一片空白),
   * 并把 3 个以上连续空行压成 1 个空行。
   */
  function normalizeCardText(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n|\r/g, "\n")
      .replace(/^(?:[ \t]*\n)+/, "")
      .replace(/(?:\n[ \t]*)+$/, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  /**
   * 条目详情卡 (对齐官方 dsh-context 详情卡):
   *   head = .lc-ts-call-name(tag) + .lc-ts-card-head-note(摘要) + .lc-ts-card-right
   *          [.lc-ts-card-meta「N 行 · ≈tokens (· 已截断)」 + Raw/Markdown 分段 (.lc-gran) + 复制]
   *   body = Raw: .lc-ts-desc-body.lc-ts-lines (行号版, 首次切到 Raw 才填充)
   *          Markdown: 不带行号的 <pre> 流式版 (默认视图)
   * 两种模式都 max-height:320px + overflow-y:auto (见 style.css .lc-ts-desc-body)。
   */
  function renderMessageCard(title, note, fullText, tokens, opts) {
    const opt = opts || {};
    const cleaned = normalizeCardText(fullText);
    const lines = cleaned ? cleaned.split("\n") : [];
    const lineCount = lines.length;
    const charCount = cleaned.length;
    const truncated = !!opt.truncated || charCount >= 24000;
    const tagText = opt.tag || title || "item";
    const metaText = `${lineCount} 行 · ${formatK(tokens)}${truncated ? " · 已截断" : ""}`;
    const noteText = note || "";

    return `
      <div class="lc-ts-card" data-lc-view="md">
        <div class="lc-ts-card-head lc-ts-card-head-wrap">
          <span class="lc-ts-call-name">${escapeHtml(tagText)}</span>
          <span class="lc-ts-card-head-note" title="${escapeHtml(noteText)}">${escapeHtml(noteText)}</span>
          <span class="lc-ts-card-right">
            <span class="lc-ts-card-meta" title="${lineCount} 行 · ${charCount} 字符">${metaText}</span>
            <span class="lc-gran lc-gran-inline" role="group" aria-label="视图切换">
              <button type="button" class="lc-gran-btn" data-lc-view-btn="raw" title="原始文本 (带行号)">Raw</button>
              <button type="button" class="lc-gran-btn lc-gran-on" data-lc-view-btn="md" title="流式正文 (无行号)">Markdown</button>
            </span>
            <button type="button" class="lc-rich-copy" title="复制全部内容">复制</button>
          </span>
        </div>
        <div class="lc-ts-desc-body lc-ts-lines" data-lc-pane="raw" data-rendered="0" style="display:none"></div>
        <pre class="lc-ts-desc-body lc-ts-md" data-lc-pane="md">${escapeHtml(cleaned)}</pre>
      </div>
    `;
  }

  /**
   * Raw / Markdown 分段控件绑定 (官方 .lc-gran/.lc-gran-btn/.lc-gran-on 复用)。
   * Raw 面板首次切换时才注入行号版 HTML —— 保持详情卡懒渲染, 20k 字符正文不重复占 DOM。
   */
  function bindCardViewToggle(card, cleanedText) {
    if (!card) return;
    const btns = card.querySelectorAll("[data-lc-view-btn]");
    const panes = card.querySelectorAll("[data-lc-pane]");
    const rawPane = card.querySelector('[data-lc-pane="raw"]');
    const fillRaw = () => {
      if (!rawPane || rawPane.getAttribute("data-rendered") === "1") return;
      const linesHtml = String(cleanedText || "").split("\n")
        .map(l => `<span class="lc-ts-line">${escapeHtml(l)}</span>`).join("");
      rawPane.innerHTML = linesHtml;
      rawPane.setAttribute("data-rendered", "1");
    };
    btns.forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-lc-view-btn") || "md";
        const cardEl = card.classList.contains("lc-ts-card") ? card : (card.querySelector(".lc-ts-card") || card);
        cardEl.setAttribute("data-lc-view", view);
        btns.forEach(b => b.classList.toggle("lc-gran-on", b === btn));
        panes.forEach(p => {
          const on = p.getAttribute("data-lc-pane") === view;
          p.style.display = on ? "" : "none";
        });
        if (view === "raw") fillRaw();
      });
    });
  }

  function bindRichCopy(container, fullText) {
    const copyBtn = container.querySelector(".lc-rich-copy");
    if (!copyBtn) return;
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 复制失败也要有可读反馈, 且不允许 Promise 拒绝冒到全局 (会触发顶部红色提示条)
      const copyTask = (navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(fullText)
        : Promise.reject(new Error("CLIPBOARD_UNAVAILABLE"));
      copyTask.then(() => {
        copyBtn.classList.add("lc-rich-copy-on");
        copyBtn.innerHTML = `
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><polyline points="3 8 7 12 13 4"/></svg>已复制
        `;
        setTimeout(() => {
          copyBtn.classList.remove("lc-rich-copy-on");
          copyBtn.innerHTML = `
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" style="margin-right:4px;"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>复制
          `;
        }, 1200);
        showToast("已复制全部内容");
      }).catch((err) => {
        console.error("[context] 复制到剪贴板失败", err);
        showToast("复制失败，请手动选择文本复制");
      });
    });
  }

  // 8. 第三行右侧：上下文浏览器 (7 大分类手风琴列表 + DNA 扁平逐条列表 + 真正差量比对，100% 对齐原版源码)
  // ==========================================================================
  // 大列表保护 + 条目详情懒渲染
  //   线上故障: WKWebView 一次性为 127 个条目渲染全文详情卡 (.lc-ts-card 内逐行 <span>),
  //   单卡几千行 -> DOM 22k 节点 / heap 35MB -> WebContent 进程被系统终止 (页面白屏)。
  //   这里改为「首次展开才渲染」+「单列表分块 400 条」。
  // ==========================================================================
  const BROWSER_ITEM_CHUNK = 400; // 单个列表一次性最多渲染 400 条, 其余点击「加载更多」追加

  /** 「还有 N 条，点击加载更多」提示行 (纯内联样式, 不依赖 style.css) */
  function createBrowserMoreRow(onLoadMore) {
    const row = document.createElement("div");
    row.className = "lc-br-more";
    row.style.cssText = "margin:4px 8px;padding:6px 10px;font-size:11px;line-height:1.6;text-align:center;color:var(--muted,#8b93a7);background:rgba(148,163,184,0.10);border:1px dashed rgba(148,163,184,0.35);border-radius:6px;cursor:pointer;user-select:none;";
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof onLoadMore === "function") onLoadMore();
    });
    return row;
  }

  /** 同步「还有 N 条」行的文案 / 显隐 */
  function updateBrowserMoreRow(row, remaining) {
    if (!row) return;
    if (remaining > 0) {
      row.textContent = "还有 " + remaining + " 条，点击加载更多";
    } else if (row.parentNode) {
      row.parentNode.removeChild(row);
    }
  }

  /**
   * 条目详情懒渲染: 首次展开 (.open) 时才注入 .lc-ts-card 并打上 data-rendered="1"。
   * 收起时不销毁, 因此复制按钮只在首次渲染时绑定一次 —— 不会重复绑定。
   */
  function ensureItemCard(itemRow, it, s, title, note) {
    const content = itemRow && itemRow.querySelector(".lc-br-content");
    if (!content) return;
    if (content.getAttribute("data-rendered") === "1") return;
    content.setAttribute("data-rendered", "1"); // 先打标记: 渲染失败也不会反复重试
    try {
      const fullText = getBandFullText(it, s);
      // 紧凑条目(大会话预算折叠): 正文没保留, 给明确提示而不是一张空白卡
      if (it && it.compact === 1 && !fullText) {
        const t = (it.toolName || title || "item");
        content.innerHTML = `<div class="lc-ts-card"><div class="lc-ts-card-head lc-ts-card-head-wrap"><span class="lc-ts-call-name">${escapeHtml(t)}</span><span class="lc-ts-card-right"><span class="lc-ts-card-meta">${formatK(it.tokens)}</span></span></div><div class="lc-ts-desc-body" style="padding:8px 10px;font-size:11px;line-height:1.6;color:var(--muted);">${escapeHtml(it.title || "")}<br/>该条目正文未保留（大会话仅保留最近若干步的完整正文，统计与计数完整）。</div></div>`;
        return;
      }
      const cleaned = normalizeCardText(fullText);
      const tagText = (it && (it.toolName || it.tag)) || title || "item";
      content.innerHTML = renderMessageCard(title, note, fullText, it && it.tokens, {
        tag: tagText,
        truncated: !!(it && it.truncated),
      });
      bindRichCopy(content, cleaned);
      bindCardViewToggle(content, cleaned);
    } catch (err) {
      console.error("[context] 条目详情渲染失败", err);
      content.innerHTML = "<div style=\"padding:8px 10px;font-size:11px;color:#f87171;\">详情渲染失败：" + escapeHtml((err && err.message) || String(err)) + "</div>";
    }
  }

  /** 上下文浏览器渲染失败时的可读错误态 (内联样式, 绝不留空白) */
  function renderBrowserErrorState(err) {
    const target = isDnaMode ? elBrowserFlatTree : elBrowserAccordionTree;
    if (!target) return;
    try { target.innerHTML = ""; } catch (e) { /* 忽略 */ }
    const box = document.createElement("div");
    box.setAttribute("data-role", "browser-error");
    box.style.cssText = "margin:8px;padding:10px 12px;border-radius:8px;border:1px solid rgba(248,113,113,0.45);background:rgba(248,113,113,0.10);color:#f87171;font-size:11.5px;line-height:1.6;";
    box.textContent = "上下文浏览器渲染失败：" + ((err && (err.message || String(err))) || "未知错误");
    target.appendChild(box);
  }

  // ── 图表 DNA 条带点选联动 (lc-pick-item) ───────────────────────────────────
  // 图表侧 dispatch(new CustomEvent("lc-pick-item", { detail:{stepIdx,turnIdx,catKey,itemKey} })),
  // 图表侧按模型读取顺序逐条绘制 (lcDnaItemBands); 这里负责: 切 step → 展开条目 → 滚动 + 短暂高亮。
  let browserSessionRef = null;   // 最近一次渲染的会话详情 (供监听器重渲染)
  let browserPickBound = false;   // window 监听只注册一次

  /**
   * DNA 逐条扁平列表的数据源: 按模型读取顺序展开 browserCategories
   * 顺序 = DSH_CATEGORIES (system→tools→user→inject→skill→assistant→tool), 类目内按 items 顺序。
   * 与图表 DNA 条带同序 —— 图表侧 lcDnaItemBands() 会把相邻同类合并、超 28 条并「其他」,
   * 这里逐条不合并, 保证「DNA 单列能看到逐条」。
   */
  function buildDnaFlatEntries(st) {
    const out = [];
    const cats = (st && st.browserCategories) || [];
    const byKey = new Map();
    cats.forEach(function (c) { if (c && c.key) byKey.set(c.key, c); });
    const seen = new Set();
    DSH_CATEGORIES.forEach(function (def) {
      const cat = byKey.get(def.key);
      const items = (cat && (cat.items || cat.list)) || [];
      seen.add(def.key);
      items.forEach(function (it) {
        out.push({
          cat: def.key,
          catName: (cat && (cat.name || cat.label)) || def.name || def.key,
          color: (cat && cat.color) || CANONICAL_COLORS[def.key] || def.color || "#6366f1",
          item: it,
        });
      });
    });
    // 兜底: 数据里出现 DSH_CATEGORIES 之外的分组时追加到末尾, 不丢条目
    cats.forEach(function (cat) {
      if (!cat || !cat.key || seen.has(cat.key)) return;
      const items = cat.items || cat.list || [];
      items.forEach(function (it) {
        out.push({
          cat: cat.key,
          catName: cat.name || cat.label || cat.key,
          color: cat.color || CANONICAL_COLORS[cat.key] || "#6366f1",
          item: it,
        });
      });
    });
    return out;
  }

  /** 短暂高亮 + 滚动到行 (优先 .lc-br-elem-flash, 兼容旧 .band-highlight) */
  function flashBrowserRow(elem) {
    if (!elem) return;
    elem.classList.add("lc-br-elem-flash");
    elem.classList.add("band-highlight");
    try { elem.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {
      try { elem.scrollIntoView(); } catch (e2) { /* noop */ }
    }
    setTimeout(function () {
      elem.classList.remove("lc-br-elem-flash");
      elem.classList.remove("band-highlight");
    }, 1600);
  }

  function findBrowserPickRow(tree, catKey, itemKey) {
    if (!tree) return null;
    const q = (sel) => { try { return tree.querySelector(sel); } catch (e) { return null; } };
    const esc = (v) => String(v == null ? "" : v).replace(/["\\]/g, "\\  function renderContextBrowser(s) {");
    let row = null;
    if (itemKey != null && itemKey !== "") row = q(`[data-item-key="${esc(itemKey)}"]`);
    if (!row && itemKey != null && catKey) row = q(`[data-cat="${esc(catKey)}"][data-item-key="${esc(itemKey)}"]`);
    if (!row && catKey) row = q(`[data-cat="${esc(catKey)}"]`);
    return row;
  }

  /**
   * 响应图表条带点选: 切到对应 step → 在列表里定位条目 → 展开 → scrollIntoView + 高亮。
   * 条目可能落在 400 条分块之后, 因此按需点击「还有 N 条」逐块加载 (上限 40 块)。
   */
  function applyBrowserPick(detail) {
    const pick = detail || {};
    const s = browserSessionRef;
    if (!s) return false;
    const steps = (s.dshContext && s.dshContext.steps) || [];
    const target = steps.find(sp => pick.stepIdx != null && sp.stepIdx === pick.stepIdx)
      || steps.find(sp => pick.turnIdx != null && sp.turnIdx === pick.turnIdx && sp.stepIdx === pick.stepIdx)
      || steps.find(sp => pick.turnIdx != null && sp.turnIdx === pick.turnIdx);
    if (target && activeStepIdx !== target.stepIdx) {
      activeStepIdx = target.stepIdx;
      renderContextBrowser(s);
    }

    const tree = isDnaMode ? elBrowserFlatTree : (elBrowserAccordionTree || elBrowserFlatTree);
    if (!tree) return false;

    let row = findBrowserPickRow(tree, pick.catKey, pick.itemKey);
    if (!row && isDnaMode) {
      let guard = 0;
      let more = tree.querySelector(".lc-br-more");
      while (!row && more && guard < 40) {
        guard += 1;
        try { more.click(); } catch (e) { break; }
        row = findBrowserPickRow(tree, pick.catKey, pick.itemKey);
        more = tree.querySelector(".lc-br-more");
      }
    }
    if (!row) return false;
    const elem = row.closest ? (row.closest(".lc-br-elem") || row) : row;
    if (isDnaMode && elem && !elem.classList.contains("open")) {
      const btn = elem.querySelector(".lc-br-elem-row");
      if (btn) { try { btn.click(); } catch (e) { /* noop */ } }
    } else if (!isDnaMode && elem) {
      // 手风琴模式: 展开所属分类节点
      const node = elem.closest && elem.closest(".lc-cat-node, .cat-node, .lc-acc-node");
      if (node) node.classList.add("open");
      const btn = elem.querySelector(".lc-br-elem-row");
      if (btn && !elem.classList.contains("open")) { try { btn.click(); } catch (e) { /* noop */ } }
    }
    flashBrowserRow(elem);
    return true;
  }

  /** 注册 window 监听 (只绑一次): 图表 DNA 条带 / 其他卡片都可能派发 lc-pick-item */
  function bindBrowserPickListener() {
    if (browserPickBound) return;
    browserPickBound = true;
    try {
      window.addEventListener("lc-pick-item", function (ev) {
        try { applyBrowserPick(ev && ev.detail); } catch (e) { console.warn("[context] 条目联动失败", e); }
      });
    } catch (e) { /* 非浏览器环境 */ }
  }

  function renderContextBrowser(s) {
    // 整段渲染兜底: 任何异常都降级成列表内的一行可读错误提示, 页面其余部分照常可用
    try {
      renderContextBrowserInner(s);
    } catch (err) {
      console.error("[context] 上下文浏览器渲染失败", err);
      try {
        renderBrowserErrorState(err);
      } catch (e2) {
        console.error("[context] 浏览器错误态渲染失败", e2);
      }
      // 同时在弹窗内显示可读错误态 (复用 #modalLoadError 结构), 让用户知道发生了什么
      try {
        showModalRenderError(err);
      } catch (e3) {
        console.error("[context] 弹窗错误态展示失败", e3);
      }
    }
  }

  function renderContextBrowserInner(s) {
    browserSessionRef = s;
    bindBrowserPickListener();
    const steps = s.dshContext?.steps || [];
    const curSelectedStepIdx = activeStepIdx === null ? steps[steps.length - 1]?.stepIdx : activeStepIdx;
    const curIdx = steps.findIndex(st => st.stepIdx === curSelectedStepIdx);
    const st = steps[curIdx >= 0 ? curIdx : steps.length - 1] || steps[0] || {};

    const elBrowserFlatTree = $("browserFlatTree");

    // 填充下拉框 (列出所有步骤)
    if (elBrowserStepDropdown) {
      elBrowserStepDropdown.innerHTML = `<option value="live" ${activeStepIdx === null ? 'selected' : ''}>当前 (下一次请求)</option>`;
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const opt = document.createElement("option");
        opt.value = String(step.stepIdx);
        opt.textContent = `第 ${step.turnIdx} 轮 · 第 ${step.stepIdx} 步 (${formatK(step.totalTokens)})`;
        if (activeStepIdx === step.stepIdx) opt.selected = true;
        elBrowserStepDropdown.appendChild(opt);
      }
    }

    if (elBrowserSelectedLabel) {
      elBrowserSelectedLabel.textContent = activeStepIdx === null ? "当前 · 下一次请求" : `第 ${st.turnIdx} 轮 · 第 ${st.stepIdx} 步`;
    }
    if (elBrowserEstimateTok) {
      elBrowserEstimateTok.textContent = `估算合计 ${formatK(Math.round((st.totalTokens || 919800) * 0.84))}`;
    }
    if (elBrowserActualTok) {
      elBrowserActualTok.innerHTML = `实际 <b>${formatK(st.totalTokens || 919800)}</b>`;
    }

    // 视图模式分流：块状占比地图 (Treemap) vs 列表滚动视图
    if (isTreemapMode) {
      if (elBrowserScroll) elBrowserScroll.style.display = "none";
      if (elBrowserTreemap) {
        elBrowserTreemap.style.display = "block";
        renderTreemap(s, st);
      }
      return;
    } else {
      if (elBrowserTreemap) elBrowserTreemap.style.display = "none";
      if (elBrowserScroll) elBrowserScroll.style.display = "block";
    }

    const cats = st.browserCategories || [];

    // 顶部分类颜色细条
    if (elBrowserColorBar) {
      elBrowserColorBar.innerHTML = "";
      cats.forEach(c => {
        const seg = document.createElement("div");
        seg.style.width = `${c.percent}%`;
        seg.style.backgroundColor = c.color;
        if (isDnaMode) {
          seg.style.boxShadow = "inset 0 0 2px rgba(255,255,255,0.4)";
        }
        elBrowserColorBar.appendChild(seg);
      });
    }

    // 确定对比基准：比前步 (prevStep) 或 比前轮最后一步 (prevTurnStep)
    let baseStep = null;
    if (diffMode === "step") {
      baseStep = (curIdx > 0) ? steps[curIdx - 1] : null;
    } else if (diffMode === "turn") {
      baseStep = (st.turnIdx > 1)
        ? [...steps].reverse().find(sp => sp.turnIdx === st.turnIdx - 1)
        : null;
    }

    // 收集基准步骤中的条目标识 (用于条目级新增高亮判定)
    const baseItemKeys = new Set();
    if (baseStep) {
      (baseStep.browserCategories || []).forEach(bc => {
        (bc.items || []).forEach((bi, bIdx) => {
          baseItemKeys.add(bi.id || `${bc.key}-${bi.idx || bIdx}-${bi.title}`);
        });
      });
    }

    // 视图模式分流：DNA 扁平阅读顺序 vs 7 大分类手风琴
    if (isDnaMode) {
      // DNA 扁平列表模式：逐条展示模型读取顺序 (超紧凑单行 .lc-br-elem 规范)
      if (elBrowserAccordionTree) elBrowserAccordionTree.style.display = "none";
      if (elBrowserFlatTree) {
        elBrowserFlatTree.style.display = "flex";
        elBrowserFlatTree.innerHTML = "";

        // 优先使用当前步骤的真实交替 DNA 条带 (消息与工具交替)
        const bandsSource = (st.dnaBands && st.dnaBands.length > 0)
          ? st.dnaBands
          : getStepDnaBands(st);

        // 倒排呈现：最新产生/读取的消息在最上方，向下回溯到工具与系统指令
        const allItems = bandsSource.slice().reverse();
        const totalBands = allItems.length;

        if (allItems.length === 0) {
          elBrowserFlatTree.innerHTML = `<div style="color:var(--muted); font-size:11px; padding:12px; text-align:center;">暂无条目</div>`;
        } else {
          allItems.forEach((it, order) => {
            const pos = totalBands - order;
            const itemKey = it.key || it.id || `${it.cat}-${order}-${it.title}`;
            const isNewItem = baseStep ? !baseItemKeys.has(itemKey) : false;

            const flatDiv = document.createElement("div");
            flatDiv.className = `lc-br-elem ${isNewItem ? 'is-new-item' : ''}`;
            flatDiv.setAttribute("data-item-key", itemKey);
            flatDiv.setAttribute("data-cat", it.cat || 'msg');

            const diffPrefix = isNewItem ? `<span class="diff" style="color:#34d399; font-weight:600; margin-right:3px;">+新进</span>` : '';
            const cat = it.cat || 'tool';
            const catColor = it.color || CANONICAL_COLORS[cat] || '#14b8a6';
            const tagText = it.toolName || cat || 'msg';
            const repBadge = (it.count && it.count > 1) ? ` × ${it.count}` : '';
            const timeStr = it.time || "";
            const stepLabel = `T${it.turnIdx || st.turnIdx} S${it.stepIdx || st.stepIdx}`;

            const fullText = getBandFullText(it, s);
            const cardHtml = renderMessageCard(it.title || tagText, it.snippet, fullText, it.tokens);

            flatDiv.innerHTML = `
              <button type="button" class="lc-br-elem-row" title="点击展开详情 / 定位步骤">
                <span class="lc-br-chev"></span>
                <span class="lc-br-pos">#${pos}</span>
                <span class="lc-br-tag tag-${cat}" style="background: color-mix(in srgb, ${catColor} 14%, transparent); border: 1px solid color-mix(in srgb, ${catColor} 45%, transparent); color: ${catColor};">${escapeHtml(tagText)}${repBadge}</span>
                <span class="lc-br-preview" title="${escapeHtml(it.snippet || it.title)}">${escapeHtml(it.snippet || it.title)}</span>
                <span class="lc-br-time">${stepLabel}${timeStr ? ` · ${timeStr}` : ''}</span>
                <span class="lc-br-tokens ${isNewItem ? 'new-tok' : ''}">${diffPrefix}≈${formatK(it.tokens).replace("≈","")}</span>
              </button>
              <div class="lc-br-content">
                ${cardHtml}
              </div>
            `;

            const rowBtn = flatDiv.querySelector(".lc-br-elem-row");
            rowBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              flatDiv.classList.toggle("open");
              if (it.stepIdx && it.stepIdx !== activeStepIdx) {
                activeStepIdx = it.stepIdx;
                activeTurnIdx = it.turnIdx || null;
                renderTrendBarsAndChart(s);
                renderStepBrief(s);
              }
            });

            bindRichCopy(flatDiv, fullText);

            elBrowserFlatTree.appendChild(flatDiv);
          });
        }
      }
    } else {
      // 7 大分类手风琴列表模式 (超紧凑单行 .lc-br-elem 规范)
      if (elBrowserFlatTree) elBrowserFlatTree.style.display = "none";
      if (elBrowserAccordionTree) {
        elBrowserAccordionTree.style.display = "flex";
        elBrowserAccordionTree.innerHTML = "";

        cats.forEach(c => {
          const isOpen = openedAccordionKeys.has(c.key);
          const catNode = document.createElement("div");
          catNode.className = `cat-node ${isOpen ? 'open' : ''}`;
          catNode.setAttribute("data-open", String(isOpen));
          catNode.setAttribute("data-cat", c.key);

          // 计算与基准 (比前步 / 比前轮) 的真实差异
          const baseCat = baseStep ? baseStep.browserCategories?.find(pc => pc.key === c.key) : null;
          const countDiff = baseStep ? (c.count - (baseCat?.count || 0)) : 0;
          const tokenDiff = baseStep ? (c.tokens - (baseCat?.tokens || 0)) : 0;

          let diffBadge = "";
          let diffTokText = "";

          if (baseStep) {
            if (countDiff > 0) {
              diffBadge = `<span class="cat-diff-tag" title="新增条目">[+${countDiff}]</span>`;
            } else if (countDiff < 0) {
              diffBadge = `<span class="cat-diff-tag" style="background:rgba(239,68,68,0.18);color:#f87171;" title="减少条目">[${countDiff}]</span>`;
            }

            if (tokenDiff !== 0) {
              const sign = tokenDiff > 0 ? "+" : "";
              const color = tokenDiff > 0 ? "#34d399" : "#f87171";
              diffTokText = `<span style="color:${color}; font-size:10px; font-weight:600;">${sign}${formatK(tokenDiff).replace("≈","")}</span>`;
            }
          }

          const catHead = document.createElement("div");
          catHead.className = "cat-head";

          catHead.innerHTML = `
            <div class="cat-head-left">
              <svg class="cat-chev" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
              </svg>
              <span class="cat-sq" style="background: ${c.color};"></span>
              <span class="cat-name">${escapeHtml(c.name)}</span>
              <span class="cat-count">${c.count} 项</span>
              ${diffBadge}
            </div>
            <div class="cat-head-right">
              ${diffTokText}
              <span class="tok">${escapeHtml(c.formatted)}</span>
              <span class="pct">${c.percent}%</span>
            </div>
          `;

          // 点击头部展开/收起
          catHead.addEventListener("click", (e) => {
            e.stopPropagation();
            const willOpen = !catNode.classList.contains("open");
            catNode.classList.toggle("open", willOpen);
            catNode.setAttribute("data-open", String(willOpen));
            if (willOpen) {
              openedAccordionKeys.add(c.key);
            } else {
              openedAccordionKeys.delete(c.key);
            }
          });

          catNode.appendChild(catHead);

          // 分类条目明细 (超紧凑单行结构，对齐原版)
          const catBody = document.createElement("div");
          catBody.className = "cat-body";

          const items = c.items || [];
          const catCount = Number(c.count) || 0;
          // 该分类在这一步确实没有任何内容 → 直接不渲染这个空分类(避免整片『暂无』)
          if (items.length === 0 && catCount === 0) {
            return;
          }
          if (items.length === 0) {
            const keepSteps = (s && s.dshContext && s.dshContext.sessionMeta && s.dshContext.sessionMeta.browserCategoriesKeepSteps) || 120;
            catBody.innerHTML = c.itemsTrimmed
              ? `<div class="lc-br-folded-hint">该分类明细已折叠（仅保留最近 ${keepSteps} 步全文，${catCount} 项 · 计数与 token 完整）</div>`
              : `<div class="lc-br-folded-hint">该分类在此步骤有 ${catCount} 项，但未保留独立条目明细</div>`;
          } else {
            // 条目行构建 (详情卡延迟到首次展开时才渲染, 见 ensureItemCard)
            const buildAccordionItemRow = (it, itIdx) => {
              const itemRow = document.createElement("div");
              const itemKey = it.id || it.key || `${c.key}-${it.idx || itIdx}-${it.title}`;
              const isNewItem = baseStep ? !baseItemKeys.has(itemKey) : false;
              itemRow.className = `lc-br-elem ${isNewItem ? 'is-new-item' : ''}`;
              itemRow.setAttribute("data-item-key", itemKey);
              itemRow.setAttribute("data-cat", c.key);

              let itemDiffBadge = "";
              if (isNewItem) {
                itemDiffBadge = `<span class="diff" style="color:#34d399; font-weight:600; margin-right:3px;">+${formatK(it.tokens).replace("≈","")}</span>`;
              } else if (it.diff && it.diff !== "+0") {
                itemDiffBadge = `<span class="diff" style="margin-right:3px;">${escapeHtml(it.diff)}</span>`;
              }

              const tagText = it.toolName || it.tag || c.name;
              const tagCls = `tag-${c.key}`;
              const catColor = c.color || CANONICAL_COLORS[c.key] || '#6366f1';
              const timeStr = it.time || "";
              const stepLabel = `T${st.turnIdx} S${st.stepIdx}`;

              itemRow.innerHTML = `
                <button type="button" class="lc-br-elem-row" title="点击展开/折叠详情">
                  <span class="lc-br-chev"></span>
                  <span class="lc-br-pos">#${it.idx || (itIdx + 1)}</span>
                  <span class="lc-br-tag ${tagCls}" style="background: color-mix(in srgb, ${catColor} 14%, transparent); border: 1px solid color-mix(in srgb, ${catColor} 45%, transparent); color: ${catColor};">${escapeHtml(tagText)}</span>
                  <span class="lc-br-preview" title="${escapeHtml(it.snippet || it.title)}">${escapeHtml(it.snippet || it.title)}</span>
                  <span class="lc-br-time">${stepLabel}${timeStr ? ` · ${timeStr}` : ''}</span>
                  <span class="lc-br-tokens ${isNewItem ? 'new-tok' : ''}">${itemDiffBadge}≈${formatK(it.tokens).replace("≈","")}</span>
                </button>
                <div class="lc-br-content" data-rendered="0"></div>
              `;

              const rowBtn = itemRow.querySelector(".lc-br-elem-row");
              rowBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                itemRow.classList.toggle("open");
                // 首次展开时才渲染全文详情卡, 之后复用 (复制按钮只绑定一次)
                if (itemRow.classList.contains("open")) {
                  ensureItemCard(itemRow, it, s, it.title || tagText, it.snippet);
                }
              });

              return itemRow;
            };

            // 大列表保护: 单个分类一次性最多渲染 400 条, 其余点击「还有 N 条」再追加 400 条
            const itemsMoreRow = createBrowserMoreRow(() => appendAccordionChunk());
            let itemsRendered = 0;

            const appendAccordionChunk = () => {
              if (!itemsMoreRow.parentNode) catBody.appendChild(itemsMoreRow);
              const end = Math.min(itemsRendered + BROWSER_ITEM_CHUNK, items.length);
              const frag = document.createDocumentFragment();
              for (let itIdx = itemsRendered; itIdx < end; itIdx++) {
                frag.appendChild(buildAccordionItemRow(items[itIdx], itIdx));
              }
              catBody.insertBefore(frag, itemsMoreRow);
              itemsRendered = end;
              updateBrowserMoreRow(itemsMoreRow, items.length - itemsRendered);
            };

            appendAccordionChunk();
          }

          catNode.appendChild(catBody);
          elBrowserAccordionTree.appendChild(catNode);
        });
      }
    }
  }

  // 9. 第四行左侧：上下文事件卡片 (100% 对齐原版 lc-events-card 规范)
  function renderEventsCard(s) {
    if (!s) return;
    const dc = s.dshContext || {};
    // 真实数据优先; 缺失时走官方 events.empty 空态 (绝不伪造事件)
    const events = Array.isArray(dc.events) ? dc.events : [];

    const countInject = events.filter(e => e.kind === "inject").length;
    const countCompact = events.filter(e => e.kind === "compaction").length;
    const countPrune = events.filter(e => e.kind === "prune").length;

    if (elChipInjectCount) elChipInjectCount.textContent = String(countInject);
    if (elChipCompactCount) elChipCompactCount.textContent = String(countCompact);
    if (elChipPruneCount) elChipPruneCount.textContent = String(countPrune);

    let filtered = events;
    if (eventsKindFilter !== "all") {
      filtered = events.filter(e => e.kind === eventsKindFilter);
    }

    if (!elEventsListContainer) return;
    if (filtered.length === 0) {
      // 官方 events.empty / events.noMatch
      const emptyText = events.length === 0
        ? "暂无上下文事件（压缩、注入、模型切换会出现在这里）"
        : "没有匹配当前过滤条件的事件";
      elEventsListContainer.innerHTML = `<div class="lc-empty lc-lane">${emptyText}</div>`;
      return;
    }

    const list = filtered.slice().reverse();
    elEventsListContainer.innerHTML = list.map(ev => {
      let icon = ev.icon || (ev.kind === "inject" ? "+" : (ev.kind === "model" ? "⤹" : (ev.kind === "compaction" ? "🗜" : "✄")));
      let kindLabel = ev.kind === "inject" ? "注入" : (ev.kind === "compaction" ? "压缩" : (ev.kind === "prune" ? "剪枝" : (ev.kind === "mode" ? "模式" : "切换")));
      let tokensHtml = "";
      if (ev.tokens) {
        const isUp = ev.tokens > 0;
        tokensHtml = `<span class="lc-event-tokens ${isUp ? 'up' : 'down'}">${isUp ? '+' : '−'}${formatK(Math.abs(ev.tokens)).replace("≈","")}</span>`;
      }
      return `
        <div class="lc-event" data-turn="${ev.turn || 1}" data-step="${ev.step || 1}" title="点击定位到该步骤">
          <span class="lc-event-icon lc-event-${ev.kind}">${icon}</span>
          <span class="lc-kind lc-kind-${ev.kind}">${kindLabel}</span>
          <span class="lc-event-desc">${escapeHtml(ev.desc || ev.name || '')}</span>
          <span class="lc-event-at">${escapeHtml(ev.at || `T${ev.turn||1}`)}</span>
          ${tokensHtml}
          <span class="lc-event-time">${escapeHtml(ev.timeText || ev.clock || (typeof ev.time === 'string' ? ev.time : '') || '')}</span>
        </div>
      `;
    }).join("");

    elEventsListContainer.querySelectorAll(".lc-event").forEach(el => {
      el.addEventListener("click", () => {
        const t = Number(el.dataset.turn) || 1;
        const stNum = Number(el.dataset.step) || 1;
        activeTurnIdx = t;
        const steps = s.dshContext?.steps || [];
        const found = steps.find(sp => sp.turnIdx === t && sp.stepIdx === stNum) || steps.find(sp => sp.turnIdx === t);
        if (found) activeStepIdx = found.stepIdx;
        renderTrendBarsAndChart(s);
        renderStepBrief(s);
        renderContextBrowser(s);
        showToast(`已定位到第 ${t} 轮上下文`);
      });
    });
  }

  // 10. 第四行右侧：文件活动卡片 (100% 对齐原版 lc-fa-card 规范)
  function renderFilesCard(s) {
    if (!s) return;
    const dc = s.dshContext || {};
    // 真实数据优先; 字段缺失时按空态渲染 (绝不注入 mock 假数据)
    const fileOps = Array.isArray(dc.fileOps) ? dc.fileOps : [];

    let totalAdd = 0;
    let totalRem = 0;
    let totalReads = 0;
    let totalWrites = 0;
    let totalSearches = 0;
    let totalImages = 0;

    fileOps.forEach(f => {
      if (!f) return;
      totalAdd += f.added || 0;
      totalRem += f.removed || 0;
      totalReads += f.reads || (f.op === "read" ? f.count || 1 : 0);
      totalWrites += f.writes || (f.op === "write" ? f.count || 1 : 0);
      totalSearches += f.searches || (f.op === "search" ? f.count || 1 : 0);
      totalImages += f.images || f.image || (f.op === "image" ? f.count || 1 : 0);
    });

    if (elFaFilesCount) elFaFilesCount.textContent = String(fileOps.length);
    if (elFaDeltaSpan) {
      elFaDeltaSpan.innerHTML = `<b class="lc-fa-up">+${formatK(totalAdd).replace("≈","")}</b> <b class="lc-fa-down">−${formatK(totalRem).replace("≈","")}</b>`;
    }

    if (elFaChipAll) elFaChipAll.textContent = String(totalReads + totalWrites + totalSearches + totalImages);
    if (elFaChipRead) elFaChipRead.textContent = String(totalReads);
    if (elFaChipWrite) elFaChipWrite.textContent = String(totalWrites);
    if (elFaChipSearch) elFaChipSearch.textContent = String(totalSearches);
    if (elFaChipImage) elFaChipImage.textContent = String(totalImages);

    let filtered = fileOps;
    if (faOpFilter === "read") {
      filtered = filtered.filter(f => (f.reads > 0) || f.op === "read");
    } else if (faOpFilter === "write") {
      filtered = filtered.filter(f => (f.writes > 0) || f.op === "write");
    } else if (faOpFilter === "search") {
      filtered = filtered.filter(f => (f.searches > 0) || f.op === "search");
    } else if (faOpFilter === "image") {
      filtered = filtered.filter(f => (f.images > 0) || (f.image > 0) || f.op === "image");
    }

    if (faSearchQ) {
      filtered = filtered.filter(f => String(f.path || "").toLowerCase().includes(faSearchQ));
    }

    filtered = filtered.slice().sort((a, b) => {
      if (faSort === "count") return ((b.reads || 0) + (b.writes || 0)) - ((a.reads || 0) + (a.writes || 0));
      if (faSort === "lines") return ((b.added || 0) + (b.removed || 0)) - ((a.added || 0) + (a.removed || 0));
      if (faSort === "latest") return (b.lastTurn || 0) - (a.lastTurn || 0);
      if (faSort === "name") return (a.name || "").localeCompare(b.name || "");
      return (a.path || "").localeCompare(b.path || "");
    });

    if (!elFaListContainer) return;
    if (filtered.length === 0) {
      // 官方 files.empty / files.noMatch: 区分"该范围本来就没有操作"与"过滤后无匹配"
      const emptyText = fileOps.length === 0
        ? "该范围内没有文件读取、写入或搜索操作"
        : "没有匹配当前过滤条件的文件";
      elFaListContainer.innerHTML = `<div class="lc-empty lc-lane">${emptyText}</div>`;
      return;
    }

    elFaListContainer.innerHTML = filtered.map(f => {
      const glyph = getFileLangGlyph(f.path);
      const lastSlash = f.path.lastIndexOf("/");
      const dir = lastSlash >= 0 ? f.path.slice(0, lastSlash + 1) : "";
      const fname = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path;

      let rBadge = f.reads > 0 ? `<span class="lc-fa-badge lc-fa-b-read" title="读取次数"><i></i>${f.reads}</span>` : "";
      let wBadge = f.writes > 0 ? `<span class="lc-fa-badge lc-fa-b-write" title="写入次数"><i></i>${f.writes}</span>` : "";
      let sBadge = f.searches > 0 ? `<span class="lc-fa-badge lc-fa-b-search" title="搜索次数"><i></i>${f.searches}</span>` : "";
      let deltaHtml = "";
      if ((f.added || 0) + (f.removed || 0) > 0) {
        deltaHtml = `
          <span class="lc-fa-delta" style="font-size:10px; font-family:var(--code);">
            ${f.added ? `<b class="lc-fa-up">+${formatK(f.added).replace("≈","")}</b>` : ''}
            ${f.removed ? `<b class="lc-fa-down">−${formatK(f.removed).replace("≈","")}</b>` : ''}
          </span>
        `;
      }

      return `
        <div class="lc-fa-item" data-path="${escapeHtml(f.path)}">
          <div class="lc-fa-row" title="${escapeHtml(f.path)}">
            <button type="button" class="lc-fa-toggle" title="展开操作详情">
              <span class="lc-br-chev"></span>
              <span class="lc-fa-form" style="background:${glyph.bg}; color:${glyph.color};">${glyph.text}</span>
            </button>
            <span class="lc-fa-path">
              ${dir ? `<em>${escapeHtml(dir)}</em>` : ''}<b>${escapeHtml(fname)}</b>
            </span>
            ${rBadge}
            ${wBadge}
            ${sBadge}
            ${deltaHtml}
            <span class="lc-fa-time">${escapeHtml(f.time || '')}</span>
          </div>
          <div class="lc-fa-ops">
            ${(f.operations && f.operations.length > 0 ? f.operations : [
              ...(f.reads ? [{ tool: 'read_file', detail: '读取文件内容', time: f.time, turn: f.lastTurn, op: 'read' }] : []),
              ...(f.writes ? [{ tool: 'write_file', detail: `写入/修改文件 (+${f.added || 0} / -${f.removed || 0})`, time: f.time, turn: f.lastTurn, op: 'write' }] : []),
              ...(f.searches ? [{ tool: 'search_files', detail: '检索匹配文件', time: f.time, turn: f.lastTurn, op: 'search' }] : [])
            ]).map(op => `
              <div class="lc-fa-op lc-fa-op-link">
                <span class="lc-fa-op-tool">${escapeHtml(op.tool || (op.op === 'write' ? 'write_file' : 'read_file'))}</span>
                <span class="lc-fa-op-detail">${escapeHtml(op.detail || (op.op === 'write' ? '写入文件' : '读取文件'))}</span>
                <div class="lc-fa-op-meta">
                  <span class="lc-fa-op-time">T${op.turn || f.lastTurn || 1} · ${escapeHtml(op.time || f.time || '')}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join("");

    elFaListContainer.querySelectorAll(".lc-fa-item").forEach(item => {
      item.querySelector(".lc-fa-row").addEventListener("click", () => {
        item.classList.toggle("open");
        item.classList.toggle("lc-fa-item-on");
      });
    });
  }

  // 11. 第五行：命令执行卡片 (100% 对齐原版 lc-cmd-card 左右分栏规范)
  function renderCommandsCard(s) {
    if (!s) return;
    const dc = s.dshContext || {};
    // 真实数据优先; 缺失时走空态 (官方 cmds.empty), 绝不注入 mock 命令
    const commands = Array.isArray(dc.commands) ? dc.commands : [];

    const totalRuns = commands.length;
    const failedCmds = commands.filter(c => c.status === "failed" || c.status === "killed");
    const slowCmds = commands.filter(c => (c.ms || 0) >= 1000);
    const bgCmds = commands.filter(c => c.background || (c.cmd && c.cmd.includes("&")));

    let totalMs = 0;
    commands.forEach(c => totalMs += (c.ms || 0));

    if (elCmdChipAll) elCmdChipAll.textContent = String(totalRuns);
    if (elCmdChipFailed) elCmdChipFailed.textContent = String(failedCmds.length);
    if (elCmdChipSlow) elCmdChipSlow.textContent = String(slowCmds.length);
    if (elCmdChipBg) elCmdChipBg.textContent = String(bgCmds.length);

    if (elCmdKpiRuns) elCmdKpiRuns.textContent = totalRuns > 1000 ? `${(totalRuns/1000).toFixed(1)}k` : String(totalRuns);
    if (elCmdKpiTime) elCmdKpiTime.textContent = formatDurationSeconds(Math.round(totalMs / 1000));
    if (elCmdKpiFail) {
      const failRate = totalRuns ? ((failedCmds.length / totalRuns) * 100).toFixed(1) : "0.0";
      elCmdKpiFail.textContent = `${failedCmds.length} (${failRate}%)`;
    }
    if (elCmdKpiBg) elCmdKpiBg.textContent = String(bgCmds.length);

    let slowest = commands[0];
    commands.forEach(c => {
      if ((c.ms || 0) > (slowest?.ms || 0)) slowest = c;
    });
    if (elCmdSlowestText) {
      elCmdSlowestText.textContent = slowest ? `${slowest.program || String(slowest.cmd || "").slice(0, 12)} (${formatDurationSeconds(Math.round((slowest.ms || 0) / 1000))})` : "—";
      elCmdSlowestText.title = slowest?.cmd || "";
    }

    const failProgramMap = new Map();
    failedCmds.forEach(c => {
      const p = c.program || c.cmd.split(" ")[0] || "shell";
      failProgramMap.set(p, (failProgramMap.get(p) || 0) + 1);
    });
    let mostFail = null;
    for (const [p, cnt] of failProgramMap.entries()) {
      if (!mostFail || cnt > mostFail.cnt) mostFail = { p, cnt };
    }
    if (elCmdMostFailText) {
      elCmdMostFailText.textContent = mostFail ? `${mostFail.p} ×${mostFail.cnt}` : "无失败记录";
    }

    const cmdFreq = new Map();
    commands.forEach(c => {
      cmdFreq.set(c.cmd, (cmdFreq.get(c.cmd) || 0) + 1);
    });
    let mostRepeat = null;
    for (const [cmd, cnt] of cmdFreq.entries()) {
      if (cnt > 1 && (!mostRepeat || cnt > mostRepeat.cnt)) mostRepeat = { cmd, cnt };
    }
    if (elCmdMostRepeatText) {
      elCmdMostRepeatText.textContent = mostRepeat ? `${mostRepeat.cmd.slice(0, 20)}... ×${mostRepeat.cnt}` : "—";
      elCmdMostRepeatText.title = mostRepeat?.cmd || "";
    }

    const progMap = new Map();
    commands.forEach(c => {
      const p = c.program || c.cmd.split(" ")[0] || "shell";
      progMap.set(p, (progMap.get(p) || 0) + 1);
    });
    const progRank = Array.from(progMap.entries()).sort((a, b) => b[1] - a[1]);

    if (elCmdProgsContainer) {
      elCmdProgsContainer.innerHTML = progRank.slice(0, 10).map(([p, cnt]) => `
        <div class="prog-item ${cmdProgramFilter === p ? 'on' : ''}" data-prog="${escapeHtml(p)}" title="点击仅看 ${escapeHtml(p)}">
          <span class="p-name"><i class="p-dot"></i>${escapeHtml(p)}</span>
          <span class="p-cnt">×${cnt}</span>
        </div>
      `).join("");

      elCmdProgsContainer.querySelectorAll(".prog-item").forEach(pi => {
        pi.addEventListener("click", () => {
          const pr = pi.dataset.prog;
          cmdProgramFilter = cmdProgramFilter === pr ? null : pr;
          renderCommandsCard(s);
          if (cmdProgramFilter) showToast(`已过滤程序: ${cmdProgramFilter}`);
        });
      });
    }

    let filtered = commands;
    if (cmdFilter === "failed") {
      filtered = filtered.filter(c => c.status === "failed" || c.status === "killed");
    } else if (cmdFilter === "slow") {
      filtered = filtered.filter(c => (c.ms || 0) >= 1000);
    } else if (cmdFilter === "bg") {
      filtered = filtered.filter(c => c.background || (c.cmd && c.cmd.includes("&")));
    }

    if (cmdProgramFilter) {
      filtered = filtered.filter(c => (c.program || String(c.cmd || "").split(" ")[0]) === cmdProgramFilter);
    }

    if (cmdSearchQ) {
      filtered = filtered.filter(c => String(c.cmd || "").toLowerCase().includes(cmdSearchQ) || (c.program && c.program.toLowerCase().includes(cmdSearchQ)));
    }

    filtered = filtered.slice().sort((a, b) => {
      if (cmdSort === "slowest") return (b.ms || 0) - (a.ms || 0);
      return (b.turn || 0) - (a.turn || 0) || (b.step || 0) - (a.step || 0);
    });

    if (!elCmdListContainer) return;
    if (filtered.length === 0) {
      // 官方 cmds.empty / cmds.noMatch
      const emptyText = commands.length === 0
        ? "本会话没有执行过命令"
        : "没有匹配当前过滤条件的命令";
      elCmdListContainer.innerHTML = `<div class="lc-empty lc-lane">${emptyText}</div>`;
      return;
    }

    elCmdListContainer.innerHTML = filtered.map(c => {
      const isOk = c.status !== "failed" && c.status !== "killed";
      const durText = c.ms ? (c.ms >= 1000 ? `≈${(c.ms/1000).toFixed(1)}s` : `≈${c.ms}ms`) : "<10ms";
      const timeStr = c.time || "";
      const stepStr = (c.turn && c.step) ? `T${c.turn} S${c.step}` : (c.turn ? `T${c.turn}` : '');
      const metaTime = [stepStr, timeStr].filter(Boolean).join(" · ");

      return `
        <div class="lc-cmd-item" data-seq="${c.seq || 0}">
          <div class="lc-cmd-row-line" title="${escapeHtml(c.cmd)}">
            <span class="lc-br-chev"></span>
            <span class="cmd-status ${isOk ? 'ok' : 'fail'}">${isOk ? '✓' : '✕'}</span>
            <span class="cmd-tag">${escapeHtml(c.tag || c.program || 'CLI')}</span>
            <span class="cmd-text">${escapeHtml(c.cmd)}</span>
            <span class="cmd-dur">${durText}</span>
            <span class="cmd-time">${escapeHtml(metaTime)}</span>
          </div>
          <div class="lc-cmd-payload">
            <div class="lc-br-content-tools">
              <button type="button" class="lc-br-copy-btn">复制命令</button>
            </div>
            <div><code>${escapeHtml(c.cmd)}</code></div>
            ${c.output ? `<div style="margin-top:6px; opacity:0.85; border-top:1px dashed var(--line-2); padding-top:4px;">${escapeHtml(c.output)}</div>` : ''}
          </div>
        </div>
      `;
    }).join("");

    elCmdListContainer.querySelectorAll(".lc-cmd-item").forEach(item => {
      item.querySelector(".lc-cmd-row-line").addEventListener("click", () => {
        item.classList.toggle("open");
      });
      const copyBtn = item.querySelector(".lc-br-copy-btn");
      if (copyBtn) {
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const cmdText = item.querySelector("code")?.textContent || "";
          navigator.clipboard.writeText(cmdText).then(() => {
            showToast("已复制命令文本");
          });
        });
      }
    });
  }

  // ==========================================================================
  // 事件绑定与监听 (100% 对齐原版交互)
  // ==========================================================================

  function initEvents() {
    // 1. Agent 分段筛选切换
    if (elAgentSegs) {
      elAgentSegs.addEventListener("click", (e) => {
        const btn = e.target.closest(".opt");
        if (!btn) return;
        elAgentSegs.querySelectorAll(".opt").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        activeAgentFilter = btn.dataset.agent || "all";
        renderWorkspaceTree();
      });
    }

    // 2. 搜索输入过滤
    if (elSessQ) {
      elSessQ.addEventListener("input", (e) => {
        searchQuery = e.target.value.trim();
        renderWorkspaceTree();
      });
    }

    // 3. 弹窗关闭事件 (关闭按钮、遮罩点击、Escape 按键)
    if (elBtnModalClose) {
      elBtnModalClose.addEventListener("click", () => {
        closeSessionModal();
      });
    }

    if (elDshContextModal) {
      elDshContextModal.addEventListener("click", (e) => {
        if (e.target === elDshContextModal) {
          closeSessionModal();
        }
      });
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && elDshContextModal?.classList.contains("open")) {
        closeSessionModal();
      }
    });

    // 4. 上下文浏览器步骤下拉框切换
    if (elBrowserStepDropdown) {
      elBrowserStepDropdown.addEventListener("change", (e) => {
        const val = e.target.value;
        activeStepIdx = val === "live" ? null : Number(val);
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) {
          renderTrendBarsAndChart(s);
          renderStepBrief(s);
          renderContextBrowser(s);
        }
      });
    }

    // 5. 全部展开/全部收起手风琴分类与所有条目详情 (支持 DNA 扁平列表与 7 大分类)
    if (elBtnToggleAllAccordions) {
      let isAllExpanded = false;
      elBtnToggleAllAccordions.addEventListener("click", () => {
        isAllExpanded = !isAllExpanded;
        elBtnToggleAllAccordions.textContent = isAllExpanded ? "收起全部" : "展开全部";

        if (isDnaMode) {
          const flatItems = elBrowserFlatTree?.querySelectorAll(".lc-br-elem") || [];
          flatItems.forEach(item => {
            item.classList.toggle("open", isAllExpanded);
          });
        } else {
          const allNodes = elBrowserAccordionTree?.querySelectorAll(".cat-node") || [];
          allNodes.forEach(node => {
            node.classList.toggle("open", isAllExpanded);
            node.setAttribute("data-open", String(isAllExpanded));
            const catKey = node.getAttribute("data-cat");
            if (catKey) {
              if (isAllExpanded) openedAccordionKeys.add(catKey);
              else openedAccordionKeys.delete(catKey);
            }
          });
          const itemRows = elBrowserAccordionTree?.querySelectorAll(".lc-br-elem") || [];
          itemRows.forEach(row => {
            row.classList.toggle("open", isAllExpanded);
          });
        }
        showToast(isAllExpanded ? "已展开全部明细内容" : "已折叠全部明细内容");
      });
    }

    // 5.1 块状占比地图 (Treemap) 切换按钮 (对标原版 lc-br-map-btn)
    if (elBtnLayoutToggle) {
      elBtnLayoutToggle.addEventListener("click", () => {
        isTreemapMode = !isTreemapMode;
        elBtnLayoutToggle.classList.toggle("on", isTreemapMode);
        showToast(isTreemapMode ? "已切换至【块状占比地图】" : "已返回【条目列表模式】");
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderContextBrowser(s);
      });
    }

    // 6. 趋势图工具栏：DNA 模式 (原版逻辑：与总览互斥)
    const toggleDna = () => {
      isDnaMode = !isDnaMode;
      if (isDnaMode) isOverview = false; // 开启 DNA 时自动关闭总览
      elBtnDnaMode?.classList.toggle("on", isDnaMode);
      elBtnBrowserDna?.classList.toggle("on", isDnaMode);
      elBtnOverview?.classList.toggle("on", isOverview);
      showToast(`已${isDnaMode ? '开启' : '关闭'} DNA 指纹模式`);
      const s = getSessionDetailOrIndex(activeModalSessionId);
      if (s) {
        renderTrendBarsAndChart(s);
        renderContextBrowser(s);
      }
    };
    elBtnDnaMode?.addEventListener("click", toggleDna);
    elBtnBrowserDna?.addEventListener("click", toggleDna);

    // 7. 趋势图工具栏：自适应模式 (原版逻辑：局部最大 vs 全局上限，与总览互斥)
    if (elBtnAdaptive) {
      elBtnAdaptive.addEventListener("click", () => {
        isAdaptive = !isAdaptive;
        if (isAdaptive) isOverview = false;
        elBtnAdaptive.classList.toggle("on", isAdaptive);
        elBtnOverview?.classList.toggle("on", isOverview);
        showToast(`已${isAdaptive ? '启用' : '关闭'}自适应缩放`);
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderTrendBarsAndChart(s);
      });
    }

    // 8. 趋势图工具栏：耗时折线开关 (原版逻辑：控制绿色耗时曲线和右轴时间刻度)
    if (elBtnDurationCurve) {
      elBtnDurationCurve.addEventListener("click", () => {
        showDurationCurve = !showDurationCurve;
        elBtnDurationCurve.classList.toggle("on", showDurationCurve);
        showToast(`已${showDurationCurve ? '显示' : '隐藏'}耗时折线`);
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderTrendBarsAndChart(s);
      });
    }

    // 9. 趋势图工具栏：总览模式 (原版逻辑：取消横向滚动，全宽挤压铺满，与 DNA、自适应互斥)
    if (elBtnOverview) {
      elBtnOverview.addEventListener("click", () => {
        isOverview = !isOverview;
        if (isOverview) {
          isDnaMode = false;
          isAdaptive = false;
          elBtnDnaMode?.classList.remove("on");
          elBtnBrowserDna?.classList.remove("on");
          elBtnAdaptive?.classList.remove("on");
        }
        elBtnOverview.classList.toggle("on", isOverview);
        showToast(`已${isOverview ? '开启' : '关闭'}总览模式`);
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderTrendBarsAndChart(s);
      });
    }

    // 10. 粒度切换：步骤 (Step) vs 轮次 (Turn)
    if (elGranularitySegs) {
      elGranularitySegs.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-opt");
        if (!btn) return;
        elGranularitySegs.querySelectorAll(".m-opt").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        trendGranularity = btn.dataset.gran || "step";
        showToast(`已切换为【${trendGranularity === 'step' ? '步骤' : '轮次'}】视图`);
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) {
          renderTrendBarsAndChart(s);
          renderStepBrief(s);
        }
      });
    }

    // 11. 模式切换：全量 (Total) vs 增量 (Delta)
    if (elModeSegs) {
      elModeSegs.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-opt");
        if (!btn) return;
        elModeSegs.querySelectorAll(".m-opt").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        trendMode = btn.dataset.mode || "total";
        showToast(`已切换为【${trendMode === 'total' ? '全量累计' : '单步增量'}】模式`);
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderTrendBarsAndChart(s);
      });
    }

    // 12. 差异对比按钮：比前步 (Diff Step) 与 比前轮 (Diff Turn) (单选互斥，对标原版 deltaBase)
    if (elBtnDiffStep) {
      elBtnDiffStep.addEventListener("click", () => {
        diffMode = "step";
        elBtnDiffStep.classList.add("on");
        if (elBtnDiffTurn) elBtnDiffTurn.classList.remove("on");
        showToast("已切换对比基线：比前步");
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderContextBrowser(s);
      });
    }

    if (elBtnDiffTurn) {
      elBtnDiffTurn.addEventListener("click", () => {
        diffMode = "turn";
        elBtnDiffTurn.classList.add("on");
        if (elBtnDiffStep) elBtnDiffStep.classList.remove("on");
        showToast("已切换对比基线：比前轮");
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderContextBrowser(s);
      });
    }

    // 13. 窗口尺寸自适应重绘 (防自激: rAF 合并 + 尺寸去重 + 渲染重入保护)
    //     旧实现直接在 ResizeObserver 回调里同步重绘趋势图, 而重绘会重建 700+ 个 .lc-bar
    //     并可能改变被观察容器的尺寸 (滚动条出现/消失), 形成 resize -> 重绘 -> 再 resize 的死循环,
    //     主线程持续抖动 + DOM 反复重建, 最终在 WKWebView 里放大内存占用。
    if (window.ResizeObserver && elTrendChartWrap) {
      let trendResizeRaf = null;
      let lastTrendBox = { w: -1, h: -1 };
      let isRenderingTrend = false;

      const scheduleTrendRedraw = () => {
        if (trendResizeRaf !== null) return; // 同一帧只重绘一次 (coalesce)
        trendResizeRaf = requestAnimationFrame(() => {
          trendResizeRaf = null;
          if (isRenderingTrend) return; // 渲染期间的重入直接跳过
          const rect = elTrendChartWrap.getBoundingClientRect();
          const w = Math.round(rect.width);
          const h = Math.round(rect.height);
          if (w === lastTrendBox.w && h === lastTrendBox.h) return; // 尺寸没变不重绘
          lastTrendBox = { w, h };
          if (!activeModalSessionId) return;
          const s = getSessionById(activeModalSessionId); // 轻量: 只取索引/已缓存详情, 不触发详情加载
          if (!s) return;
          isRenderingTrend = true;
          try {
            renderTrendBarsAndChart(s);
          } catch (err) {
            console.error("[context] 趋势图重绘失败", err);
          } finally {
            isRenderingTrend = false;
          }
        });
      };

      const ro = new ResizeObserver(() => { scheduleTrendRedraw(); });
      ro.observe(elTrendChartWrap);
    }

    // 14. 刷新数据: 只重新拉取轻量索引 (cache-bust) 并重渲染, 不再整页 reload (旧版刷新会重新下载 122MB)
    if (elBtnRefresh) {
      elBtnRefresh.addEventListener("click", () => {
        refreshIndexData();
      });
    }

    // 14.1 详情加载失败后的重试按钮 (弹窗内错误态)
    const elBtnModalRetry = $("btnModalRetry");
    if (elBtnModalRetry) {
      elBtnModalRetry.addEventListener("click", () => {
        const sessionId = activeModalSessionId;
        if (!sessionId) return;
        renderSkeleton(true);
        loadModalDetail(sessionId);
      });
    }

    // 15. 上下文事件类型过滤
    if (elEventsKindChips) {
      elEventsKindChips.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-chip");
        if (!btn) return;
        elEventsKindChips.querySelectorAll(".m-chip").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        eventsKindFilter = btn.dataset.kind || "all";
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderEventsCard(s);
      });
    }

    // 16. 文件活动操作过滤
    if (elFaKindChips) {
      elFaKindChips.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-chip");
        if (!btn) return;
        elFaKindChips.querySelectorAll(".m-chip").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        faOpFilter = btn.dataset.op || "all";
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderFilesCard(s);
      });
    }

    // 17. 文件活动搜索
    if (elInputFaFilter) {
      elInputFaFilter.addEventListener("input", (e) => {
        faSearchQ = e.target.value.trim().toLowerCase();
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderFilesCard(s);
      });
    }

    // 18. 文件活动排序
    if (elFaSortChips) {
      elFaSortChips.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-chip");
        if (!btn) return;
        elFaSortChips.querySelectorAll(".m-chip").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        faSort = btn.dataset.sort || "lines";
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderFilesCard(s);
      });
    }

    // 19. 命令执行过滤
    if (elCmdFilterChips) {
      elCmdFilterChips.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-chip");
        if (!btn) return;
        elCmdFilterChips.querySelectorAll(".m-chip").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        cmdFilter = btn.dataset.filter || "all";
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderCommandsCard(s);
      });
    }

    // 20. 命令执行排序
    if (elCmdSortChips) {
      elCmdSortChips.addEventListener("click", (e) => {
        const btn = e.target.closest(".m-chip");
        if (!btn) return;
        elCmdSortChips.querySelectorAll(".m-chip").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        cmdSort = btn.dataset.sort || "latest";
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderCommandsCard(s);
      });
    }

    // 21. 命令执行搜索
    if (elInputCmdSearch) {
      elInputCmdSearch.addEventListener("input", (e) => {
        cmdSearchQ = e.target.value.trim().toLowerCase();
        const s = getSessionDetailOrIndex(activeModalSessionId);
        if (s) renderCommandsCard(s);
      });
    }
  }

  // ==========================================================================
  // 初始化启动
  // ==========================================================================

  function init() {
    initEvents();

    // 首屏: 骨架屏 (静态 HTML 已在解析期可见) 先出, 索引数据就绪后渲染真实内容并淡出
    renderPageSkeleton();

    // 未生成数据 (刚安装) → 明确的设置引导, 而不是空列表或误导性的「加载失败」
    if (isPlaceholderDataset()) {
      requestAnimationFrame(() => {
        renderMainStats();
        renderNoDataState();
        revealPageContent();
        hidePageSkeleton();
      });
      return;
    }

    const hasIndex = Array.isArray(window.CONTEXT_SESSIONS);
    if (hasIndex) {
      // 索引脚本是阻塞式前置脚本, 到这里数据已就绪 → 下一帧渲染, 保证骨架至少可见一帧
      requestAnimationFrame(() => {
        renderMainStats();
        renderWorkspaceTree();
        revealPageContent();
        hidePageSkeleton();
      });
      return;
    }

    // 索引缺失 (脚本加载失败/被缓存拦截) → 重新拉取一次; 仍失败则展示可读空态而不是白屏
    reloadIndexScript()
      .then(() => {
        renderMainStats();
        renderWorkspaceTree();
        revealPageContent();
        hidePageSkeleton();
      })
      .catch(() => {
        renderMainStats();
        const noData = isPlaceholderDataset();
        if (noData) renderNoDataState();
        else renderIndexErrorState();
        revealPageContent();
        hidePageSkeleton();
        showToast(noData ? "尚未生成本地数据, 请先运行 npx magpie-context sync" : "索引数据加载失败, 请点击刷新重试");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
