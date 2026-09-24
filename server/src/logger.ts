// ---------------------------------------------------------------------------
// 统一日志：时间戳 + 级别图标 + ANSI 颜色
//
//   ok      ✔ 绿    成功/里程碑事件（连接建立、服务启动、数据加载）
//   info    ℹ 青    常规事件（客户端连接、订阅变化）
//   warn    ⚠ 黄    异常但已自动处理（降级、重试、写入失败）
//   error   ✖ 红    需要人介入的错误
//
// 输出示例：[2026-09-24 15:40:12] ✔ [binance] stream connected: wss://...
// 设 NO_COLOR=1 关闭颜色（纯文本环境）；error 级别附带错误堆栈。
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const MAGENTA = '\x1b[35m'

interface LevelStyle {
  icon: string
  color: string
  stream: 'log' | 'warn' | 'error'
}

const LEVELS: Record<string, LevelStyle> = {
  ok: { icon: '✔', color: '\x1b[32m', stream: 'log' },
  info: { icon: 'ℹ', color: '\x1b[36m', stream: 'log' },
  warn: { icon: '⚠', color: '\x1b[33m', stream: 'warn' },
  error: { icon: '✖', color: '\x1b[31m', stream: 'error' },
}

const colored = process.env.NO_COLOR !== '1'

function timestamp(): string {
  const d = new Date()
  const p = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Error → message（error 级别带堆栈）；对象/数组 → JSON；其余 → String */
function fmt(value: unknown, withStack: boolean): string {
  if (value instanceof Error) {
    return withStack && value.stack ? value.stack : value.message
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function emit(level: keyof typeof LEVELS, tag: string, parts: unknown[]): void {
  const style = LEVELS[level]
  const body = parts.map((p) => fmt(p, level === 'error')).join(' ')
  const head = colored
    ? `${DIM}[${timestamp()}]${RESET} ${style.color}${style.icon}${RESET} ${MAGENTA}[${tag}]${RESET}`
    : `[${timestamp()}] ${style.icon} [${tag}]`
  console[style.stream](head === '' ? body : `${head} ${body}`)
}

export const log = {
  ok: (tag: string, ...parts: unknown[]): void => emit('ok', tag, parts),
  info: (tag: string, ...parts: unknown[]): void => emit('info', tag, parts),
  warn: (tag: string, ...parts: unknown[]): void => emit('warn', tag, parts),
  error: (tag: string, ...parts: unknown[]): void => emit('error', tag, parts),
}
