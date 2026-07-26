#!/usr/bin/env bash
# AI Console 开发收尾验证：docker 重建 → 健康检查 → SPA 检查 → 登录 → 受保护接口冒烟
# 由 .agents/skills/dev-workflow/SKILL.md 调用；也可单独运行。
set -euo pipefail

# 定位仓库根（脚本可能从 skill 目录或仓库任意位置被调用）
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT"

PORT="${AI_CONSOLE_PORT:-15150}"
BASE="http://localhost:${PORT}"
USER="${BOOTSTRAP_ADMIN_USER:-admin}"
# 从 .env 读密码（不回显到日志），缺省回退 dev 默认 admin
PASS="$(grep -E "^BOOTSTRAP_ADMIN_PASS=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
[ -z "$PASS" ] && PASS="admin"

echo "==> [1/5] docker compose up -d --build （必须 --build 才能拿到新代码）"
docker compose up -d --build

echo "==> [2/5] 轮询 ${BASE}/api/health （最多 ~120s）"
ok=""
for _ in $(seq 1 60); do
  if body="$(curl -fsS --max-time 3 "${BASE}/api/health" 2>/dev/null)" && echo "$body" | grep -q '"ok":true'; then
    ok="$body"; break
  fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "FAIL: /api/health 在 ~120s 内未就绪"
  docker compose logs --tail=60
  exit 1
fi
echo "  health OK: $ok"

echo "==> [3/5] SPA 页面（期望 HTTP 200 + text/html）"
html_code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/")"
ct="$(curl -s -o /dev/null -w '%{content_type}' "${BASE}/")"
if [ "$html_code" != "200" ] || ! echo "$ct" | grep -qi 'text/html'; then
  echo "FAIL: 根路径 HTTP=${html_code} CT=${ct}（期望 200 + text/html，可能 SPA 构建失败）"
  docker compose logs --tail=40
  exit 1
fi
echo "  SPA OK: HTTP 200, ${ct}"

echo "==> [4/5] 登录获取 accessToken（user=${USER}）"
# ponytail: 用 jq 构造 body，避免密码里的 " 或 \ 破坏 JSON；登录用 -w 抓状态码+响应体，
# 不用 -f，否则 4xx 时响应体被丢弃，无法定位（401 密码漂移 / 423 锁定 / 429 限流）。
body_json="$(jq -nc --arg u "$USER" --arg p "$PASS" '{username:$u, password:$p}')"
login_body="$(mktemp)"
do_login() {
  curl -sS --max-time 5 -o "$login_body" -w '%{http_code}' \
    -H 'content-type: application/json' -d "$body_json" "${BASE}/api/auth/login"
}
code="$(do_login)"
token=""
[ "$code" = "200" ] && token="$(jq -r '.accessToken // empty' "$login_body" 2>/dev/null || true)"
# ponytail: 持久化 DB 的 admin 密码可能早于 .env（bootstrap 只在 users 表空时建一次），
# 漂移导致 401。本机验证环境直接把 admin 密码同步成 .env 值再重试；设 VERIFY_SKIP_RESET=1 跳过。
if [ -z "$token" ] && [ "$code" = "401" ] && [ "${VERIFY_SKIP_RESET:-0}" != "1" ]; then
  echo "  首次登录 401（admin 密码与 .env 漂移），自动重置后重试…"
  bash "$(dirname "$0")/reset-admin.sh" >/dev/null
  code="$(do_login)"
  [ "$code" = "200" ] && token="$(jq -r '.accessToken // empty' "$login_body" 2>/dev/null || true)"
fi
if [ -z "$token" ]; then
  echo "FAIL: 登录失败 HTTP=${code}，响应: $(cat "$login_body" 2>/dev/null)"
  echo "  423=账户锁定（5min），429=限流（5次/15min），401=密码仍不一致。"
  echo "  可手动运行: $(dirname "$0")/reset-admin.sh"
  rm -f "$login_body"
  exit 1
fi
rm -f "$login_body"
echo "  登录 OK"

echo "==> [5/5] 受保护接口冒烟（JWT-gated GET）"
for ep in "/api/providers" "/api/servers" "/api/agent/manifest"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer ${token}" "${BASE}${ep}")"
  if [ "$code" = "200" ]; then
    echo "  GET ${ep} -> 200 OK"
  else
    echo "  FAIL: GET ${ep} -> ${code}（期望 200）"
    exit 1
  fi
done

echo ""
echo "✅ 全部验证通过：health / SPA / 登录 / 受保护接口"
echo "   管理后台：${BASE}/   （用户 ${USER}）"
