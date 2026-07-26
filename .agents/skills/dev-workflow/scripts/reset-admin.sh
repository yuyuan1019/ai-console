#!/usr/bin/env bash
# 把数据库里 admin 用户（或 BOOTSTRAP_ADMIN_USER 指定用户）的密码重置为 .env 的
# BOOTSTRAP_ADMIN_PASS 值。开发验证专用：持久化 DB 里的 admin 密码可能早于当前
# .env 设置，导致 docker 验证登录 401。本脚本在容器内用 node 内置 scrypt（参数与
# core/crypto.ts 的 hashPassword 完全一致）原地改写 password_hash。
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT"

USER="${BOOTSTRAP_ADMIN_USER:-admin}"
PASS="$(grep -E "^BOOTSTRAP_ADMIN_PASS=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
[ -z "$PASS" ] && PASS="admin"

if ! docker compose ps --services 2>/dev/null | grep -q '^ai-console$'; then
  echo "FAIL: ai-console 容器未运行，先执行 verify.sh 或 docker compose up -d" >&2
  exit 1
fi

# ponytail: 用环境变量把用户名/密码传进容器，避免 node -e 的 process.argv 索引
# 歧义（-e 模式下 argv[1] 行为随版本不同），也避免密码进 ps 列表。scrypt 参数与
# core/crypto.ts:hashPassword 逐字对齐（N=16384 r=8 p=1 dklen=64，盐 16B 随机）。
AIC_USER="$USER" AIC_PASS="$PASS" docker compose exec -T \
  -e AIC_USER -e AIC_PASS ai-console \
  node --input-type=module -e '
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/app/console/data/ai-console.db");
const salt = crypto.randomBytes(16);
const derived = crypto.scryptSync(process.env.AIC_PASS, salt, 64, { N: 16384, r: 8, p: 1 });
const hash = `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
const now = Date.now();
const r = db.prepare(
  "UPDATE users SET password_hash=?, password_algo=?, failed_login_count=0, locked_until=NULL, updated_at=? WHERE username=?"
).run(hash, "scrypt", now, process.env.AIC_USER);
if (r.changes === 0) {
  console.error(`未找到用户: ${process.env.AIC_USER}（先确认该用户存在于 users 表）`);
  process.exit(1);
}
console.log(`已重置 ${process.env.AIC_USER} 的密码为 .env 配置值（scrypt）；同时清除了登录失败计数/锁定。`);
db.close();
' 2>&1 | grep -v -i 'ExperimentalWarning\|--trace-warnings'
