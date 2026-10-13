#!/usr/bin/env bash
# 本机（现有 compose 栈所在机器）执行：打包三样数据并推送到服务器。
#   ./deploy/oracle/migrate-local.sh ubuntu@服务器IP
# 产物：PG 逻辑备份 / MinIO 命名卷整卷 / server-data 配置目录 → 服务器 /tmp/
set -euo pipefail
REMOTE="${1:?用法: migrate-local.sh user@server-ip}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# 1) PostgreSQL 逻辑备份（-Fc 自定义格式，恢复时可 --role 重定属主）
echo '[1/3] pg_dump ...'
docker exec biance-vision-postgres pg_dump -U postgres -d biance_vision -Fc -f /tmp/biance.dump
docker cp biance-vision-postgres:/tmp/biance.dump "$STAGE/biance.dump"

# 2) MinIO 命名卷整卷打包（含桶元数据，免 S3 逐对象拷贝；
#    卷名前缀 = compose 项目名，仓库根目录名是 biance-vision）
echo '[2/3] 打包 minio-data 卷 ...'
docker run --rm -v biance-vision_minio-data:/data -v "$STAGE":/out alpine \
  tar czf /out/minio-data.tgz -C /data .

# 3) server/data（ai-config.json / secrets.json / seed-users.json——含密钥，仅走 scp）
echo '[3/3] 打包 server/data ...'
tar czf "$STAGE/server-data.tgz" -C server data

echo "scp → $REMOTE:/tmp/"
scp "$STAGE/biance.dump" "$STAGE/minio-data.tgz" "$STAGE/server-data.tgz" "$REMOTE:/tmp/"
echo '完成。在服务器仓库根目录执行：bash deploy/oracle/migrate-remote.sh'
