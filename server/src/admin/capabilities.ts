/**
 * 能力配置（docs/specs/admin-security.md）：chat / embedding / rerank / vision / search
 * 五类，密钥只存 server/data/secrets.json（配置中仅出现引用名）。
 * 首版持久化在 app_settings（key=agent_capabilities）；Agent 版本表落地后
 * 由版本配置覆盖此处全局默认，读取接口不变（OCP）。
 * 开发便利：环境变量 EMBEDDING_BASE_URL/EMBEDDING_MODEL（及 *_API_KEY）可直接注入 embedding 能力。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { AgentCapabilitiesSchema } from 'biance-vision-brooks'
import type { AgentCapabilities, CapabilityConfig } from 'biance-vision-brooks'
import { appSettings } from '../models.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SECRETS_FILE = path.join(__dirname, '..', 'data', 'secrets.json')

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  chat: { enabled: false },
  embedding: { enabled: false },
  rerank: { enabled: false },
  vision: { enabled: false },
  search: { enabled: false },
}

/** secrets.json：引用名 → 密钥；缺失/不可读返回空表（能力显示待配置，不抛错） */
export function readSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** 按引用名取密钥：先 secrets.json，再环境变量 `<REF大写>_API_KEY` */
export function resolveSecret(ref: string | undefined): string | null {
  if (!ref) return null
  const fromFile = readSecrets()[ref]
  if (fromFile) return fromFile
  const fromEnv = process.env[`${ref.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`]
  return fromEnv ?? null
}

/** 环境变量注入的 embedding 开发配置 */
function envEmbedding(): CapabilityConfig | null {
  const baseUrl = process.env.EMBEDDING_BASE_URL
  const model = process.env.EMBEDDING_MODEL
  if (!baseUrl || !model) return null
  return {
    provider: process.env.EMBEDDING_PROVIDER ?? 'openai-compatible',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    secretRef: process.env.EMBEDDING_SECRET_REF ?? 'embedding',
    enabled: true,
  }
}

function withEnvFallback(caps: AgentCapabilities): AgentCapabilities {
  const envEmb = envEmbedding()
  if (envEmb && !caps.embedding.enabled) return { ...caps, embedding: envEmb }
  return caps
}

let cached: AgentCapabilities | null = null

/** 当前生效能力（同步读缓存；缓存未建立时先用默认+环境变量，并异步补读一次库） */
export function getCapabilities(): AgentCapabilities {
  if (cached) return cached
  void refreshCapabilities().catch(() => {})
  return withEnvFallback(DEFAULT_CAPABILITIES)
}

/**
 * 能力解析链（admin-security.md）：当前发布 Agent 版本的 config.capabilities
 * > app_settings（agent_capabilities，草稿期/无版本时的全局配置）> 环境变量注入（开发）> 全部待配置。
 */
export async function refreshCapabilities(): Promise<void> {
  const db = getDb()
  if (!db) return
  try {
    const { currentAgentConfig } = await import('./agentVersions.js')
    const versionConfig = await currentAgentConfig()
    if (versionConfig !== null) {
      cached = withEnvFallback(versionConfig.config.capabilities)
      return
    }
    const rows = await db.select().from(appSettings).where(eq(appSettings.key, 'agent_capabilities'))
    cached =
      rows.length > 0
        ? withEnvFallback(AgentCapabilitiesSchema.parse(rows[0].value))
        : withEnvFallback(DEFAULT_CAPABILITIES)
  } catch (err) {
    log.warn('capabilities', '读取能力配置失败（保持默认）', kv({ 错误: (err as Error).message }))
  }
}

/** 写入能力配置（admin 路由用）；立即生效 */
export async function saveCapabilities(input: unknown): Promise<AgentCapabilities> {
  const parsed = AgentCapabilitiesSchema.parse(input)
  const db = getDb()
  if (!db) throw Object.assign(new Error('数据库不可用，无法保存能力配置'), { statusCode: 503 })
  const value = parsed as unknown as Record<string, unknown>
  await db
    .insert(appSettings)
    .values({ key: 'agent_capabilities', value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
  cached = withEnvFallback(parsed)
  log.ok(
    'capabilities',
    '能力配置已更新',
    kv({ 状态: Object.entries(parsed).map(([k, v]) => `${k}=${v.enabled ? 'on' : '待配置'}`).join(' ') }),
  )
  return parsed
}

/** 使缓存失效（测试/降级用） */
export function invalidateCapabilitiesCache(): void {
  cached = null
}
