/**
 * 管理端业务洞察（v0.18.4 大盘）：用户增长/活跃、消息趋势、研究上下文热点、
 * 内容词云——一次聚合返回。仅 admin-api 注册（superadmin；全局 sourceGuard/CSRF）。
 *
 * 口径说明（诚实缺失纪律，与观测路由一致）：
 * - 日/小时桶统一 Asia/Shanghai 墙上钟（面向中文管理员），day label 为 YYYY-MM-DD。
 * - DAU 以 audit_records 按天去重 username 近似（表裁剪保留最近 1000 行，
 *   窗口长于留存时早期天数自然缺行——如实缺，不补 0 冒充无活跃）。
 * - 词云仅统计 role='user' 消息（用户意图），斜杠命令整条跳过；
 *   Node 22 full-icu 内置 Intl.Segmenter 中文分词，零第三方依赖。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import type { SessionRecord } from '../users.js'

interface InsightsDeps {
  requireSuperadmin: (req: FastifyRequest) => SessionRecord
}

function ensureStorage(reply: FastifyReply): boolean {
  if (!getDb()) {
    reply.code(503).send({ code: 'storage_unavailable', message: 'PostgreSQL 不可用' })
    return false
  }
  return true
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** 功能虚词/口语衬词（中英），只过滤无业务含义的高频词——业务词（涨跌/仓位/BTC 等）保留 */
const STOP_WORDS = new Set([
  // 中文虚词与口语
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '有', '和', '就', '不', '也',
  '都', '很', '这', '那', '与', '及', '或', '等', '什么', '怎么', '为什么', '哪个', '吗',
  '呢', '吧', '啊', '呀', '哦', '嗯', '请', '帮', '帮我', '一下', '现在', '目前', '然后',
  '之后', '以后', '可以', '可能', '应该', '需要', '会', '要', '能', '想', '看看', '说',
  '请问', '今天', '昨天', '明天', '这个', '那个', '这些', '那些', '时候', '时间', '关于',
  '对于', '以及', '还有', '但是', '因为', '所以', '如果', '还是', '不是', '没有', '多少',
  '一些', '一直', '比较', '怎么', '如何', '进行', '分析', '看看', '当前', '最近', '问题',
  // 英文功能词（业务符号 BTC/ETH/USDT 等不过滤）
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'do', 'does', 'did', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that',
  'these', 'those', 'what', 'how', 'why', 'when', 'where', 'which', 'who', 'will',
  'would', 'can', 'could', 'should', 'need', 'want', 'me', 'please', 'help', 'now',
  'then', 'than', 'so', 'if', 'but', 'about', 'from', 'at', 'by', 'as', 'not', 'no',
  'yes', 'ok', 'okay', 'just', 'like', 'get', 'got', 'has', 'have', 'had',
  // 斜杠命令残留高频词
  'calc', 'run', 'clear', 'reset', 'help',
])

/** 上海墙上钟的天标签（与 SQL 侧 AT TIME ZONE 'Asia/Shanghai' 对齐，en-CA 恰好输出 YYYY-MM-DD） */
function shanghaiDay(offsetDays: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - offsetDays * 86_400_000))
}

/** 分词统计：中文词组（≥2 字）+ 英文词（≥2 字母）；纯数字/停用词/超长串过滤 */
function countWords(texts: string[], limit: number): { name: string; value: number }[] {
  const freq = new Map<string, number>()
  for (const raw of texts) {
    const text = raw.trim()
    if (text === '' || text.startsWith('/')) continue // 斜杠命令不是自然语言
    for (const seg of segmenter.segment(text)) {
      if (!seg.isWordLike) continue
      const word = seg.segment.toLowerCase()
      if (word.length < 2) continue // 单字/单字母噪音大
      if (word.length > 20) continue // 长串（哈希/粘贴残留）
      if (STOP_WORDS.has(word)) continue
      if (/^[0-9.,%]+$/.test(word)) continue // 纯数字/百分比
      freq.set(word, (freq.get(word) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, value]) => ({ name, value }))
}

export function registerInsightsAdminRoutes(app: FastifyInstance, deps: InsightsDeps): void {
  app.get('/api/admin/insights', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const db = getDb()
    if (db === null) return reply
    const q = req.query as { days?: string }
    const n = Number.parseInt(q.days ?? '', 10)
    const days = Number.isFinite(n) ? Math.min(Math.max(n, 1), 90) : 30

    const userRows = await db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM users GROUP BY 1 ORDER BY 1`)
    const dauRows = await db.execute(sql`
      SELECT to_char(last_active_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
        count(DISTINCT username)::int AS n
      FROM audit_records
      WHERE last_active_at AT TIME ZONE 'Asia/Shanghai' >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - make_interval(days => ${days})
      GROUP BY 1 ORDER BY 1`)
    const aiMsgRows = await db.execute(sql`
      SELECT to_char(at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM ai_messages WHERE role = 'user'
        AND at AT TIME ZONE 'Asia/Shanghai' >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - make_interval(days => ${days})
      GROUP BY 1 ORDER BY 1`)
    const researchMsgRows = await db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM conversation_messages WHERE role = 'user'
        AND created_at AT TIME ZONE 'Asia/Shanghai' >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - make_interval(days => ${days})
      GROUP BY 1 ORDER BY 1`)
    const hotspotRows = await db.execute(sql`
      SELECT symbol, horizon, count(*)::int AS n
      FROM research_runs
      WHERE created_at AT TIME ZONE 'Asia/Shanghai' >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - make_interval(days => ${days})
      GROUP BY symbol, horizon ORDER BY n DESC`)
    const productRows = await db.execute(sql`
      SELECT product, count(*)::int AS n
      FROM research_runs
      WHERE created_at AT TIME ZONE 'Asia/Shanghai' >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - make_interval(days => ${days})
      GROUP BY product ORDER BY n DESC`)
    // 词云语料：两表用户消息合并（量级小；LIMIT 兜底防极端增长）
    const aiTexts = await db.execute(sql`
      SELECT content FROM ai_messages WHERE role = 'user'
        AND at >= now() - make_interval(days => ${days}) ORDER BY at DESC LIMIT 2500`)
    const researchTexts = await db.execute(sql`
      SELECT content FROM conversation_messages WHERE role = 'user'
        AND created_at >= now() - make_interval(days => ${days}) ORDER BY created_at DESC LIMIT 2500`)
    const texts = [...(aiTexts as unknown as Array<{ content: string }>), ...(researchTexts as unknown as Array<{ content: string }>)]
      .map((r) => String(r.content))

    // 用户增长：全历史累计基数 + 窗口内逐日（缺注册日的天 new=0、cumulative 续前值）
    const userByDay = new Map((userRows as unknown as Array<{ day: string; n: number }>).map((r) => [r.day, Number(r.n)]))
    const total = [...userByDay.values()].reduce((a, b) => a + b, 0)
    const startDay = shanghaiDay(days)
    let cumulative = 0
    for (const [day, n] of userByDay) if (day < startDay) cumulative += n
    const userDays: { day: string; newUsers: number; cumulative: number }[] = []
    for (let i = days; i >= 0; i--) {
      const day = shanghaiDay(i)
      const newUsers = userByDay.get(day) ?? 0
      cumulative += newUsers
      userDays.push({ day, newUsers, cumulative })
    }
    const dauByDay = new Map((dauRows as unknown as Array<{ day: string; n: number }>).map((r) => [r.day, Number(r.n)]))
    const aiByDay = new Map((aiMsgRows as unknown as Array<{ day: string; n: number }>).map((r) => [r.day, Number(r.n)]))
    const researchByDay = new Map((researchMsgRows as unknown as Array<{ day: string; n: number }>).map((r) => [r.day, Number(r.n)]))

    return {
      days,
      users: { total, days: userDays },
      activity: { days: userDays.map(({ day }) => ({ day, dau: dauByDay.get(day) ?? 0 })) },
      messages: {
        days: userDays.map(({ day }) => ({ day, ai: aiByDay.get(day) ?? 0, research: researchByDay.get(day) ?? 0 })),
      },
      hotspots: {
        cells: (hotspotRows as unknown as Array<{ symbol: string; horizon: string; n: number }>).map((r) => ({
          symbol: String(r.symbol), horizon: String(r.horizon), count: Number(r.n),
        })),
        products: (productRows as unknown as Array<{ product: string; n: number }>).map((r) => ({
          product: String(r.product), count: Number(r.n),
        })),
      },
      wordcloud: { words: countWords(texts, 120) },
      observedAt: new Date().toISOString(),
    }
  })
}
