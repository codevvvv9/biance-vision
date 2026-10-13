/**
 * MinIO/S3 兼容 BlobStore（AWS SigV4，最小实现：PUT/GET/HEAD，无 SDK 依赖）。
 * 环境变量齐备（MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY/MINIO_BUCKET，
 * 可选 MINIO_BUCKET_PATH_STYLE=true 走 path-style）时启用，否则保持本地磁盘实现。
 * 切换由 getBlobStore() 决定，调用方（pipeline/ingest）无感知（OCP）。
 */
import { createHash, createHmac } from 'node:crypto'
import type { BlobStore, PutResult } from './blobstore.js'

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

interface S3Config {
  endpoint: URL
  accessKey: string
  secretKey: string
  bucket: string
  pathStyle: boolean
}

export class MinioBlobStore implements BlobStore {
  private readonly cfg: S3Config

  constructor(env: {
    MINIO_ENDPOINT: string
    MINIO_ACCESS_KEY: string
    MINIO_SECRET_KEY: string
    MINIO_BUCKET: string
    MINIO_PATH_STYLE?: string
  }) {
    this.cfg = {
      endpoint: new URL(env.MINIO_ENDPOINT.replace(/\/+$/, '')),
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
      pathStyle: env.MINIO_PATH_STYLE !== 'false',
    }
  }

  private host(): string {
    const u = this.cfg.endpoint
    const port = u.port !== '' ? `:${u.port}` : ''
    return `${u.hostname}${port}`
  }

  private urlFor(key: string): URL {
    const u = new URL(this.cfg.endpoint.toString())
    u.pathname = this.cfg.pathStyle ? `/${this.cfg.bucket}/${key}` : `/${key}`
    if (!this.cfg.pathStyle) u.hostname = `${this.cfg.bucket}.${u.hostname}`
    return u
  }

  /** SigV4 签名请求（GET/PUT/HEAD，payload 全量入签） */
  private async request(method: 'GET' | 'PUT' | 'HEAD', key: string, body?: Buffer): Promise<Response> {
    const url = this.urlFor(key)
    const now = new Date()
    const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}` // 20260101T000000Z
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256Hex(body ?? '')
    const headers: Record<string, string> = {
      host: this.host(),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (body !== undefined) headers['content-length'] = String(body.byteLength)
    const signedHeaders = Object.keys(headers).sort().join(';')
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join('')
    const canonicalRequest = [
      method,
      url.pathname,
      url.search.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${dateStamp}/auto/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n')
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretKey}`, dateStamp), 'auto'), 's3'), 'aws4_request')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    return fetch(url, {
      method,
      headers: { ...headers, authorization },
      body: body !== undefined ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
  }

  async put(key: string, data: Buffer): Promise<PutResult> {
    const res = await this.request('PUT', key, data)
    if (!res.ok) {
      throw new Error(`MinIO PUT ${key} → ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`)
    }
    return { blobKey: key, bytes: data.byteLength }
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', key)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`MinIO GET ${key} → ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.request('HEAD', key)
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`MinIO HEAD ${key} → ${res.status}`)
    return true
  }
}

/** 环境齐备则返回 MinIO 实现，否则 null（调用方落回本地磁盘） */
export function tryMinioBlobStore(): MinioBlobStore | null {
  const endpoint = process.env.MINIO_ENDPOINT
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  const bucket = process.env.MINIO_BUCKET
  if (!endpoint || !accessKey || !secretKey || !bucket) return null
  return new MinioBlobStore({ MINIO_ENDPOINT: endpoint, MINIO_ACCESS_KEY: accessKey, MINIO_SECRET_KEY: secretKey, MINIO_BUCKET: bucket })
}
