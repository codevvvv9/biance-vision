/**
 * 本地 mock embedding 服务（仅用于离线验证向量召回管线 / 无外部密钥的开发环境）：
 * POST /embeddings → 1536 维词袋向量（token 哈希投影 + 归一化），
 * 语义上等价"词重叠相似度"，足以验证 写入→pgvector→向量召回→RRF 全链路。
 * 真实语义检索请配置 OpenAI 兼容 embedding 能力（EMBEDDING_BASE_URL/EMBEDDING_MODEL/EMBEDDING_API_KEY）。
 * 运行：node scripts/mock-embeddings.mjs （默认 127.0.0.1:8123）
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

const DIMS = 1536
const PORT = Number(process.env.PORT ?? 8123)

function tokenize(text) {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9_-]{0,19}/g) ?? []
  const cjk = []
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) cjk.push(run)
    for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2))
  }
  return [...latin, ...cjk]
}

function embed(text) {
  const v = new Array(DIMS).fill(0)
  for (const tok of tokenize(text)) {
    const h = createHash('md5').update(tok).digest()
    const idx = ((h[0] << 16) | (h[1] << 8) | h[2]) % DIMS
    const sign = h[3] % 2 === 0 ? 1 : -1
    v[idx] += sign
  }
  let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0))
  if (norm === 0) norm = 1
  return v.map((x) => x / norm)
}

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/embeddings')) {
      res.writeHead(404).end('{"detail":"Not Found"}')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { input } = JSON.parse(body)
        const list = Array.isArray(input) ? input : [input]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: list.map((t, i) => ({ index: i, embedding: embed(String(t)) })), model: 'mock-bow-1536' }))
      } catch {
        res.writeHead(400).end('{"error":"bad request"}')
      }
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock-embeddings listening on http://127.0.0.1:${PORT} (dim=${DIMS})`))
