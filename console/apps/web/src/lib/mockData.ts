export interface Server {
  id: string
  name: string
  os: "linux" | "macOS"
  host: string
  status: "online" | "offline" | "warning"
  lastSeen: string
  tools: string[]
}

export const mockServers: Server[] = [
  { id: "1", name: "prod-web-01", os: "linux", host: "192.168.1.10", status: "online", lastSeen: "2 min 前", tools: ["codex", "claude"] },
  { id: "3", name: "gpu-node-03", os: "linux", host: "192.168.1.30", status: "online", lastSeen: "1 min 前", tools: ["gemini"] },
  { id: "4", name: "ci-runner-07", os: "linux", host: "10.0.1.22", status: "offline", lastSeen: "32 min 前", tools: ["codex", "claude", "gemini"] },
]

export interface Provider {
  id: string
  name: string
  baseUrl: string
  family: "claude" | "codex" | "gemini" | "mixed"
  keyCount: number
  balanceUsd: string
}

export const mockProviders: Provider[] = [
  { id: "1", name: "PackyCode", baseUrl: "https://www.packyapi.com", family: "claude", keyCount: 1, balanceUsd: "12.50" },
  { id: "2", name: "智枢", baseUrl: "https://zhishu.dev", family: "codex", keyCount: 1, balanceUsd: "88.00" },
  { id: "3", name: "bytecat", baseUrl: "https://codecdn.bytecatcode.org", family: "claude", keyCount: 1, balanceUsd: "3.20" },
  { id: "4", name: "opentk.ai", baseUrl: "https://opentk.ai", family: "codex", keyCount: 1, balanceUsd: "45.10" },
]
