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
  kind: 'text' | 'figure' | 'table'
  text?: string | null
  pageNo?: number | null
  figureId?: string | null
  bbox?: number[] | null
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
