# Pi 配置下发说明

配置文件路径：`~/.pi/agent/models.json`，不存在时 agent 会自动创建目录 `~/.pi/agent/` 并写入。

Pi 是 earendil-works 的终端编码 agent（`@earendil-works/pi-coding-agent`）。自定义供应商与模型通过 `models.json` 声明，支持 OpenAI / Anthropic / Google 四种 API 协议；API Key 直接内联在 provider 块里（与 opencode 同构，无独立凭据文件）。

> 本文件是 AI Console **下发实现**的说明。Pi 官方完整字段（cost / thinkingLevelMap / compat 等）见 pi 文档 `docs/models.md` 与 `docs/custom-provider.md`。
>
> AI Console 下发字段：`baseUrl` / `api` / `apiKey` / `models[]`。除 `id`/`name` 外，**思考等级（reasoning）自动推断**：`core/thinking.ts` 的 `matchThinkingProfile` 按 model id 启发式判断模型是否支持思考（规律提炼自 pi-ai 1098 模型库，召回 ~88% / 精确 ~99%），支持则自动补 `models[].reasoning=true`；adaptive Claude（opus-4.6+/sonnet-5/fable）在 `api=anthropic-messages` 时额外补 `compat.forceAdaptiveThinking=true`。保守策略：不设 `thinkingLevelMap`，pi 暴露 `off..high`（xhigh/max 隐藏，多数中转不支持）。匹配不到的模型不下发 reasoning，pi 按默认 `false` 处理（思考不显示，安全降级）。

## 下发通道

| 通道 | 行为 |
|---|---|
| `write_config` | 写 `~/.pi/agent/models.json`（provider + 内联 apiKey + 模型列表）。**这是 pi 唯一真正生效的通道。** |
| `set_credential` | 对 pi 是 **no-op**（pi 不读环境变量 / 不读独立凭据文件，apiKey 全在 models.json 里）。 |

## API 协议映射

Pi 的 `api` 字段由供应商 Key 的 `api_format` 派生：

| provider_keys.api_format | pi models.json `api` |
|---|---|
| `anthropic` | `anthropic-messages` |
| `gemini` | `google-generative-ai` |
| `openai_responses` | `openai-responses` |
| `""`（默认）/其他 | `openai-completions`（pi 标注 most compatible，适合中转/代理） |

`baseUrl` 统一经 `withOpenAiV1` 规整（保证以 `/v1` 结尾、去多余斜杠），与 opencode 一致。

## 单渠道示例

```json
{
  "providers": {
    "packycode": {
      "baseUrl": "https://www.packyapi.com/v1",
      "api": "anthropic-messages",
      "apiKey": "sk-xxxx",
      "models": [
        { "id": "claude-sonnet-4-20250514", "name": "claude-sonnet-4-20250514" },
        { "id": "claude-opus-4-20250514", "name": "claude-opus-4-20250514" }
      ]
    }
  }
}
```

## 多渠道示例（批量下发多个供应商）

provider key 按供应商名+分组派生 `providerId`（小写、非字母数字转 `-`），同名同组自动加后缀去重：

```json
{
  "providers": {
    "packycode": {
      "baseUrl": "https://www.packyapi.com/v1",
      "api": "anthropic-messages",
      "apiKey": "sk-aaaa",
      "models": [{ "id": "claude-sonnet-4-20250514", "name": "claude-sonnet-4-20250514" }]
    },
    "zhishu": {
      "baseUrl": "https://zhishu.dev/v1",
      "api": "openai-completions",
      "apiKey": "sk-bbbb",
      "models": [{ "id": "gpt-5.6", "name": "gpt-5.6" }]
    }
  }
}
```

## 卸载

卸载时把 `models.json` 覆盖为最小内容（清空 provider 块即清空凭据）：

```json
{ "providers": {} }
```

## 与 opencode 的差异

| 维度 | opencode | pi |
|---|---|---|
| 配置文件 | `~/.config/opencode/opencode.json` | `~/.pi/agent/models.json` |
| provider 容器键 | `provider` | `providers` |
| 顶层默认模型 | `config.model = "${providerId}/${model}"` | **无** —— pi 启动后用 `/model` 交互选择 |
| 协议字段 | `api: "openai"\|"anthropic"` | `api: openai-completions\|openai-responses\|anthropic-messages\|google-generative-ai` |
| 卸载 scrub | `{ "$schema": "https://opencode.ai/config.json" }` | `{ "providers": {} }` |

## 模型选择

Pi 没有"默认模型"概念：`models.json` 里声明的所有模型都会出现在 `/model` 选择器里，用户交互切换。因此 AI Console 下发时会把该供应商下**所有启用的模型**全部写入 `models` 数组，而非只写主模型。
