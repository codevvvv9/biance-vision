#!/usr/bin/env bash
# ngrok 备用隧道：代理本机 3200（biance-vision 完整服务）
# 用法：
#   首次：ngrok config add-authtoken <你的token>
#   启动：bash scripts/ngrok-start.sh [固定域名]
# 日志：/tmp/ngrok-bv.log；停止：pkill -f "ngrok http"
# 免费账户自带一个固定静态域名（名字由 ngrok 随机分配、不可自取）：
DEFAULT_DOMAIN="monastically-overstrung-tyra.ngrok-free.dev"

set -euo pipefail

PORT="${PORT:-3200}"
DOMAIN="${1:-$DEFAULT_DOMAIN}"
LOG=/tmp/ngrok-bv.log

if ! ngrok config check >/dev/null 2>&1; then
  echo "❌ 尚未配置 authtoken：到 https://dashboard.ngrok.com/get-started/your-authtoken 复制后执行"
  echo "   ngrok config add-authtoken <你的token>"
  exit 1
fi

if pgrep -f "ngrok http" >/dev/null 2>&1; then
  echo "⚠ ngrok 已在运行：$(pgrep -f 'ngrok http' | tr '\n' ' ')"
  exit 0
fi

ARGS=(http "$PORT" --log=stdout --log-format=logfmt)
if [ -n "$DOMAIN" ]; then
  ARGS+=(--url="$DOMAIN")
fi

nohup ngrok "${ARGS[@]}" > "$LOG" 2>&1 &
sleep 4
# 从本地管理 API 读当前公网地址（4040 被占时 ngrok 用 4041）
for api in 4040 4041; do
  url=$(curl -s "http://127.0.0.1:$api/api/tunnels" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'])" 2>/dev/null) && break
done
if [ -n "${url:-}" ]; then
  echo "🌐 公网地址：$url"
else
  echo "启动中，稍后查看日志：tail -f $LOG"
fi
