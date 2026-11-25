// 决定数据写到哪个 page 目录。
//
// 关键约束：Magpie 加载的是 ~/.config/magpie/plugins/node_modules/magpie-context 那一份，
// 而用户跑 `npx magpie-context sync` 时可能执行在 npm 的临时副本里（npx 的缓存目录）。
// 若只按 __dirname 写，数据会落进临时目录，magpie 那边永远是空的 —— 用户看不到任何效果。
//
// 解析顺序：
//   1. MAGPIE_CONTEXT_PAGE_DIR —— 显式指定（CI / 测试 / 自定义安装位置）
//   2. Magpie 插件目录里那份已安装的副本（存在且不是自己）——最常见情况
//   3. 自己所在插件的 page/ ——本地开发（magpie plugin add <本地路径>）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Magpie 的插件安装目录（跟随 MAGPIE_CONFIG_DIR，默认 ~/.config/magpie） */
export function magpiePluginsDir() {
  const configDir = process.env.MAGPIE_CONFIG_DIR || path.join(os.homedir(), ".config", "magpie");
  return path.join(configDir, "plugins", "node_modules", "magpie-context");
}

function isContextPlugin(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg && pkg.name === "magpie-context" && !!(pkg.magpie && pkg.magpie.page);
  } catch {
    return false;
  }
}

function realOrSelf(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/**
 * 返回 { pageDir, source } —— source 用于 doctor 输出，说明为什么选了这个路径。
 */
export function resolvePageDir() {
  const override = process.env.MAGPIE_CONTEXT_PAGE_DIR;
  if (override && override.trim()) {
    return { pageDir: path.join(path.resolve(override.trim()), ""), source: "MAGPIE_CONTEXT_PAGE_DIR" };
  }

  const installed = magpiePluginsDir();
  if (isContextPlugin(installed) && realOrSelf(installed) !== realOrSelf(SELF_ROOT)) {
    return { pageDir: path.join(installed, "page"), source: "Magpie 已安装的插件" };
  }

  return { pageDir: path.join(SELF_ROOT, "page"), source: "当前插件目录" };
}