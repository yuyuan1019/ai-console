# Claude Code 配置与登录凭据

## API Key 模式

AI Console 将 API Key 与端点写入 `~/.claude/settings.json` 的 `env` 块：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-relay.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
  }
}
```

## Anthropic 订阅账户登录

先在一台已接入 AI Console 的来源机器上执行：

```bash
claude auth login
```

Linux 上 Claude Code 通常将订阅会话保存到 `~/.claude/.credentials.json`；macOS 某些版本保存到 Login Keychain 的 `Claude Code-credentials` 项。AI Console Agent 会优先读取凭据文件，在 macOS 上找不到文件时再读取对应 Keychain 项。

在“供应商”页面点击“新增”→“Anthropic”→“Claude 订阅登录”并选择来源服务器后，控制台会验证 `claudeAiOauth` 中的 access/refresh token，并以 AES-256-GCM 密文保存。若尚未登录，页面会提示执行 `claude auth login`，登录后可直接点击“重新读取”。下发时写入目标机器的 `~/.claude/.credentials.json`，不会生成 `ANTHROPIC_AUTH_TOKEN`、Base URL 或 API Ping 请求。文件和覆盖前备份均为 `0600`，任务记录与审计日志不保存 token 明文。

该功能需要来源和目标机器的 Agent 均为 `v2.0.6` 或更高版本。不要向控制台提交 Anthropic 用户名或密码；多个机器共享同一刷新令牌时需遵守 Anthropic 的账户与会话策略。
