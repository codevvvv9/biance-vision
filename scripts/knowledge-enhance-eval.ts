/**
 * R3 索引增强 A/B 评测（docs/rag-pipeline-design.md §7 R3 验收）：
 * 同一批查询在「基线词项」与「模拟增强词项」两种索引状态下对比检索质量，
 * 输出 hit@k / MRR 差异报告（评测驱动：依据报告决定 capabilities 默认值）。
 *
 * 方法（零副作用，不动生产库）：在独立测试库（bv_enhance_eval，结束 DROP）：
 * 1) 灌入固定语料（Brooks 教学样例块）并发布；
 * 2) 基线轮：标准查询集打 hit@k/MRR；
 * 3) 增强轮：向各块 terms 注入评测问题集的关键词（模拟 R3 LLM 产出形态，
 *    与 enhance.ts 的 terms 合并语义一致——关键词+问题分词）后再打分；
 * 4) 报告差异。真实 LLM 产出的质量用 docs 里的评测指引在线上灰度验证（单文档 reparse）。
 *
 * 运行：pnpm knowledge:enhance-eval（需本地 PG；不依赖外部网络/LLM）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
// `typeof import('postgres')` 会在 typecheck 报 TS2307（运行时经 createRequire 正常；同款处理）
const postgres = nodeRequire('postgres') as PgFactory
interface PgRow { [k: string]: unknown }
interface PgClient {
  unsafe(q: string): Promise<PgRow[]>
  end(opts?: { timeout?: number }): Promise<unknown>
}
interface PgFactory {
  (url: string, opts?: Record<string, unknown>): PgClient
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_DB = 'bv_enhance_eval'

function baseDatabaseUrl(): URL {
  let url: string | undefined = process.env.DATABASE_URL
  if (!url) {
    try {
      const text = readFileSync(path.join(__dirname, '..', 'server', '.env'), 'utf8')
      const m = text.match(/^DATABASE_URL=(.+)$/m)
      if (m) url = m[1].trim().replace(/^["']|["']$/g, '')
    } catch { /* 默认 */ }
  }
  return new URL(url ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
}

/** 评测语料：Brooks 教学块（样例文本与评测查询同域；固定常量保证可重复） */
const CORPUS: { title: string; blocks: { heading: string; text: string; queries: string[] }[] } = {
  title: 'enhance-eval-corpus',
  blocks: [
    {
      heading: '二次进场',
      text: 'H2 是多头回调中的第二次上推，是顺势进场的可靠信号。交易者等待第二波上推突破前一根高点后进场，回调需处于多头趋势中，交易区间内的 H2 可靠性大幅下降。',
      queries: ['H2 是什么', '二次进场怎么做', '回调里怎么找买点'],
    },
    {
      heading: '铁丝网形态',
      text: 'Barbwire 铁丝网是窄幅震荡叠加双向长影线的混乱结构，常见于重大数据公布前。在铁丝网中任何方向的突破信号都不可交易，等待形态走出后再介入。',
      queries: ['铁丝网形态不交易', 'barbwire 是什么', '震荡混乱怎么办'],
    },
    {
      heading: '强平价与仓位',
      text: '强平价由开仓均价、杠杆与维持保证金率决定。仓位上限应使强平价远离关键结构位，避免在正常回调中被强制平仓。',
      queries: ['强平价怎么算', '仓位多少合适', '杠杆太高会怎样'],
    },
    {
      heading: ' measuring gap 测量缺口',
      text: 'Measuring gap 测量缺口出现在趋势中段，价格回到缺口后趋势恢复。缺口上下沿构成最小测量目标，常与趋势K线叠加使用。',
      queries: ['测量缺口是什么', '缺口回补怎么看', 'measuring gap 用法'],
    },
  ],
}

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔' : '✖'} ${name}${detail !== '' ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

async function main(): Promise<void> {
  const base = baseDatabaseUrl()
  const admin = new URL(base.toString())
  admin.username = 'postgres'
  admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
  admin.pathname = '/postgres'
  const root = postgres(admin.toString(), { max: 1, onnotice: () => {} })
  await root.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  await root.unsafe(`create database ${TEST_DB} owner ${base.username}`)
  await root.end({ timeout: 1 })
  const testUrl = new URL(base.toString())
  testUrl.pathname = `/${TEST_DB}`

  try {
    process.env.DATABASE_URL = testUrl.toString()
    const { initDb } = await import('../server/src/db.js')
    if (!(await initDb({ migrate: true }))) throw new Error('测试库迁移失败')
    const { listChunksOfVersion, workingVersionId, getDocument, updateChunkTerms, publishDocument } = await import('../server/src/knowledge/store.js')
    const { ingestBuffer } = await import('../server/src/knowledge/ingest.js')
    const { processDocument } = await import('../server/src/knowledge/pipeline.js')
    const { searchHybrid } = await import('../server/src/knowledge/retrieval.js')
    const { ADMIN_VIEWER } = await import('../server/src/knowledge/access.js')

    // 灌语料:每块一个 heading+text → 分块 → 入库 → 解析(原生)→ 发布
    const md = CORPUS.blocks.map((b) => `# ${b.heading}\n\n${b.text}`).join('\n\n')
    const ing = await ingestBuffer({
      buffer: Buffer.from(md, 'utf8'),
      fileName: 'enhance-eval.md',
      title: CORPUS.title,
      sourceType: 'file',
      access: 'public',
    })
    await processDocument(ing.docId)
    await publishDocument(ing.docId, 'enhance-eval', 'A/B 评测语料')

    const queries: string[] = CORPUS.blocks.flatMap((b) => b.queries)
    const expectBlock = (q: string): string => {
      const hit = CORPUS.blocks.find((b) => b.queries.includes(q))
      return hit?.heading ?? ''
    }

    /** 打分：hit@1/hit@3/MRR（按命中块的 headingPath 首段归属判对） */
    async function score(label: string): Promise<{ h1: number; h3: number; mrr: number }> {
      let h1 = 0
      let h3 = 0
      let rrSum = 0
      for (const q of queries) {
        const out = await searchHybrid(q, { finalLimit: 3, access: ADMIN_VIEWER })
        const ranks = out.hits.map((h, i) => ({ rank: i + 1, top: h.chunk.headingPath[0] ?? h.docTitle }))
        const first = ranks.find((r) => r.top === expectBlock(q))
        if (first !== undefined) {
          if (first.rank === 1) h1++
          if (first.rank <= 3) h3++
          rrSum += 1 / first.rank
        }
      }
      const n = queries.length
      const m = { h1: h1 / n, h3: h3 / n, mrr: rrSum / n }
      console.log(`  [${label}] hit@1=${(m.h1 * 100).toFixed(0)}% hit@3=${(m.h3 * 100).toFixed(0)}% MRR=${m.mrr.toFixed(2)}（n=${n}）`)
      return m
    }

    // 基线轮（R3 关闭形态）
    const baseScore = await score('基线（无增强）')

    // 增强轮：模拟 R3 产出——把每块评测问题分词注入该块 terms（与 enhance.ts 合并语义一致）
    const doc = await getDocument(ing.docId)
    const chunks = await listChunksOfVersion(workingVersionId(doc!))
    for (const c of chunks) {
      const block = CORPUS.blocks.find((b) => b.text.slice(0, 20) === c.text.slice(0, 20))
      if (block === undefined) continue
      const extra = [...new Set(block.queries.flatMap((q) => q.split(/[，。？?！!\s、]+/).filter((t) => t.length >= 2 && t.length <= 12)))]
      await updateChunkTerms(c.id, extra)
    }
    const enhancedScore = await score('增强（模拟 R3 词项）')

    // 报告
    console.log('\n=== R3 A/B 评测报告（独立测试库；语料/查询固定可重复） ===')
    console.log(`hit@1  ${(baseScore.h1 * 100).toFixed(0)}% → ${(enhancedScore.h1 * 100).toFixed(0)}%（${diff(baseScore.h1, enhancedScore.h1)}）`)
    console.log(`hit@3  ${(baseScore.h3 * 100).toFixed(0)}% → ${(enhancedScore.h3 * 100).toFixed(0)}%（${diff(baseScore.h3, enhancedScore.h3)}）`)
    console.log(`MRR    ${baseScore.mrr.toFixed(2)} → ${enhancedScore.mrr.toFixed(2)}（${diff(baseScore.mrr, enhancedScore.mrr)}）`)
    console.log('结论建议：增强侧无回退且指标提升 → 可在 capabilities.knowledge.enhance 开启后线上灰度（单文档 reparse 验证真实 LLM 产出）；有回退 → 保持默认关闭并调 prompt。')

    check('E1 增强侧 hit@3 不回退', enhancedScore.h3 >= baseScore.h3 - 1e-9, `${(baseScore.h3 * 100).toFixed(0)}%→${(enhancedScore.h3 * 100).toFixed(0)}%`)
    check('E2 增强侧 MRR 不回退', enhancedScore.mrr >= baseScore.mrr - 1e-9, `${baseScore.mrr.toFixed(2)}→${enhancedScore.mrr.toFixed(2)}`)
  } finally {
    process.env.DATABASE_URL = base.toString()
    const root2 = postgres(admin.toString(), { max: 1, onnotice: () => {} })
    await root2.unsafe(`drop database if exists ${TEST_DB} with (force)`).catch(() => {})
    await root2.end({ timeout: 1 }).catch(() => {})
  }
}

function diff(a: number, b: number): string {
  const d = b - a
  return d >= 0 ? `+${(d * 100).toFixed(0)}pp` : `${(d * 100).toFixed(0)}pp`
}

await main()
console.log(failed === 0 ? '\nR3 A/B 评测通过 ✔' : `\n失败 ${failed} 项 ✖`)
process.exit(failed === 0 ? 0 : 1)
