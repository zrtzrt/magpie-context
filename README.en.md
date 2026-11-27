# Magpie Context Lens

[![GitHub](https://img.shields.io/badge/GitHub-zrtzrt%2Fmagpie--context-blue?logo=github)](https://github.com/zrtzrt/magpie-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A cross-agent session content inspector and context evolution monitor **page plugin** designed for [Magpie](https://github.com/yetone/magpie) (inspired by and expanding upon `dsh-context`). It has no gateway middleware and no provider-list permission; the built-in `page.service` is only a background data refresher.

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

# The page runs in a sandbox with `connect-src 'none'`, so the plugin's local
# page.service generates the index in the background. This can also be run manually:
npx magpie-context sync     # generate/refresh now, then reopen the "Context" tab
npx magpie-context watch    # optional foreground watcher: poll changes and refresh after a quiet period
```

See [Magpie plugin docs](https://usemagpie.ai/docs/zh/plugins) for the page-plugin contract this follows.

> **Service lifecycle** (check here first when data looks stale)
> - The background sync process is **detached** on purpose: it outlives the plugin host. A full sync
>   takes 11–46 s, and the Magpie host restarts whenever another plugin throws — a child that dies
>   with the host never finishes, which looks like "the service is healthy but the data is old".
> - Single-instance is enforced by `page/data/.watch.lock`, not by parent shutdown, so host restarts
>   never spawn a doomed duplicate.
> - Reloading the plugin in the same process never double-binds the port: state lives on `globalThis`;
>   if the port is taken by a foreign program the service moves to the next one, and if it is taken by
>   our own older instance it is reused.
> - Health: `curl 127.0.0.1:3457/health` reports `watcher`/`watcherPid` based on the real process in the lock file.
> - Diagnostics: `page/data/.service.log` (truncated past 512 KB).

---

## 📄 License

MIT License (c) 2026 zrtzrt
