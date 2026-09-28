#!/usr/bin/env bash
# 一键拉起全部隧道（本地 3200 -> 三条公网入口）
# 用法：bash scripts/tunnels-start.sh
# 固定子域/域名的值不入库（仓库是 public 的，入口地址按需保密）：
#   首次使用请创建 scripts/tunnels.local.sh（已 gitignore）：
#     export OTUN_SUBDOMAIN="你的固定子域"        # 留空 = otun 随机子域
#     export NGROK_DOMAIN="xxx.ngrok-free.dev"    # 留空 = ngrok 随机域名
#   或直接用环境变量传入。
# 各隧道独立脚本：ngrok-start.sh / cf-start.sh；otun 直接在此启动
# 停止全部：pkill -f "otun http"; pkill -f "ngrok http"; pkill -f "cloudflared tunnel"

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3200}"
# 本地私有配置（不入库）：固定子域名等
[ -f "$DIR/tunnels.local.sh" ] && . "$DIR/tunnels.local.sh"
OTUN_SUBDOMAIN="${OTUN_SUBDOMAIN:-}"

if ! curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "❌ 本地 $PORT 无服务，先启动应用：docker compose up -d"
  exit 1
fi

echo "== otun（${OTUN_SUBDOMAIN:+固定子域名}）=="
if pgrep -f "otun http" >/dev/null; then
  echo "⚠ otun 已在运行"
elif [ -n "$OTUN_SUBDOMAIN" ]; then
  nohup otun http "$PORT" -s "$OTUN_SUBDOMAIN" > /tmp/otun-bv.log 2>&1 &
else
  echo "（未配置 OTUN_SUBDOMAIN，使用随机子域）"
  nohup otun http "$PORT" > /tmp/otun-bv.log 2>&1 &
fi
sleep 3; grep -oE "https://[a-z0-9-]+\.tunnel\.otun\.dev" /tmp/otun-bv.log | tail -1 || true

echo "== ngrok（${NGROK_DOMAIN:+账户固定域名}）=="; bash "$DIR/ngrok-start.sh"
echo "== cloudflared（临时域名）=="; bash "$DIR/cf-start.sh"
