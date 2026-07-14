// 浏览器 WebSocket 客户端：实时事件推送（消除前端轮询）

type EventCallback = (payload: any) => void

let ws: WebSocket | null = null
let currentToken: string | null = null
let reconnectTimer: number | null = null
let reconnectDelay = 1000
const subscribers = new Map<string, Set<EventCallback>>()
const pendingSubscriptions = new Set<string>()

export function initWS(token: string) {
  if (ws && currentToken === token) return
  closeWS()
  currentToken = token

  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  ws = new WebSocket(`${proto}//${location.host}/api/ws?token=${encodeURIComponent(token)}`)

  ws.onopen = () => {
    reconnectDelay = 1000
    for (const channel of pendingSubscriptions) {
      ws?.send(JSON.stringify({ type: "subscribe", channel }))
    }
    for (const channel of subscribers.keys()) {
      ws?.send(JSON.stringify({ type: "subscribe", channel }))
    }
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === "event") {
        const cbs = subscribers.get(msg.channel)
        if (cbs) cbs.forEach((cb) => cb(msg.payload))
      }
    } catch {}
  }

  ws.onclose = () => {
    ws = null
    if (currentToken) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
      reconnectTimer = window.setTimeout(() => {
        if (currentToken) initWS(currentToken)
      }, reconnectDelay)
    }
  }

  ws.onerror = () => {
    ws?.close()
  }
}

export function closeWS() {
  currentToken = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  subscribers.clear()
  pendingSubscriptions.clear()
}

export function subscribe(channel: string, cb: EventCallback): () => void {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set())
  subscribers.get(channel)!.add(cb)

  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: "subscribe", channel }))
  } else {
    pendingSubscriptions.add(channel)
  }

  return () => {
    subscribers.get(channel)?.delete(cb)
    if (subscribers.get(channel)?.size === 0) {
      subscribers.delete(channel)
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: "unsubscribe", channel }))
      }
      pendingSubscriptions.delete(channel)
    }
  }
}
