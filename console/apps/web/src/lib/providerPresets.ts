// 常用供应商预设：点一下填 API key 即可用，免去手填 base_url / api_format / family。
//
// 约定（与 core/config.ts 的 withOpenAiV1 / normUrl 对齐）：
//   * baseUrl 存「根路径」，不带尾 /v1 —— 配置下发时 withOpenAiV1 会按需补 /v1。
//   * modelsEndpoint 是完整路径，refresh models 时直接拼 baseUrl + modelsEndpoint。
//   * family 决定该 key 走哪个工具族（codex=OpenAI 兼容 / claude / gemini）。
//   * apiFormat：openai_responses | anthropic | gemini | null(null→openai-completions，
//     即 /chat/completions，是绝大多数 OpenAI 兼容服务的正确默认)。

export type ProviderRegion = "国内" | "国外"

export interface ProviderPreset {
  /** 唯一标识，写入 providers.preset 列 */
  key: string
  /** 默认供应商名（用户可改） */
  name: string
  /** 根路径，不带尾 /v1 */
  baseUrl: string
  /** 模型列表端点完整路径 */
  modelsEndpoint: string
  /** 工具族：codex | claude | gemini */
  family: string
  /** API 协议：openai_responses | anthropic | gemini | null */
  apiFormat: string | null
  region: ProviderRegion
  /** 一句话说明 / 代表模型 */
  description: string
  /** 申请 API key 的地址，表单里给个外链 */
  docsUrl: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ===== 国外 =====
  {
    key: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    modelsEndpoint: "/v1/models",
    family: "codex",
    apiFormat: "openai_responses",
    region: "国外",
    description: "GPT / o 系列 / Codex",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    key: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    modelsEndpoint: "/v1/models",
    family: "claude",
    apiFormat: "anthropic",
    region: "国外",
    description: "Claude 系列",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    key: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    modelsEndpoint: "/v1beta/models",
    family: "gemini",
    apiFormat: "gemini",
    region: "国外",
    description: "Gemini 系列",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai",
    modelsEndpoint: "/api/v1/models",
    family: "codex",
    apiFormat: null,
    region: "国外",
    description: "聚合 300+ 模型",
    docsUrl: "https://openrouter.ai/keys",
  },

  // ===== 国内 =====
  {
    key: "deepseek",
    name: "DeepSeek 深度求索",
    baseUrl: "https://api.deepseek.com",
    modelsEndpoint: "/v1/models",
    family: "codex",
    apiFormat: null,
    region: "国内",
    description: "DeepSeek-V3 / R1",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    key: "moonshot",
    name: "Moonshot 月之暗面",
    baseUrl: "https://api.moonshot.cn",
    modelsEndpoint: "/v1/models",
    family: "codex",
    apiFormat: null,
    region: "国内",
    description: "Kimi",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    key: "qwen",
    name: "通义千问 (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    modelsEndpoint: "/v1/models",
    family: "codex",
    apiFormat: null,
    region: "国内",
    description: "Qwen 系列（OpenAI 兼容模式）",
    docsUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    key: "doubao",
    name: "火山方舟 豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    modelsEndpoint: "/models",
    family: "codex",
    apiFormat: null,
    region: "国内",
    description: "Doubao 系列",
    docsUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  },
  {
    key: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelsEndpoint: "/models",
    family: "codex",
    apiFormat: null,
    region: "国内",
    description: "GLM-4 系列",
    docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    key: "siliconflow",
    name: "SiliconFlow 硅基流动",
    baseUrl: "https://api.siliconflow.cn",
    modelsEndpoint: "/v1/models",
    family: "codex",
    apiFormat: null,
    region: "国内",
    description: "聚合开源模型",
    docsUrl: "https://cloud.siliconflow.cn/account/ak",
  },
]

/** 按 region 分组，方便 UI 分段展示 */
export function groupPresetsByRegion(): Record<ProviderRegion, ProviderPreset[]> {
  const out: Record<ProviderRegion, ProviderPreset[]> = { 国内: [], 国外: [] }
  for (const p of PROVIDER_PRESETS) out[p.region].push(p)
  return out
}
