/**
 * 错误文案单点翻译自测（pnpm errors:selftest）——钉住 apiErrorMessage 四级兜底链：
 *   E1 错误码命中 errors 词典：英文界面出英文（不得含 CJK，线上事故回归钉）
 *   E2 同码切 zh-CN 出中文词典文案（中文环境 UX 不变）
 *   E3 未登记码 + 无 _status 分组 → 回退原始 message（过渡期兜底）
 *   E4 无码但 status 有分组（503）→ 出 _status.503 文案而非内部 message
 *   E5 非 ApiError 的普通 Error → 原样 message
 *   E6 空信息 → common:api.requestFailed 最终兜底非空
 *   E7 en-US errors 词典全文无 CJK（英文文案防串中文，词典层钉死）
 * 环境注记：i18next-browser-languagedetector 在 Node 无 localStorage——先装桩
 * 再动态 import（i18n init 是模块加载副作用，必须晚于桩生效）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CJK = /[\u4e00-\u9fff]/

let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
  if (!ok) failed++
}

async function main(): Promise<void> {
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => 'en-US',
    setItem: () => {},
    removeItem: () => {},
  }
  // i18n 模块加载副作用会写 document.documentElement.lang（浏览器语义），Node 下装最小桩
  ;(globalThis as { document?: unknown }).document = { documentElement: { lang: '' } }
  // 经变量路径动态 import：字面量说明符会让根 tsconfig（NodeNext/无 DOM）追进
  // 浏览器侧 shared-ui 编译图报 TS1543/TS2584；本脚本断言在运行时，类型让位
  const load = (rel: string): Promise<Record<string, unknown>> =>
    import(path.join(__dirname, '../packages/shared-ui/src', rel)) as Promise<Record<string, unknown>>
  const i18nMod = (await load('i18n/index.js')) as unknown as {
    default: { changeLanguage(l: string): Promise<void>; language: string }
  }
  const i18n = i18nMod.default
  const { ApiError } = (await load('api.js')) as unknown as {
    ApiError: new (init: { status: number; message: string; code?: string }) => Error & { code: string | null }
  }
  const { apiErrorMessage } = (await load('errors.js')) as unknown as { apiErrorMessage: (err: unknown) => string }
  await Promise.resolve()
  // detector 的 localStorage 通道依赖 window，Node 下被跳过（落到 fallback zh-CN）——
  // 显式切语言，等价于 UI LanguageSwitcher 写入 app-lang 后的终态
  await i18n.changeLanguage('en-US')

  const credErr = new ApiError({ status: 401, message: '用户名或密码错误', code: 'invalid_credentials' })
  const en = apiErrorMessage(credErr)
  check('E1 英文环境 invalid_credentials 出英文', en, 'Incorrect username or password')
  check('E1b 英文文案不含 CJK', CJK.test(en), false)

  await i18n.changeLanguage('zh-CN')
  check('E2 中文环境同码出词典中文', apiErrorMessage(credErr), '用户名或密码错误')

  check(
    'E3 未登记码回退原始 message',
    apiErrorMessage(new ApiError({ status: 418, code: 'unregistered_code', message: '原始信息' })),
    '原始信息',
  )
  check(
    'E4 无码 503 走 _status 分组',
    apiErrorMessage(new ApiError({ status: 503, message: 'Internal Server Error' })),
    '服务暂时不可用，请稍后重试',
  )
  check('E5 普通 Error 原样透传', apiErrorMessage(new Error('network down')), 'network down')
  check('E6 空信息最终兜底非空', apiErrorMessage(new Error('')) !== '', true)

  const enErrors = JSON.parse(
    readFileSync(path.join(__dirname, '../packages/shared-ui/src/locales/en-US/errors.json'), 'utf8'),
  ) as Record<string, unknown>
  const cjkHits: string[] = []
  for (const [k, v] of Object.entries(enErrors)) {
    if (typeof v === 'string' && CJK.test(v)) cjkHits.push(k)
    else if (v !== null && typeof v === 'object')
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>))
        if (typeof v2 === 'string' && CJK.test(v2)) cjkHits.push(`${k}.${k2}`)
  }
  check('E7 en-US errors 词典全文无 CJK', cjkHits.join(','), '')

  await i18n.changeLanguage('en-US')
  if (failed > 0) {
    console.error(`error-i18n-selftest: ${failed} 项失败`)
    process.exit(1)
  }
  console.log('error-i18n-selftest: 全部通过')
}

void main()
