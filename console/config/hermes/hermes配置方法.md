# Hermes Agent 配置方法

Hermes 指 Nous Research 的 [Hermes Agent](https://github.com/NousResearch/hermes-agent)，命令名为 `hermes`。

## 安装与升级

AI Console 使用官方安装入口，不使用同名的非官方 npm bridge：

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

远程安装时 Agent 会下载该脚本，并以 `--skip-setup --non-interactive` 执行。升级调用 `hermes update --yes`；卸载调用 `hermes uninstall --yes`，保留 `~/.hermes` 下的配置与数据。

## 配置文件

Hermes 主配置位于：

```text
~/.hermes/config.yaml
```

AI Console 写入 JSON 语法内容；JSON 是 YAML 的严格子集，因此 Hermes 可直接读取。文件权限由 Agent 设置为 `0600`，写入前会在同目录创建备份。

下发内容使用 Hermes v12+ 的 `providers` 结构：

```yaml
{
  "_config_version": 33,
  "model": {
    "default": "gpt-5",
    "provider": "example"
  },
  "providers": {
    "example": {
      "name": "Example",
      "api": "https://example.com/v1",
      "api_key": "sk-...",
      "default_model": "gpt-5",
      "transport": "chat_completions",
      "models": {
        "gpt-5": {}
      }
    }
  }
}
```

## API 协议映射

| AI Console `api_format` | Hermes `transport` |
|---|---|
| `openai_responses` | `codex_responses` |
| `anthropic` | `anthropic_messages` |
| `gemini` 或空值 | `chat_completions` |

OpenAI 风格地址会规范化为带 `/v1` 的地址；Anthropic 风格地址保留供应商原始 Base URL。

## 清除配置

“清除配置”会把 `config.yaml` 覆盖为不含供应商和 API Key 的最小配置：

```yaml
{"model":"","providers":{}}
```

“卸载 Hermes CLI”和“清除配置”是两个独立操作；默认 CLI 卸载不会删除配置与会话数据。
