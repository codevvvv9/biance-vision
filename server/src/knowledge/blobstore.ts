/**
 * 原始文件/抓取内容存储。
 * 对应 docs/specs/knowledge-rag.md「解析产物与原始文件存 MinIO，元数据落 PG」——
 * 接口先行、实现可换：首版本地磁盘（server/data/knowledge-files/），
 * MinIO/S3 上线时新增实现类即可，调用方（pipeline/routes）不感知（OCP）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../store.js'
import { tryMinioBlobStore } from './minioBlobstore.js'

export interface PutResult {
  blobKey: string
  bytes: number
}

export interface BlobStore {
  put(key: string, data: Buffer): Promise<PutResult>
  get(key: string): Promise<Buffer | null>
  /** 键必须在本存储根内（拒绝路径穿越） */
  exists(key: string): Promise<boolean>
}

const ROOT = path.join(DATA_DIR, 'knowledge-files')

/** 键安全化：只允许 [A-Za-z0-9._-] 与目录分隔，落盘前再校验解析结果不出根 */
function resolveKey(key: string): string {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes('..')) {
    throw new Error(`非法存储键：${key}`)
  }
  const full = path.resolve(ROOT, key)
  if (!full.startsWith(ROOT + path.sep)) throw new Error(`存储键越界：${key}`)
  return full
}

export class LocalDiskBlobStore implements BlobStore {
  async put(key: string, data: Buffer): Promise<PutResult> {
    const full = resolveKey(key)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, data)
    return { blobKey: key, bytes: data.byteLength }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(resolveKey(key))
    } catch {
      return null
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      resolveKey(key)
      return fs.existsSync(resolveKey(key))
    } catch {
      return false
    }
  }
}

let instance: BlobStore | null = null

/** 进程内单例；MinIO 环境齐备时用 S3 实现，否则本地磁盘（docs/specs/knowledge-rag.md Lumen 复用映射） */
export function getBlobStore(): BlobStore {
  if (!instance) {
    const minio = tryMinioBlobStore()
    instance = minio ?? new LocalDiskBlobStore()
  }
  return instance
}

export function currentBlobStoreKind(): 'minio' | 'local-disk' {
  return getBlobStore() instanceof LocalDiskBlobStore ? 'local-disk' : 'minio'
}
