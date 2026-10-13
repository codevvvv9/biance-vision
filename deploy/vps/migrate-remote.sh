#!/usr/bin/env bash
# 服务器（仓库根目录）执行：恢复 /tmp 下三个迁移包（先跑过 migrate-local.sh）。
#   bash deploy/oracle/migrate-remote.sh
# 前提：compose 栈已用覆盖层启动过至少一次（卷已初始化：biance_app 角色由 init.sql 创建）。
set -euo pipefail
COMPOSE="docker compose -f docker-compose.yml -f deploy/vps/compose.override.yml"

for f in /tmp/biance.dump /tmp/minio-data.tgz /tmp/server-data.tgz; do
  [ -f "$f" ] || { echo "缺少 $f（先在本机跑 deploy/vps/migrate-local.sh）"; exit 1; }
done

echo '[1/3] 恢复 server/data（先停服务，避免空配置起跑写脏数据）'
$COMPOSE stop app worker research-py minio || true
tar xzf /tmp/server-data.tgz

echo '[2/3] 恢复 minio-data 卷'
docker run --rm -v biance-vision_minio-data:/data -v /tmp:/in alpine \
  sh -c 'rm -rf /data/* && tar xzf /in/minio-data.tgz -C /data'

echo '[3/3] 恢复 PostgreSQL（重建空库 → --role=biance_app 恢复属主）'
$COMPOSE up -d postgres --no-deps
until docker exec biance-vision-postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker exec -i biance-vision-postgres psql -U postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'biance_vision' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS biance_vision;
CREATE DATABASE biance_vision OWNER biance_app;
SQL
docker cp /tmp/biance.dump biance-vision-postgres:/tmp/biance.dump
docker exec biance-vision-postgres pg_restore -U postgres -d biance_vision \
  --no-owner --role=biance_app /tmp/biance.dump

echo '拉起全部服务'
$COMPOSE up -d
echo '验证：curl -s http://127.0.0.1:3200/api/health；浏览器登录 admin 后 /research 应能看到迁移来的历史 run 与知识库文档。'
