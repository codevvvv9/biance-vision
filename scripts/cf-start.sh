#!/usr/bin/env bash
# cloudflared 备用隧道（免登录临时域名）：代理本机 3200
# 用法：bash scripts/cf-start.sh
# 注意：临时域名每次重启都会变；本机 UDP/QUIC 不通时必须 --protocol http2
# 日志：/tmp/cf-tunnel.log；停止：pkill -f "cloudflared tunnel"

set -euo pipefail

PORT="${PORT:-3200}"
LOG=/tmp/cf-tunnel.log

if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
  # 免费临时隧道会被 Cloudflare 服务端回收：进程不退出但地址永久失效，
  # 日志特征 = 循环 "Unauthorized: Tunnel not found"。检测到即自动重启换新地址。
  if tail -50 "$LOG" 2>/dev/null | grep -q "Tunnel not found"; then
    echo "⚠ 临时隧道已被服务端回收（地址失效），自动重启换新地址…"
    pkill -f "cloudflared tunnel" || true
    sleep 2
  else
    echo "⚠ cloudflared 已在运行：$(pgrep -f 'cloudflared tunnel' | tr '\n' ' ')"
    grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | tail -1
    exit 0
  fi
fi

nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol http2 > "$LOG" 2>&1 &
for i in $(seq 1 15); do
  sleep 2
  url=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1) && [ -n "$url" ] && break
done
if [ -n "${url:-}" ]; then
  echo "🌐 公网地址：$url"
else
  echo "启动中，稍后查看日志：tail -f $LOG"
fi
