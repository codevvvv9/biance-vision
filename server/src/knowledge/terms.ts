/**
 * Brooks 术语词表与查询归一化。
 * 对应 docs/specs/knowledge-rag.md：H2、L2、ii、ioi 等短词需要精确词项与同义词表，
 * 不能仅靠向量召回。中文按二元分词（bigram）补充词项召回。
 */

/** 术语条目：规范名 + 别名（全小写匹配） */
export interface TermEntry {
  canonical: string
  aliases: string[]
  /** 中文释义（供查询归一化与答案组织引用） */
  zh: string
}

export const BROOKS_TERMS: TermEntry[] = [
  { canonical: 'h1', aliases: ['h1', 'high 1', '高一'], zh: '多头回调中第一次上破前根高点（首次进场尝试）' },
  { canonical: 'h2', aliases: ['h2', 'high 2', '高二', '二次进场', 'second entry'], zh: '多头回调中第二次上破（二次进场）' },
  { canonical: 'h3', aliases: ['h3', 'high 3', '高三'], zh: '多头回调第三次进场尝试' },
  { canonical: 'h4', aliases: ['h4', 'high 4', '高四'], zh: '多头回调第四次进场尝试（警惕衰竭）' },
  { canonical: 'l1', aliases: ['l1', 'low 1', '低一'], zh: '空头回调中第一次跌破前根低点' },
  { canonical: 'l2', aliases: ['l2', 'low 2', '低二'], zh: '空头回调中第二次跌破（二次进场）' },
  { canonical: 'l3', aliases: ['l3', 'low 3', '低三'], zh: '空头回调第三次进场尝试' },
  { canonical: 'l4', aliases: ['l4', 'low 4', '低四'], zh: '空头回调第四次进场尝试（警惕衰竭）' },
  { canonical: 'ii', aliases: ['ii', '双内包', ' consecutive inside'], zh: '连续两根内包线（突破模式）' },
  { canonical: 'iii', aliases: ['iii', '三内包'], zh: '连续三根内包线' },
  { canonical: 'ioi', aliases: ['ioi', '内外内'], zh: '内包-外包-内包（突破模式）' },
  { canonical: 'oo', aliases: ['oo', '双外包'], zh: '连续两根外包线' },
  { canonical: 'inside_bar', aliases: ['inside bar', '内包线', '内包'], zh: '高低点被前一根完全包含' },
  { canonical: 'outside_bar', aliases: ['outside bar', '外包线', '外包'], zh: '高低点吞没前一根' },
  { canonical: 'trend_bar', aliases: ['trend bar', '趋势棒', '趋势k线'], zh: '实体占比高的方向棒' },
  { canonical: 'doji', aliases: ['doji', '十字星', '十字线'], zh: '开收盘接近的微型交易区间棒' },
  { canonical: 'spike', aliases: ['spike', '冲刺'], zh: '连续同向强趋势棒段（spike and channel 的冲刺腿）' },
  { canonical: 'channel', aliases: ['channel', '通道'], zh: '趋势中斜向推进段' },
  { canonical: 'trading_range', aliases: ['trading range', '交易区间', '震荡', '区间'], zh: '多空拉锯的无方向段' },
  { canonical: 'tight_range', aliases: ['tight trading range', 'ttr', '紧凑区间'], zh: 'K 线大幅重叠的紧凑交易区间' },
  { canonical: 'barbwire', aliases: ['barbwire', '铁丝网'], zh: '重叠+十字星的铁丝网（不交易区）' },
  { canonical: 'always_in', aliases: ['always in', 'always-in', '始终持仓方向'], zh: '若必须持仓非多即空的方向' },
  { canonical: 'mtr', aliases: ['mtr', 'major trend reversal', '主要趋势反转'], zh: '趋势线突破+测试+反转信号的反转序列' },
  { canonical: 'tlb', aliases: ['tlb', 'trend line break', '趋势线突破', '破线'], zh: '趋势线被收盘穿越（趋势减弱首信号）' },
  { canonical: 'wedge', aliases: ['wedge', '楔形', '三推'], zh: '三推反转形态' },
  { canonical: 'double_top', aliases: ['double top', '双顶'], zh: '两摆动高点近似等高' },
  { canonical: 'double_bottom', aliases: ['double bottom', '双底'], zh: '两摆动低点近似等低' },
  { canonical: 'swing_high', aliases: ['swing high', '摆动高点'], zh: '左右均有更低高点的 bar 高点' },
  { canonical: 'swing_low', aliases: ['swing low', '摆动低点'], zh: '左右均有更高低点的 bar 低点' },
  { canonical: 'leg', aliases: ['leg', '腿'], zh: '相邻摆动点之间的单向移动' },
  { canonical: 'pullback', aliases: ['pullback', '回调'], zh: '趋势中的逆向移动' },
  { canonical: 'breakout', aliases: ['breakout', '突破'], zh: '收盘越过形态/区间极值' },
  { canonical: 'breakout_test', aliases: ['breakout test', '突破测试'], zh: '突破后回测突破位' },
  { canonical: 'measured_move', aliases: ['measured move', '测量移动', 'ab=cd'], zh: '一腿约等于前一腿的等距投影' },
  { canonical: 'ema20', aliases: ['ema20', 'ema 20', '20ema', '20周期ema'], zh: '20 周期指数均线（Brooks 唯一参考指标）' },
  { canonical: 'signal_bar', aliases: ['signal bar', '信号棒'], zh: '触发前的形态棒' },
  { canonical: 'entry_bar', aliases: ['entry bar', '入场棒'], zh: '实际触发进场的棒' },
  { canonical: 'gap', aliases: ['gap', '缺口'], zh: '摆动点/均线与价格之间的空隙' },
  { canonical: 'funding_rate', aliases: ['funding rate', '资金费率'], zh: '永续合约多空双方的定期结算费率' },
  { canonical: 'open_interest', aliases: ['open interest', 'oi', '持仓量'], zh: '未平仓合约总量' },
  { canonical: 'liquidation', aliases: ['liquidation', '强平', '爆仓'], zh: '保证金不足时的强制平仓' },
  { canonical: 'mark_price', aliases: ['mark price', '标记价格'], zh: '用于强平与未实现盈亏的标记价' },
  { canonical: 'index_price', aliases: ['index price', '指数价格'], zh: '现货指数成分加权价' },
]

const ALIAS_MAP = new Map<string, string>()
for (const t of BROOKS_TERMS) for (const a of t.aliases) ALIAS_MAP.set(a.toLowerCase(), t.canonical)

/** 提取拉丁词项（含 H2/ii/ioi/ema20 等），小写化 */
export function extractLatinTokens(text: string): string[] {
  const m = text.toLowerCase().match(/[a-z][a-z0-9._-]{0,19}/g)
  return m ? [...new Set(m)] : []
}

/** 中文二元分词（CJK bigram），供词项召回 */
export function extractCjkBigrams(text: string): string[] {
  const out: string[] = []
  const runs = text.match(/[一-鿿]+/g) ?? []
  for (const run of runs) {
    if (run.length === 1) out.push(run)
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return [...new Set(out)]
}

/** 查询归一化：拉丁词项经别名表映射为规范术语；中文别名命中时补充规范术语 */
export function normalizeQueryTerms(text: string): { terms: string[]; matchedTerms: string[] } {
  const latin = extractLatinTokens(text)
  const canonical = new Set<string>()
  const matched = new Set<string>()
  for (const tok of latin) {
    const hit = ALIAS_MAP.get(tok)
    if (hit) {
      canonical.add(hit)
      matched.add(hit)
    } else {
      canonical.add(tok)
    }
  }
  // 中文别名（如「二次进场」「铁丝网」）整体匹配
  const lower = text.toLowerCase()
  for (const entry of BROOKS_TERMS) {
    for (const alias of entry.aliases) {
      if (/[一-鿿]/.test(alias) && text.includes(alias)) {
        canonical.add(entry.canonical)
        matched.add(entry.canonical)
      }
    }
    void lower
  }
  return { terms: [...canonical], matchedTerms: [...matched] }
}

/** 文档侧词项提取：拉丁规范词项 + CJK bigram + 命中的规范术语 */
export function extractDocTerms(text: string): string[] {
  const { terms } = normalizeQueryTerms(text)
  return [...new Set([...terms, ...extractCjkBigrams(text)])]
}
