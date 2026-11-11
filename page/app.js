// app.js - 上下文透视 (Context Lens) 官方会话树组织、点击弹窗与 dsh-context 交互逻辑

(() => {
  const $ = (id) => document.getElementById(id);

  // 1. 状态定义
  let rawSessions = Array.isArray(window.CONTEXT_SESSIONS) ? [...window.CONTEXT_SESSIONS] : [];
  let summary = window.CONTEXT_SUMMARY || {};
  let activeAgentFilter = "all";
  let activeSessionId = null;
  let activeTurnIdx = 1;
  let activeRoleFilter = "all";
  let searchQuery = "";
  const openedFolders = new Set(); // 记录展开的工作区目录

  // 2. DOM 节点引用
  const elWorkspaceTree = $("workspaceTree");
  const elAgentSegs = $("agentSegs");
  const elSessQ = $("sessQ");
  const elBtnRefresh = $("btnRefresh");
  const elBtnTheme = $("btnTheme");
  const elToast = $("toast");

  // 全局 KPI 节点
  const elKpiTotalSess = $("kpiTotalSess");
  const elKpiPeakWatermark = $("kpiPeakWatermark");
  const elKpiTotalTurns = $("kpiTotalTurns");
  const elKpiTotalCompactions = $("kpiTotalCompactions");
  const elKpiCacheRead = $("kpiCacheRead");

  // Modal 弹窗相关节点
  const elModal = $("contextModal");
  const elBtnModalClose = $("btnModalClose");
  const elModalAgentIcon = $("modalAgentIcon");
  const elModalTitle = $("modalTitle");
  const elModalSub = $("modalSub");
  const elModalWatermarkText = $("modalWatermarkText");
  const elModalLimitText = $("modalLimitText");
  const elModalWatermarkFill = $("modalWatermarkFill");

  // Detail & KPI 节点
  const elDetCurTokens = $("detCurTokens");
  const elDetPeakTokens = $("detPeakTokens");
  const elDetTurnsCount = $("detTurnsCount");
  const elDetCompCount = $("detCompCount");
  const elDetCacheRead = $("detCacheRead");

  // Chart 节点
  const elCanvasWrap = $("canvasWrap");
  const elCanvas = $("ctxCanvas");
  const elTooltip = $("ctxTooltip");
  const elTurnsBar = $("turnsBar");

  // Inspector 节点
  const elInspTurnBadge = $("inspTurnBadge");
  const elInspTokens = $("inspTokens");
  const elInspDelta = $("inspDelta");
  const elRoleSegs = $("roleSegs");
  const elMessagesList = $("messagesList");
  const elTopConsumersBody = $("topConsumersBody");
  const elHealthTips = $("healthTips");

  // 辅助函数
  function showToast(msg) {
    if (!elToast) return;
    elToast.textContent = msg;
    elToast.hidden = false;
    setTimeout(() => {
      elToast.hidden = true;
    }, 2000);
  }

  function formatNumber(n) {
    if (!n && n !== 0) return "0";
    return Number(n).toLocaleString("en-US");
  }

  function baseName(p) {
    if (!p) return "";
    const clean = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const segs = clean.split("/");
    return segs[segs.length - 1] || p;
  }

  function getAgentIconSvg(agentKey) {
    if (typeof window.getIconSvg === "function") {
      return window.getIconSvg(agentKey);
    }
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="#888"><circle cx="12" cy="12" r="8"/></svg>`;
  }

  function getActiveSession() {
    if (!rawSessions.length) return null;
    return rawSessions.find(s => s.id === activeSessionId) || rawSessions[0];
  }

  // 3. 渲染全局 KPI 与 Agent 选项卡徽标
  function renderGlobalKpi() {
    const ags = summary.agents || {};
    $("badge-all").textContent = String(rawSessions.length);
    $("badge-antigravity").textContent = String(ags.antigravity || rawSessions.filter(s => s.agent === "antigravity").length);
    $("badge-dsh").textContent = String(ags.dsh || rawSessions.filter(s => s.agent === "dsh").length);
    $("badge-codex").textContent = String(ags.codex || rawSessions.filter(s => s.agent === "codex").length);
    $("badge-other").textContent = String(ags.other || rawSessions.filter(s => !["antigravity", "dsh", "codex"].includes(s.agent)).length);

    elKpiTotalSess.textContent = String(rawSessions.length);
    const maxWm = Math.max(...rawSessions.map(s => s.watermarkPercent || 0), 0);
    elKpiPeakWatermark.textContent = `${maxWm}%`;
    elKpiPeakWatermark.style.color = maxWm > 75 ? "var(--red)" : (maxWm > 50 ? "var(--amber)" : "var(--green)");

    elKpiTotalTurns.textContent = formatNumber(rawSessions.reduce((a, b) => a + (b.turnsCount || 0), 0));
    elKpiTotalCompactions.textContent = String(rawSessions.reduce((a, b) => a + (b.compactionCount || 0), 0));
    elKpiCacheRead.textContent = formatNumber(rawSessions.reduce((a, b) => a + (b.totalCacheRead || 0), 0));
  }

  // 4. 按工作区聚类会话并渲染会话树 (对标 Magpie 官方 .sm-folders 与 .row.sm-folder)
  function renderWorkspaceTree() {
    elWorkspaceTree.innerHTML = "";

    // 过滤会话
    const filtered = rawSessions.filter(s => {
      if (activeAgentFilter === "antigravity" && s.agent !== "antigravity") return false;
      if (activeAgentFilter === "dsh" && s.agent !== "dsh") return false;
      if (activeAgentFilter === "codex" && s.agent !== "codex") return false;
      if (activeAgentFilter === "other" && ["antigravity", "dsh", "codex"].includes(s.agent)) return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const mTitle = (s.name || "").toLowerCase().includes(q);
        const mCwd = (s.cwd || "").toLowerCase().includes(q);
        const mModel = (s.model || "").toLowerCase().includes(q);
        if (!mTitle && !mCwd && !mModel) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      elWorkspaceTree.innerHTML = `
        <div style="text-align: center; color: var(--muted); padding: 48px 16px; font-size: 13px;">
          没有找到匹配的会话
        </div>`;
      return;
    }

    // 按 cwd 工作区分组
    const groupsMap = new Map();
    filtered.forEach(s => {
      const key = s.cwd || "GW";
      if (!groupsMap.has(key)) {
        groupsMap.set(key, []);
      }
      groupsMap.get(key).push(s);
    });

    // 默认如果首次加载，展开前 3 个项目工作区
    if (openedFolders.size === 0 && !searchQuery) {
      let count = 0;
      for (const k of groupsMap.keys()) {
        openedFolders.add(k);
        count++;
        if (count >= 3) break;
      }
    }

    // 如果处于搜索状态，自动展开所有包含匹配项的工作区
    if (searchQuery) {
      for (const k of groupsMap.keys()) {
        openedFolders.add(k);
      }
    }

    // 渲染每个工作区分组
    for (const [cwdKey, sessList] of groupsMap.entries()) {
      const isGateway = cwdKey === "GW";
      const folderName = isGateway ? "经网关看到的会话" : baseName(cwdKey);
      const folderPath = isGateway ? "网关直连请求与未绑定物理目录的会话" : cwdKey;
      const isOpen = openedFolders.has(cwdKey);

      const latestSession = sessList[0];
      const latestTime = latestSession?.timeAgo || "";

      // 建立 .sm-group
      const groupEl = document.createElement("div");
      groupEl.className = `sm-group ${isOpen ? "open" : ""}`;

      // 工作区折叠行 .row.sm-folder
      const folderRow = document.createElement("div");
      folderRow.className = "row sm-folder";

      folderRow.innerHTML = `
        <button type="button" class="fold" aria-expanded="${isOpen}">
          <svg class="sm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 12 10 8 6 4"/>
          </svg>
          <span class="sm-fwords">
            <span class="sm-fline">
              <span class="name" title="${folderName}">${folderName}</span>
              <span class="sub sm-path" title="${folderPath}">${folderPath}</span>
            </span>
            <span class="sm-latest" title="${latestSession?.name || ''}">最近: ${latestSession?.name || '(无指令)'}</span>
          </span>
        </button>
        <div class="sm-when">
          <span class="sm-ago">${latestTime}</span>
          <span class="note">${sessList.length} 个会话</span>
        </div>
      `;

      // 点击展开/折叠
      const foldBtn = folderRow.querySelector(".fold");
      foldBtn.addEventListener("click", () => {
        if (openedFolders.has(cwdKey)) {
          openedFolders.delete(cwdKey);
        } else {
          openedFolders.add(cwdKey);
        }
        renderWorkspaceTree();
      });

      groupEl.appendChild(folderRow);

      // 展开项容器
      const itemsContainer = document.createElement("div");
      itemsContainer.className = "sm-items-container";

      // 渲染该工作区下的每个会话行
      sessList.forEach(s => {
        const row = document.createElement("div");
        row.className = "row sess sm-sess";

        const wm = s.watermarkPercent || 0;
        let wmColor = "var(--green)";
        if (wm > 75) wmColor = "var(--red)";
        else if (wm > 50) wmColor = "var(--amber)";

        const subParts = [
          s.agentName || s.agent,
          s.model || "",
          s.timeAgo || "",
          `${s.turnsCount || 1} 轮`
        ].filter(Boolean);

        row.innerHTML = `
          <div class="ag-handle" title="${s.agentName || s.agent}">
            ${getAgentIconSvg(s.agent)}
          </div>
          <div class="who">
            <div class="name" title="${s.name || ''}">${s.name || '(未命名会话)'}</div>
            <div class="sub" title="${subParts.join(" · ")}">${subParts.join(" · ")}</div>
          </div>
          <div class="num">
            <b>${formatNumber(s.currentTokens)} tok</b>
            <small style="color: ${wmColor};">${wm}% 水位</small>
          </div>
          ${s.compactionCount ? `<span class="compaction-tag">✂ ${s.compactionCount}</span>` : ""}
          <svg class="sess-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 12 10 8 6 4"/>
          </svg>
        `;

        // 点击会话行打开 Modal 弹窗显示 dsh-context
        row.addEventListener("click", () => {
          openSessionModal(s.id);
        });

        itemsContainer.appendChild(row);
      });

      groupEl.appendChild(itemsContainer);
      elWorkspaceTree.appendChild(groupEl);
    }
  }

  // 5. 打开会话 Modal 弹窗显示 dsh-context 交互大盘
  function openSessionModal(sessionId) {
    activeSessionId = sessionId;
    const s = getActiveSession();
    if (!s) return;

    // 默认定位到最后轮次
    activeTurnIdx = s.turns?.length ? s.turns[s.turns.length - 1].turnIdx : 1;

    // 填充弹窗 Header
    elModalAgentIcon.innerHTML = getAgentIconSvg(s.agent);
    elModalTitle.textContent = s.name || "(未命名会话)";
    elModalSub.innerHTML = `
      <span>Agent: <b style="color:var(--fg);">${s.agentName || s.agent}</b></span>
      <span>·</span>
      <span>模型: <b style="color:var(--fg);">${s.model}</b></span>
      <span>·</span>
      <span>目录: ${s.cwd ? baseName(s.cwd) : "默认工作区"}</span>
      <span>·</span>
      <span>活跃: ${s.lastTime || s.timeAgo || ""}</span>
    `;

    const wm = s.watermarkPercent || 0;
    elModalWatermarkText.textContent = `${wm}% 水位`;
    elModalLimitText.textContent = `/ ${formatNumber(s.modelLimit)} tok 上限`;
    elModalWatermarkFill.style.width = `${Math.min(100, wm)}%`;

    if (wm > 75) {
      elModalWatermarkFill.style.backgroundColor = "#ff453a";
      elModalWatermarkText.style.color = "#ff453a";
    } else if (wm > 50) {
      elModalWatermarkFill.style.backgroundColor = "#ffd60a";
      elModalWatermarkText.style.color = "#ffd60a";
    } else {
      elModalWatermarkFill.style.backgroundColor = "#30d158";
      elModalWatermarkText.style.color = "#30d158";
    }

    // 填充 dsh-context KPI
    elDetCurTokens.textContent = `${formatNumber(s.currentTokens)} tok`;
    elDetPeakTokens.textContent = `${formatNumber(s.peakTokens)} tok`;
    elDetTurnsCount.textContent = `${s.turnsCount} 轮`;
    elDetCompCount.textContent = `${s.compactionCount || 0} 次`;
    elDetCacheRead.textContent = formatNumber(s.totalCacheRead || 0);

    // 渲染轮次导航条与诊断
    renderTurnsBar(s);
    renderDiagnostics(s);

    // 显示 Modal 弹窗
    elModal.classList.add("open");
    document.body.style.overflow = "hidden";

    // 等待弹窗在下一帧完成 DOM 布局与宽度计算后绘制图表
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        renderContextEvolutionChart(s);
        renderTurnInspector(s);
      });
    });
  }

  // 关闭 Modal 弹窗
  function closeModal() {
    elModal.classList.remove("open");
    document.body.style.overflow = "";
    if (elTooltip) elTooltip.style.display = "none";
  }

  // 6. 渲染轮次导航条
  function renderTurnsBar(s) {
    elTurnsBar.innerHTML = "";
    if (!s || !s.turns) return;

    s.turns.forEach(t => {
      const btn = document.createElement("button");
      btn.type = "button";
      let cls = `turn-pill ${t.turnIdx === activeTurnIdx ? "active" : ""}`;
      if (t.isCompaction) cls += " compaction";
      btn.className = cls;

      let label = `T${t.turnIdx}`;
      if (t.isCompaction) label += " ✂";
      else if (t.isBloat) label += " ⚡";

      btn.textContent = label;
      btn.title = `Turn #${t.turnIdx} · ${formatNumber(t.totalTokens)} tok`;

      btn.addEventListener("click", () => {
        activeTurnIdx = t.turnIdx;
        renderTurnsBar(s);
        renderContextEvolutionChart(s);
        renderTurnInspector(s);
      });

      elTurnsBar.appendChild(btn);
    });
  }

  // 7. 绘制 dsh-context 演进图 (严格支持 1 轮与多轮，使用实体色彩避免 CSS 变量解析失效)
  function renderContextEvolutionChart(s) {
    if (!s || !elCanvas) return;

    const ctx = elCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = elCanvas.getBoundingClientRect();
    const w = rect.width || elCanvas.parentElement?.clientWidth || 760;
    const h = rect.height || 220;

    elCanvas.width = w * dpr;
    elCanvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const turns = s.turns || [];
    if (turns.length === 0) return;

    const padLeft = 52;
    const padRight = 20;
    const padTop = 24;
    const padBottom = 28;

    const chartW = Math.max(10, w - padLeft - padRight);
    const chartH = Math.max(10, h - padTop - padBottom);

    const maxTokens = Math.max(...turns.map(t => t.totalTokens), 1200);
    const maxY = Math.max(maxTokens * 1.15, 6000);

    // 绘制横向参考刻度网格
    const isDark = document.documentElement.dataset.theme !== "light";
    const gridLineColor = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.08)";
    const textColor = isDark ? "#8e8e93" : "#6c6c70";

    const gridRows = 4;
    ctx.strokeStyle = gridLineColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = "10.5px ui-monospace, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let r = 0; r <= gridRows; r++) {
      const yVal = (maxY / gridRows) * r;
      const yPos = padTop + chartH - (r / gridRows) * chartH;

      ctx.beginPath();
      ctx.moveTo(padLeft, yPos);
      ctx.lineTo(padLeft + chartW, yPos);
      ctx.stroke();

      let yLabel = Math.round(yVal);
      if (yVal >= 1000) yLabel = (yVal / 1000).toFixed(0) + "k";
      ctx.fillText(yLabel, padLeft - 8, yPos);
    }

    const getY = (val) => padTop + chartH - (val / maxY) * chartH;

    // 单轮会话：绘制醒目的堆叠柱状图
    if (turns.length === 1) {
      const t = turns[0];
      const b = t.breakdown || {};
      const vSys = b.systemTokens || 4500;
      const vTools = b.toolsTokens || 3200;
      const vChat = (b.userTokens || 0) + (b.assistantTokens || 0);
      const vRes = b.toolResultTokens || 0;

      const barW = Math.min(180, chartW * 0.4);
      const barX = padLeft + (chartW - barW) / 2;

      let curBase = 0;
      const layers = [
        { name: "System", val: vSys, color: "rgba(168, 85, 247, 0.65)" },
        { name: "Tools", val: vTools, color: "rgba(56, 189, 248, 0.65)" },
        { name: "Chat", val: vChat, color: "rgba(16, 185, 129, 0.65)" },
        { name: "Tool Results", val: vRes, color: "rgba(249, 115, 22, 0.75)" }
      ];

      layers.forEach(layer => {
        const yTop = getY(curBase + layer.val);
        const yBot = getY(curBase);
        const layerH = Math.max(2, yBot - yTop);

        ctx.fillStyle = layer.color;
        ctx.fillRect(barX, yTop, barW, layerH);
        curBase += layer.val;
      });

      // 顶部总标签
      ctx.fillStyle = isDark ? "#ffffff" : "#1d1d1f";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${formatNumber(t.totalTokens)} Tokens (单轮)`, barX + barW / 2, getY(t.totalTokens) - 8);

      // X 轴标签
      ctx.fillStyle = textColor;
      ctx.fillText("Turn #1", barX + barW / 2, padTop + chartH + 16);
      return;
    }

    // 多轮会话：绘制平滑堆叠面积图
    const getX = (idx) => padLeft + (idx / (turns.length - 1)) * chartW;

    const points = turns.map((t, idx) => {
      const b = t.breakdown || {};
      const vSys = b.systemTokens || 0;
      const vTools = b.toolsTokens || 0;
      const vChat = (b.userTokens || 0) + (b.assistantTokens || 0);
      const vRes = b.toolResultTokens || 0;

      const y0 = 0;
      const y1 = vSys;
      const y2 = y1 + vTools;
      const y3 = y2 + vChat;
      const y4 = y3 + vRes;

      return {
        x: getX(idx),
        y0: getY(y0),
        y1: getY(y1),
        y2: getY(y2),
        y3: getY(y3),
        y4: getY(y4),
        turn: t
      };
    });

    function drawStackedArea(upperKey, lowerKey, color) {
      ctx.beginPath();
      ctx.fillStyle = color;
      points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p[upperKey]);
        else ctx.lineTo(p.x, p[upperKey]);
      });
      for (let i = points.length - 1; i >= 0; i--) {
        ctx.lineTo(points[i].x, points[i][lowerKey]);
      }
      ctx.closePath();
      ctx.fill();
    }

    // 1. System Prompt (🟣 紫)
    drawStackedArea("y1", "y0", "rgba(168, 85, 247, 0.45)");
    // 2. Tools Schema (🔵 蓝)
    drawStackedArea("y2", "y1", "rgba(56, 189, 248, 0.50)");
    // 3. Chat History (🟢 绿)
    drawStackedArea("y3", "y2", "rgba(16, 185, 129, 0.55)");
    // 4. Tool Results & Files (🟠 橙)
    drawStackedArea("y4", "y3", "rgba(249, 115, 22, 0.65)");

    // 顶部轮廓线
    ctx.beginPath();
    ctx.strokeStyle = isDark ? "rgba(255, 255, 255, 0.7)" : "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1.8;
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y4);
      else ctx.lineTo(p.x, p.y4);
    });
    ctx.stroke();

    // 绘制轮次节点与事件标线
    points.forEach((p) => {
      const isSelected = p.turn.turnIdx === activeTurnIdx;

      ctx.beginPath();
      ctx.arc(p.x, p.y4, isSelected ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#ffffff" : "#4f46e5";
      ctx.strokeStyle = isSelected ? "#4f46e5" : "rgba(255, 255, 255, 0.5)";
      ctx.lineWidth = 1.6;
      ctx.fill();
      ctx.stroke();

      // ✂ 压缩事件标记
      if (p.turn.isCompaction) {
        ctx.save();
        ctx.strokeStyle = "#ffd60a";
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(p.x, padTop);
        ctx.lineTo(p.x, padTop + chartH);
        ctx.stroke();

        ctx.fillStyle = "#ffd60a";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✂ 压缩", p.x, padTop - 4);
        ctx.restore();
      }

      // ⚡ 膨胀激增标记
      if (p.turn.isBloat) {
        ctx.save();
        ctx.fillStyle = "#ff453a";
        ctx.font = "bold 9.5px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("⚡ 激增", p.x, p.y4 - 7);
        ctx.restore();
      }
    });

    // 选中轮次的高亮竖向辅助线
    const curP = points.find(p => p.turn.turnIdx === activeTurnIdx);
    if (curP) {
      ctx.save();
      ctx.strokeStyle = isDark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(curP.x, padTop);
      ctx.lineTo(curP.x, padTop + chartH);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 8. Canvas 鼠标交互 (Tooltip 与点击跳转轮次)
  if (elCanvas) {
    elCanvas.addEventListener("mousemove", (e) => {
      const s = getActiveSession();
      if (!s || !s.turns?.length) return;

      const rect = elCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const padLeft = 52;
      const padRight = 20;
      const chartW = rect.width - padLeft - padRight;

      if (mouseX < padLeft - 10 || mouseX > rect.width - padRight + 10) {
        elTooltip.style.display = "none";
        return;
      }

      const ratio = Math.max(0, Math.min(1, (mouseX - padLeft) / chartW));
      const idx = Math.round(ratio * (s.turns.length - 1));
      const t = s.turns[idx];
      if (!t) return;

      const b = t.breakdown || {};
      elTooltip.style.display = "block";
      elTooltip.style.left = `${Math.min(mouseX + 12, rect.width - 180)}px`;
      elTooltip.style.top = `18px`;

      elTooltip.innerHTML = `
        <div style="font-weight: 700; color: #fff; margin-bottom: 4px; display:flex; justify-content:space-between;">
          <span>Turn #${t.turnIdx}</span>
          <span style="color:var(--green);">${t.timestamp || ""}</span>
        </div>
        <div style="font-size: 10.5px; line-height: 1.5;">
          <div>总 Tokens: <b>${formatNumber(t.totalTokens)}</b> (${t.tokenDelta >= 0 ? "+" : ""}${formatNumber(t.tokenDelta)})</div>
          <div style="color: #c084fc;">🟣 System: ${formatNumber(b.systemTokens)}</div>
          <div style="color: #38bdf8;">🔵 Tools: ${formatNumber(b.toolsTokens)}</div>
          <div style="color: #34d399;">🟢 Chat: ${formatNumber((b.userTokens || 0) + (b.assistantTokens || 0))}</div>
          <div style="color: #fb923c;">🟠 Tool Results: ${formatNumber(b.toolResultTokens)}</div>
          ${t.cacheRead ? `<div style="color: var(--cyan);">⚡ Cache Read: ${formatNumber(t.cacheRead)}</div>` : ""}
        </div>
      `;
    });

    elCanvas.addEventListener("mouseleave", () => {
      if (elTooltip) elTooltip.style.display = "none";
    });

    elCanvas.addEventListener("click", (e) => {
      const s = getActiveSession();
      if (!s || !s.turns?.length) return;

      const rect = elCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const padLeft = 52;
      const chartW = rect.width - padLeft - 20;

      const ratio = Math.max(0, Math.min(1, (mouseX - padLeft) / chartW));
      const idx = Math.round(ratio * (s.turns.length - 1));
      const t = s.turns[idx];
      if (t) {
        activeTurnIdx = t.turnIdx;
        renderTurnsBar(s);
        renderContextEvolutionChart(s);
        renderTurnInspector(s);
      }
    });
  }

  // 9. 渲染当前单轮消息透视 (Turn Inspector)
  function renderTurnInspector(s) {
    if (!s || !s.turns) return;
    const curTurn = s.turns.find(t => t.turnIdx === activeTurnIdx) || s.turns[0];
    if (!curTurn) return;

    elInspTurnBadge.textContent = `Turn #${curTurn.turnIdx}`;
    elInspTokens.textContent = `${formatNumber(curTurn.totalTokens)} Tokens`;

    const delta = curTurn.tokenDelta || 0;
    elInspDelta.textContent = `${delta >= 0 ? "+" : ""}${formatNumber(delta)}`;
    elInspDelta.style.color = delta > 15000 ? "var(--red)" : (delta < 0 ? "var(--amber)" : "var(--green)");

    elMessagesList.innerHTML = "";
    const msgs = curTurn.messages || [];

    const filtered = msgs.filter(m => {
      if (activeRoleFilter === "all") return true;
      return m.role === activeRoleFilter;
    });

    if (filtered.length === 0) {
      elMessagesList.innerHTML = `
        <div style="text-align: center; color: var(--muted); padding: 24px; font-size: 12px;">
          当前角色筛选下无独立记录
        </div>`;
      return;
    }

    filtered.forEach((m, idx) => {
      const card = document.createElement("div");
      card.className = "msg-card";

      const roleClass = m.role || "user";
      const roleLabel = {
        system: "System Prompt",
        tools: "Tools Schema",
        user: "User",
        assistant: "Assistant",
        tool_result: "Tool Results / Files"
      }[m.role] || m.role;

      card.innerHTML = `
        <div class="msg-head">
          <div class="msg-head-left">
            <span class="role-tag ${roleClass}">${roleLabel}</span>
            <span class="msg-tok">${formatNumber(m.tokens)} tok · ${formatNumber(m.chars || 0)} 字符</span>
          </div>
          <div class="msg-actions">
            <button type="button" class="msg-btn btn-expand">
              <span>展开详情</span>
            </button>
            <button type="button" class="msg-btn btn-copy">
              <span>复制内容</span>
            </button>
          </div>
        </div>
        <div class="msg-snippet">${escapeHtml(m.snippet || "")}</div>
        <div class="msg-full">${escapeHtml(m.fullText || m.snippet || "")}</div>
      `;

      // 展开/收起
      const btnExpand = card.querySelector(".btn-expand");
      btnExpand.addEventListener("click", () => {
        const isExp = card.classList.toggle("expanded");
        btnExpand.querySelector("span").textContent = isExp ? "收起" : "展开详情";
      });

      // 复制内容
      const btnCopy = card.querySelector(".btn-copy");
      btnCopy.addEventListener("click", () => {
        const textToCopy = m.fullText || m.snippet || "";
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast("已复制到剪贴板");
        }).catch(() => {
          showToast("复制失败，请手动选取");
        });
      });

      elMessagesList.appendChild(card);
    });
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

  // 10. 诊断与 Top 消耗排行
  function renderDiagnostics(s) {
    elTopConsumersBody.innerHTML = "";

    const consumers = [];
    (s.turns || []).forEach(t => {
      (t.messages || []).forEach(m => {
        if (m.tokens > 300) {
          consumers.push({
            name: m.role === "tool_result" ? `工具输出: ${m.snippet.slice(0, 32)}` : (m.snippet ? m.snippet.slice(0, 32) : m.role),
            turn: `T${t.turnIdx}`,
            tokens: m.tokens,
            percent: Math.min(100, Math.round((m.tokens / s.modelLimit) * 100))
          });
        }
      });
    });

    consumers.sort((a, b) => b.tokens - a.tokens);
    const top5 = consumers.slice(0, 5);

    if (top5.length === 0) {
      elTopConsumersBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:12px;">无显著异常大块数据</td></tr>`;
    } else {
      top5.forEach(c => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
          <td><b>${c.turn}</b></td>
          <td><b>${formatNumber(c.tokens)}</b> tok</td>
          <td style="color:${c.percent > 20 ? 'var(--red)' : 'var(--amber)'}; font-weight:600;">${c.percent}%</td>
        `;
        elTopConsumersBody.appendChild(tr);
      });
    }

    // 智能诊断建议
    const wm = s.watermarkPercent || 0;
    const compCount = s.compactionCount || 0;
    const tips = [];

    if (wm > 80) {
      tips.push(`<span style="color:var(--red);">⚠️ 上下文水位已达 ${wm}%，接近模型极限。极易触发大模型注意力丢失或高昂计费，建议主动触发压缩或启动新会话。</span>`);
    } else if (wm > 50) {
      tips.push(`<span style="color:var(--amber);">⚡ 上下文水位为 ${wm}%，健康度尚可，长文件读取或多轮大输出容易迅速推高水位。</span>`);
    } else {
      tips.push(`<span style="color:var(--green);">✅ 上下文水位处于极佳状态 (${wm}%)，注意力专注且保留充裕的思考余量。</span>`);
    }

    if (compCount > 0) {
      tips.push(`<span>✂ 历史检测到 ${compCount} 次上下文裁剪/压缩事件，有效抑制了上下文无序膨胀。</span>`);
    }

    elHealthTips.innerHTML = tips.join("");
  }

  // 11. 绑定交互事件监听
  function initEvents() {
    // Agent 分段切换
    elAgentSegs.addEventListener("click", (e) => {
      const btn = e.target.closest(".opt");
      if (!btn) return;
      elAgentSegs.querySelectorAll(".opt").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      activeAgentFilter = btn.dataset.agent;
      renderWorkspaceTree();
    });

    // 搜索监听
    elSessQ.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      renderWorkspaceTree();
    });

    // 角色分段切换
    elRoleSegs.addEventListener("click", (e) => {
      const btn = e.target.closest(".opt");
      if (!btn) return;
      elRoleSegs.querySelectorAll(".opt").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      activeRoleFilter = btn.dataset.role;
      const s = getActiveSession();
      if (s) renderTurnInspector(s);
    });

    // 弹窗关闭按钮
    elBtnModalClose.addEventListener("click", closeModal);

    // 点击弹窗遮罩背景关闭
    elModal.addEventListener("click", (e) => {
      if (e.target === elModal) {
        closeModal();
      }
    });

    // 按 ESC 键关闭弹窗
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && elModal.classList.contains("open")) {
        closeModal();
      }
    });

    // 窗口尺寸变化时重绘 Canvas 演进图
    if (window.ResizeObserver && elCanvasWrap) {
      const ro = new ResizeObserver(() => {
        if (elModal.classList.contains("open")) {
          const s = getActiveSession();
          if (s) renderContextEvolutionChart(s);
        }
      });
      ro.observe(elCanvasWrap);
    }

    // 主题切换
    elBtnTheme.addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      showToast(`已切换为 ${next === 'light' ? '浅色' : '深色'} 模式`);
      const s = getActiveSession();
      if (s && elModal.classList.contains("open")) {
        renderContextEvolutionChart(s);
      }
    });

    // 刷新数据
    elBtnRefresh.addEventListener("click", () => {
      showToast("正在重新加载数据...");
      setTimeout(() => {
        window.location.reload();
      }, 300);
    });
  }

  // 12. 页面启动初始化
  function init() {
    initEvents();
    renderGlobalKpi();
    renderWorkspaceTree();
  }

  init();
})();
