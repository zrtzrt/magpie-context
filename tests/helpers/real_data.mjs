// tests/helpers/real_data.mjs
// CI runner 上没有用户的本机会话数据。以下"真实数据验收"测试在无数据时
// 优雅降级为 skip,而非 fail —— 避免 CI 因环境缺数据误报红色。
// 本地有数据时照常做真值对照,不是"造假绿"。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function hasRealSessionData(agent) {
  const home = os.homedir();
  const roots = {
    dsh: [path.join(home, ".dsh", "sessions")],
    antigravity: [path.join(home, ".gemini", "antigravity", "brain")],
    codex: [path.join(home, ".codex", "archived_sessions"), path.join(home, ".codex", "sessions")]
  };
  const list = agent ? (roots[agent] || []) : Object.values(roots).flat();
  return list.some((dir) => {
    try { return fs.readdirSync(dir).length > 0; } catch { return false; }
  });
}