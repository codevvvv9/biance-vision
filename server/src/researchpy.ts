/**
 * research-py（FastAPI，固定任务端点）HTTP 客户端。
 * 对应 docs/specs/architecture.md：Python worker 只暴露 /health、/tasks/parse-document、
 * /tasks/train、/tasks/predict、/tasks/calibration-report，不提供任意代码执行入口。
 * 服务不可达/超时/非 2xx 统一抛 ResearchPyError（调用方决定重试或置 failed）。
 */
import { log } from './logger.js'
import { kv } from './logger.js'

export const RESEARCH_PY_URL = (process.env.RESEARCH_PY_URL ?? 'http://127.0.0.1:8100').replace(/\/+$/, '')

export class ResearchPyError extends Error {
  constructor(
    message: string,
    /** service_down（连不上/超时）| bad_request | remote_error */
    readonly kind: 'service_down' | 'bad_request' | 'remote_error',
  ) {
    super(message)
    this.name = 'ResearchPyError'
  }
}

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${RESEARCH_PY_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new ResearchPyError(`research-py 不可达：${(err as Error).message}`, 'service_down')
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500)
    throw new ResearchPyError(
      `research-py ${path} → ${res.status}：${text}`,
      res.status === 422 || res.status === 400 ? 'bad_request' : 'remote_error',
    )
  }
  return (await res.json()) as T
}

// ---- /tasks/parse-document（Docling；对齐 research-py/app/schemas.py） ----

export interface PyParseBlock {
  kind: 'text' | 'figure' | 'table' | 'heading'
  text?: string | null
  pageNo?: number | null
  figureId?: string | null
  bbox?: number[] | null
  /** heading 层级（1-6）：W1-B 缺口 A 修复后由 docling label 映射产出 */
  level?: number | null
}

export interface PyParseResponse {
  docId: string
  status: 'ok' | 'failed'
  error?: string | null
  blocks: PyParseBlock[]
  pageCount?: number | null
}

export function parseDocument(
  input: { docId: string; fileName: string; contentBase64?: string; fetchUrl?: string },
  timeoutMs = 120_000,
): Promise<PyParseResponse> {
  return call('/tasks/parse-document', input, timeoutMs)
}

// ---- /tasks/parse-document-async + parse-status + parse-cancel（W1-B 异步任务化） ----

export interface PyParseEvent {
  seq: number
  stage: string
  message?: string | null
  atMs: number
  durationMs?: number | null
}

export interface PyParseTaskSnapshot {
  taskId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  stage?: string | null
  pageNo?: number | null
  totalPages?: number | null
  error?: string | null
  events: PyParseEvent[]
  blocks?: PyParseBlock[] | null
  pageCount?: number | null
}

/** 提交一批异步解析（20 页/批；立即返回，进度经 parseStatus 轮询）。
 * 超时 90s：每批都携带完整 base64 文档内容（2-3MB JSON），Python 高内存时
 * GC/接收缓冲使 30s 不够（v0.11.0 Brooks 验收实测超时根因） */
export function submitParseBatch(
  input: { taskId: string; docId: string; fileName: string; contentBase64: string; pageFrom?: number; pageTo?: number },
  timeoutMs = 90_000,
): Promise<PyParseTaskSnapshot> {
  return call('/tasks/parse-document-async', input, timeoutMs)
}

async function getRaw<T>(path: string, timeoutMs: number): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${RESEARCH_PY_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new ResearchPyError(`research-py 不可达：${(err as Error).message}`, 'service_down')
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500)
    throw new ResearchPyError(`research-py ${path} → ${res.status}：${text}`, 'remote_error')
  }
  return (await res.json()) as T
}

/** 轮询任务状态；completed 且 includeBlocks=true 时返回 blocks */
export function parseStatus(taskId: string, includeBlocks = false, timeoutMs = 10_000): Promise<PyParseTaskSnapshot> {
  return getRaw(`/tasks/parse-status/${encodeURIComponent(taskId)}${includeBlocks ? '?includeBlocks=true' : ''}`, timeoutMs)
}

/** 协作取消（批间生效；白跑上限=一个在飞批次） */
export function cancelParse(taskId: string, timeoutMs = 10_000): Promise<PyParseTaskSnapshot> {
  return call(`/tasks/parse-cancel/${encodeURIComponent(taskId)}`, {}, timeoutMs)
}

// ---- /tasks/inspect（R2 预检：扫描版/数字版路由判定）----

export interface PdfInspectResult {
  pageCount: number
  encrypted: boolean
  textCharRatio: number
  emptyPageCount: number
}

/** PDF 预检：文本层覆盖率（<0.3 = 扫描版需走 OCR 路由） */
export function inspectPdf(contentBase64: string, timeoutMs = 15_000): Promise<PdfInspectResult> {
  return call('/tasks/inspect', { contentBase64 }, timeoutMs)
}

// ---- /tasks/parse-mineru（R2 双引擎备选：扫描版/复杂版面）----

export interface MineruParseResponse {
  docId: string
  status: 'ok' | 'failed'
  error?: string | null
  blocks: PyParseBlock[]
  pageCount?: number | null
}

/** MinerU 解析（内置 OCR；比 docling+RapidOCR 对扫描版更强） */
export function parseMineru(
  input: { docId: string; fileName: string; contentBase64: string },
  timeoutMs = 600_000,
): Promise<MineruParseResponse> {
  return call('/tasks/parse-mineru', input, timeoutMs)
}

/** research-py health 中的引擎可用性 */
export async function engineAvailability(): Promise<{ docling: boolean; mineru: boolean }> {
  try {
    const res = await fetch(`${RESEARCH_PY_URL}/health`, { signal: AbortSignal.timeout(5000) })
    const data = (await res.json()) as { docling?: boolean; mineru?: boolean }
    return { docling: data.docling === true, mineru: data.mineru === true }
  } catch {
    return { docling: false, mineru: false }
  }
}

// ---- /tasks/predict（分位 GBM 推理）与 /tasks/train（训练） ----

export interface PyPredictOut {
  quantiles: Record<string, number>
  /** isotonic 重映射后的分位网格（level→预测值）：概率内插（EV/三分支/方向）必须用它 */
  calibratedQuantiles?: Record<string, number>
  probabilityUp: number
  degenerate?: boolean
}

export interface PyPredictResponse {
  modelVersion: string
  featureNames: string[]
  predictions: PyPredictOut[]
  warnings: string[]
  /** 工件绑定的校准映射元数据（null = 工件无 calibrator，不得发布） */
  calibration?: { kind: string; calRows: number } | null
}

export interface PyTrainRow {
  features: Record<string, number>
  labelReturn: number
  split: 'dev' | 'calibration' | 'test'
}

export interface PyTrainResponse {
  modelVersion: string
  artifactPath: string
  metrics: {
    splits: Record<string, {
      coverage: Record<string, number>
      probabilityUp: { brier: number | null; sampleSize: number } | null
      sampleSize: number
    }>
    sampleSize: Record<string, number>
  }
  featureNames: string[]
  trainedRows: number
  calibrationReport: { brier: number | null; sampleSize: number }
  /** isotonic 校准映射是否已拟合并随工件持久化（false = 不得进入 candidate） */
  calibrated?: boolean
  calibrationRows?: number
}

export function predict(
  input: { modelVersion: string; rows: { features: Record<string, number> }[] },
  timeoutMs = 30_000,
): Promise<PyPredictResponse> {
  return call('/tasks/predict', input, timeoutMs)
}

/** 训练（时间切分由 Node 侧给定；服务只按 split 标签训练，不自行再切分） */
export function train(
  input: {
    modelVersion: string
    horizon: string
    featureVersion: string
    rows: PyTrainRow[]
    quantiles?: number[]
  },
  timeoutMs = 600_000,
): Promise<PyTrainResponse> {
  return call('/tasks/train', input, timeoutMs)
}

/** 健康探测：false = 服务未启动（解析走原生通道的文档不受影响） */
export async function researchPyHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${RESEARCH_PY_URL}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

// ---- /tasks/translate（Argos 离线翻译；Part 2 翻译 Agent 的兜底引擎） ----

export interface PyTranslateResponse {
  status: 'ok' | 'failed'
  /** 失败原因码：package_missing = 语言对离线包未下载；unsupported = 语言不在 Argos 支持集 */
  error?: 'package_missing' | 'unsupported' | string | null
  text?: string | null
  /** sourceLang='auto' 时的检测结果 */
  detectedLang?: string | null
}

/**
 * Argos 离线翻译（zh↔en；语言包缺失抛 ResearchPyError('remote_error') 且
 * 错误信息含 package_missing，由调用方降级）。翻译文本量小，30s 超时足够。
 */
export function translateViaArgos(text: string, sourceLang: string, targetLang: string, timeoutMs = 30_000): Promise<string> {
  return call<PyTranslateResponse>('/tasks/translate', { text, sourceLang, targetLang }, timeoutMs).then((r) => {
    if (r.status !== 'ok' || r.text === null || r.text === undefined) {
      throw new ResearchPyError(
        `research-py /tasks/translate → ${r.error ?? 'failed'}`,
        r.error === 'package_missing' || r.error === 'unsupported' ? 'bad_request' : 'remote_error',
      )
    }
    return r.text
  })
}

export function logResearchPyDown(context: string, err: unknown): void {
  log.warn('researchpy', `${context} 失败（research-py 服务未启动或超时）`, kv({ 错误: (err as Error).message }))
}
