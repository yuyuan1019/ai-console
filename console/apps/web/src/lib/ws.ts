// 浏览器 WebSocket 客户端：实时事件推送（消除前端轮询）

import { api, getAccessToken, refreshAccessToken } from "@/lib/api"

type EventCallback = (payload: any) => void

let ws: WebSocket | null = null
let currentToken: string | null = null
let reconnectTimer: number | null = null
let reconnectDelay = 1000
const subscribers = new Map<string, Set<EventCallback>>()
const pendingSubscriptions = new Set<string>()

// ponytail (BUG-09): connect-attempt generation. Two concurrent initWS()
// calls (e.g. auth restore + explicit login) used to each spawn a WebSocket
// and each consume a ticket; the losing attempt would consume a ticket that
// was then rejected (4001), and its onclose would tear down the winning
// socket's map entries via the shared `ws` variable. The generation counter
// captures which attempt owns any given socket; stale attempts return early
// after the async ticket fetch and never assign to `ws`.
let connectionGeneration = 0

// ponytail (bug 21): single-flight 领票——并发重连共享一次 POST /auth/ws-ticket。
// request() 内置 401-refresh-retry 拦截器，access JWT 过期会先静默轮换再开 socket。
// ponytail (BUG-09): ticket is one-shot; settle → null immediately. The
// previous 1s cache made a second initWS() reuse the just-consumed ticket
// and get rejected with 4001, triggering a reconnect loop.
let ticketPromise: Promise<string | null> | null = null
function fetchWsTicket(): Promise<string | null> {
  if (ticketPromise) return ticketPromise
  ticketPromise = (async () => {
    try {
      const res = await api.wsTicket()
      return res.ticket
    } catch {
      return null
    } finally {
      ticketPromise = null
    }
  })()
  return ticketPromise
}

// ponytail (BUG-09): disconnectSocket only tears down the socket + timers.
// initWS and auto-reconnect must call this instead of closeWS() so
// subscribers survive reconnects (previously closeWS().clear() ran on every
// reconnect, silently killing every hook's subscription).
function disconnectSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.onopen = null
    try { ws.close() } catch {}
    ws = null
  }
}

export async function initWS(token: string) {
  if (!token) return
  if (ws && currentToken === token) return
  const gen = ++connectionGeneration
  disconnectSocket()
  currentToken = token

  // 用一次性 30s 票据连 ?ticket=，避免 access JWT 进 URL/访问日志。
  const ticket = await fetchWsTicket()
  // ponytail (BUG-09): if another initWS bumped the generation while we
  // awaited the ticket, back off — the newer attempt owns the connect
  // sequence. Also honour closeWS() invalidating currentToken during await.
  if (gen !== connectionGeneration || currentToken !== token) return
  if (!ticket) {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
    reconnectTimer = window.setTimeout(() => {
      if (currentToken === token) void initWS(token)
    }, reconnectDelay)
    return
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(`${proto}//${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`)
  ws = socket

  socket.onopen = () => {
    if (ws !== socket || gen !== connectionGeneration) return
    reconnectDelay = 1000
    for (const channel of pendingSubscriptions) {
      socket.send(JSON.stringify({ type: "subscribe", channel }))
    }
    for (const channel of subscribers.keys()) {
      socket.send(JSON.stringify({ type: "subscribe", channel }))
    }
  }

  socket.onmessage = (e) => {
    if (ws !== socket || gen !== connectionGeneration) return
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === "event") {
        const cbs = subscribers.get(msg.channel)
        if (cbs) cbs.forEach((cb) => cb(msg.payload))
      }
    } catch {}
  }

  socket.onclose = async (ev) => {
    // ponytail (BUG-09): a stale socket's delayed close event must not clear
    // the current socket. If ws has already been replaced by a newer attempt,
    // or the generation has advanced, drop the event entirely.
    if (ws !== socket || gen !== connectionGeneration) return
    ws = null
    if (!currentToken) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
    reconnectTimer = window.setTimeout(async () => {
      // 4001 = access token rejected by the server. Rotate via the refresh cookie
      // before retrying; if the refresh cookie is also dead, refreshAccessToken
      // returns null and we stop reconnecting - the next API call's 401 interceptor
      // then clears the session. Otherwise the stale token would 4001-loop forever.
      const tok = ev.code === 4001 ? await refreshAccessToken() : getAccessToken()
      if (tok) initWS(tok)
    }, reconnectDelay)
  }

  socket.onerror = () => {
    if (ws !== socket || gen !== connectionGeneration) return
    try { socket.close() } catch {}
  }
}

export function closeWS() {
  // ponytail (BUG-09): full teardown — used only on logout / AuthProvider
  // unmount. Advancing the generation invalidates any in-flight init.
  currentToken = null
  connectionGeneration++
  disconnectSocket()
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
