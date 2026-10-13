/**
 * 向量化客户端：知识切块/查询 → embedding。
 * 唯一实现走 OpenAI 兼容 /embeddings（admin-security.md 的 embedding 能力项）；
 * 能力未配置时 resolveEmbeddingClient 返回 null —— 检索层显式跳过向量召回并记录，
 * 绝不静默降级成伪造向量。
 */
import type { CapabilityConfig } from 'biance-vision-brooks'
import { resolveSecret } from '../admin/capabilities.js'

export interface EmbeddingClient {
  readonly dims: number
  embed(texts: string[]): Promise<number[][]>
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

const BATCH = 32

export class OpenAICompatibleEmbeddings implements EmbeddingClient {
  readonly dims: number
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey: string | null

  constructor(cap: CapabilityConfig) {
    this.baseUrl = (cap.baseUrl ?? '').replace(/\/+$/, '')
    this.model = cap.model ?? ''
    this.apiKey = resolveSecret(cap.secretRef)
    this.dims = cap.dims ?? 1536
    if (!this.baseUrl || !this.model) throw new EmbeddingError('embedding 能力缺少 baseUrl/model')
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000))
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.model, input: batch }),
          signal: AbortSignal.timeout(60_000),
        })
      } catch (err) {
        throw new EmbeddingError(`embedding 接口不可达：${(err as Error).message}`)
      }
      if (!res.ok) {
        throw new EmbeddingError(`embedding 接口 → ${res.status}：${(await res.text().catch(() => '')).slice(0, 300)}`)
      }
      const json = (await res.json()) as { data?: { embedding: number[] }[] }
      if (!json.data || json.data.length !== batch.length) {
        throw new EmbeddingError('embedding 返回数量与输入不一致')
      }
      for (const d of json.data) {
        if (d.embedding.length !== this.dims) {
          throw new EmbeddingError(
            `embedding 维度不匹配：端点返回 ${d.embedding.length}，配置 ${this.dims}（需与 knowledge_chunks.embedding 列一致）`,
          )
        }
        out.push(d.embedding)
      }
    }
    return out
  }
}

/** 能力已配置且 baseUrl/model/密钥齐备时返回客户端；否则 null（显式待配置） */
export function resolveEmbeddingClient(cap: CapabilityConfig | undefined): EmbeddingClient | null {
  if (!cap?.enabled || !cap.baseUrl || !cap.model) return null
  try {
    return new OpenAICompatibleEmbeddings(cap)
  } catch {
    return null
  }
}
