/**
 * 反证输出解析与证据绑定（P0-3，vertical-agent-architecture.md §6 P0-3 / §3.2.7-A）：
 * LLM 反证归纳输出若干行声明，每行绑定其引用的反证证据（evidence_items 行）。
 *
 * 绑定策略（与 counter-reviewer 模板约定配套）：
 * 1. 模板要求每行末尾 [k] 证据编号（无合适证据标 [0]）——标记全部有效 → 'cited'
 *    精确绑定对应证据（可多条）；部分越界只用有效部分；
 * 2. 显式 [0]/全部越界 = 模型明确「不引用」→ 空绑定（不补绑，不误计有效反证）；
 * 3. 完全无标记 → 锚定词项回退：行文本与证据文本的词项重叠
 * （CJK bigram + 拉丁词项，同 queryRewrite 反漂移口径）取至多 2 条 → 'anchored'；
 * 4. 无任何重叠 → evidenceIds=[]（不误绑；调用方记录「未绑定」标注）。
 * 评测（scripts/eval-conversations.ts citation_support）钉住行为：基线的 legacy
 * 实现（统一前两条）已被替换，b1/b2 用例自此转 PASS。
 */
import { extractCjkBigrams, extractLatinTokens } from '../../knowledge/terms.js'

/** 反证证据行的最小形状（来自 evidence_items；id/text 参与 [k] 标记与锚定回退） */
export interface CounterEvidenceRow {
  id: string
  text: string
}

/**
 * 剥离行尾 [k] 证据标记：`理由文本 [1][3]` → { text: '理由文本', refs: [1,3] }。
 * 标记必须出现在行尾（允许 [0] 表示无合适证据）；行中出现的 [k] 不视为引用标记。
 * LLM 常在标记后再补句读（e2e 实测「……基础数据 [1][3]。」）：标记与句末标点并存时
 * 标记照常剥离、原句标点保留在净文本末尾——否则标记残留入库且精确绑定退化为锚定回退。
 */
export function stripCiteMarkers(line: string): { text: string; refs: number[] } {
  const refs: number[] = []
  let rest = line.trimEnd()
  let trailingPunct = ''
  for (;;) {
    const m = rest.match(/\s*\[(\d{1,2})\]([。．.！!？?；;]?)$/)
    if (m === null) break
    refs.unshift(Number(m[1]))
    if (trailingPunct === '' && m[2] !== '') trailingPunct = m[2]
    rest = rest.slice(0, m.index).trimEnd()
  }
  return { text: (rest + trailingPunct).trim(), refs }
}

/** 词项集合（锚定回退的匹配口径，与 queryRewrite.sharesAnchor 同源） */
function termsOf(text: string): Set<string> {
  return new Set([...extractLatinTokens(text.toLowerCase()), ...extractCjkBigrams(text)])
}

export type BindMode = 'cited' | 'anchored' | 'legacy'
export function bindCounterEvidence(line: string, rows: CounterEvidenceRow[]): { evidenceIds: string[]; mode: BindMode } {
  const { refs } = stripCiteMarkers(line)
  // 1) 行尾标记绑定：编号全部有效（1..rows.length；[0]=无合适证据 → 视为无标记走回退）
  const validRefs = refs.filter((k) => k >= 1 && k <= rows.length)
  if (refs.length > 0 && validRefs.length === refs.length) {
    return { evidenceIds: [...new Set(validRefs)].sort((a, b) => a - b).map((k) => rows[k - 1].id), mode: 'cited' }
  }
  if (refs.length > 0 && validRefs.length !== refs.length && validRefs.length > 0) {
    // 部分越界：只用有效部分（越界编号丢弃，不因格式缺陷整体误绑）
    return { evidenceIds: [...new Set(validRefs)].sort((a, b) => a - b).map((k) => rows[k - 1].id), mode: 'cited' }
  }
  // 2026-10-19 审查修正（P2）：显式标记（含 [0]=无合适证据、全部越界）是模型的明确
  // 「不引用」表态——保持空绑定，禁止词项重叠补绑（曾把「突破已经失效 [0]」补绑到
  // 「突破尚未失效」的证据并计入有效反证数量）；只有完全无标记才走锚定回退。
  if (refs.length > 0) return { evidenceIds: [], mode: 'cited' }
  // 2) 锚定词项回退：无标记 → 与证据文本词项重叠最多的至多 2 条
  const lineTerms = termsOf(stripCiteMarkers(line).text)
  if (lineTerms.size === 0) return { evidenceIds: [], mode: 'anchored' }
  const scored = rows
    .map((r) => {
      let overlap = 0
      for (const t of termsOf(r.text)) if (lineTerms.has(t)) overlap++
      return { id: r.id, overlap }
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
  if (scored.length === 0) return { evidenceIds: [], mode: 'anchored' }
  return { evidenceIds: scored.slice(0, 2).map((s) => s.id), mode: 'anchored' }
}
