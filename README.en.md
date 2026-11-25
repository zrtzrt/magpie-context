# Magpie Context Lens

[![GitHub](https://img.shields.io/badge/GitHub-zrtzrt%2Fmagpie--context-blue?logo=github)](https://github.com/zrtzrt/magpie-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A cross-agent session content inspector and context evolution monitor **page plugin** designed for [Magpie](https://github.com/yetone/magpie) (inspired by and expanding upon `dsh-context`). Page-only: no gateway middleware and no provider-list permission.

Real-time tracking of context window growth curves, token composition (System / Tools / Messages / Tool Outputs), compaction events (`✂`), and turn-by-turn payload inspection.

---

## 🌟 Key Features

* **Context Evolution & Growth Chart**: Interactive stacked area visualization tracking tokens across System, Tools, History, and Tool Results.
* **Lifecycle Events (✂ Compaction & ⚡ Bloat)**: Visual markers on timeline indicating when context compaction/pruning occurred or when large file injections caused a spike.
* **Turn-by-turn Message Inspector**: Inspect exact payloads sent to models per turn with token badges, search, formatting, and clipboard copy.
* **Diagnostics & Headroom**: Top token consumers table and contextual health advice against model context window limits.
* **Three agents with real log parsers**: DeepSeek Harness (DSH), Google Antigravity, and OpenAI Codex. Other sources (Claude Code, OpenCode, Cursor, Cline) are **not** parsed yet, so they produce no drill-down data.

---

## 📦 Installation

```bash
magpie plugin add magpie-context      # from npm
# or: magpie plugin add github:zrtzrt/magpie-context

# Magpie page plugins run in a sandbox with `connect-src 'none'` and no plugin host,
# so the page cannot read your disk or fetch anything. Generate the index once:
npx magpie-context sync     # then reopen the "Context" tab
npx magpie-context watch    # optional: keep it fresh every 5s
```

See [Magpie plugin docs](https://usemagpie.ai/docs/zh/plugins) for the page-plugin contract this follows.

---

## 📄 License

MIT License (c) 2026 zrtzrt
