# Codex/Claude/Gemini 下发与卸载统一改造

## 目标

让"下发"和"批量下发"一次性写齐 config + apikey，匹配各 spec（codex 不再依赖环境变量）。
让"卸载 Key"真正清空配置中的 apikey，而不只是删凭据文件。
codex 两个任务顺序：write_config 在前，set_credential 在后。

## 约束

agent 当前无法重建（AGENTS.md: agent build is broken）。所有修复必须在 server 端完成，
依赖现有 deployed agent 二进制的 `handleWriteConfig` / `handleSetCred` / `handleRemoveCred`。

## 每工具任务表

### 下发（`POST /api/servers/:id/credentials/set` 与 `POST /api/batch/execute`）

| 工具 | 任务（顺序）                              | 写入文件                                                        |
|------|-------------------------------------------|----------------------------------------------------------------|
| codex | `write_config` 然后 `set_credential`     | `~/.codex/config.toml` + `~/.codex/auth.json`                 |
| claude | `write_config`（不变）                   | `~/.claude/settings.json`（apikey 在 `env.ANTHROPIC_AUTH_TOKEN`）|
| gemini | `write_config`（不变）                   | `~/.gemini/settings.json`（apikey 在 `env.GEMINI_API_KEY`）    |
| opencode | `write_config`（不变）                 | `~/.config/opencode/opencode.json`（apikey 在 provider options）|

### 卸载（`POST /api/servers/:id/credentials/remove`）

| 工具 | 任务（顺序）                                       | 结果                                                                              |
|------|----------------------------------------------------|-----------------------------------------------------------------------------------|
| codex | `remove_credential`（不变）                       | 删除 `~/.codex/auth.json`；`config.toml` 不动（无 apikey 可清）                  |
| claude | `write_config`(scrubbed) 然后 `remove_credential` | 覆盖 `~/.claude/settings.json` 为 `{"env":{}}`；删除遗留 `creds/claude.sh`        |
| gemini | `write_config`(scrubbed) 然后 `remove_credential` | 覆盖 `~/.gemini/settings.json` 为 `{"selectedAuthType":"GEMINI_API_KEY","env":{}}`；删除 `creds/gemini.sh` |
| opencode | `write_config`(scrubbed)                         | 覆盖 `~/.config/opencode/opencode.json` 为 `{"$schema":"https://opencode.ai/config.json"}` |

scrubbed 内容在任务创建时由 server 端构造，直接放进 `payload_json`（无 secret，不需要 sensitive payload 加密）。

## 文件改动清单

### 1. `console/apps/api/src/modules/servers/routes.ts`

**`/api/servers/:id/credentials/set`（lines 230-287）**

把 `if (tool === "opencode")` 分支改成对所有 4 个工具统一发 `write_config`（provider_refs 源）。
对所有工具校验 `model_id` 可用（当前仅 opencode 校验）。
**codex 额外**：在 `write_config` 之后插入第二个 `set_credential` 任务（同样 provider_refs）。
返回 write_config 任务 ID（保持前端 `AgentTask` 形状）；第二个任务通过 WS 出现在 task list。

替换后的代码骨架：

```ts
const key = db
  .prepare("SELECT id FROM provider_keys WHERE id=? AND provider_id=? AND enabled=1")
  .get(keyId, providerId) as any
if (!key) return reply.code(404).send({ error: "key not found" })

// ponytail: 统一下发。所有工具都走 write_config（以前只有 opencode）。
// materializeTaskPayload 在 dispatch 时按工具生成原生配置，明文从不落到 DB。
//   - claude/gemini/opencode: 单个 write_config（apikey 已嵌入 settings.json
//     env 块 / opencode.json provider options）。
//   - codex: write_config（config.toml，按 spec 不含 key）后跟第二个
//     set_credential 任务写 ~/.codex/auth.json。per-server 单任务不变式保证
//     两者顺序执行。
const keyDetail = db
  .prepare(`SELECT k.default_model_id FROM provider_keys k
            WHERE k.id=? AND k.provider_id=? AND k.enabled=1`)
  .get(keyId, providerId) as any
const modelId = keyDetail?.default_model_id ||
  (db.prepare("SELECT model_id FROM models WHERE provider_id=? AND enabled=1 ORDER BY model_id LIMIT 1").get(providerId) as any)?.model_id
if (!modelId) return reply.code(400).send({ error: "no model available for this provider" })

const writeConfigTask = createAgentTask(
  req.params.id, user.id, "write_config",
  { tool, source: "provider_refs", redacted: true },
  {
    sensitivePayload: {
      tool, source: "provider_refs",
      entries: [{ provider_id: providerId, key_id: keyId, model_id: modelId }],
    },
    auditMeta: { tool, provider_ids: [providerId], key_ids: [keyId], model_ids: [modelId] },
  }
)

if (tool === "codex") {
  // ponytail: codex 下发拆成 config.toml (write_config) + ~/.codex/auth.json
  // (set_credential)。两者都是 codex 鉴权必需。
  createAgentTask(
    req.params.id, user.id, "set_credential",
    { tool, source: "provider_refs", redacted: true },
    {
      sensitivePayload: { tool, provider_id: providerId, key_id: keyId },
      auditMeta: { tool, provider_ids: [providerId], key_ids: [keyId] },
    }
  )
}

return reply.code(201).send(writeConfigTask)
```

**`/api/servers/:id/credentials/remove`（lines 302-314）**

按工具分发：
- **codex**：保持现状（单个 `remove_credential`）。
- **claude/gemini**：在 `remove_credential` **之前**插入 `write_config`（scrubbed payload 直接进 `payload_json`）：
  - claude content：`JSON.stringify({ env: {} })`
  - gemini content：`JSON.stringify({ selectedAuthType: "GEMINI_API_KEY", env: {} })`
- **opencode**：只发 `write_config`（scrubbed）：content `JSON.stringify({ $schema: "https://opencode.ai/config.json" })`
- 返回首个任务 ID。

替换后的代码骨架：

```ts
app.post<{ Params: { id: string }; Body: { tool?: string; provider_id?: string; key_id?: string } }>(
  "/api/servers/:id/credentials/remove",
  async (req, reply) => {
    const user = (req as any).auth as AuthUser
    const server = db.prepare("SELECT id FROM servers WHERE id=?").get(req.params.id)
    if (!server) return reply.code(404).send({ error: "not found" })
    const tool = String(req.body?.tool || "").trim()
    const providerId = req.body?.provider_id ? String(req.body.provider_id).trim() : null
    const keyId = req.body?.key_id ? String(req.body.key_id).trim() : null
    if (!["codex", "claude", "gemini", "opencode"].includes(tool)) return reply.code(400).send({ error: "unsupported tool for credential removal" })

    // ponytail: 卸载需要清空配置文件里的 apikey 字段。
    //   - codex: 配置无 apikey，仅 remove_credential 删 auth.json 即可。
    //   - claude/gemini: 先 write_config 覆盖 settings.json 为最小内容（清空 env），
    //     再 remove_credential 删遗留的 creds/<tool>.sh。
    //   - opencode: 仅 write_config 把 opencode.json 重置为最小内容（清空 provider 块）。
    if (tool === "claude" || tool === "gemini") {
      const scrubbed = tool === "claude"
        ? { env: {} }
        : { selectedAuthType: "GEMINI_API_KEY", env: {} }
      const writeTask = createAgentTask(
        req.params.id, user.id, "write_config",
        { tool, format: "json", content: JSON.stringify(scrubbed) },
        { auditMeta: { tool, action: "scrub_config_on_remove" } }
      )
      createAgentTask(
        req.params.id, user.id, "remove_credential",
        { tool, provider_id: providerId, key_id: keyId }
      )
      return reply.code(201).send(writeTask)
    }

    if (tool === "opencode") {
      return reply.code(201).send(createAgentTask(
        req.params.id, user.id, "write_config",
        { tool, format: "json", content: JSON.stringify({ $schema: "https://opencode.ai/config.json" }) },
        { auditMeta: { tool, action: "scrub_config_on_remove" } }
      ))
    }

    return reply.code(201).send(createAgentTask(
      req.params.id, user.id, "remove_credential",
      { tool, provider_id: providerId, key_id: keyId }
    ))
  }
)
```

### 2. `console/apps/api/src/modules/batch/routes.ts`

**`/api/batch/execute`（lines 98-199）**

在 `BEGIN…COMMIT` 的 per-server 循环里，对 codex 加一条：
- **codex**：每台 server 插入 2 个任务（`write_config` + `set_credential`，都带 `provider_refs`）。
  把两个 task id 都 push 到 `insertedIds`，把两条进度都 push 到 `progress_json`（每 server 两条）。
  batch "done" 条件：所有任务都到终态。
- 其他工具：不变。

修改后的关键片段（在 `for (const sid of serverIds)` 循环里）：

```ts
for (const sid of serverIds) {
  const server = db.prepare("SELECT name FROM servers WHERE id=?").get(sid) as any
  if (!server) continue
  const providerRefs = {
    tool,
    source: "provider_refs" as const,
    entries: keyEntries.map((ke) => ({
      provider_id: ke.providerId, key_id: ke.keyId,
      model_id: ke.modelId, primary: ke.primary,
    })),
  }
  const safePlaceholder = { tool, source: "provider_refs", redacted: true }
  const task = insertAgentTask(sid, user.id, "write_config", safePlaceholder, {
    sensitivePayload: providerRefs,
    auditMeta: {
      tool,
      provider_ids: keyEntries.map((k) => k.providerId),
      key_ids: keyEntries.map((k) => k.keyId),
      model_ids: keyEntries.map((k) => k.modelId),
    },
  })
  insertedIds.push(task.id)
  progress.push({ server_id: sid, server_name: server.name, task_id: task.id, state: "pending" })

  // ponytail: codex 还需要第二个 set_credential 任务写 ~/.codex/auth.json。
  if (tool === "codex") {
    const credTask = insertAgentTask(sid, user.id, "set_credential", safePlaceholder, {
      sensitivePayload: providerRefs,
      auditMeta: {
        tool,
        provider_ids: keyEntries.map((k) => k.providerId),
        key_ids: keyEntries.map((k) => k.keyId),
      },
    })
    insertedIds.push(credTask.id)
    progress.push({ server_id: sid, server_name: server.name, task_id: credTask.id, state: "pending" })
  }
}
```

注：`set_credential` 的 `materializeInnerPayload` 接受 `provider_refs` 源吗？
**需要确认**——目前 set_credential 走的是 `{tool, provider_id, key_id}` 形状的 sensitivePayload，
不是 `{tool, source:'provider_refs', entries:[...]}`。看 `console/apps/api/src/modules/agent/routes.ts:278-314`。

**核对结果**：set_credential 的 materialize 期望 `{tool, provider_id, key_id}`（不是 provider_refs）。
所以 batch 里给 codex 的 set_credential 任务，sensitivePayload 应该是单 key 形式：

```ts
if (tool === "codex") {
  const ke = keyEntries[0]  // codex batch 仅支持单 key（与 claude/gemini/opencode 单 key 路径一致）
  const credTask = insertAgentTask(sid, user.id, "set_credential",
    { tool, source: "provider_refs", redacted: true },
    {
      sensitivePayload: { tool, provider_id: ke.providerId, key_id: ke.keyId },
      auditMeta: { tool, provider_ids: [ke.providerId], key_ids: [ke.keyId] },
    }
  )
  insertedIds.push(credTask.id)
  progress.push({ server_id: sid, server_name: server.name, task_id: credTask.id, state: "pending" })
}
```

### 3. `console/apps/api/src/modules/agent/routes.ts`（line 269）

清理 stale env key。`remove_credential` 里 codex 分支当前 push `["OPENAI_API_KEY", "OPENAI_BASE_URL"]`。
按 bug 26，agent 已忽略 env_keys_to_remove，且 OPENAI_BASE_URL 根本不存在。改成 `["OPENAI_API_KEY"]`。

```ts
// before
else if (tool === "codex") envKeys.push("OPENAI_API_KEY", "OPENAI_BASE_URL")
// after
else if (tool === "codex") envKeys.push("OPENAI_API_KEY")
```

### 4. `console/apps/web/src/pages/ServerDetailPage.tsx`

**按钮文案（line 391）**：移除三元，所有工具都显示 `"下发配置"`。

```tsx
// before
{tool === "opencode" ? "下发配置" : "下发凭据"}
// after
{"下发配置"}
```

**`credKeyPreview`（lines 148-162）**：重写以反映实际写入文件。

```tsx
const credKeyPreview = useMemo((): Record<string, string> => {
  const k = credKeys.find((x) => x.id === credKeyId)
  if (!k) return {}
  const baseUrl = (credProviderDetail?.base_url || "").replace(/\/+$/, "")
  if (tool === "codex") {
    return {
      "配置文件": "~/.codex/config.toml",
      "凭据文件": "~/.codex/auth.json (OPENAI_API_KEY)",
      "Base URL": baseUrl || "—",
    }
  }
  if (tool === "claude") {
    return {
      "配置文件": "~/.claude/settings.json",
      "字段": "env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL",
      "Base URL": baseUrl || "—",
    }
  }
  if (tool === "gemini") {
    return {
      "配置文件": "~/.gemini/settings.json",
      "字段": "env.GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL",
      "Base URL": baseUrl || "—",
    }
  }
  if (tool === "opencode") {
    const modelId = k.default_model_id || credProviderDetail?.models[0]?.model_id || "—"
    return { "配置文件": "~/.config/opencode/opencode.json", "使用模型": modelId }
  }
  return {}
}, [tool, credKeyId, credKeys, credProviderDetail])
```

**卸载确认文案（line 399）**：更准确——说明会覆盖配置文件。

```tsx
// before
if (confirm(`从 ${server.name} 卸载 ${tool} 的 key？会删除 agent 上的凭据文件和已写入工具配置中的 key。`))
// after
if (confirm(`从 ${server.name} 卸载 ${tool} 的配置？会删除凭据文件，并用最小配置覆盖工具配置文件（apikey 字段会被清空，其他自定义配置可能丢失）。`))
```

### 5. `console/apps/web/src/lib/api.ts`

无变更。`setCredential` 和 `removeCredential` 都返回单个 `AgentTask`，server 端返回首个任务 ID。

## 不动的文件

- `console/apps/api/src/core/config.ts` — `generateConfig` 对所有 4 个工具已经正确。
- `agent/internal/agent/agent.go` — 无法重建；现有 handler 已覆盖所需全部 action。
- `materializeProviderRefs` — 已经在单 key 路径正确调用 `generateConfig`。

## 验证（server-side only，因为 agent 跑不起来）

```powershell
cd console/apps/api; npm run dev
# login as admin/admin, then:
# 1. deliver codex → expect 2 tasks by created_at order (write_config, set_credential)
# 2. deliver claude/gemini → expect 1 task (write_config)
# 3. deliver opencode → expect 1 task (write_config) — no regression
# 4. remove claude → expect 2 tasks (write_config scrubbed, remove_credential)
# 5. remove opencode → expect 1 task (write_config scrubbed)
# 6. batch execute codex → expect 2 tasks per server
# verify via sqlite:
#   SELECT action, status, json_extract(payload_json,'$.tool') AS tool, created_at
#   FROM agent_tasks WHERE server_id=? ORDER BY created_at
```

带真实 agent 的端到端测试需要先修好 agent build（不在本次范围）。

## 已知 trade-offs

- **codex 下发**：2 任务顺序执行。若 write_config 成功但 set_credential 失败，codex 拿到无 key 配置 → 鉴权失败。UI 会同时显示两个任务状态，用户可手动重试。和今天的风险一致，只是更显式。
- **claude/gemini 卸载是破坏性**：覆盖整个 settings.json，丢失 permissions / model 等自定义。dialog 已说明。
- **opencode 卸载是破坏性**：清空所有 provider（不只被卸载的那个）。dialog 已说明。
  （要精确"只删一个 provider"需要新 DB 列 + 配置指纹识别，超出本次范围。）
- **`set_credential` 和 `creds/<tool>.sh` + `ensureCredSourcing`** 在 agent 中变成 legacy 路径
  （新流程不再为 claude/gemini 触发）。保留以兼容历史任务/老 agent。
- **历史 `.bashrc`/`.zshrc` source 循环**（来自过去 claude/gemini 下发）保留直到手动删除。
  新流程不再追加新循环。
- **`gemini配置方法.md` 提到 `GEMINI_MODEL`**，但 `generateConfig("gemini", …)` 不设置它。
  按当前行为保持不设（用户未要求）。

## 执行顺序

1. servers/routes.ts 的 `/credentials/set` 与 `/credentials/remove`
2. batch/routes.ts 的 `/batch/execute`
3. agent/routes.ts line 269 cleanup
4. ServerDetailPage.tsx 前端文案与 preview
5. dev 跑通，按上面验证清单跑一遍
