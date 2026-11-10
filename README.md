# 上下文透视 (Magpie Context Lens)

[![GitHub](https://img.shields.io/badge/GitHub-zrtzrt%2Fmagpie--context-blue?logo=github)](https://github.com/zrtzrt/magpie-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

专为 [Magpie](https://github.com/yetone/magpie) 设计的**跨 Agent 会话内容透视与上下文演进监控插件**（对标并超越 `dsh-context`）。

实时监控各 AI 客户端在交互过程中的上下文增长轨迹、Token 构成（System / Tools / Messages / Tool Outputs）、历史压缩事件（Compaction `✂`）与单轮完整内容透视。

---

## 🌟 核心功能特性

### 1. 📈 上下文演进与增长曲线 (Context Evolution Chart)
* **分层 Token 构成堆叠面积图**：
  * 🟣 **System Prompt**：系统提示词、身份与指引基数；
  * 🔵 **Tools Definition**：声明的工具 Schema 与参数定义；
  * 🟢 **Chat History**：多轮对话上下文历史；
  * 🟠 **Tool Results & Files**：工具执行返回值、文件内容与终端输出（上下文膨胀核心源头）。
* **事件时间轴打标**：
  * ✂ **Compaction 压缩标记**：检测上下文突降事件，直观掌握历史截断与压缩时机；
  * ⚡ **Bloat 膨胀预警**：单轮 Token 激增（>15k）自动标记，定位超大文件注入。

### 2. 🔍 逐轮具体内容与消息透视 (Turn-by-turn Content Inspector)
* **逐轮下钻**：点击演进曲线任意轮次（Turn #N），右侧联动展开该轮发给模型的完整 Context 消息树；
* **角色与类型筛选**：支持按 `System`、`User`、`Assistant`、`Tools` 快速筛选；
* **细粒度消耗标尺**：每条消息独立展示 Token 数量、字符数及占当前轮次比例；
* **一键复制与展开**：长文本/工具结果默认折叠保护性能，支持一键展开查看原文与复制到剪贴板。

### 3. 🩺 上下文健康度与体检大盘 (Diagnostics & Headroom)
* **Top 上下文消耗源排行**：快速找出在哪个轮次调用了哪个工具注入了最多的 Token；
* **水位预警 (Watermark Gauge)**：对标模型物理上限（如 Gemini 1M / DeepSeek 128k / Claude 200k），实时提示剩余空间安全边际；
* **优化建议**：智能评估历史压缩效率，预警冗余工具调用。

### 4. 🌐 真正的全 Agent 生态覆盖
不同于仅适用于单一客户端的插件，`magpie-context` 作为 Magpie 本地网关级插件：
* ✅ **Google DeepMind Antigravity**（IDE & CLI）
* ✅ **DeepSeek Harness (DSH)**（原生解析 `.v4.jsonl.zstd`）
* ✅ **OpenAI Codex**
* ✅ **Claude Code / OpenCode / Cursor**
* ✅ **所有走 Magpie 本地网关的实时请求**

---

## 📦 安装方式

### 方式 1：本地源码挂载安装（推荐）
在终端中执行：
```bash
# 挂载当前目录至 Magpie
magpie plugin add /Users/reno/Documents/code/tools/magpie-context
```

### 方式 2：通过 GitHub 安装
```bash
magpie plugin add github:zrtzrt/magpie-context
```

---

## 🛠️ 本地调试与后台同步

```bash
cd magpie-context

# 启动数据实时同步守护进程
node daemon.mjs
```

进入 Magpie 桌面客户端或 Web 控制台，在左侧导航点击 **「上下文透视」** 即可体验。

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
