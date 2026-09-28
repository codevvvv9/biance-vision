#!/usr/bin/env bash
# 一键拉起全部隧道（本地 3200 -> 三条公网入口）
# 用法：bash scripts/tunnels-start.sh
# 各隧道独立脚本：ngrok-start.sh / cf-start.sh；otun 直接在此启动
# 停止全部：pkill -f "otun http"; pkill -f "ngrok http"; pkill -f "cloudflared tunnel"

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3200}"

if ! curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "❌ 本地 $PORT 无服务，先启动应用：docker compose up -d"
  exit 1
fi

echo "== otun（固定子域名）=="
pgrep -f "otun http" >/dev/null || nohup otun http "$PORT" -s redacted-otun-subdomain > /tmp/otun-bv.log 2>&1 &
sleep 3; grep -oE "https://[a-z0-9-]+\.tunnel\.otun\.dev" /tmp/otun-bv.log | tail -1 || true

echo "== ngrok（账户固定域名）=="; bash "$DIR/ngrok-start.sh"
echo "== cloudflared（临时域名）=="; bash "$DIR/cf-start.sh"
