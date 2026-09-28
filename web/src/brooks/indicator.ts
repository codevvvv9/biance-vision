/**
 * klinecharts 自定义指标「BROOKS」：在主图蜡烛之上绘制 Brooks 结构标注。
 * - 顶部状态条：市场状态分段着色（冲刺/通道/震荡/铁丝网）
 * - EMA20 参考线（Brooks 判趋势的核心基准）
 * - zigzag 腿连线 + 摆动点标签（HH/HL/LH/LL）
 * - 内包/外包标记（i / O / ii / oo / ioi）
 * - 信号三角标 + 短标签（H2、楔顶、MTR…）
 * - 右上角 Always In 方向水印
 * 分析结果通过 extendData 注入；只绘制可见范围附近，千根K线无压力。
 */

import { registerIndicator } from 'klinecharts'
import type { Axis, VisibleRange } from 'klinecharts'
import type { BrooksAnalysis, BrooksDisplay, RegimeType } from 'biance-vision-brooks'

export interface BrooksExtendData {
  analysis: BrooksAnalysis | null
  display: BrooksDisplay
  upColor: 'green' | 'red'
}

const C = {
  cyan: '#00e5ff',
  amber: '#ffb020',
  purple: '#7c5cff',
  gray: '#8ea0c2',
  dim: '#5a6b8c',
}

const REGIME_STRIP: Record<RegimeType, string> = {
  spike_bull: 'rgba(0,214,143,.75)',
  channel_bull: 'rgba(0,214,143,.22)',
  spike_bear: 'rgba(255,77,106,.75)',
  channel_bear: 'rgba(255,77,106,.22)',
  trading_range: 'rgba(255,176,32,.28)',
  tight_range: 'rgba(124,92,255,.4)',
  barbwire: 'rgba(124,92,255,.75)',
}

const FONT = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
const FONT_BOLD = 'bold 10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'

function drawBrooks(
  ctx: CanvasRenderingContext2D,
  barCount: number,
  ext: BrooksExtendData,
  visibleRange: VisibleRange,
  width: number,
  xAxis: Axis,
  yAxis: Axis,
): void {
  const a = ext.analysis
  if (!a) return
  const d = ext.display
  const up = ext.upColor === 'red' ? '#ff4d6a' : '#00d68f'
  const down = ext.upColor === 'red' ? '#00d68f' : '#ff4d6a'
  const from = Math.max(0, visibleRange.from - 80)
  const to = Math.min(barCount - 1, visibleRange.to + 80)
  const x = (i: number): number => xAxis.convertToPixel(i)
  const y = (p: number): number => yAxis.convertToPixel(p)

  // ── 顶部市场状态条 ────────────────────────────────────────────
  if (d.regime) {
    for (const seg of a.regimes) {
      if (seg.to < from || seg.from > to) continue
      const x1 = x(seg.from)
      const x2 = x(seg.to)
      if (x2 - x1 < 2) continue
      ctx.fillStyle = REGIME_STRIP[seg.type]
      ctx.fillRect(x1, 0, x2 - x1, 4)
    }
  }

  // ── EMA20 ────────────────────────────────────────────────────
  if (d.ema) {
    ctx.save()
    ctx.strokeStyle = 'rgba(0,229,255,.55)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    let started = false
    for (let i = from; i <= to; i++) {
      const v = a.ema20[i]
      if (!Number.isFinite(v)) continue
      const px = x(i)
      const py = y(v)
      if (!started) {
        ctx.moveTo(px, py)
        started = true
      } else ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.restore()
  }

  // ── zigzag 腿连线 ────────────────────────────────────────────
  if (d.legs) {
    ctx.save()
    ctx.lineWidth = 1.4
    for (const leg of a.legs) {
      if (leg.toIndex < from || leg.fromIndex > to) continue
      ctx.strokeStyle = leg.direction === 'up' ? 'rgba(0,214,143,.55)' : 'rgba(255,77,106,.55)'
      ctx.beginPath()
      ctx.moveTo(x(leg.fromIndex), y(leg.fromPrice))
      ctx.lineTo(x(leg.toIndex), y(leg.toPrice))
      ctx.stroke()
    }
    // 最后一根摆动点 → 最新收盘的虚线延伸（未确认的腿）
    // 注意：图表数据可能比分析数据多一根实时未收盘K线，一律以分析数组自身长度为准
    const zig = a.legs.length > 0 ? a.legs[a.legs.length - 1] : null
    const lastAnalysis = a.bars.length - 1
    if (zig && lastAnalysis >= 0 && to >= lastAnalysis) {
      const lastBar = a.bars[lastAnalysis]
      ctx.strokeStyle = 'rgba(138,160,194,.4)'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x(zig.toIndex), y(zig.toPrice))
      ctx.lineTo(x(lastAnalysis), y(lastBar.close))
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }

  // ── 摆动点标签 HH/HL/LH/LL ───────────────────────────────────
  if (d.swings) {
    ctx.save()
    ctx.font = 'bold 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.lineJoin = 'round'
    for (const s of a.swings) {
      if (s.index < from || s.index > to || s.label === '') continue
      const px = x(s.index)
      const py = s.kind === 'high' ? y(s.price) - 15 : y(s.price) + 20
      const bullish = s.label === 'HH' || s.label === 'HL'
      ctx.strokeStyle = 'rgba(6, 12, 26, 0.85)'
      ctx.lineWidth = 3
      ctx.strokeText(s.label, px, py)
      ctx.fillStyle = bullish ? up : down
      ctx.fillText(s.label, px, py)
    }
    ctx.restore()
  }

  // ── 内包/外包标记 ────────────────────────────────────────────
  if (d.io) {
    ctx.save()
    ctx.font = FONT
    ctx.textAlign = 'center'
    for (let i = from; i <= to; i++) {
      const f = a.features[i]
      if (!f) continue
      let tag = ''
      if (f.isIII) tag = 'iii'
      else if (f.isII) tag = 'ii'
      else if (f.isOO) tag = 'oo'
      else if (f.isIOI) tag = 'ioi'
      else if (f.isOutside) tag = 'O'
      else if (f.isInside) tag = 'i'
      if (tag === '') continue
      ctx.strokeStyle = 'rgba(6, 12, 26, 0.8)'
      ctx.lineWidth = 2.5
      ctx.strokeText(tag, x(i), y(f.high) - 5)
      ctx.fillStyle = f.isII || f.isOO ? C.amber : C.dim
      ctx.fillText(tag, x(i), y(f.high) - 5)
    }
    ctx.restore()
  }

  // ── 信号三角标 + 标签 ────────────────────────────────────────
  if (d.signals) {
    ctx.save()
    for (const s of a.signals) {
      if (s.index < from || s.index > to) continue
      const bar = a.bars[s.index]
      if (!bar) continue
      const px = x(s.index)
      const col = s.direction === 'bull' ? up : s.direction === 'bear' ? down : C.amber
      ctx.fillStyle = col
      ctx.strokeStyle = col
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.lineJoin = 'round'
      if (s.direction === 'bull') {
        const py = y(bar.low) + 10
        ctx.moveTo(px, py - 6)
        ctx.lineTo(px - 5.5, py + 3)
        ctx.lineTo(px + 5.5, py + 3)
        ctx.closePath()
        ctx.fill()
        ctx.font = 'bold 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.strokeStyle = 'rgba(6, 12, 26, 0.85)'
        ctx.lineWidth = 3
        ctx.strokeText(s.label, px, py + 15)
        ctx.fillStyle = col
        ctx.fillText(s.label, px, py + 15)
      } else if (s.direction === 'bear') {
        const py = y(bar.high) - 10
        ctx.moveTo(px, py + 6)
        ctx.lineTo(px - 5.5, py - 3)
        ctx.lineTo(px + 5.5, py - 3)
        ctx.closePath()
        ctx.fill()
        ctx.font = 'bold 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.strokeStyle = 'rgba(6, 12, 26, 0.85)'
        ctx.lineWidth = 3
        ctx.strokeText(s.label, px, py - 8)
        ctx.fillStyle = col
        ctx.fillText(s.label, px, py - 8)
      } else {
        ctx.arc(px, y(bar.high) - 10, 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  // ── Always In 水印 ───────────────────────────────────────────
  const ai = a.alwaysIn
  if (ai.direction !== 'neutral') {
    ctx.save()
    ctx.font = FONT_BOLD
    ctx.textAlign = 'right'
    ctx.fillStyle = ai.direction === 'bull' ? up : down
    ctx.globalAlpha = 0.9
    ctx.fillText(
      `Always In：${ai.direction === 'bull' ? '多头' : '空头'}（第 ${ai.sinceIndex + 1} 根起）`,
      width - 10,
      18,
    )
    ctx.restore()
  }
}

let registered = false

/** 注册 BROOKS 自定义指标（幂等） */
export function ensureBrooksIndicator(): void {
  if (registered) return
  registered = true
  registerIndicator({
    name: 'BROOKS',
    shortName: 'Brooks 结构',
    calc: (dataList) => dataList.map(() => ({})),
    draw: ({ ctx, kLineDataList, indicator, visibleRange, bounding, xAxis, yAxis }) => {
      const ext = indicator.extendData as BrooksExtendData | undefined
      if (!ext || !ext.analysis) return false
      drawBrooks(ctx, kLineDataList.length, ext, visibleRange, bounding.width, xAxis, yAxis)
      return false
    },
  })
}
