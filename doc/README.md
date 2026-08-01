# 文档中心 / Docs

AI Console 的文档集中存放于此，按类别组织。

## 工具配置与凭据 / Tool Config & Credentials

各 CLI 工具的配置/凭据格式说明与样例（人工维护的规格，位于 `doc/tools/<tool>/`）：

| 工具 / Tool | 文档 / Doc | 样例 / Samples |
|---|---|---|
| Codex CLI | [codex配置.md](tools/codex/codex配置.md) | [auth.json](tools/codex/auth.json) · [config.toml](tools/codex/config.toml) |
| Claude Code | [claude配置方法.md](tools/claude/claude配置方法.md) | — |
| Gemini CLI | [gemini配置方法.md](tools/gemini/gemini配置方法.md) | — |
| OpenCode | [opencode配置方法.md](tools/opencode/opencode配置方法.md) | — |
| Pi | [pi配置方法.md](tools/pi/pi配置方法.md) | — |
| Hermes | [hermes配置方法.md](tools/hermes/hermes配置方法.md) | — |

> 注意：规格文档是**简化描述**，不是字面实现——例如文档说环境变量写入 `~/.bashrc`，Agent 实际写入 `~/.ai-console-agent/creds/<tool>.sh` 并由 shell 自动加载；opencode 文档展示的丰富 per-model 对象，实际生成时只写 `{}`（或 `{reasoning:true}`）。

## 仓库指引 / Repo Guidance

- [AGENTS.md](../AGENTS.md) — 仓库结构、架构、交付链路与关键陷阱
- [README.md](../README.md) — 项目介绍与快速开始
