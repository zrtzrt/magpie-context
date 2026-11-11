// app.js - 上下文透视 (Context Lens) 官方样式与响应式布局交互逻辑

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

  // 2. DOM 节点引用
  const elMainLayout = $("mainLayout");
  const elAgentSegs = $("agentSegs");
  const elRoleSegs = $("roleSegs");
  const elSessList = $("sessList");
  const elSessQ = $("sessQ");
  const elBtnBackToList = $("btnBackToList");
  const elBtnRefresh = $("btnRefresh");
  const elBtnTheme = $("btnTheme");
  const elToast = $("toast");

  // 全局 KPI 节点
  const elKpiTotalSess = $("kpiTotalSess");
  const elKpiPeakWatermark = $("kpiPeakWatermark");
  const elKpiPeakWatermarkSub = $("kpiPeakWatermarkSub");
  const elKpiTotalTurns = $("kpiTotalTurns");
  const elKpiTotalCompactions = $("kpiTotalCompactions");
  const elKpiCacheRead = $("kpiCacheRead");

  // Detail 节点
  const elDetTitle = $("detTitle");
  const elDetSub = $("detSub");
  const elDetWatermarkText = $("detWatermarkText");
  const elDetLimitText = $("detLimitText");
  const elDetProgressBar = $("detProgressBar");
  const elDetCurTokens = $("detCurTokens");
  const elDetPeakTokens = $("detPeakTokens");
  const elDetTurnsCount = $("detTurnsCount");
  const elDetCompCount = $("detCompCount");
  const elDetCacheRead = $("detCacheRead");

  // Chart 节点
  const elCanvas = $("ctxCanvas");
  const elTooltip = $("ctxTooltip");
  const elTurnsBar = $("turnsBar");

  // Inspector 节点
  const elInspTurnBadge = $("inspTurnBadge");
  const elInspTokens = $("inspTokens");
  const elInspDelta = $("inspDelta");
  const elMessagesList = $("messagesList");
  const elTopConsumersBody = $("topConsumersBody");
  const elHealthTips = $("healthTips");

  function showToast(msg) {
    if (!elToast) return;
    elToast.textContent = msg;
    elToast.hidden = false;
    setTimeout(() => {
      elToast.hidden = true;
    }, 2200);
  }

  function formatNumber(n) {
    if (!n && n !== 0) return "0";
    return Number(n).toLocaleString("en-US");
  }

  function baseName(p) {
    if (!p) return "";
    const segs = p.replace(/\/+$/, "").split("/");
    return segs[segs.length - 1] || p;
  }

  function getActiveSession() {
    if (!rawSessions.length) return null;
    return rawSessions.find(s => s.id === activeSessionId) || rawSessions[0];
  }

  function getAgentIconSvg(agentKey) {
    if (typeof window.getIconSvg === "function") {
      return window.getIconSvg(agentKey);
    }
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="#888"><circle cx="12" cy="12" r="8"/></svg>`;
  }

  // 3. 渲染全局 KPI 与 Agent Tab 徽标数
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

  // 4. 渲染会话列表 (严格对标官方 .row.sess)
  function renderSessionsList() {
    elSessList.innerHTML = "";

    const filtered = rawSessions.filter(s => {
      // Agent 分段筛选
      if (activeAgentFilter === "antigravity" && s.agent !== "antigravity") return false;
      if (activeAgentFilter === "dsh" && s.agent !== "dsh") return false;
      if (activeAgentFilter === "codex" && s.agent !== "codex") return false;
      if (activeAgentFilter === "other" && ["antigravity", "dsh", "codex"].includes(s.agent)) return false;

      // 关键词搜索
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
      elSessList.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 36px 12px; font-size: 12.5px;">没有找到匹配的会话</div>`;
      return;
    }

    filtered.forEach(s => {
      const row = document.createElement("div");
      row.className = `row sess sess-link ${s.id === activeSessionId ? "active" : ""}`;

      const wm = s.watermarkPercent || 0;
      let wmColor = "var(--green)";
      if (wm > 75) wmColor = "var(--red)";
      else if (wm > 50) wmColor = "var(--amber)";

      const subParts = [
        s.cwd ? baseName(s.cwd) : "",
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
          <div class="sub" title="${s.cwd || ''}">${subParts.join(" · ")}</div>
        </div>
        <div class="num">
          <b>${formatNumber(s.currentTokens)} tok</b>
          <small style="color: ${wmColor};">${wm}% 水位</small>
        </div>
        ${s.compactionCount ? `<span style="font-size:10px; color:var(--amber); background:var(--amber-soft); border-radius:4px; padding:1px 4px; font-weight:600;">✂ ${s.compactionCount}</span>` : ''}
        <svg class="sess-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 12 10 8 6 4"/>
        </svg>
      `;

      row.addEventListener("click", () => {
        selectSession(s.id);
        // 小屏幕/移动端进入详情视图
        elMainLayout.classList.add("detail-open");
      });

      elSessList.appendChild(row);
    });
  }

  // 5. 选中会话
  function selectSession(sid) {
    activeSessionId = sid;
    const s = getActiveSession();
    if (!s) return;

    // 默认定位到最后轮次
    activeTurnIdx = s.turns?.length ? s.turns[s.turns.length - 1].turnIdx : 1;

    renderSessionsList();
    renderSessionDetailBanner(s);
    renderTurnsBar(s);
    renderContextEvolutionChart(s);
    renderTurnInspector(s);
    renderDiagnostics(s);
  }

  // 6. 渲染会话详情 Header 与 dsh-context KPI
  function renderSessionDetailBanner(s) {
    elDetTitle.textContent = s.name || "(未命名会话)";
    elDetSub.innerHTML = `
      <span>Agent: <b style="color:var(--fg);">${s.agentName || s.agent}</b></span>
      <span>·</span>
      <span>模型: <b style="color:var(--fg);">${s.model}</b></span>
      <span>·</span>
      <span>目录: ${s.cwd ? baseName(s.cwd) : "默认工作区"}</span>
      <span>·</span>
      <span>活跃: ${s.lastTime || s.timeAgo || ""}</span>
    `;

    const wm = s.watermarkPercent || 0;
    elDetWatermarkText.textContent = `${wm}% 水位`;
    elDetLimitText.textContent = `/ ${formatNumber(s.modelLimit)} Tokens 上限`;
    elDetProgressBar.style.width = `${Math.min(100, wm)}%`;

    if (wm > 75) {
      elDetProgressBar.style.background = "var(--red)";
      elDetWatermarkText.style.color = "var(--red)";
    } else if (wm > 50) {
      elDetProgressBar.style.background = "var(--amber)";
      elDetWatermarkText.style.color = "var(--amber)";
    } else {
      elDetProgressBar.style.background = "var(--green)";
      elDetWatermarkText.style.color = "var(--green)";
    }

    elDetCurTokens.textContent = `${formatNumber(s.currentTokens)} tok`;
    elDetPeakTokens.textContent = `${formatNumber(s.peakTokens)} tok`;
    elDetTurnsCount.textContent = `${s.turnsCount} 轮`;
    elDetCompCount.textContent = `${s.compactionCount || 0} 次`;
    elDetCacheRead.textContent = formatNumber(s.totalCacheRead || 0);
  }

  // 7. 渲染轮次步进导航条
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

  // 8. 绘制 dsh-context 风格的上下文演进堆叠图 (Context Evolution Chart on Canvas)
  function renderContextEvolutionChart(s) {
    if (!s || !elCanvas) return;

    const ctx = elCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = elCanvas.getBoundingClientRect();

    elCanvas.width = rect.width * dpr;
    elCanvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const turns = s.turns || [];
    if (turns.length === 0) return;

    const padLeft = 46;
    const padRight = 16;
    const padTop = 20;
    const padBottom = 26;

    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    const maxTokensInSession = Math.max(...turns.map(t => t.totalTokens), 1000);
    const maxY = Math.max(maxTokensInSession * 1.15, 6000);

    // 绘制横向网格刻度线
    const gridRows = 4;
    ctx.strokeStyle = document.documentElement.dataset.theme === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#88888e";
    ctx.font = "10px ui-monospace, sans-serif";
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
      ctx.fillText(yLabel, padLeft - 6, yPos);
    }

    const getX = (idx) => {
      if (turns.length <= 1) return padLeft + chartW / 2;
      return padLeft + (idx / (turns.length - 1)) * chartW;
    };

    const getY = (val) => {
      return padTop + chartH - (val / maxY) * chartH;
    };

    // 准备 4 层堆叠数据点 (System, Tools, Chat History, Tool Results)
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

    function drawStackedLayer(upperKey, lowerKey, fillColor) {
      ctx.beginPath();
      ctx.fillStyle = fillColor;
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

    // 1. System Prompt (🟣)
    drawStackedLayer("y1", "y0", "rgba(168, 85, 247, 0.42)");
    // 2. Tools Definition (🔵)
    drawStackedLayer("y2", "y1", "rgba(56, 189, 248, 0.48)");
    // 3. Chat History (🟢)
    drawStackedLayer("y3", "y2", "rgba(16, 185, 129, 0.52)");
    // 4. Tool Results & Files (🟠)
    drawStackedLayer("y4", "y3", "rgba(249, 115, 22, 0.62)");

    // 绘制总外轮廓线
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 1.8;
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y4);
      else ctx.lineTo(p.x, p.y4);
    });
    ctx.stroke();

    // 绘制节点与事件标线 (✂ 压缩, ⚡ 膨胀)
    points.forEach((p) => {
      const isSelected = p.turn.turnIdx === activeTurnIdx;

      ctx.beginPath();
      ctx.arc(p.x, p.y4, isSelected ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#ffffff" : "var(--accent)";
      ctx.strokeStyle = isSelected ? "var(--accent)" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = 1.8;
      ctx.fill();
      ctx.stroke();

      if (p.turn.isCompaction) {
        ctx.save();
        ctx.strokeStyle = "var(--amber)";
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(p.x, padTop);
        ctx.lineTo(p.x, padTop + chartH);
        ctx.stroke();

        ctx.fillStyle = "var(--amber)";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✂ 压缩", p.x, padTop - 4);
        ctx.restore();
      }

      if (p.turn.isBloat) {
        ctx.save();
        ctx.fillStyle = "var(--red)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("⚡ 激增", p.x, p.y4 - 7);
        ctx.restore();
      }
    });

    // 选定轮次竖向辅助线
    const curPoint = points.find(p => p.turn.turnIdx === activeTurnIdx);
    if (curPoint) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(curPoint.x, padTop);
      ctx.lineTo(curPoint.x, padTop + chartH);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Canvas 鼠标交互 (Tooltip 与点击切轮次)
  if (elCanvas) {
    elCanvas.addEventListener("mousemove", (e) => {
      const s = getActiveSession();
      if (!s || !s.turns?.length) return;

      const rect = elCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const padLeft = 46;
      const padRight = 16;
      const chartW = rect.width - padLeft - padRight;

      const ratio = (mouseX - padLeft) / chartW;
      const idx = Math.round(ratio * (s.turns.length - 1));

      if (idx >= 0 && idx < s.turns.length) {
        const turn = s.turns[idx];
        const b = turn.breakdown || {};

        elTooltip.style.display = "block";
        elTooltip.style.left = `${e.clientX - rect.left}px`;
        elTooltip.style.top = `${e.clientY - rect.top}px`;

        elTooltip.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 4px; border-bottom: 1px solid var(--line-2); padding-bottom: 3px;">
            Turn #${turn.turnIdx} · ${formatNumber(turn.totalTokens)} Tokens
          </div>
          <div style="display:flex; flex-direction:column; gap:2px;">
            <div style="color: var(--c-system);">🟣 系统提示词: ${formatNumber(b.systemTokens)}</div>
            <div style="color: var(--c-tools);">🔵 工具声明: ${formatNumber(b.toolsTokens)}</div>
            <div style="color: var(--c-user);">🟢 对话历史: ${formatNumber((b.userTokens || 0) + (b.assistantTokens || 0))}</div>
            <div style="color: var(--c-toolres);">🟠 工具/文件注入: ${formatNumber(b.toolResultTokens)}</div>
          </div>
          ${turn.isCompaction ? `<div style="color: var(--amber); margin-top: 4px;">✂ 发生了历史上下文压缩</div>` : ""}
          ${turn.isBloat ? `<div style="color: var(--red); margin-top: 4px;">⚡ 单轮 Token 突增超过 15k</div>` : ""}
        `;
      }
    });

    elCanvas.addEventListener("mouseleave", () => {
      elTooltip.style.display = "none";
    });

    elCanvas.addEventListener("click", (e) => {
      const s = getActiveSession();
      if (!s || !s.turns?.length) return;

      const rect = elCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const padLeft = 46;
      const padRight = 16;
      const chartW = rect.width - padLeft - padRight;

      const ratio = (mouseX - padLeft) / chartW;
      const idx = Math.round(ratio * (s.turns.length - 1));

      if (idx >= 0 && idx < s.turns.length) {
        activeTurnIdx = s.turns[idx].turnIdx;
        renderTurnsBar(s);
        renderContextEvolutionChart(s);
        renderTurnInspector(s);
      }
    });
  }

  // 9. 渲染单轮内容透视 (Turn Inspector - dsh-context 核心模块)
  function renderTurnInspector(s) {
    if (!s) return;

    const turn = (s.turns || []).find(t => t.turnIdx === activeTurnIdx) || s.turns?.[0];
    if (!turn) {
      elMessagesList.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 20px;">当前轮次暂无消息记录</div>`;
      return;
    }

    elInspTurnBadge.textContent = `Turn #${turn.turnIdx}`;
    elInspTokens.textContent = `${formatNumber(turn.totalTokens)} Tokens`;

    const delta = turn.tokenDelta || 0;
    if (delta > 0) {
      elInspDelta.textContent = `+${formatNumber(delta)} 增量`;
      elInspDelta.style.color = "var(--green)";
    } else if (delta < 0) {
      elInspDelta.textContent = `${formatNumber(delta)} (压缩 ✂)`;
      elInspDelta.style.color = "var(--amber)";
    } else {
      elInspDelta.textContent = "首轮启动";
      elInspDelta.style.color = "var(--muted)";
    }

    elMessagesList.innerHTML = "";
    let msgs = turn.messages || [];

    // 角色过滤
    if (activeRoleFilter !== "all") {
      msgs = msgs.filter(m => m.role === activeRoleFilter);
    }

    if (msgs.length === 0) {
      elMessagesList.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 20px;">该角色在此轮次无消息</div>`;
      return;
    }

    msgs.forEach(m => {
      const card = document.createElement("div");
      card.className = "msg-card";

      const pct = turn.totalTokens ? Math.round((m.tokens / turn.totalTokens) * 100) : 0;
      let toolPills = "";
      if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        toolPills = m.toolCalls.map(tc => `<span style="background:var(--card); border:1px solid var(--line); border-radius:3px; padding:1px 5px; font-size:10px; color:var(--cyan);">${tc}</span>`).join(" ");
      }

      card.innerHTML = `
        <div class="msg-head">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="role-pill ${m.role}">${m.role}</span>
            ${toolPills}
            <span style="font-size:11px; color:var(--muted);">${m.chars ? formatNumber(m.chars) + ' 字符' : ''}</span>
          </div>
          <div class="msg-meta">
            <span style="color:var(--fg-2); font-weight:600;">${formatNumber(m.tokens)} tok (${pct}%)</span>
            <button type="button" class="btn-inline btn-copy">复制</button>
            <button type="button" class="btn-inline btn-toggle">收起</button>
          </div>
        </div>
        <div class="msg-body">${escapeHtml(m.fullText || m.snippet || "")}</div>
      `;

      // 复制功能
      const btnCopy = card.querySelector(".btn-copy");
      btnCopy.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(m.fullText || m.snippet || "").then(() => {
          showToast("已成功复制该消息内容！");
        });
      });

      // 收起/展开功能
      const btnToggle = card.querySelector(".btn-toggle");
      const bodyEl = card.querySelector(".msg-body");
      btnToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (bodyEl.style.display === "none") {
          bodyEl.style.display = "block";
          btnToggle.textContent = "收起";
        } else {
          bodyEl.style.display = "none";
          btnToggle.textContent = "展开";
        }
      });

      elMessagesList.appendChild(card);
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 10. 渲染 Top 上下文消耗源与健康体检建议
  function renderDiagnostics(s) {
    if (!s) return;

    elTopConsumersBody.innerHTML = "";
    const consumers = [];

    (s.turns || []).forEach(t => {
      (t.messages || []).forEach(m => {
        if (m.tokens > 800) {
          let name = m.role.toUpperCase();
          if (m.toolCalls?.length) name = `工具调用: ${m.toolCalls.join(",")}`;
          else if (m.role === "tool") name = "工具返回值 / 文件读取";
          else if (m.role === "system") name = "系统提示词 / 指令定义";

          consumers.push({
            name,
            turn: `Turn #${t.turnIdx}`,
            tokens: m.tokens,
            pct: s.peakTokens ? Math.round((m.tokens / s.peakTokens) * 100) : 0
          });
        }
      });
    });

    consumers.sort((a, b) => b.tokens - a.tokens);
    const top5 = consumers.slice(0, 5);

    if (top5.length === 0) {
      elTopConsumersBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:14px;">未检测到超过 800 Token 的单项大型数据块</td></tr>`;
    } else {
      top5.forEach(c => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="color:var(--fg); font-weight:500;">${c.name}</td>
          <td>${c.turn}</td>
          <td style="color:var(--c-toolres); font-weight:700;">${formatNumber(c.tokens)}</td>
          <td>${c.pct}%</td>
        `;
        elTopConsumersBody.appendChild(tr);
      });
    }

    // 健康体检建议
    elHealthTips.innerHTML = "";
    const tips = [];
    const wm = s.watermarkPercent || 0;

    if (wm < 35) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--green);">●</span> 上下文余量充裕 (${wm}%)，模型注意力与长文本推理处于极佳窗口。</div>`);
    } else if (wm > 75) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--red);">⚠️</span> 上下文占用已达 ${wm}%，接近物理上限，建议精简长命令输出或触发 Compaction。</div>`);
    }

    if (s.compactionCount > 0) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--amber);">✂</span> 本会话已有效执行 ${s.compactionCount} 次历史压缩，成功释放了冗余工具输出占用。</div>`);
    }

    if (s.bloatCount > 0) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--red);">⚡</span> 检测到 ${s.bloatCount} 次单轮 Token 激增 (>15,000 Tokens)，多由大文件全量读取引起。</div>`);
    }

    tips.forEach(html => {
      const div = document.createElement("div");
      div.innerHTML = html;
      elHealthTips.appendChild(div);
    });
  }

  // 11. 绑定交互事件
  function bindEvents() {
    // Agent Tab 分段筛选
    if (elAgentSegs) {
      elAgentSegs.addEventListener("click", (e) => {
        const btn = e.target.closest(".opt");
        if (!btn) return;
        elAgentSegs.querySelectorAll(".opt").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        activeAgentFilter = btn.dataset.agent;
        renderSessionsList();
      });
    }

    // Role 筛选
    if (elRoleSegs) {
      elRoleSegs.addEventListener("click", (e) => {
        const btn = e.target.closest(".opt");
        if (!btn) return;
        elRoleSegs.querySelectorAll(".opt").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        activeRoleFilter = btn.dataset.role;
        renderTurnInspector(getActiveSession());
      });
    }

    // 搜索
    if (elSessQ) {
      elSessQ.addEventListener("input", (e) => {
        searchQuery = e.target.value.trim();
        renderSessionsList();
      });
    }

    // 移动端返回会话列表按钮
    if (elBtnBackToList) {
      elBtnBackToList.addEventListener("click", () => {
        elMainLayout.classList.remove("detail-open");
      });
    }

    // 刷新数据
    if (elBtnRefresh) {
      elBtnRefresh.addEventListener("click", () => {
        if (Array.isArray(window.CONTEXT_SESSIONS)) {
          rawSessions = [...window.CONTEXT_SESSIONS];
          summary = window.CONTEXT_SUMMARY || {};
          renderGlobalKpi();
          renderSessionsList();
          const cur = getActiveSession();
          if (cur) {
            selectSession(cur.id);
          }
          showToast("已成功同步最新上下文数据！");
        }
      });
    }

    // 主题切换
    if (elBtnTheme) {
      elBtnTheme.addEventListener("click", () => {
        const cur = document.documentElement.dataset.theme;
        const next = cur === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        renderContextEvolutionChart(getActiveSession());
      });
    }

    // 窗口尺寸变化重绘图表
    window.addEventListener("resize", () => {
      renderContextEvolutionChart(getActiveSession());
    });
  }

  // 12. 初始化
  async function init() {
    if (globalThis.magpie) {
      try {
        const theme = await magpie.ready;
        if (theme && theme.dark !== undefined) {
          document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
        }
        if (magpie.onTheme) {
          magpie.onTheme((t) => {
            document.documentElement.dataset.theme = t.dark ? "dark" : "light";
            renderContextEvolutionChart(getActiveSession());
          });
        }
      } catch (e) {}
    }

    bindEvents();
    renderGlobalKpi();

    if (rawSessions.length > 0) {
      selectSession(rawSessions[0].id);
    } else {
      renderSessionsList();
    }
  }

  init();
})();
