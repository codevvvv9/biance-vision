/**
 * 能力配置的命令行引导脚本（可选）：把端点写入 app_settings.agent_capabilities。
 * ⚠️ 配置里不要出现真实端点/密钥——仓库不保存任何环境特定值；
 *    正式入口是超管登录后的「Agent 配置域」页面（/admin/agents → 能力配置）。
 *
 * 用法（端点从环境变量读，不落文件）：
 *   EMBEDDING_BASE_URL=http://host:port/v1 EMBEDDING_MODEL=xxx [EMBEDDING_DIMS=4096] \
 *   [RERANK_BASE_URL=http://host:port/v1 RERANK_MODEL=xxx] pnpm tsx scripts/config-capabilities.ts
 */
import { initDb } from '../server/src/db.js'
import { getCapabilities, saveCapabilities } from '../server/src/admin/capabilities.js'

const ok = await initDb()
if (!ok) {
  console.error('PostgreSQL 不可用')
  process.exit(1)
}
const caps = getCapabilities()
const embedding = process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_MODEL
  ? {
      provider: 'openai-compatible',
      baseUrl: process.env.EMBEDDING_BASE_URL,
      model: process.env.EMBEDDING_MODEL,
      ...(process.env.EMBEDDING_DIMS ? { dims: Number(process.env.EMBEDDING_DIMS) } : {}),
      enabled: true,
    }
  : null
const rerank = process.env.RERANK_BASE_URL && process.env.RERANK_MODEL
  ? { provider: 'openai-compatible', baseUrl: process.env.RERANK_BASE_URL, model: process.env.RERANK_MODEL, enabled: true }
  : null
if (!embedding && !rerank) {
  console.error('未提供任何配置（EMBEDDING_BASE_URL/EMBEDDING_MODEL 或 RERANK_BASE_URL/RERANK_MODEL）。日常配置请用 /admin/agents 页面。')
  process.exit(1)
}
const updated = await saveCapabilities({
  ...caps,
  ...(embedding ? { embedding } : {}),
  ...(rerank ? { rerank } : {}),
})
console.log('已保存能力配置：', Object.entries(updated).filter(([, v]) => typeof v === 'object' && v !== null && 'enabled' in v).map(([k, v]) => `${k}=${(v as { enabled: boolean }).enabled ? 'on' : '待配置'}`).join(' '))
process.exit(0)
