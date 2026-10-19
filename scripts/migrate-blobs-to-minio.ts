/**
 * 本地磁盘 BlobStore → MinIO 幂等迁移（2026-10-19 双后端分裂收口）。
 * 背景：本地源码进程曾无 MINIO_* 环境而落盘 server/data/knowledge-files/，容器走 MinIO——
 * 两边各持有对方读不到的对象（快照输入包 / 知识库原始文件 / 解析产物）。
 * 统一后端（server/.env 配 MINIO_*）后，用本脚本把磁盘上的历史对象补写入 MinIO：
 * 键不变、内容不变，已存在的对象跳过，可重复执行。
 * 运行：pnpm blobs:migrate
 */
import fs from 'node:fs'
import path from 'node:path'
import '../server/src/env.js'
import { currentBlobStoreKind, getBlobStore } from '../server/src/knowledge/blobstore.js'
import { DATA_DIR } from '../server/src/store.js'
import { kv, log } from '../server/src/logger.js'

const ROOT = path.join(DATA_DIR, 'knowledge-files')

function walk(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = base === '' ? name : `${base}/${name}`
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel))
    else out.push(rel)
  }
  return out
}

if (currentBlobStoreKind() !== 'minio') {
  log.error('blobs-migrate', '当前 BlobStore 不是 MinIO（检查 server/.env 的 MINIO_* 四项是否齐备），中止')
  process.exit(1)
}
if (!fs.existsSync(ROOT)) {
  log.warn('blobs-migrate', '本地磁盘无 knowledge-files 目录，无需迁移')
  process.exit(0)
}

const store = getBlobStore()
const keys = walk(ROOT)
let existed = 0
let migrated = 0
const failed: { key: string; err: string }[] = []
for (const key of keys) {
  try {
    if (await store.exists(key)) {
      existed += 1
      continue
    }
    await store.put(key, fs.readFileSync(path.join(ROOT, key)))
    migrated += 1
  } catch (err) {
    failed.push({ key, err: (err as Error).message })
  }
}
log.ok('blobs-migrate', '迁移完成', kv({ 对象总数: keys.length, 已存在跳过: existed, 本次迁入: migrated, 失败: failed.length }))
for (const f of failed) log.warn('blobs-migrate', `失败：${f.key} → ${f.err}`)
process.exit(failed.length > 0 ? 1 : 0)
