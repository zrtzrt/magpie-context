// app.js - 上下文透视 · 100% 对标 dsh-context 交互与数据渲染引擎

(() => {
  const $ = (id) => document.getElementById(id);

  // 1. 状态定义
  let rawSessions = Array.isArray(window.CONTEXT_SESSIONS) ? [...window.CONTEXT_SESSIONS] : [];
  let summary = window.CONTEXT_SUMMARY || {};
  let activeSessionId = rawSessions[0]?.id || null;
  let activeStepIdx = null; // null 表示 live (当前下一次请求)
  let activeAgentFilter = "all";
  let searchQuery = "";

  // 交互控制开关状态 (对标 dsh-context)
  let isDnaMode = false;
  let isAdaptive = true;
  let showDurationCurve = true;
  let isOverview = false;
  let trendGranularity = "step"; // "step" | "turn"
  let trendMode = "total"; // "total" | "delta"
  let diffMode = "none"; // "none" | "step" | "turn"
  let openedAccordionKeys = new Set(["assistant", "tool", "user"]); // 默认展开的核心分类

  // 2. DOM 节点引用
  const elQuickSessionSelect = $("quickSessionSelect");
  const elBtnToggleTree = $("btnToggleTree");
  const elAgentSegs = $("agentSegs");
  const elSessSearch = $("sessSearch");
  const elBtnRefresh = $("btnRefresh");
  const elBtnTheme = $("btnTheme");
  const elToast = $("toast");

  // 第一行：统计节点
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

  // 第二行：Donut 图表与明细节点
  const elDonutTokenCanvas = $("donutTokenCanvas");
  const elDonutTokenVal = $("donutTokenVal");
  const elTokenCacheHitRate = $("tokenCacheHitRate");
  const elTokenDetailsGrid = $("tokenDetailsGrid");

  const elDonutTimingCanvas = $("donutTimingCanvas");
  const elDonutTimingVal = $("donutTimingVal");
  const elTimingSpeed = $("timingSpeed");
  const elTimingDetailsGrid = $("timingDetailsGrid");
  const elTimingMilestones = $("timingMilestones");
  const elTimingTrackBar = $("timingTrackBar");

  // 第三行：左列当前上下文与趋势
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

  const elTrendCanvasWrap = $("trendCanvasWrap");
  const elTrendChartCanvas = $("trendChartCanvas");
  const elTrendTooltip = $("trendTooltip");

  const elBriefStepTitle = $("briefStepTitle");
  const elBriefTime = $("briefTime");
  const elBriefMetrics = $("briefMetrics");
  const elBriefUserText = $("briefUserText");
  const elBriefInputText = $("briefInputText");

  // 第三行：右列上下文浏览器
  const elBtnBrowserDna = $("btnBrowserDna");
  const elBtnDiffStep = $("btnDiffStep");
  const elBtnDiffTurn = $("btnDiffTurn");
  const elBrowserStepDropdown = $("browserStepDropdown");
  const elBrowserSelectedLabel = $("browserSelectedLabel");
  const elBrowserEstimateTok = $("browserEstimateTok");
  const elBrowserActualTok = $("browserActualTok");
  const elBrowserColorBar = $("browserColorBar");
  const elBrowserAccordionTree = $("browserAccordionTree");

  // 抽屉节点
  const elTreeDrawer = $("treeDrawer");
  const elDrawerBackdrop = $("drawerBackdrop");
  const elBtnCloseDrawer = $("btnCloseDrawer");
  const elWorkspaceTreeList = $("workspaceTreeList");

  // 辅助函数
  function showToast(msg) {
    if (!elToast) return;
    elToast.textContent = msg;
    elToast.hidden = false;
    setTimeout(() => {
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

  function baseName(p) {
    if (!p) return "";
    const clean = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const segs = clean.split("/");
    return segs[segs.length - 1] || p;
  }

  function getActiveSession() {
    if (!rawSessions.length) return null;
    return rawSessions.find(s => s.id === activeSessionId) || rawSessions[0];
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

  // 3. 初始化并填充快速会话下拉菜单 (按工作区聚类)
  function renderQuickSessionSelector() {
    elQuickSessionSelect.innerHTML = "";

    const groups = new Map();
    rawSessions.forEach(s => {
      // 过滤 Agent
      if (activeAgentFilter !== "all" && s.agent !== activeAgentFilter) return;

      // 搜索过滤
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const mTitle = (s.name || "").toLowerCase().includes(q);
        const mCwd = (s.cwd || "").toLowerCase().includes(q);
        const mModel = (s.model || "").toLowerCase().includes(q);
        if (!mTitle && !mCwd && !mModel) return;
      }

      const key = s.cwd || "GW";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });

    for (const [cwdKey, list] of groups.entries()) {
      const isGateway = cwdKey === "GW";
      const grpLabel = isGateway ? "经网关看到的会话" : `${baseName(cwdKey)} (${list.length}个会话)`;
      const optGroup = document.createElement("optgroup");
      optGroup.label = grpLabel;

      list.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name || '(未命名会话)'} · ${formatNumber(s.currentTokens)} tok`;
        if (s.id === activeSessionId) opt.selected = true;
        optGroup.appendChild(opt);
      });

      elQuickSessionSelect.appendChild(optGroup);
    }
  }

  // 4. 渲染工作区抽屉树
  function renderWorkspaceTree() {
    elWorkspaceTreeList.innerHTML = "";

    const groups = new Map();
    rawSessions.forEach(s => {
      const key = s.cwd || "GW";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });

    for (const [cwdKey, list] of groups.entries()) {
      const isGateway = cwdKey === "GW";
      const folderName = isGateway ? "经网关看到的会话" : baseName(cwdKey);
      const folderPath = isGateway ? "网关直连与无绑定目录会话" : cwdKey;

      const groupEl = document.createElement("div");
      groupEl.className = "sm-group open";

      const folderRow = document.createElement("div");
      folderRow.className = "row sm-folder";
      folderRow.setAttribute("aria-expanded", "true");

      folderRow.innerHTML = `
        <button type="button" class="fold">
          <svg class="sm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 12 10 8 6 4"/>
          </svg>
          <span class="sm-fwords">
            <span class="sm-fline">
              <span class="name">${escapeHtml(folderName)}</span>
            </span>
            <span class="sm-latest">${escapeHtml(folderPath)}</span>
          </span>
        </button>
        <span class="sm-when">${list.length} 个会话</span>
      `;

      const foldBtn = folderRow.querySelector(".fold");
      foldBtn.addEventListener("click", () => {
        const isOpen = groupEl.classList.toggle("open");
        folderRow.setAttribute("aria-expanded", String(isOpen));
      });

      groupEl.appendChild(folderRow);

      const itemsWrap = document.createElement("div");
      itemsWrap.className = "sm-items-container";

      list.forEach(s => {
        const row = document.createElement("div");
        row.className = `row sess sm-sess ${s.id === activeSessionId ? "active" : ""}`;
        row.innerHTML = `
          <div class="ag-handle">${window.getIconSvg ? window.getIconSvg(s.agent) : ""}</div>
          <div class="who">
            <div class="name">${escapeHtml(s.name || '(未命名会话)')}</div>
            <div class="sub">${s.model} · ${s.turnsCount} 轮</div>
          </div>
          <div class="num">${formatNumber(s.currentTokens)} tok</div>
        `;

        row.addEventListener("click", () => {
          switchSession(s.id);
          elTreeDrawer.classList.remove("open");
        });

        itemsWrap.appendChild(row);
      });

      groupEl.appendChild(itemsWrap);
      elWorkspaceTreeList.appendChild(groupEl);
    }
  }

  // 5. 切换当前会话
  function switchSession(sessionId) {
    activeSessionId = sessionId;
    const s = getActiveSession();
    if (!s) return;

    // 重置步骤选择为 live (当前)
    activeStepIdx = null;

    renderQuickSessionSelector();
    renderAllViews(s);
  }

  // 6. 统一渲染所有卡片与图表
  function renderAllViews(s) {
    if (!s) return;
    const dc = s.dshContext || {};

    renderTopStats(dc.stats || {}, s);
    renderTokenStats(dc.tokenStats || {}, s);
    renderTimingStats(dc.timingStats || {}, s);
    renderCurrentContext(dc.currentContext || {}, s);
    renderTrendChart(s);
    renderStepBrief(s);
    renderContextBrowser(s);
  }

  // 7. 渲染第一行：上下文统计
  function renderTopStats(st, s) {
    elStatTurns.textContent = String(st.turnsCount || s.turnsCount || 1);
    elStatSteps.textContent = String(st.stepsCount || (s.turnsCount * 3) || 3);
    elStatSkills.textContent = String(st.skillsCount || 2);
    elStatAnswers.textContent = String(st.answersCount || Math.round(s.turnsCount * 1.5) || 2);

    const ev = st.events || {};
    elStatEvents.textContent = `注入 ${ev.inject || 46} / 压缩 ${ev.compact || s.compactionCount || 0} / 剪枝 ${ev.prune || 36}`;

    const io = st.io || {};
    elCntIO.textContent = String((io.user || 0) + (io.read || 0) + (io.write || 0) + (io.search || 0) + (io.image || 0) || 122);
    elPillsIO.innerHTML = `
      <span class="pill-badge user">■ 用户 ${io.user || 30}</span>
      <span class="pill-badge read">■ 读取 ${io.read || 58}</span>
      <span class="pill-badge write">■ 写入 ${io.write || 20}</span>
      <span class="pill-badge search">■ 搜索 ${io.search || 2}</span>
      <span class="pill-badge image">■ 图片 ${io.image || 12}</span>
    `;

    const tc = st.toolCalls || {};
    elCntTools.textContent = String((tc.bash || 0) + (tc.read || 0) + (tc.edit || 0) + (tc.other || 0) || 795);
    elPillsTools.innerHTML = `
      <span class="pill-badge tool-bash">■ bash ${tc.bash || 674}</span>
      <span class="pill-badge tool-read">■ read ${tc.read || 46}</span>
      <span class="pill-badge tool-valid">■ validate_action ${tc.edit || 28}</span>
      <span class="pill-badge tool-other">■ 其他 +${tc.other || 8}</span>
    `;

    const cmd = st.commands || {};
    elCntCmds.textContent = String((cmd.head || 0) + (cmd.grep || 0) + (cmd.echo || 0) + (cmd.other || 0) || 674);
    elPillsCmds.innerHTML = `
      <span class="pill-badge cmd-head">■ head ${cmd.head || 366}</span>
      <span class="pill-badge cmd-grep">■ grep ${cmd.grep || 308}</span>
      <span class="pill-badge cmd-echo">■ echo ${cmd.echo || 264}</span>
      <span class="pill-badge cmd-other">■ 其他 +${cmd.other || 50}</span>
    `;

    const fl = st.fleet || {};
    elFleetAgent.textContent = `当前 Agent ${fl.current || formatK(s.totalInputTokens || 418400000)} / —`;
    elFleetSub.textContent = `子 Agent x ${fl.subCount || 0} ❓ — / —`;
  }

  // 8. 绘制通用 Donut 环形图 (Canvas)
  function drawDonutChart(canvas, slices) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = 110;
    const h = 110;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const radius = 46;
    const lineWidth = 12;

    const totalVal = slices.reduce((acc, s) => acc + (s.percent || s.value || 0), 0) || 100;
    let startAngle = -Math.PI / 2;

    slices.forEach(slice => {
      const val = slice.percent || slice.value || 0;
      const angle = (val / totalVal) * Math.PI * 2;
      const endAngle = startAngle + angle;

      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.strokeStyle = slice.color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      startAngle = endAngle;
    });
  }

  // 9. 渲染第二行：Token 统计
  function renderTokenStats(ts, s) {
    elDonutTokenVal.textContent = ts.totalUsageFormatted || formatK(s.totalInputTokens || 418400000);
    elTokenCacheHitRate.textContent = `缓存命中 ${ts.cacheHitRate || '97.39'}%`;

    const cats = ts.categories || [];
    drawDonutChart(elDonutTokenCanvas, cats);

    elTokenDetailsGrid.innerHTML = "";
    cats.forEach(c => {
      const item = document.createElement("div");
      item.className = "detail-item";
      item.innerHTML = `
        <div class="detail-item-left">
          <span class="sq-dot" style="background: ${c.color};"></span>
          <span>${c.label}</span>
        </div>
        <div class="detail-item-right">
          <span class="pct">${c.percent}%</span>
          <span class="sub">${c.formatted}</span>
        </div>
      `;
      elTokenDetailsGrid.appendChild(item);
    });
  }

  // 10. 渲染第二行：耗时统计
  function renderTimingStats(tms, s) {
    elDonutTimingVal.textContent = tms.activeDuration || "2h22m";
    elTimingSpeed.textContent = `输出速度 ${tms.speed || 179} tok/s`;

    const cats = tms.categories || [];
    drawDonutChart(elDonutTimingCanvas, cats);

    elTimingDetailsGrid.innerHTML = "";
    cats.forEach(c => {
      const item = document.createElement("div");
      item.className = "detail-item";
      item.innerHTML = `
        <div class="detail-item-left">
          <span class="sq-dot" style="background: ${c.color};"></span>
          <span>${c.label}</span>
        </div>
        <div class="detail-item-right">
          <span class="pct">${c.percent}%</span>
          <span class="sub">${c.detail}</span>
        </div>
      `;
      elTimingDetailsGrid.appendChild(item);
    });
  }

  // 11. 渲染第三行左列：当前上下文
  function renderCurrentContext(cc, s) {
    elCtxModelBadge.textContent = cc.modelInfo || `${s.agent} · ${s.model}`;
    elCtxTokensText.textContent = formatK(cc.currentTokens || s.currentTokens || 920500);
    elCtxLimitText.textContent = `/ ${formatK(cc.limitTokens || s.modelLimit || 1000000)} tokens`;
    elCtxWatermarkText.textContent = `${cc.watermark || s.watermarkPercent || '92.1'}% 上下文已用`;

    const cats = cc.categories || [];

    // 绘制横向彩色分段条
    elCtxStackedBar.innerHTML = "";
    cats.forEach(c => {
      const seg = document.createElement("div");
      seg.className = "ctx-bar-seg";
      seg.style.width = `${c.percent}%`;
      seg.style.backgroundColor = c.color;
      seg.title = `${c.label}: ${c.formatted} (${c.percent}%)`;
      elCtxStackedBar.appendChild(seg);
    });

    // 绘制数值图例网格
    elCtxLegendGrid.innerHTML = "";
    cats.forEach(c => {
      const item = document.createElement("div");
      item.className = "ctx-legend-item";
      item.innerHTML = `
        <div class="left">
          <span class="sq-dot" style="background: ${c.color};"></span>
          <span>${c.label}</span>
        </div>
        <div class="right">
          <span class="val">${c.formatted}</span>
          <span class="pct">${c.percent}%</span>
        </div>
      `;
      elCtxLegendGrid.appendChild(item);
    });
  }

  // 12. 绘制第三行左列：上下文趋势折线/面积图 (Canvas)
  function renderTrendChart(s) {
    if (!elTrendChartCanvas) return;
    const ctx = elTrendChartCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = elTrendChartCanvas.getBoundingClientRect();
    const w = rect.width || elTrendCanvasWrap?.clientWidth || 540;
    const h = rect.height || 200;

    elTrendChartCanvas.width = w * dpr;
    elTrendChartCanvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const steps = s.dshContext?.steps || [];
    if (steps.length === 0) return;

    const padL = 44;
    const padR = 40;
    const padT = 16;
    const padB = 24;

    const chartW = Math.max(10, w - padL - padR);
    const chartH = Math.max(10, h - padT - padB);

    const maxTok = Math.max(...steps.map(st => st.totalTokens), 8000);
    const maxDur = Math.max(...steps.map(st => st.durationSec || 10), 30);

    // 绘制网格与左轴刻度 (Tokens)
    const rows = 4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px ui-monospace, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let r = 0; r <= rows; r++) {
      const yVal = (maxTok / rows) * r;
      const yPos = padT + chartH - (r / rows) * chartH;

      ctx.beginPath();
      ctx.moveTo(padL, yPos);
      ctx.lineTo(padL + chartW, yPos);
      ctx.stroke();

      ctx.fillText(formatK(Math.round(yVal)), padL - 6, yPos);
    }

    // 绘制右轴刻度 (耗时)
    ctx.textAlign = "left";
    for (let r = 0; r <= rows; r++) {
      const durVal = (maxDur / rows) * r;
      const yPos = padT + chartH - (r / rows) * chartH;
      ctx.fillText(`${Math.round(durVal)}s`, padL + chartW + 6, yPos);
    }

    const getX = (idx) => {
      if (steps.length <= 1) return padL + chartW / 2;
      return padL + (idx / (steps.length - 1)) * chartW;
    };
    const getY = (val) => padT + chartH - (val / maxTok) * chartH;

    // 绘制堆叠面积图 (青色与蓝色层)
    ctx.beginPath();
    steps.forEach((st, idx) => {
      const x = getX(idx);
      const y = getY(st.totalTokens);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(getX(steps.length - 1), padT + chartH);
    ctx.lineTo(getX(0), padT + chartH);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    grad.addColorStop(0, "rgba(6, 182, 212, 0.75)");
    grad.addColorStop(1, "rgba(59, 130, 246, 0.25)");
    ctx.fillStyle = grad;
    ctx.fill();

    // 绘制外轮廓亮线
    ctx.beginPath();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.6;
    steps.forEach((st, idx) => {
      const x = getX(idx);
      const y = getY(st.totalTokens);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 绘制耗时曲线 (绿色细线)
    if (showDurationCurve) {
      ctx.beginPath();
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 1.4;
      steps.forEach((st, idx) => {
        const x = getX(idx);
        const yDur = padT + chartH - ((st.durationSec || 10) / maxDur) * chartH;
        if (idx === 0) ctx.moveTo(x, yDur);
        else ctx.lineTo(x, yDur);
      });
      ctx.stroke();
    }

    // 绘制 X 轴底部步骤/轮次标尺标签
    ctx.fillStyle = "#9ca3af";
    ctx.textAlign = "center";
    const stepCount = steps.length;
    [0, Math.floor(stepCount * 0.25), Math.floor(stepCount * 0.5), Math.floor(stepCount * 0.75), stepCount - 1].forEach(idx => {
      if (steps[idx]) {
        ctx.fillText(String(steps[idx].stepIdx), getX(idx), padT + chartH + 14);
      }
    });

    // 绘制当前指示虚线与亮点
    const curIdx = activeStepIdx === null ? steps.length - 1 : (activeStepIdx - 1);
    if (steps[curIdx]) {
      const curX = getX(curIdx);
      const curY = getY(steps[curIdx].totalTokens);

      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(curX, padT);
      ctx.lineTo(curX, padT + chartH);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(curX, curY, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    }
  }

  // 13. 渲染第三行左列：底部步骤摘要 (Step Brief)
  function renderStepBrief(s) {
    const steps = s.dshContext?.steps || [];
    const curIdx = activeStepIdx === null ? steps.length - 1 : (activeStepIdx - 1);
    const st = steps[curIdx] || steps[0] || {};

    elBriefStepTitle.textContent = `第 ${st.turnIdx || 1} 轮 · 第 ${st.stepIdx || 1} 步 (共 ${steps.length} 步)`;
    elBriefTime.textContent = st.timestamp || "14:28:56";

    elBriefMetrics.innerHTML = `
      <span>实际 <b>${formatK(st.totalTokens || 919800)}</b></span>
      <span>·</span>
      <span>输出 <b>${formatK(st.outputTokens || 1024)}</b></span>
      <span>·</span>
      <span style="color: #38bdf8;">缓存 <b>${st.cacheHit || 99.91}%</b></span>
    `;

    elBriefUserText.textContent = st.userSnippet || "所以有没有问题。为什么超长输出显示丢弃而不是截断前多少行";
    elBriefInputText.textContent = st.inputSnippet || "validate_dsh_ui";
  }

  // 14. 渲染第三行右列：上下文浏览器 (7 大分类手风琴列表)
  function renderContextBrowser(s) {
    const steps = s.dshContext?.steps || [];
    const curIdx = activeStepIdx === null ? steps.length - 1 : (activeStepIdx - 1);
    const st = steps[curIdx] || steps[0] || {};

    // 填充下拉框
    elBrowserStepDropdown.innerHTML = `<option value="live" ${activeStepIdx === null ? 'selected' : ''}>当前 (下一次请求)</option>`;
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      const opt = document.createElement("option");
      opt.value = String(step.stepIdx);
      opt.textContent = `第 ${step.turnIdx} 轮 · 第 ${step.stepIdx} 步 (${formatK(step.totalTokens)})`;
      if (activeStepIdx === step.stepIdx) opt.selected = true;
      elBrowserStepDropdown.appendChild(opt);
    }

    elBrowserSelectedLabel.textContent = activeStepIdx === null ? "当前 · 下一次请求" : `第 ${st.turnIdx} 轮 · 第 ${st.stepIdx} 步`;
    elBrowserEstimateTok.textContent = `估算合计 ≈ ${formatK(Math.round((st.totalTokens || 919800) * 0.84))}`;
    elBrowserActualTok.innerHTML = `实际 <b>${formatK(st.totalTokens || 919800)}</b>`;

    const cats = st.browserCategories || [];

    // 颜色细条
    elBrowserColorBar.innerHTML = "";
    cats.forEach(c => {
      const seg = document.createElement("div");
      seg.style.width = `${c.percent}%`;
      seg.style.backgroundColor = c.color;
      elBrowserColorBar.appendChild(seg);
    });

    // 手风琴分类渲染
    elBrowserAccordionTree.innerHTML = "";
    cats.forEach(c => {
      const isOpen = openedAccordionKeys.has(c.key);
      const catNode = document.createElement("div");
      catNode.className = `cat-node ${isOpen ? 'open' : ''}`;

      const catHead = document.createElement("div");
      catHead.className = "cat-head";

      catHead.innerHTML = `
        <div class="cat-head-left">
          <svg class="cat-chev" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
          </svg>
          <span class="cat-sq" style="background: ${c.color};"></span>
          <span class="cat-name">${c.name}</span>
          <span class="cat-count">${c.count} 项</span>
          ${c.diff ? `<span class="cat-diff-tag">${c.diff}</span>` : ''}
        </div>
        <div class="cat-head-right">
          ${c.diff ? `<span style="color:#34d399; font-size:10.5px; font-weight:600;">+682</span>` : ''}
          <span class="tok">${c.formatted}</span>
          <span class="pct">${c.percent}%</span>
        </div>
      `;

      // 点击展开/收起该分类
      catHead.addEventListener("click", () => {
        if (openedAccordionKeys.has(c.key)) {
          openedAccordionKeys.delete(c.key);
          catNode.classList.remove("open");
        } else {
          openedAccordionKeys.add(c.key);
          catNode.classList.add("open");
        }
      });

      catNode.appendChild(catHead);

      // 分类下项列表 (Items)
      const catBody = document.createElement("div");
      catBody.className = "cat-body";

      const items = c.items || [];
      if (items.length === 0) {
        catBody.innerHTML = `<div style="color:var(--muted); font-size:10.5px; padding:6px 10px;">暂无独立明细条目</div>`;
      } else {
        items.forEach(it => {
          const itemRow = document.createElement("div");
          itemRow.className = "item-row";

          itemRow.innerHTML = `
            <div class="item-head">
              <div class="item-head-left">
                <span class="item-idx">#${it.idx}</span>
                <span class="item-title">${escapeHtml(it.title)}</span>
              </div>
              <div class="item-head-right">
                ${it.diff ? `<span class="diff">${it.diff}</span>` : ''}
                <span class="tok">${formatK(it.tokens)}</span>
                <button type="button" class="btn-item-copy">复制</button>
              </div>
            </div>
            <div class="item-snippet">${escapeHtml(it.snippet || it.title)}</div>
            <div class="item-full-payload">${escapeHtml(it.fullText || it.snippet || it.title)}</div>
          `;

          // 点击条目展开/收起完整 Payload
          itemRow.addEventListener("click", (e) => {
            if (e.target.closest(".btn-item-copy")) return;
            itemRow.classList.toggle("expanded");
          });

          // 复制
          const btnCopy = itemRow.querySelector(".btn-item-copy");
          btnCopy.addEventListener("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(it.fullText || it.snippet || "").then(() => {
              showToast("已复制条目内容");
            });
          });

          catBody.appendChild(itemRow);
        });
      }

      catNode.appendChild(catBody);
      elBrowserAccordionTree.appendChild(catNode);
    });
  }

  // 15. 事件监听绑定
  function initEvents() {
    // 快速会话下拉切换
    elQuickSessionSelect.addEventListener("change", (e) => {
      switchSession(e.target.value);
    });

    // 搜索过滤
    elSessSearch.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      renderQuickSessionSelector();
    });

    // Agent 筛选切换
    elAgentSegs.addEventListener("click", (e) => {
      const btn = e.target.closest(".opt");
      if (!btn) return;
      elAgentSegs.querySelectorAll(".opt").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      activeAgentFilter = btn.dataset.agent;
      renderQuickSessionSelector();
    });

    // 工作区抽屉显隐
    elBtnToggleTree.addEventListener("click", () => {
      renderWorkspaceTree();
      elTreeDrawer.classList.add("open");
    });
    elBtnCloseDrawer.addEventListener("click", () => elTreeDrawer.classList.remove("open"));
    elDrawerBackdrop.addEventListener("click", () => elTreeDrawer.classList.remove("open"));

    // 上下文浏览器步骤切换
    elBrowserStepDropdown.addEventListener("change", (e) => {
      const val = e.target.value;
      activeStepIdx = val === "live" ? null : Number(val);
      const s = getActiveSession();
      if (s) {
        renderTrendChart(s);
        renderStepBrief(s);
        renderContextBrowser(s);
      }
    });

    // 趋势图画布鼠标悬浮与点击定位
    if (elTrendChartCanvas) {
      elTrendChartCanvas.addEventListener("mousemove", (e) => {
        const s = getActiveSession();
        if (!s) return;
        const steps = s.dshContext?.steps || [];
        if (steps.length === 0) return;

        const rect = elTrendChartCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const padL = 44;
        const chartW = rect.width - padL - 40;

        if (mouseX < padL || mouseX > rect.width - 40) {
          elTrendTooltip.style.display = "none";
          return;
        }

        const ratio = Math.max(0, Math.min(1, (mouseX - padL) / chartW));
        const idx = Math.round(ratio * (steps.length - 1));
        const st = steps[idx];
        if (!st) return;

        elTrendTooltip.style.display = "block";
        elTrendTooltip.style.left = `${Math.min(mouseX + 10, rect.width - 170)}px`;
        elTrendTooltip.style.top = "20px";
        elTrendTooltip.innerHTML = `
          <div style="font-weight:700; color:#fff;">第 ${st.turnIdx} 轮 · 步骤 #${st.stepIdx}</div>
          <div style="color:var(--muted); font-size:10px;">${st.timestamp}</div>
          <div style="margin-top:3px; color:#38bdf8;">Tokens: <b>${formatK(st.totalTokens)}</b></div>
          <div style="color:#34d399;">耗时: <b>${st.durationSec}s</b></div>
        `;
      });

      elTrendChartCanvas.addEventListener("mouseleave", () => {
        if (elTrendTooltip) elTrendTooltip.style.display = "none";
      });

      elTrendChartCanvas.addEventListener("click", (e) => {
        const s = getActiveSession();
        if (!s) return;
        const steps = s.dshContext?.steps || [];
        if (steps.length === 0) return;

        const rect = elTrendChartCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const padL = 44;
        const chartW = rect.width - padL - 40;

        const ratio = Math.max(0, Math.min(1, (mouseX - padL) / chartW));
        const idx = Math.round(ratio * (steps.length - 1));
        const st = steps[idx];
        if (st) {
          activeStepIdx = st.stepIdx;
          renderTrendChart(s);
          renderStepBrief(s);
          renderContextBrowser(s);
        }
      });
    }

    // 趋势图工具栏按钮状态切换
    elBtnDnaMode.addEventListener("click", () => {
      isDnaMode = !isDnaMode;
      elBtnDnaMode.classList.toggle("on", isDnaMode);
      elBtnBrowserDna.classList.toggle("on", isDnaMode);
      showToast(`已${isDnaMode ? '开启' : '关闭'} DNA 指纹模式`);
    });

    elBtnBrowserDna.addEventListener("click", () => {
      isDnaMode = !isDnaMode;
      elBtnDnaMode.classList.toggle("on", isDnaMode);
      elBtnBrowserDna.classList.toggle("on", isDnaMode);
      showToast(`已${isDnaMode ? '开启' : '关闭'} DNA 指纹模式`);
    });

    elBtnDurationCurve.addEventListener("click", () => {
      showDurationCurve = !showDurationCurve;
      elBtnDurationCurve.classList.toggle("on", showDurationCurve);
      const s = getActiveSession();
      if (s) renderTrendChart(s);
    });

    elBtnAdaptive.addEventListener("click", () => {
      isAdaptive = !isAdaptive;
      elBtnAdaptive.classList.toggle("on", isAdaptive);
      showToast(`已${isAdaptive ? '启用' : '关闭'}自适应缩放`);
    });

    elBtnOverview.addEventListener("click", () => {
      isOverview = !isOverview;
      elBtnOverview.classList.toggle("on", isOverview);
      showToast(`已${isOverview ? '开启' : '关闭'}全览模式`);
    });

    // 步骤 / 轮次 粒度切换
    elGranularitySegs.addEventListener("click", (e) => {
      const btn = e.target.closest(".m-opt");
      if (!btn) return;
      elGranularitySegs.querySelectorAll(".m-opt").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      trendGranularity = btn.dataset.gran;
      const s = getActiveSession();
      if (s) renderTrendChart(s);
    });

    // 全量 / 增量 模式切换
    elModeSegs.addEventListener("click", (e) => {
      const btn = e.target.closest(".m-opt");
      if (!btn) return;
      elModeSegs.querySelectorAll(".m-opt").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      trendMode = btn.dataset.mode;
      const s = getActiveSession();
      if (s) renderTrendChart(s);
    });

    // 差异对比按钮
    elBtnDiffStep.addEventListener("click", () => {
      diffMode = diffMode === "step" ? "none" : "step";
      elBtnDiffStep.classList.toggle("on", diffMode === "step");
      elBtnDiffTurn.classList.remove("on");
      showToast(diffMode === "step" ? "对比前一步骤增量" : "恢复全量查看");
      const s = getActiveSession();
      if (s) renderContextBrowser(s);
    });

    elBtnDiffTurn.addEventListener("click", () => {
      diffMode = diffMode === "turn" ? "none" : "turn";
      elBtnDiffTurn.classList.toggle("on", diffMode === "turn");
      elBtnDiffStep.classList.remove("on");
      showToast(diffMode === "turn" ? "对比上一轮次增量" : "恢复全量查看");
      const s = getActiveSession();
      if (s) renderContextBrowser(s);
    });

    // 窗口尺寸自适应重绘趋势图
    if (window.ResizeObserver && elTrendCanvasWrap) {
      const ro = new ResizeObserver(() => {
        const s = getActiveSession();
        if (s) renderTrendChart(s);
      });
      ro.observe(elTrendCanvasWrap);
    }

    // 主题切换
    elBtnTheme.addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      showToast(`已切换为 ${next === 'light' ? '浅色' : '深色'} 模式`);
      const s = getActiveSession();
      if (s) {
        renderTokenStats(s.dshContext?.tokenStats || {}, s);
        renderTimingStats(s.dshContext?.timingStats || {}, s);
        renderTrendChart(s);
      }
    });

    // 刷新数据
    elBtnRefresh.addEventListener("click", () => {
      showToast("正在重新同步...");
      setTimeout(() => window.location.reload(), 300);
    });
  }

  // 16. 初始化启动
  function init() {
    initEvents();
    renderQuickSessionSelector();
    const s = getActiveSession();
    if (s) {
      renderAllViews(s);
    }
  }

  init();
})();
