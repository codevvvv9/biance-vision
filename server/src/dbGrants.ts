/**
 * 数据库账号分权（W3-S4，docs/admin-isolation-plan.md §3.2/§3.5）：
 * user-api 进程使用最小权限账号 `biance_user`（表级 GRANT 白名单）；
 * admin-api / worker / migrate 继续使用 owner 级账号 `biance_app`。
 *
 * 白名单维护纪律：新增表时必须同步归类（models.ts 建表 → 此处归类 →
 * db-grants-check 断言矩阵），漏归类=运行时 42501，误归类=越权——两个方向
 * 都有断言钉住。
 */

/** user-api 可读写（用户域：预警/AI 聊天/研究/产品/认证审计） */
export const RW_TABLES = [
  'alert_rules',
  'alert_history',
  'app_settings', // 预警设置（用户端可写）+ worker 心跳；管理项同表不同 key
  'ai_conversations',
  'ai_messages',
  'ai_memories',
  'market_candles',
  'market_funding_rates',
  'market_open_interest',
  'market_snapshots',
  'ingest_state',
  'structure_events',
  'research_runs',
  'run_steps',
  'run_events',
  'evidence_items',
  'research_memories',
  'trader_profiles',
  'conversations',
  'conversation_messages',
  'portfolio_positions',
  'event_quotes',
  'predictions',
  'prediction_models', // 研究管线读取模型版本做校准推理（写由 admin/worker）
  'auth_sessions',
  'login_guards',
  'audit_records',
  'membership_usage',
  'membership_reservations',
] as const

/** user-api 只读（判权/检索命中/系统提示词渲染——写路径全在 admin-api/worker） */
export const RO_TABLES = [
  'users',
  'membership_plans',
  'membership_plan_versions',
  'membership_campaigns',
  'membership_accounts',
  'membership_grants',
  'membership_receipts',
  'membership_redemptions',
  'membership_refresh_settings',
  'knowledge_documents',
  'knowledge_chunks',
  'knowledge_versions',
  'knowledge_publications',
  'rule_cards',
  'case_windows',
  'prompt_templates',
  'prompt_template_pointers',
] as const

/**
 * user-api 无任何权限（纯管理域；S4 验收断言 INSERT 被拒）：
 * eval_datasets / eval_runs / agent_versions / knowledge_manifest_entries；
 * 安全状态表（P1-2）同样无 DML——限流计数只经受控函数 EXECUTE（迁移内授权）。
 */
export const DENIED_TABLES = ['eval_datasets', 'eval_runs', 'agent_versions', 'knowledge_manifest_entries', 'security_rate_buckets'] as const

export const DB_USER_ROLE = 'biance_user'

/**
 * 角色同步（幂等，migrate 容器每次执行）：建角色/同步密码/重放白名单 GRANT。
 * 密码经 env BV_DB_USER_PASSWORD 注入（不入库不入镜像；缺省仅本地开发用弱值）。
 * 返回执行的语句数（日志用）。
 */
export async function syncDbUserRole(db: {
  unsafe: (sql: string) => Promise<unknown[]>
}): Promise<number> {
  const password = process.env.BV_DB_USER_PASSWORD ?? 'biance_user_local'
  let n = 0
  // CREATE ROLE 幂等（DO 块）+ 密码每次同步（轮换即改 env 重跑 migrate）
  await db.unsafe(
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER_ROLE}') THEN
        CREATE ROLE ${DB_USER_ROLE} LOGIN;
      END IF;
    END $$;`,
  )
  n += 1
  await db.unsafe(`ALTER ROLE ${DB_USER_ROLE} WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}';`)
  n += 1
  await db.unsafe(`GRANT CONNECT ON DATABASE ${process.env.PG_DATABASE_NAME ?? 'biance_vision'} TO ${DB_USER_ROLE};`)
  n += 1
  await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${DB_USER_ROLE};`)
  n += 1
  await db.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER_ROLE};`)
  n += 1
  await db.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${RW_TABLES.join(', ')} TO ${DB_USER_ROLE};`)
  n += 1
  await db.unsafe(`GRANT SELECT ON TABLE ${RO_TABLES.join(', ')} TO ${DB_USER_ROLE};`)
  n += 1
  // pgboss 队列 schema（owner=biance_app，由 worker 侧 pg-boss 建表/迁移）：
  // user-api 以 biance_user 入队/查询需要 USAGE+DML；schema 尚未建（全新库首启
  // migrate 先于 worker）时整段跳过，下次 migrate 重放补上（幂等）。
  // DEFAULT PRIVILEGES 让 pg-boss 后续迁移新建的表自动继承同款授权，
  // 否则 app 侧 startQueue 42501 降级、入队链路（知识库解析/研究 run）断。
  const queueSchema = process.env.QUEUE_SCHEMA ?? 'pgboss'
  await db.unsafe(
    `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${queueSchema}') THEN
        GRANT USAGE ON SCHEMA ${queueSchema} TO ${DB_USER_ROLE};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${queueSchema} TO ${DB_USER_ROLE};
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${queueSchema} TO ${DB_USER_ROLE};
        ALTER DEFAULT PRIVILEGES FOR ROLE biance_app IN SCHEMA ${queueSchema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DB_USER_ROLE};
        ALTER DEFAULT PRIVILEGES FOR ROLE biance_app IN SCHEMA ${queueSchema} GRANT USAGE, SELECT ON SEQUENCES TO ${DB_USER_ROLE};
      END IF;
    END $$;`,
  )
  n += 1
  return n
}
