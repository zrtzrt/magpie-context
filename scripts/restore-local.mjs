#!/usr/bin/env node
// postpack: 打包结束，把 ensure-placeholder 备份的真实索引还原回去。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pageDir = path.resolve(here, "../page");
const indexPath = path.join(pageDir, "context-data.js");
const backupPath = path.join(pageDir, ".context-data.local.js");

if (!fs.existsSync(backupPath)) {
  console.error("[restore-local] 没有本地备份，保持占位索引");
  process.exit(0);
}

fs.copyFileSync(backupPath, indexPath);
fs.unlinkSync(backupPath);
console.error("[restore-local] 已还原本机真实索引");