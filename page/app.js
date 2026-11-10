// app.js - 上下文透视 (Context Lens) 前端交互与图表引擎

(() => {
  const $ = (id) => document.getElementById(id);

  // 1. 状态定义
  let sessions = Array.isArray(window.CONTEXT_SESSIONS) ? [...window.CONTEXT_SESSIONS] : [];
  let summary = window.CONTEXT_SUMMARY || {};
  let activeSessionId = null;
  let activeTurnIdx = 1;
  let agentFilter = "all";
  let roleFilter = "all";
  let searchQuery = "";

  // 2. DOM 节点引用
  const elSessionsList = $("sessions-list");
  const elSessionSearch = $("session-search-input");
  const elAgentFilters = $("agent-filter-pills");
  const elRoleFilters = $("role-filter-pills");
  const elCanvas = $("evolutionChart");
  const elTooltip = $("chart-tooltip");
  const elTurnsSelector = $("turns-selector");
  const elMessagesStream = $("messages-stream");
  const elTopConsumers = $("top-consumers-tbody");
  const elHealthTips = $("health-tips-container");
  const elToast = $("toast");

  // KPI 节点
  const elKpiWatermark = $("kpi-watermark");
  const elKpiWatermarkBar = $("kpi-watermark-bar");
  const elKpiWatermarkSub = $("kpi-watermark-sub");
  const elKpiPeakTokens = $("kpi-peak-tokens");
  const elKpiPeakSub = $("kpi-peak-sub");
  const elKpiTurnsCount = $("kpi-turns-count");
  const elKpiTurnsSub = $("kpi-turns-sub");
  const elKpiCompactions = $("kpi-compactions");
  const elKpiCompactionsSub = $("kpi-compactions-sub");
  const elKpiSessionsTotal = $("kpi-sessions-total");

  // Inspector 节点
  const elInspectTurnIdx = $("inspect-turn-idx");
  const elInspectTurnTokens = $("inspect-turn-tokens");
  const elInspectTurnDelta = $("inspect-turn-delta");
  const elInspectTurnPercent = $("inspect-turn-percent");

  function showToast(msg) {
    if (!elToast) return;
    elToast.textContent = msg;
    elToast.hidden = false;
    setTimeout(() => {
      elToast.hidden = true;
    }, 2400);
  }

  function formatNumber(n) {
    if (!n && n !== 0) return "0";
    return Number(n).toLocaleString("en-US");
  }

  function getActiveSession() {
    if (!sessions.length) return null;
    return sessions.find(s => s.id === activeSessionId) || sessions[0];
  }

  // 3. 渲染全局 KPI
  function renderGlobalKpi() {
    const s = getActiveSession();
    if (!s) return;

    // 当前选定会话的水位
    const wm = s.watermarkPercent || 0;
    elKpiWatermark.textContent = `${wm}%`;
    elKpiWatermarkBar.style.width = `${Math.min(100, wm)}%`;

    if (wm > 80) {
      elKpiWatermarkBar.style.background = "var(--red)";
      elKpiWatermark.style.color = "var(--red)";
    } else if (wm > 60) {
      elKpiWatermarkBar.style.background = "var(--amber)";
      elKpiWatermark.style.color = "var(--amber)";
    } else {
      elKpiWatermarkBar.style.background = "var(--green)";
      elKpiWatermark.style.color = "var(--fg)";
    }

    elKpiWatermarkSub.textContent = `${formatNumber(s.currentTokens)} / ${formatNumber(s.modelLimit)} Tokens`;

    // 峰值与轮次
    elKpiPeakTokens.textContent = formatNumber(s.peakTokens);
    elKpiPeakSub.textContent = `峰值水位 ${(s.peakTokens && s.modelLimit ? Math.round((s.peakTokens / s.modelLimit) * 100) : 0)}%`;

    elKpiTurnsCount.textContent = `${s.turnsCount} 轮`;
    const totalMsgs = (s.turns || []).reduce((acc, t) => acc + (t.messages?.length || 0), 0);
    elKpiTurnsSub.textContent = `${totalMsgs} 条上下文消息`;

    elKpiCompactions.textContent = `${s.compactionCount || 0} 次`;
    elKpiCompactionsSub.textContent = s.compactionCount > 0 ? "已执行历史压缩 ✂" : "未触发压缩事件";

    elKpiSessionsTotal.textContent = String(summary.totalSessions || sessions.length);
  }

  // 4. 渲染会话侧边栏列表
  function renderSessionsList() {
    elSessionsList.innerHTML = "";

    const filtered = sessions.filter(s => {
      // 客户端筛选
      if (agentFilter === "antigravity" && s.agent !== "antigravity") return false;
      if (agentFilter === "dsh" && s.agent !== "dsh") return false;
      if (agentFilter === "codex" && s.agent !== "codex") return false;
      if (agentFilter === "live" && !s.id.startsWith("sess-") && !s.name.includes("[实时]")) return false;

      // 关键词搜索
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchTitle = (s.name || "").toLowerCase().includes(q);
        const matchCwd = (s.cwd || "").toLowerCase().includes(q);
        const matchModel = (s.model || "").toLowerCase().includes(q);
        if (!matchTitle && !matchCwd && !matchModel) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      elSessionsList.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 30px 10px; font-size: 12px;">暂无匹配会话</div>`;
      return;
    }

    filtered.forEach(s => {
      const card = document.createElement("div");
      card.className = `session-card ${s.id === activeSessionId ? "active" : ""}`;

      let agentLabel = s.agentName || s.agent;
      let badgeColor = "var(--accent)";
      if (s.agent === "antigravity") badgeColor = "var(--c-system)";
      else if (s.agent === "dsh") badgeColor = "var(--cyan)";
      else if (s.agent === "codex") badgeColor = "var(--green)";

      const wm = s.watermarkPercent || 0;
      let wmColor = "var(--green)";
      if (wm > 75) wmColor = "var(--red)";
      else if (wm > 50) wmColor = "var(--amber)";

      card.innerHTML = `
        <div class="session-card-head">
          <span class="session-agent-badge" style="color: ${badgeColor};">
            <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${badgeColor};"></span>
            ${agentLabel}
          </span>
          <span class="session-time">${s.lastTime ? s.lastTime.slice(5, 16) : ""}</span>
        </div>
        <div class="session-title" title="${s.name}">${s.name}</div>
        <div class="session-stats-row">
          <span class="session-tokens-badge">${formatNumber(s.currentTokens)} tok</span>
          <span style="color: ${wmColor}; font-weight: 600;">${wm}% 水位</span>
          ${s.compactionCount ? `<span style="color: var(--amber); font-size: 10px;">✂ ${s.compactionCount}</span>` : ""}
        </div>
      `;

      card.addEventListener("click", () => {
        selectSession(s.id);
      });

      elSessionsList.appendChild(card);
    });
  }

  // 5. 切换会话
  function selectSession(sessionId) {
    activeSessionId = sessionId;
    const s = getActiveSession();
    if (!s) return;

    $("active-session-title").textContent = s.name;
    $("active-session-desc").textContent = `Agent: ${s.agentName || s.agent} · 模型: ${s.model} · 上下文上限: ${formatNumber(s.modelLimit)} Tokens`;

    // 默认定位到最后或最大的轮次
    activeTurnIdx = s.turns?.length ? s.turns[s.turns.length - 1].turnIdx : 1;

    renderGlobalKpi();
    renderSessionsList();
    renderTurnsScrubber();
    renderEvolutionChart();
    renderTurnInspector();
    renderDiagnostics();
  }

  // 6. 渲染轮次步进选择器
  function renderTurnsScrubber() {
    elTurnsSelector.innerHTML = "";
    const s = getActiveSession();
    if (!s || !s.turns) return;

    s.turns.forEach(t => {
      const btn = document.createElement("button");
      btn.type = "button";
      let cls = `turn-pill-btn ${t.turnIdx === activeTurnIdx ? "active" : ""}`;
      if (t.isCompaction) cls += " compaction";
      btn.className = cls;

      let label = `T${t.turnIdx}`;
      if (t.isCompaction) label += " ✂";
      else if (t.isBloat) label += " ⚡";

      btn.textContent = label;
      btn.title = `Turn #${t.turnIdx} (${formatNumber(t.totalTokens)} tokens)`;

      btn.addEventListener("click", () => {
        activeTurnIdx = t.turnIdx;
        renderTurnsScrubber();
        renderEvolutionChart();
        renderTurnInspector();
      });

      elTurnsSelector.appendChild(btn);
    });
  }

  // 7. 渲染上下文增长演进图 (Evolution Stacked Chart on Canvas)
  let chartHoverIdx = null;

  function renderEvolutionChart() {
    const s = getActiveSession();
    if (!s || !elCanvas) return;

    const ctx = elCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = elCanvas.getBoundingClientRect();

    elCanvas.width = rect.width * dpr;
    elCanvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // 清空画布
    ctx.clearRect(0, 0, w, h);

    const turns = s.turns || [];
    if (turns.length === 0) return;

    const padLeft = 50;
    const padRight = 20;
    const padTop = 20;
    const padBottom = 30;

    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    // 计算 Y 轴最大值
    const maxTokensInSession = Math.max(...turns.map(t => t.totalTokens), 1000);
    const maxY = Math.max(maxTokensInSession * 1.18, 5000);

    // 绘制横向网格线与 Y 轴刻度
    const gridRows = 4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    if (document.documentElement.dataset.theme === "light") {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.06)";
    }
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
      ctx.fillText(yLabel, padLeft - 8, yPos);
    }

    // X 轴坐标映射
    const getX = (idx) => {
      if (turns.length <= 1) return padLeft + chartW / 2;
      return padLeft + (idx / (turns.length - 1)) * chartW;
    };

    // 辅助计算堆叠各层的 Y 坐标
    const getY = (val) => {
      return padTop + chartH - (val / maxY) * chartH;
    };

    // 准备堆叠数据点 (从底向上: System, Tools, User & Assistant, Tool Results)
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

    // 绘制分层填充区域 (Helper)
    function drawStackedLayer(upperKey, lowerKey, fillColor) {
      ctx.beginPath();
      ctx.fillStyle = fillColor;

      // 顶部轮廓
      points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p[upperKey]);
        else ctx.lineTo(p.x, p[upperKey]);
      });

      // 底部轮廓 (反向闭合)
      for (let i = points.length - 1; i >= 0; i--) {
        ctx.lineTo(points[i].x, points[i][lowerKey]);
      }

      ctx.closePath();
      ctx.fill();
    }

    // 1. Layer: System (紫)
    drawStackedLayer("y1", "y0", "rgba(168, 85, 247, 0.45)");

    // 2. Layer: Tools (蓝)
    drawStackedLayer("y2", "y1", "rgba(56, 189, 248, 0.5)");

    // 3. Layer: Chat History (绿)
    drawStackedLayer("y3", "y2", "rgba(16, 185, 129, 0.55)");

    // 4. Layer: Tool Results (橙)
    drawStackedLayer("y4", "y3", "rgba(249, 115, 22, 0.65)");

    // 绘制总外轮廓线
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 2;
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y4);
      else ctx.lineTo(p.x, p.y4);
    });
    ctx.stroke();

    // 绘制各轮次数据点与事件标记 (✂ 压缩, ⚡ 膨胀)
    points.forEach((p) => {
      const isSelected = p.turn.turnIdx === activeTurnIdx;

      // 绘制普通节点
      ctx.beginPath();
      ctx.arc(p.x, p.y4, isSelected ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#ffffff" : "var(--accent)";
      ctx.strokeStyle = isSelected ? "var(--accent)" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      // 压缩剪枝事件 (✂)
      if (p.turn.isCompaction) {
        ctx.save();
        ctx.strokeStyle = "var(--amber)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x, padTop);
        ctx.lineTo(p.x, padTop + chartH);
        ctx.stroke();

        ctx.fillStyle = "var(--amber)";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✂ 压缩", p.x, padTop - 5);
        ctx.restore();
      }

      // 膨胀预警事件 (⚡)
      if (p.turn.isBloat) {
        ctx.save();
        ctx.fillStyle = "var(--red)";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("⚡ 膨胀", p.x, p.y4 - 8);
        ctx.restore();
      }
    });

    // 绘制当前选定轮次的高亮竖线
    const curPoint = points.find(p => p.turn.turnIdx === activeTurnIdx);
    if (curPoint) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(curPoint.x, padTop);
      ctx.lineTo(curPoint.x, padTop + chartH);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Canvas 交互事件监听 (鼠标移动展示 Tooltip，点击切换轮次)
  if (elCanvas) {
    elCanvas.addEventListener("mousemove", (e) => {
      const s = getActiveSession();
      if (!s || !s.turns?.length) return;

      const rect = elCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;

      const padLeft = 50;
      const padRight = 20;
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
      const padLeft = 50;
      const padRight = 20;
      const chartW = rect.width - padLeft - padRight;

      const ratio = (mouseX - padLeft) / chartW;
      const idx = Math.round(ratio * (s.turns.length - 1));

      if (idx >= 0 && idx < s.turns.length) {
        activeTurnIdx = s.turns[idx].turnIdx;
        renderTurnsScrubber();
        renderEvolutionChart();
        renderTurnInspector();
      }
    });
  }

  // 8. 渲染当前选定轮次的内容透视 (Turn Inspector)
  function renderTurnInspector() {
    const s = getActiveSession();
    if (!s) return;

    const turn = (s.turns || []).find(t => t.turnIdx === activeTurnIdx) || s.turns?.[0];
    if (!turn) {
      elMessagesStream.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 20px;">当前轮次暂无消息记录</div>`;
      return;
    }

    elInspectTurnIdx.textContent = `Turn #${turn.turnIdx}`;
    elInspectTurnTokens.textContent = `${formatNumber(turn.totalTokens)} Tokens`;

    // 变化量
    const delta = turn.tokenDelta || 0;
    if (delta > 0) {
      elInspectTurnDelta.textContent = `+${formatNumber(delta)}`;
      elInspectTurnDelta.style.color = "var(--green)";
    } else if (delta < 0) {
      elInspectTurnDelta.textContent = `${formatNumber(delta)} (压缩)`;
      elInspectTurnDelta.style.color = "var(--amber)";
    } else {
      elInspectTurnDelta.textContent = "首轮启动";
      elInspectTurnDelta.style.color = "var(--muted)";
    }

    const pct = s.modelLimit ? Math.round((turn.totalTokens / s.modelLimit) * 100) : 0;
    elInspectTurnPercent.textContent = `${pct}% 窗口`;

    // 渲染消息流卡片
    elMessagesStream.innerHTML = "";
    let msgs = turn.messages || [];

    // 角色过滤
    if (roleFilter !== "all") {
      msgs = msgs.filter(m => m.role === roleFilter);
    }

    if (msgs.length === 0) {
      elMessagesStream.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 24px;">该角色在此轮次无消息</div>`;
      return;
    }

    msgs.forEach((m) => {
      const card = document.createElement("div");
      card.className = "message-item";

      const pctOfTurn = turn.totalTokens ? Math.round((m.tokens / turn.totalTokens) * 100) : 0;
      let toolPills = "";
      if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        toolPills = m.toolCalls.map(tc => `<span style="background:var(--card); border:1px solid var(--line); border-radius:3px; padding:1px 5px; font-size:10px; color:var(--cyan);">${tc}</span>`).join(" ");
      }

      card.innerHTML = `
        <div class="message-head">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="role-badge ${m.role}">${m.role}</span>
            ${toolPills}
            <span style="font-size:11px; color:var(--muted);">${m.chars ? formatNumber(m.chars) + ' 字符' : ''}</span>
          </div>
          <div class="message-meta">
            <span style="color:var(--fg-2); font-weight:600;">${formatNumber(m.tokens)} tok (${pctOfTurn}%)</span>
            <div class="message-actions">
              <button type="button" class="btn-mini btn-copy">复制</button>
              <button type="button" class="btn-mini btn-toggle">收起</button>
            </div>
          </div>
        </div>
        <div class="message-body">${escapeHtml(m.fullText || m.snippet || "")}</div>
      `;

      // 复制功能
      const btnCopy = card.querySelector(".btn-copy");
      btnCopy.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(m.fullText || m.snippet || "").then(() => {
          showToast("已成功复制该消息全文到剪贴板！");
        });
      });

      // 折叠功能
      const btnToggle = card.querySelector(".btn-toggle");
      const bodyEl = card.querySelector(".message-body");
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

      elMessagesStream.appendChild(card);
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 9. 渲染诊断与 Top 上下文消耗源
  function renderDiagnostics() {
    const s = getActiveSession();
    if (!s) return;

    elTopConsumers.innerHTML = "";

    // 收集该会话中各轮次的 Top 消息与工具消耗
    const consumers = [];
    (s.turns || []).forEach(t => {
      (t.messages || []).forEach(m => {
        if (m.tokens > 1000) {
          let name = m.role.toUpperCase();
          if (m.toolCalls?.length) name = `工具调用: ${m.toolCalls.join(",")}`;
          else if (m.role === "tool") name = "工具返回值 / 文件读取";
          else if (m.role === "system") name = "系统身份 / 指令设定";

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
      elTopConsumers.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:16px;">未检测到单项超过 1,000 Token 的大型数据块</td></tr>`;
    } else {
      top5.forEach(c => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="color:var(--fg); font-weight:500;">${c.name}</td>
          <td>${c.turn}</td>
          <td style="color:var(--c-toolres); font-weight:700;">${formatNumber(c.tokens)}</td>
          <td>${c.pct}% 峰值</td>
        `;
        elTopConsumers.appendChild(tr);
      });
    }

    // 右侧健康度建议
    elHealthTips.innerHTML = "";
    const tips = [];

    const wm = s.watermarkPercent || 0;
    if (wm < 35) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--green);">●</span> 上下文余量充足，当前占用仅 ${wm}%，Agent 思考与检索处于极佳状态。</div>`);
    } else if (wm > 75) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--red);">⚠️</span> 上下文已达 ${wm}%，接近模型极限，极易导致遗忘或截断，建议触发压缩 (Compaction) 或开启新会话。</div>`);
    }

    if (s.compactionCount > 0) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--amber);">✂</span> 本会话已有效执行了 ${s.compactionCount} 次历史压缩，精简了冗余工具输出。</div>`);
    } else {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--cyan);">ℹ</span> 尚未发生自动压缩，历史多轮工具调用均完整保留在上下文流中。</div>`);
    }

    if (s.bloatCount > 0) {
      tips.push(`<div style="display:flex; align-items:center; gap:6px;"><span style="color:var(--red);">⚡</span> 检测到 ${s.bloatCount} 次单轮 Token 激增 (>15,000 Tokens)，多由大文件全量读取或超长 Shell 输出引起。</div>`);
    }

    tips.forEach(html => {
      const div = document.createElement("div");
      div.innerHTML = html;
      elHealthTips.appendChild(div);
    });
  }

  // 10. 事件绑定
  function bindEvents() {
    // 客户端分类切换
    if (elAgentFilters) {
      elAgentFilters.addEventListener("click", (e) => {
        const btn = e.target.closest(".filter-btn");
        if (!btn) return;
        elAgentFilters.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        agentFilter = btn.dataset.agent;
        renderSessionsList();
      });
    }

    // 角色分类切换
    if (elRoleFilters) {
      elRoleFilters.addEventListener("click", (e) => {
        const btn = e.target.closest(".filter-btn");
        if (!btn) return;
        elRoleFilters.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        roleFilter = btn.dataset.role;
        renderTurnInspector();
      });
    }

    // 会话搜索
    if (elSessionSearch) {
      elSessionSearch.addEventListener("input", (e) => {
        searchQuery = e.target.value.trim();
        renderSessionsList();
      });
    }

    // 刷新按钮
    $("btn-refresh")?.addEventListener("click", () => {
      if (Array.isArray(window.CONTEXT_SESSIONS)) {
        sessions = [...window.CONTEXT_SESSIONS];
        summary = window.CONTEXT_SUMMARY || {};
        renderGlobalKpi();
        renderSessionsList();
        renderEvolutionChart();
        renderTurnInspector();
        renderDiagnostics();
        showToast("已成功同步最新上下文数据！");
      }
    });

    // 主题切换
    $("btn-theme-toggle")?.addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      renderEvolutionChart();
    });

    // 窗口尺寸自适应重新绘制图表
    window.addEventListener("resize", () => {
      renderEvolutionChart();
    });
  }

  // 11. 初始化与 Magpie Bridge 联动
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
            renderEvolutionChart();
          });
        }
      } catch (e) {}
    }

    bindEvents();

    if (sessions.length > 0) {
      selectSession(sessions[0].id);
    } else {
      renderSessionsList();
    }
  }

  init();
})();
