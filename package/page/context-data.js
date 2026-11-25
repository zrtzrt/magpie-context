// context-data.js — 打包占位（真实数据由 `npx magpie-context sync` 在本机生成）
// 本文件不含任何会话内容：会话数恒为 0，页面据此显示首次使用引导。
window.CONTEXT_DATA_VERSION = 2;
window.CONTEXT_DATA_PLACEHOLDER = true;
window.CONTEXT_SUMMARY = {
  totalSessions: 0,
  totalTurns: 0,
  totalCompactions: 0,
  maxWatermark: 0,
  totalCacheRead: 0,
  agents: { all: 0, antigravity: 0, dsh: 0, codex: 0, other: 0 },
  updatedAt: ""
};
window.CONTEXT_SESSIONS = [];
window.CONTEXT_DETAIL_DIR = "data";
window.CONTEXT_DETAIL_FILES = {};
