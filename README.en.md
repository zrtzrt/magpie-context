# Magpie Context Lens

[![GitHub](https://img.shields.io/badge/GitHub-zrtzrt%2Fmagpie--context-blue?logo=github)](https://github.com/zrtzrt/magpie-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A cross-agent session content inspector and context evolution monitor plugin designed for [Magpie](https://github.com/yetone/magpie) (inspired by and expanding upon `dsh-context`).

Real-time tracking of context window growth curves, token composition (System / Tools / Messages / Tool Outputs), compaction events (`✂`), and turn-by-turn payload inspection.

---

## 🌟 Key Features

* **Context Evolution & Growth Chart**: Interactive stacked area visualization tracking tokens across System, Tools, History, and Tool Results.
* **Lifecycle Events (✂ Compaction & ⚡ Bloat)**: Visual markers on timeline indicating when context compaction/pruning occurred or when large file injections caused a spike.
* **Turn-by-turn Message Inspector**: Inspect exact payloads sent to models per turn with token badges, search, formatting, and clipboard copy.
* **Diagnostics & Headroom**: Top token consumers table and contextual health advice against model context window limits.
* **Full Agent Ecosystem Support**: Works seamlessly across Antigravity, DeepSeek Harness (DSH), Codex, Claude Code, and real-time Magpie gateway traffic.

---

## 📦 Installation

```bash
# Add local plugin to Magpie
magpie plugin add /Users/reno/Documents/code/tools/magpie-context

# Run background sync daemon
cd magpie-context
node daemon.mjs
```

---

## 📄 License

MIT License (c) 2026 zrtzrt
