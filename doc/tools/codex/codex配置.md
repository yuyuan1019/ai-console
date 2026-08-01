# Codex 配置与登录凭据

## API Key 模式

模型配置位于 `~/.codex/config.toml`：

```toml
model_provider = "OpenAI"
model = "gpt-5.5"
model_reasoning_effort = "medium"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://your-relay.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
```

API Key 独立写入 `~/.codex/auth.json`：

```json
{
  "OPENAI_API_KEY": "sk-ABC"
}
```

AI Console 不会把 Codex API Key 写入 `config.toml` 或全局环境变量。

## OpenAI 订阅账户登录

先在一台已接入 AI Console 的来源机器上执行：

```bash
codex login
```

登录成功后 Codex 会把账户会话写入 `~/.codex/auth.json`，其中包含 `auth_mode`、`tokens` 和刷新时间等字段。在“供应商”页面点击“新增”→“OpenAI”→“Codex 订阅登录”，选择该来源服务器后，AI Console 会读取完整文件、验证 access/refresh token，并以 AES-256-GCM 密文保存。若尚未登录，页面会提示执行 `codex login`，登录后可直接点击“重新读取”。

下发订阅登录时只覆盖目标机器的 `~/.codex/auth.json`，不生成 `OPENAI_API_KEY`，也不修改 Base URL。文件和覆盖前备份均为 `0600`。任务记录与审计日志不保存 token 明文。

该功能需要来源和目标机器的 Agent 均为 `v2.0.6` 或更高版本。不要手工填写账号密码；多个机器共享同一刷新令牌时需遵守 OpenAI 的账户与会话策略。
