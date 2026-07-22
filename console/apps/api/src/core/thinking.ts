// ponytail: 模型思考等级（reasoning effort）自动推断 —— 路径 A「全自动」。
//
// 背景：pi 的 ~/.pi/agent/models.json 里每个 model 可声明 reasoning:true +
// thinkingLevelMap + compat.{thinkingFormat, forceAdaptiveThinking}，pi 据此在
// /model 选择器与状态栏暴露「思考等级」控制；opencode 的 model 对象也有 reasoning
// 字段；codex 的 config.toml 有 model_reasoning_effort；claude code 的 settings.json
// 有 effortLevel。AI Console 此前只写最小子集 → 各工具思考等级不可用（用户原始问题）。
//
// 本模块用「启发式正则规则」按 model id 推断模型是否支持思考，覆盖主流模型族。
// 规律提炼自 pi-ai 内置 1098 模型库（@earendil-works/pi-ai/dist/providers/data）。
// 回归测试（见文末注释）: 召回率 ~88%, 精确率 ~99% —— 主流 gpt/claude/gemini/
// deepseek/kimi/qwen/glm/grok/gemma/nemotron 全覆盖；剩余漏报为 mistral 变体/seed/
// aion/palmyra 等长尾模型，剩余误报为 pi-ai 数据自身矛盾（同模型跨 provider 标注不一致）。
//
// 不内置完整 1098 条表：中转/代理供应商的 model id 往往不规范（gpt-5.5 vs gpt-5-5
// vs 自定义名），精确查表命中率低且会随 pi 版本漂移；正则按「模型族 + 版本号」匹配，
// 对中转更鲁棒，文件也更小。
//
// 设计约束（路径 A 全自动，保守优先 —— 误报比漏报更糟：误报会让用户看到思考 UI 但
// 调用报错；漏报只是少显示思考，安全降级）：
// 1. 只标 reasoning:true；未命中返回 null（pi 仍按默认 false → 思考不显示）。
// 2. 基本不设 thinkingLevelMap → pi/opencode 用默认 off..high（xhigh/max 隐藏）。
//    刻意保守：xhigh/max 多数中转不支持，暴露了反而报错。要全档走路径 B 手动配。
// 3. thinkingFormat 不在此推断 —— openai-completions 中转无法判断后端用哪种 wire
//    格式（openrouter/deepseek/qwen/...），让 pi 用默认 reasoning_effort（最通用）。
//    只有调用方确认 anthropic-messages 协议时，才对 adaptive Claude 模型加
//    compat.forceAdaptiveThinking（否则 Claude API 直接 400）。

export interface ThinkingProfile {
  /** 是否支持 extended thinking。写入 pi model.reasoning / opencode model.reasoning。 */
  reasoning: boolean
  /** Claude adaptive-thinking 模型（opus-4.6+/sonnet-5/fable 等）。仅当调用方确认
   *  pi api=anthropic-messages 时，才写入 model.compat.forceAdaptiveThinking。 */
  needsAdaptive?: boolean
}

type Rule = { re: RegExp; profile: ThinkingProfile; note?: string }

// 前置排除：命中任一即认定「不支持思考」(返回 null)，避免下面 RULES 误报。
// 这些子串在 pi-ai 库里几乎只出现在 reasoning=false 的模型上（非推理变体）。
const EXCLUDE: RegExp[] = [
  /coder/,            // qwen3-coder / codestral 等（注意：gpt-5-codex 是 codex 不含 coder）
  /instruct/,         // qwen3-*-instruct / llama-*-instruct
  /safeguard/,        // gpt-oss-safeguard（护栏模型，不推理）
  /non-reasoning/,
  /non-thinking/,
  /realtime/,         // gpt-realtime / gpt-audio（语音，非推理）
  /audio/,
  /voxtral/,          // mistral 语音
  /pixtral/,          // mistral 视觉
  /whisper/,
  /\btts\b/,
  /gpt[._-]?5.*(chat|instant)/,  // gpt-5-chat / gpt-5.x-instant（非推理聊天变体）
]

// 规则按「特异性 → 通用」顺序，第一个命中即返回。/i + 容忍 - _ . 分隔符混用（中转常见）。
const RULES: Rule[] = [
  // === Anthropic Claude ===
  // adaptive thinking：opus/sonnet 4.6+ 与 5、fable/mythos。须 forceAdaptiveThinking，
  // 否则 Anthropic API 400（这些模型不支持旧版 budget thinking）。
  { re: /claude[^a-z]*(fable|mythos)/i, profile: { reasoning: true, needsAdaptive: true } },
  { re: /claude[^a-z0-9]*(opus|sonnet)[^a-z0-9]*(4[._-][6-9]|\b5\b)/i, profile: { reasoning: true, needsAdaptive: true }, note: "opus/sonnet 4.6+ / 5" },
  // 标准 budget thinking：opus/sonnet/haiku 4.x（4.1/4.5 等）；claude-3 不命中（无 4）
  { re: /claude[^a-z0-9]*(opus|sonnet|haiku)[^a-z0-9]*4/i, profile: { reasoning: true } },

  // === OpenAI ===
  { re: /gpt[._-]?5/i, profile: { reasoning: true } },
  { re: /(^|[^a-z])o[1-4]([^a-z]|$)/i, profile: { reasoning: true }, note: "o1/o3/o4 推理系列" },
  { re: /gpt[._-]?oss/i, profile: { reasoning: true } },

  // === Google Gemini 2.5+ / 3.x（含 *-latest 无版本号变体）===
  { re: /gemini[^a-z0-9]*(2[._-][5-9]|[3-9]|flash-latest|pro-latest)/i, profile: { reasoning: true } },
  // Gemma 4（开源，支持思考）
  { re: /gemma[^a-z0-9]*4/i, profile: { reasoning: true } },

  // === DeepSeek（v3 裸版不推理；v3.1/v3.2-thinking/v4/r1 推理）===
  { re: /deepseek.*(v[._-]?4|r1|v3[._-]?1|thinking)/i, profile: { reasoning: true } },

  // === Moonshot Kimi（k2-thinking/k2.5+/k3；兼容 fireworks 的 k2p6 写法）===
  { re: /kimi[^a-z0-9]*k[23][._-p]?(thinking|[5-9])/i, profile: { reasoning: true } },
  { re: /kimi[^a-z0-9]*k3\b/i, profile: { reasoning: true } },

  // === Qwen：3.5+ 新版（默认支持）+ *-thinking 变体；qwen3 裸数字版不匹配（同族 true/false 混乱）===
  { re: /qwen[^a-z0-9]*3[._-]?[5-9]/i, profile: { reasoning: true } },
  { re: /qwen.*thinking/i, profile: { reasoning: true } },

  // === 智谱 GLM 4.5+ / 5.x ===
  { re: /glm[^a-z0-9]*(4[._-][5-9]|5)/i, profile: { reasoning: true } },

  // === xAI Grok 4.x ===
  { re: /grok[^a-z0-9]*4/i, profile: { reasoning: true } },

  // === MiniMax M2+/M3（含裸 m2.5+/m3 id）===
  { re: /minimax[^a-z0-9]*m?([2-9]|3)/i, profile: { reasoning: true } },
  { re: /(^|[^a-z0-9])m([2-9][._-][5-9]|3)([^a-z0-9]|$)/i, profile: { reasoning: true } },

  // === 其他 ===
  { re: /nemotron.*3/i, profile: { reasoning: true }, note: "NVIDIA Nemotron 3" },
  { re: /magistral/i, profile: { reasoning: true }, note: "Mistral Magistral 推理" },
  { re: /mimo/i, profile: { reasoning: true }, note: "小米 MiMo" },
  { re: /step[^a-z0-9]*[3-9]/i, profile: { reasoning: true }, note: "阶跃 Step 3.x" },
  // 兜底：id 含 thinking 的变体（未被 non-thinking 排除的）
  { re: /thinking/i, profile: { reasoning: true } },
]

/**
 * 按 model id 启发式推断思考等级能力。未命中返回 null。
 *
 * @param modelId   模型 id（中转原始值，如 "gpt-5.5"、"claude-opus-4-6"）
 * @param _family   预留（inferFamily 结果），当前不参与推断
 * @param _apiFormat 预留（provider_keys.api_format），当前不参与推断；
 *                  thinkingFormat/forceAdaptiveThinking 的协议判断留给调用方。
 */
export function matchThinkingProfile(
  modelId: string,
  _family?: string | null,
  _apiFormat?: string | null,
): ThinkingProfile | null {
  const id = String(modelId || "").trim().toLowerCase()
  if (!id) return null
  for (const ex of EXCLUDE) if (ex.test(id)) return null
  for (const rule of RULES) if (rule.re.test(id)) return { ...rule.profile }
  return null
}

/* 规则来源与回归验证：
 *   规律提炼自 pi-ai 内置 1098 模型库（@earendil-works/pi-ai/dist/providers/data/*.json，
 *   flat 结构：modelId → {reasoning, thinkingLevelMap, compat...}）。回归方法：遍历该目录
 *   所有模型，对比 matchThinkingProfile 输出与 pi-ai 的 reasoning 标注，统计召回/精确。
 *   当前指标 ~88% 召回 / ~99% 精确（主流全覆盖；漏报为 mistral变体/seed/aion/palmyra 等
 *   长尾模型，误报为 pi-ai 自身跨 provider 标注矛盾，均非规则可解）。
 */
