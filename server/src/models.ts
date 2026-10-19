import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { bigint, boolean, doublePrecision, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/** 预警规则（type 对应 server/src/types.ts 的 RuleType） */
export const alertRules = pgTable('alert_rules', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  symbol: text('symbol').notNull(),
  type: text('type').notNull(),
  value: doublePrecision('value').notNull(),
  note: text('note').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  /** 边缘触发布防状态：true 时条件满足才会触发 */
  armed: boolean('armed').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** 最后修改时间（毫秒语义），用于数据库恢复后与 JSON 镜像做新旧合并 */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
})

/** 预警触发历史（保留最近 200 条，与 JSON 镜像一致） */
export const alertHistory = pgTable(
  'alert_history',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id'),
    symbol: text('symbol').notNull(),
    type: text('type'),
    value: doublePrecision('value'),
    note: text('note'),
    message: text('message').notNull(),
    price: doublePrecision('price').notNull(),
    changePct: doublePrecision('change_pct').notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('alert_history_triggered_at_idx').on(table.triggeredAt)],
)

/** 应用设置：key-value（jsonb），当前仅 webhook */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
})

/** 登录用户（role 对应 server/src/users.ts 的 UserRole；密码只存 scrypt 哈希） */
export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  /** 用户级聊天管控（jsonb，null = 不禁不限；结构对应 server/src/users.ts 的 ChatPolicy） */
  chatPolicy: jsonb('chat_policy').$type<{ disabled: boolean; dailyLimit: number | null } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
/**
 * 操作审计记录（会话聚合式）：一次登录 = 一条记录，登录后的全部操作
 * 追加在 actions JSON 里；登录失败是无会话的独立事件记录。
 * id 由应用生成，JSON 镜像与数据库共用；保留最近 AUDIT_KEEP 条。
 */
export const auditRecords = pgTable(
  'audit_records',
  {
    id: text('id').primaryKey(),
    /** 'session'：登录会话；'login_failed'：登录失败事件 */
    kind: text('kind').notNull(),
    /** 会话 token 的 sha256 前缀：重启后据此把新操作挂回原会话 */
    sessionKey: text('session_key').notNull().default(''),
    username: text('username').notNull(),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    /** 会话 = 登录时间；失败事件 = 发生时间 */
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** 会话结束时间（登出）；null = 仍在进行或未封存 */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** 会话内操作时间线（失败事件为空数组），按时间正序 */
    actions: jsonb('actions').$type<unknown[]>().notNull(),
    /** 最后活动时间：列表排序与裁剪依据 */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('audit_records_last_active_at_idx').on(table.lastActiveAt)],
)

export type AlertRuleRow = typeof alertRules.$inferSelect
export type NewAlertRuleRow = typeof alertRules.$inferInsert
export type AlertHistoryRow = typeof alertHistory.$inferSelect
export type NewAlertHistoryRow = typeof alertHistory.$inferInsert
export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
export type AuditRecordRow = typeof auditRecords.$inferSelect
export type NewAuditRecordRow = typeof auditRecords.$inferInsert

/** AI 聊天会话（按用户隔离；消息体在 ai_messages，此处存元信息） */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    title: text('title').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 最近一条消息时间：排序与裁剪依据 */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ai_conversations_username_idx').on(table.username)],
)

/** AI 聊天消息（一条 user / assistant 消息一行，属某个会话） */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (table) => [index('ai_messages_conversation_idx').on(table.conversationId)],
)

/** AI 长期记忆：一条记忆一个独立事实（用户偏好 / 背景 / 习惯），对话时注入提示词 */
export const aiMemories = pgTable(
  'ai_memories',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** preference 偏好 / fact 背景 / interest 关注 / habit 习惯 */
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ai_memories_username_idx').on(table.username)],
)

export type AiConversationRow = typeof aiConversations.$inferSelect
export type NewAiConversationRow = typeof aiConversations.$inferInsert
export type AiMessageRow = typeof aiMessages.$inferSelect
export type NewAiMessageRow = typeof aiMessages.$inferInsert
export type AiMemoryRow = typeof aiMemories.$inferSelect
export type NewAiMemoryRow = typeof aiMemories.$inferInsert

// ---------------------------------------------------------------------------
// 行情数据基础（docs/specs/market-data.md）：PostgreSQL 唯一权威，无 JSON 镜像。
// OHLCV 用 numeric 存精确十进制（读写均为十进制字符串，对齐 shared 的 CandleRow）。
// 时间维度列（open_time 等）用 bigint 存 UTC 毫秒整数。
// ---------------------------------------------------------------------------

/** 各市场/价格类型的 K 线；复合主键即幂等键，重复/乱序/修订按 revision 处理 */
export const marketCandles = pgTable(
  'market_candles',
  {
    venue: text('venue').notNull().default('binance'),
    /** spot | usdm_perp */
    marketType: text('market_type').notNull(),
    /** trade | mark | index */
    priceType: text('price_type').notNull(),
    symbol: text('symbol').notNull(),
    /** 1m/5m/15m/... 与 shared 的 Interval 对齐 */
    interval: text('interval').notNull(),
    openTime: bigint('open_time', { mode: 'number' }).notNull(),
    closeTime: bigint('close_time', { mode: 'number' }).notNull(),
    open: numeric('open').notNull(),
    high: numeric('high').notNull(),
    low: numeric('low').notNull(),
    close: numeric('close').notNull(),
    /** 指数 K 线的占位成交量归一化为 null，不得当作成交量使用 */
    volume: numeric('volume'),
    quoteVolume: numeric('quote_volume'),
    trades: integer('trades'),
    isClosed: boolean('is_closed').notNull(),
    /** 交易所事件时间；REST 采集为 null */
    eventTime: bigint('event_time', { mode: 'number' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** rest | ws | backfill */
    source: text('source').notNull(),
    revision: integer('revision').notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.venue, table.marketType, table.priceType, table.symbol, table.interval, table.openTime],
    }),
    index('market_candles_close_time_idx').on(table.symbol, table.marketType, table.priceType, table.interval, table.closeTime),
  ],
)

/** 资金费率历史（仅 usdm_perp；独立数据，不得从 OHLC 推断） */
export const marketFundingRates = pgTable(
  'market_funding_rates',
  {
    venue: text('venue').notNull().default('binance'),
    marketType: text('market_type').notNull(),
    symbol: text('symbol').notNull(),
    fundingTime: bigint('funding_time', { mode: 'number' }).notNull(),
    fundingRate: numeric('funding_rate').notNull(),
    markPrice: numeric('mark_price'),
  },
  (table) => [
    primaryKey({ columns: [table.venue, table.marketType, table.symbol, table.fundingTime] }),
  ],
)

/** 持仓量 OI 历史（仅 usdm_perp，按 period 粒度分别存储） */
export const marketOpenInterest = pgTable(
  'market_open_interest',
  {
    venue: text('venue').notNull().default('binance'),
    marketType: text('market_type').notNull(),
    symbol: text('symbol').notNull(),
    interval: text('interval').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    sumOpenInterest: numeric('sum_open_interest').notNull(),
    sumOpenInterestValue: numeric('sum_open_interest_value'),
  },
  (table) => [
    primaryKey({ columns: [table.venue, table.marketType, table.symbol, table.interval, table.timestamp] }),
  ],
)

/** 研究冻结快照：各周期 closeTime<=asOf 的最后已收盘 openTime 集合 */
export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    symbol: text('symbol').notNull(),
    marketType: text('market_type').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    /** Record<interval, { lastClosedOpenTime }>（UTC 毫秒） */
    perInterval: jsonb('per_interval').$type<Record<string, { lastClosedOpenTime: number }>>().notNull(),
    /** 实时价格时间戳，独立于闭合 K 线；取价失败为 null */
    priceAsOf: timestamp('price_as_of', { withTimezone: true }),
    /** P1：可复现输入包（K 线/资金费率/参考价/修订号）存 BlobStore 的键与内容哈希 */
    inputPackKey: text('input_pack_key'),
    inputHash: text('input_hash'),
    /** 质量检查结果：{ ok, issues: [{code, detail}] }（时间阈值是版本化工程参数） */
    quality: jsonb('quality').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('market_snapshots_symbol_idx').on(table.symbol, table.marketType, table.asOf)],
)

/** 每个采集序列的游标与状态：最后连续收盘点、缺口登记、最近错误 */
export const ingestState = pgTable(
  'ingest_state',
  {
    venue: text('venue').notNull().default('binance'),
    marketType: text('market_type').notNull(),
    priceType: text('price_type').notNull(),
    symbol: text('symbol').notNull(),
    interval: text('interval').notNull(),
    /** 最后一根已收盘 K 线的 openTime（UTC 毫秒）；未采集过为 null */
    lastClosedOpenTime: bigint('last_closed_open_time', { mode: 'number' }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }).notNull().defaultNow(),
    /** 当前登记中的缺口数量（只登记不补平盘；回填后重算） */
    gapCount: integer('gap_count').notNull().default(0),
    /** ok | error */
    status: text('status').notNull().default('ok'),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({
      columns: [table.venue, table.marketType, table.priceType, table.symbol, table.interval],
    }),
  ],
)

/**
 * Brooks 结构事件（阶段四由引擎写入，本阶段只建表）。
 * barIndices 为事件覆盖的 bar 下标集合；provisional 事件待下一根收盘确认。
 */
export const structureEvents = pgTable(
  'structure_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    snapshotId: text('snapshot_id').notNull(),
    symbol: text('symbol').notNull(),
    marketType: text('market_type').notNull(),
    interval: text('interval').notNull(),
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    /** setup | trigger | invalidation | swing | leg | regime 等 */
    kind: text('kind').notNull(),
    /** long | short | null */
    direction: text('direction'),
    atIndex: integer('at_index').notNull(),
    atTime: bigint('at_time', { mode: 'number' }).notNull(),
    knownAtIndex: integer('known_at_index'),
    knownAtTime: bigint('known_at_time', { mode: 'number' }),
    barIndices: jsonb('bar_indices').$type<number[]>().notNull(),
    provisional: boolean('provisional').notNull().default(false),
    note: text('note').notNull().default(''),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('structure_events_snapshot_idx').on(table.snapshotId),
    index('structure_events_series_idx').on(table.symbol, table.marketType, table.interval, table.atTime),
  ],
)

// ---------------------------------------------------------------------------
// 知识库（docs/specs/knowledge-rag.md）：三通道导入、状态机、发布版本、混合检索。
// 向量列 embedding(vector) 不进 drizzle 模型 —— 由迁移末尾的守卫式 DDL
// 在 pgvector 扩展可用时补建（无扩展环境自动跳过，向量召回显式禁用），
// 避免 app 连接账号（非超级用户）在建表时因缺扩展而迁移失败。
// ---------------------------------------------------------------------------

/** 知识文档：状态机 uploaded→parsing→parsed→chunked→indexed→published / failed */
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** file | url | manifest */
    sourceType: text('source_type').notNull(),
    title: text('title').notNull(),
    /** url 导入的来源地址；file 导入为 null */
    sourceUrl: text('source_url'),
    fileName: text('file_name').notNull().default(''),
    /** BlobStore 键（原始文件/抓取内容） */
    blobKey: text('blob_key'),
    /** uploaded|parsing|parsed|chunked|indexed|published|failed */
    status: text('status').notNull().default('uploaded'),
    /** official | official_derivative | community */
    sourceTier: text('source_tier').notNull().default('community'),
    /** public | purchase | member */
    access: text('access').notNull().default('public'),
    /** 已发布次数；docVersionId = `${id}#${version+1}`（工作版本），发布后即该号 */
    version: integer('version').notNull().default(0),
    /** 原始内容指纹（去重依据） */
    contentHash: text('content_hash').notNull(),
    error: text('error'),
    /** 解析/索引元信息：pageCount、parseQuality、embeddingSkipped 等 */
    parseMeta: jsonb('parse_meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('knowledge_documents_status_idx').on(table.status, table.updatedAt)],
)

/**
 * 知识切块：docVersionId 归属某个发布（或待发布工作）版本；检索只命中
 * knowledge_versions 里登记过的 docVersionId。terms[] 供应用侧词项召回（GIN）。
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: text('id')
      .unique()
      .notNull()
      .$defaultFn(() => randomUUID()),
    docId: text('doc_id').notNull(),
    /** `${docId}#${version}`；已发布版本的切块不可变，重解析写新版本号 */
    docVersionId: text('doc_version_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    /** text | figure | table */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    pageNo: integer('page_no'),
    figureId: text('figure_id'),
    headingPath: jsonb('heading_path').$type<string[]>().notNull().default([]),
    terms: text('terms')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.docVersionId, table.chunkIndex] }),
    index('knowledge_chunks_doc_idx').on(table.docId),
    index('knowledge_chunks_terms_gin').using('gin', table.terms),
  ],
)

/** 知识发布快照：不可变；Agent/检索按版本引用，发布新资料不影响旧引用 */
export const knowledgeVersions = pgTable(
  'knowledge_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** kv-YYYYMMDD-nn */
    label: text('label').notNull().unique(),
    docVersionIds: jsonb('doc_version_ids').$type<string[]>().notNull(),
    note: text('note').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

/** 资料清单条目：对齐 docs/references/knowledge-source-manifest.json 字段语义 */
export const knowledgeManifestEntries = pgTable('knowledge_manifest_entries', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  topics: text('topics')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  access: text('access').notNull(),
  sourceTier: text('source_tier').notNull(),
  /** url_fetch | user_upload */
  importMethod: text('import_method').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  notes: text('notes'),
  /** pending | imported | skipped | failed */
  status: text('status').notNull().default('pending'),
  docId: text('doc_id'),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect
export type NewKnowledgeDocumentRow = typeof knowledgeDocuments.$inferInsert
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect
export type NewKnowledgeChunkRow = typeof knowledgeChunks.$inferInsert
export type KnowledgeVersionRow = typeof knowledgeVersions.$inferSelect
export type NewKnowledgeVersionRow = typeof knowledgeVersions.$inferInsert
export type KnowledgeManifestEntryRow = typeof knowledgeManifestEntries.$inferSelect
export type NewKnowledgeManifestEntryRow = typeof knowledgeManifestEntries.$inferInsert

// ---------------------------------------------------------------------------
// 研究流程（docs/specs/api-storage.md 实体清单）：运行/步骤/证据冻结 +
// 用户持仓 + 事件报价 + 预测与模型注册表。PG 唯一权威，无 JSON 镜像。
// 时间维度统一 bigint 毫秒；金额/价格 numeric（十进制字符串）。
// ---------------------------------------------------------------------------

/** 研究运行主记录：输入、状态、共享版本钉住（snapshot/config/knowledge/rule/model） */
export const researchRuns = pgTable(
  'research_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    /** queued|running|validating|published|failed|cancelled */
    status: text('status').notNull().default('queued'),
    /** perp | event | teaching */
    product: text('product').notNull(),
    symbol: text('symbol').notNull(),
    marketType: text('market_type').notNull(),
    horizon: text('horizon').notNull(),
    question: text('question'),
    positionId: text('position_id'),
    quoteId: text('quote_id'),
    asOf: bigint('as_of', { mode: 'number' }).notNull(),
    snapshotId: text('snapshot_id'),
    configVersion: text('config_version'),
    knowledgeVersion: text('knowledge_version'),
    ruleVersion: text('rule_version'),
    modelVersion: text('model_version'),
    /** 用户请求取消（流水线在步骤间检查） */
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    /** P2：创建时冻结的完整运行配置（能力/角色/预算/检索参数/知识版本/决策策略/内容哈希） */
    frozenConfig: jsonb('frozen_config').$type<Record<string, unknown>>(),
    /** worker 运行租约（恢复用；原子抢占：lease_until 过期才可被其他 worker 抢走） */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** 持有租约的 worker 标识（只有 owner 本人可续租，防止过期后旧 worker 覆盖新 owner） */
    leaseOwner: text('lease_owner'),
    /** 断点恢复检查点：每步完成后的可序列化上下文（snapshotPack 从输入包重载） */
    ctxState: jsonb('ctx_state').$type<Record<string, unknown>>(),
    conversationId: text('conversation_id'),
    error: text('error'),
    /** ResearchRunCreate 原始输入（冻结） */
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    /** 校验通过后的 ResearchResult（发布时写入，此后不可变） */
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('research_runs_user_idx').on(table.userId, table.createdAt),
    index('research_runs_status_idx').on(table.status),
  ],
)

/** 流水线单步持久化：attempt>0 为校验修复轮重跑 */
export const runSteps = pgTable(
  'run_steps',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    runId: text('run_id').notNull(),
    step: text('step').notNull(),
    /** pending|running|completed|failed|skipped */
    status: text('status').notNull().default('pending'),
    startedAt: bigint('started_at', { mode: 'number' }),
    endedAt: bigint('ended_at', { mode: 'number' }),
    summary: text('summary'),
    costMs: integer('cost_ms'),
    error: text('error'),
    attempt: integer('attempt').notNull().default(0),
  },
  (table) => [
    index('run_steps_run_idx').on(table.runId, table.step),
  ],
)

/**
 * 证据冻结：发布回答时把实际使用的片段快照进来，资料更新不影响已发布结论。
 * kind=knowledge_chunk 引用知识切块；market_bar/structure_event 引用行情与结构；
 * rule_card 引用规则卡；web_page 引用搜索+原页核验后的网页（refId 存最终 URL）。
 */
export const evidenceItems = pgTable(
  'evidence_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    runId: text('run_id').notNull(),
    /** knowledge_chunk | market_bar | structure_event | rule_card | web_page */
    kind: text('kind').notNull(),
    /** support | counter */
    stance: text('stance').notNull().default('support'),
    refId: text('ref_id').notNull(),
    docVersionId: text('doc_version_id'),
    pageNo: integer('page_no'),
    figureId: text('figure_id'),
    contentHash: text('content_hash'),
    sourceTier: text('source_tier'),
    /** 冻结的原文片段（资料更新不影响此处） */
    text: text('text').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evidence_items_run_idx').on(table.runId)],
)

/** 用户手动确认的永续持仓（App 抄录；强平价仅存用户录入值） */
export const portfolioPositions = pgTable(
  'portfolio_positions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    symbol: text('symbol').notNull(),
    /** long | short */
    side: text('side').notNull(),
    qty: numeric('qty').notNull(),
    entryPrice: numeric('entry_price').notNull(),
    leverage: integer('leverage').notNull(),
    /** cross | isolated */
    marginMode: text('margin_mode').notNull(),
    riskBudget: numeric('risk_budget').notNull(),
    stopPrice: numeric('stop_price'),
    /** 用户抄录的精确强平价；未知 null，不得以估算冒充 */
    liquidationPrice: numeric('liquidation_price'),
    confirmedAt: bigint('confirmed_at', { mode: 'number' }).notNull(),
    /** 会话确认卡草稿指纹（评审 R2 幂等）：同用户同指纹只落一条持仓（部分唯一索引兜底并发/重试）；手工录入为 null */
    confirmFp: text('confirm_fp'),
    staleAfterHours: integer('stale_after_hours').notNull().default(72),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('portfolio_positions_user_idx').on(table.userId, table.createdAt)],
)

/** 事件合约报价（手动抄录；asOf 冻结，更正=作废重建） */
export const eventQuotes = pgTable(
  'event_quotes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    symbol: text('symbol').notNull(),
    strikePrice: numeric('strike_price').notNull(),
    expiryAt: bigint('expiry_at', { mode: 'number' }).notNull(),
    asOf: bigint('as_of', { mode: 'number' }).notNull(),
    /** 投入金额 */
    stake: numeric('stake').notNull(),
    /** 含本金总返还 */
    totalPayout: numeric('total_payout').notNull(),
    /** above | below */
    direction: text('direction').notNull(),
    refPrice: numeric('ref_price'),
    note: text('note'),
    /** 到期后追加：研究估算（指数价 vs 执行价）与用户确认，互不覆盖 */
    estimatedOutcome: text('estimated_outcome'),
    userConfirmedOutcome: text('user_confirmed_outcome'),
    /** P1：preview=参与前研究（预览价 60s 时效）/ submitted=已提交订单（固定值，只研究剩余期限与结算） */
    orderState: text('order_state').notNull().default('preview'),
    /** preview=执行价未锁定 / locked=App 确认的固定执行价 */
    strikeStatus: text('strike_status').notNull().default('preview'),
    /** 预览创建时刻（判定 60s 刷新） */
    previewAsOf: bigint('preview_as_of', { mode: 'number' }),
    /** 用户确认的事件风险预算（单笔可承受损失）；conditional_entry 门槛之一 */
    eventRiskBudget: numeric('event_risk_budget'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('event_quotes_user_idx').on(table.userId, table.createdAt)],
)

/** 预测记录：概率唯一来自统计模块；特征/模型版本随记录冻结 */
export const predictions = pgTable(
  'predictions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    quoteId: text('quote_id'),
    symbol: text('symbol').notNull(),
    marketType: text('market_type').notNull(),
    horizon: text('horizon').notNull(),
    modelVersion: text('model_version').notNull(),
    featureVersion: text('feature_version').notNull(),
    probabilityUp: doublePrecision('probability_up'),
    /** 分位点 → 预测收益（十进制字符串） */
    quantiles: jsonb('quantiles').$type<Record<string, string>>().notNull().default({}),
    snapshotId: text('snapshot_id').notNull(),
    /** active|estimated|user_confirmed|expired_unavailable */
    status: text('status').notNull().default('active'),
    estimatedOutcome: text('estimated_outcome'),
    userConfirmedOutcome: text('user_confirmed_outcome'),
    outcomeSource: text('outcome_source'),
    /** 冻结的特征向量（可复现） */
    features: jsonb('features').$type<Record<string, number>>().notNull().default({}),
    unavailableReason: text('unavailable_reason'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('predictions_user_idx').on(table.userId, table.createdAt),
    index('predictions_quote_idx').on(table.quoteId),
  ],
)

/** 模型注册表：版本、训练截止、适用期限、校准指标、状态 */
export const predictionModels = pgTable(
  'prediction_models',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    modelVersion: text('model_version').notNull().unique(),
    horizon: text('horizon').notNull(),
    /** 最后样本的标签结束时间（asOf 门控：早于该时刻的回放不使用此模型，保证标签已可得） */
    trainedUntil: bigint('trained_until', { mode: 'number' }).notNull(),
    featureVersion: text('feature_version').notNull(),
    /** 基础周期（1m/1h）：与 featureVersion 一起做「期限↔周期↔特征」三元组门控 */
    baseInterval: text('base_interval'),
    /** P1 状态机：training → candidate → published（校准确认后）→ retired（旧值 ready/stale 迁移为 retired） */
    status: text('status').notNull().default('training'),
    metrics: jsonb('metrics').$type<Record<string, number> | null>(),
    artifactPath: text('artifact_path'),
    /** P1 治理：按交易对训练（禁止跨币种复用）；事件模型用指数价，方向研究用成交价 */
    symbol: text('symbol').notNull().default('*'),
    marketType: text('market_type').notNull().default('usdm_perp'),
    priceType: text('price_type').notNull().default('index'),
    /** strike_relative（事件：到期指数价相对执行价） | return_positive（方向研究，成交价） */
    targetType: text('target_type').notNull().default('strike_relative'),
    /** 已验证的剩余期限范围 {minSec,maxSec}：推理剩余时间必须落在其中 */
    validatedDurationRange: jsonb('validated_duration_range').$type<{ minSec: number; maxSec: number } | null>(),
    /** 发布门槛策略版本（validationPolicyVersion，不可被提示词改变） */
    validationPolicyVersion: text('validation_policy_version'),
    /** 发布时刻（历史回放门控：asOf 早于发布时间不得使用该模型） */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** 分布校准确认时刻（数值门槛 + 校准确认双门控后才 published） */
    calibratedAt: timestamp('calibrated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

export type ResearchRunRow = typeof researchRuns.$inferSelect
export type NewResearchRunRow = typeof researchRuns.$inferInsert
export type RunStepRow = typeof runSteps.$inferSelect
export type NewRunStepRow = typeof runSteps.$inferInsert
export type EvidenceItemRow = typeof evidenceItems.$inferSelect
export type NewEvidenceItemRow = typeof evidenceItems.$inferInsert
export type PortfolioPositionRow = typeof portfolioPositions.$inferSelect
export type NewPortfolioPositionRow = typeof portfolioPositions.$inferInsert
export type EventQuoteRow = typeof eventQuotes.$inferSelect
export type NewEventQuoteRow = typeof eventQuotes.$inferInsert
export type PredictionRow = typeof predictions.$inferSelect
export type NewPredictionRow = typeof predictions.$inferInsert
export type PredictionModelRow = typeof predictionModels.$inferSelect
export type NewPredictionModelRow = typeof predictionModels.$inferInsert

// ---------------------------------------------------------------------------
// Admin 配置与评测（docs/specs/admin-security.md、evaluation-deployment.md）：
// Agent 版本（草稿→发布不可变→回滚指针）、评测数据集（版本化）、评测运行。
// ---------------------------------------------------------------------------

/** Agent 配置版本：声明式全文（角色/工具白名单/预算/检索策略/能力引用）；发布后不可变 */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** 版本标识（semver 或可读标签）；唯一 */
    label: text('label').notNull().unique(),
    /** draft | published | archived */
    status: text('status').notNull().default('draft'),
    /** AgentConfig 全文（jsonb，shared 契约解析） */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

/** 评测数据集：四类（structure/rag/dialog/replay）；items jsonb 按类型各异，版本化 */
export const evalDatasets = pgTable(
  'eval_datasets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    itemCount: integer('item_count').notNull().default(0),
    /** 数据集条目（结构按 kind 而定；version 递增产生新行，旧行保留） */
    items: jsonb('items').$type<unknown[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('eval_datasets_kind_idx').on(table.kind, table.name, table.version)],
)

/** 评测运行：pg-boss 任务执行；metrics/report 完成时写入 */
export const evalRuns = pgTable(
  'eval_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    datasetId: text('dataset_id').notNull(),
    /** 运行时钉住的 Agent 配置版本 */
    configVersion: text('config_version').notNull(),
    /** queued | running | completed | failed */
    status: text('status').notNull().default('queued'),
    metrics: jsonb('metrics').$type<Record<string, number>>(),
    report: jsonb('report').$type<Record<string, unknown>>(),
    startedAt: bigint('started_at', { mode: 'number' }),
    endedAt: bigint('ended_at', { mode: 'number' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('eval_runs_dataset_idx').on(table.datasetId, table.createdAt)],
)

export type AgentVersionRow = typeof agentVersions.$inferSelect
export type NewAgentVersionRow = typeof agentVersions.$inferInsert
export type EvalDatasetRow = typeof evalDatasets.$inferSelect
export type NewEvalDatasetRow = typeof evalDatasets.$inferInsert
export type EvalRunRow = typeof evalRuns.$inferSelect
export type NewEvalRunRow = typeof evalRuns.$inferInsert

// ---------------------------------------------------------------------------
// 会话层（P2）：跨轮上下文、消息流与确认卡；SSE 事件落库支持游标重连。
// ---------------------------------------------------------------------------

/** 会话：结构化上下文（币种/场景/期限/持仓与报价引用/信息来源） */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    title: text('title').notNull().default(''),
    /** { product, symbol, marketType, horizon, positionId, quoteId, source } */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversations_user_idx').on(table.userId, table.updatedAt)],
)

/** 会话消息：role=user/assistant；runId 关联研究运行；card 为补全/确认卡 */
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    conversationId: text('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** concept | structure | perp | event | replay | news | system */
    intent: text('intent'),
    runId: text('run_id'),
    /** 确认卡/补全卡：{ kind:'confirm_position'|'completion', draft } */
    card: jsonb('card').$type<Record<string, unknown>>(),
    /** 本条回复实际使用的提示词版本（P0-6 审计）：[{name,scene,version,templateId}] */
    promptRefs: jsonb('prompt_refs').$type<Record<string, unknown>[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversation_messages_conv_idx').on(table.conversationId, table.createdAt)],
)

/** SSE 事件落库：?after=seq 游标重连，worker 重启后进度不丢 */
export const runEvents = pgTable(
  'run_events',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    step: text('step'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
)

export type ConversationRow = typeof conversations.$inferSelect
export type NewConversationRow = typeof conversations.$inferInsert
export type ConversationMessageRow = typeof conversationMessages.$inferSelect
export type NewConversationMessageRow = typeof conversationMessages.$inferInsert
export type RunEventRow = typeof runEvents.$inferSelect
export type NewRunEventRow = typeof runEvents.$inferSelect

// ---------------------------------------------------------------------------
// 规则卡层与案例层（docs/specs/knowledge-rag.md 三资料层的第 2/3 层）：
// - 规则卡：一概念一卡（定义/成立条件/上下文/失效条件/易混淆/反例/ruleId/出处），
//   LLM 草拟 → 管理员审核发布；资料正文更新不自动修改线上规则代码；
// - 案例窗：真实 OHLC 窗口 + 人工标注；「决策时可见上下文」与「未来结果标签」
//   分列存储，案例检索只返回 visibleContext（防未来泄漏）。
// ---------------------------------------------------------------------------

/** 规则卡：status 草稿→发布（版本递增）；published 内容不可改，改版=新草稿 */
export const ruleCards = pgTable(
  'rule_cards',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** 规范概念名（对应 terms.ts 的 canonical，如 h2 / barbwire / mtr） */
    concept: text('concept').notNull(),
    /** draft | published | archived */
    status: text('status').notNull().default('draft'),
    /** 同概念发布次数；docVersion 语义：`${id}#v${version}` */
    version: integer('version').notNull().default(0),
    /** 卡片内容：definition/conditions/context/invalidation/confusable/counterExamples/ruleId/sourceNote */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** 草拟时的引用快照：[{docVersionId, chunkId, pageNo}] */
    citations: jsonb('citations').$type<{ docVersionId: string; chunkId: string; pageNo: number | null }[]>().notNull().default([]),
    /** draft | template（LLM 未配置时模板草拟，仍需人工补全审核） */
    draftedBy: text('drafted_by').notNull().default('template'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [index('rule_cards_concept_idx').on(table.concept, table.status)],
)

/**
 * 知识发布历史（迁移 0018，append-only）：规则卡发布时快照 concept+content、案例发布时
 * 记 ref。as-of 检索按「每个 ref 在 asOf 前最后一次发布」重放——与当前状态
 * （归档/下架/新版覆盖）解耦，历史重放结果不随后续管理操作漂移（P0-4 复现性）。
 */
export const knowledgePublications = pgTable(
  'knowledge_publications',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** rulecard | case */
    kind: text('kind').notNull(),
    /** publish | unpublish（迁移 0019：案例下架记事件，as-of 按最后事件判断有效性） */
    eventType: text('event_type').notNull().default('publish'),
    refId: text('ref_id').notNull(),
    version: integer('version').notNull().default(1),
    /** 规则卡快照字段（案例为 null：案例 visibleContext 构建后不可变） */
    concept: text('concept'),
    contentSnapshot: jsonb('content_snapshot').$type<Record<string, unknown> | null>(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_publications_kind_published_idx').on(table.kind, table.publishedAt),
    index('knowledge_publications_ref_idx').on(table.kind, table.refId, table.publishedAt),
  ],
)

/** 案例窗：visibleContext=决策时可见（检索返回）；outcome=未来结果（仅 admin 详情，不参与检索） */
export const caseWindows = pgTable(
  'case_windows',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    symbol: text('symbol').notNull(),
    marketType: text('market_type').notNull(),
    interval: text('interval').notNull(),
    /** 决策时刻（窗口右端，UTC 毫秒） */
    atTime: bigint('at_time', { mode: 'number' }).notNull(),
    /** 决策时可见：窗口内 K 线摘要 + 引擎结构快照（knownAt<=atTime） */
    visibleContext: jsonb('visible_context').$type<Record<string, unknown>>().notNull(),
    /** 未来结果标签（决策后才可知）：远期收益/方向等；检索永不返回 */
    outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull().default({}),
    /** 人工结构标注 */
    annotation: text('annotation').notNull().default(''),
    published: boolean('published').notNull().default(false),
    /** 发布时刻（P0-4 as-of 过滤：run 冻结知识版本后发布的案例不进入该 run 检索；取消发布置空） */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('case_windows_series_idx').on(table.symbol, table.marketType, table.interval, table.atTime)],
)

export type RuleCardRow = typeof ruleCards.$inferSelect

// ---------------------------------------------------------------------------
// 提示词模板注册表（P0-6，vertical-agent-architecture.md §4.B）：
// draft → published（不可变，WHERE status='draft' 防写穿）→ retired；
// 生效指针 (name, scene) 复合键（scene='' 为全局）；rollback=指针切回历史 published。
// run 创建时终解析冻结进 frozenConfig.raw.prompts；执行阶段只读冻结内容（红线 #2）。
// ---------------------------------------------------------------------------

/** 提示词模板版本：同 (name,scene) 内 version 递增；published 行永久保留可解析 */
export const promptTemplates = pgTable(
  'prompt_templates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** 模板名（PROMPT_NAMES 五个之一；场景作用域见 scene） */
    name: text('name').notNull(),
    /** 场景作用域（''=全局生效；P1-1 场景注册表启用差异化模板） */
    scene: text('scene').notNull().default(''),
    /** draft | published | retired */
    status: text('status').notNull().default('draft'),
    /** 同 (name,scene) 内递增 */
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    note: text('note').notNull().default(''),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('prompt_templates_name_idx').on(table.name, table.scene, table.version)],
)

/** 生效指针：(name,scene) → published 模板 id；与发布同事务切换 */
export const promptTemplatePointers = pgTable(
  'prompt_template_pointers',
  {
    name: text('name').notNull(),
    scene: text('scene').notNull().default(''),
    publishedId: text('published_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.name, table.scene] })],
)

export type PromptTemplateRow = typeof promptTemplates.$inferSelect
export type NewPromptTemplateRow = typeof promptTemplates.$inferInsert
export type PromptTemplatePointerRow = typeof promptTemplatePointers.$inferSelect
export type NewRuleCardRow = typeof ruleCards.$inferInsert
export type CaseWindowRow = typeof caseWindows.$inferSelect
export type NewCaseWindowRow = typeof caseWindows.$inferInsert

export type MarketCandleRow = typeof marketCandles.$inferSelect
export type NewMarketCandleRow = typeof marketCandles.$inferInsert
export type MarketFundingRateRow = typeof marketFundingRates.$inferSelect
export type NewMarketFundingRateRow = typeof marketFundingRates.$inferInsert
export type MarketOpenInterestRow = typeof marketOpenInterest.$inferSelect
export type NewMarketOpenInterestRow = typeof marketOpenInterest.$inferInsert
export type MarketSnapshotRow = typeof marketSnapshots.$inferSelect
export type NewMarketSnapshotRow = typeof marketSnapshots.$inferInsert
export type IngestStateRow = typeof ingestState.$inferSelect
export type NewIngestStateRow = typeof ingestState.$inferInsert
export type StructureEventRow = typeof structureEvents.$inferSelect
export type NewStructureEventRow = typeof structureEvents.$inferInsert
