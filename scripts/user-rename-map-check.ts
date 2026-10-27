/**
 * 用户改名清单静态门禁（2026-10-27）：改名是单事务级联更新（server/src/admin/renameUser.ts），
 * 清单漏一张带用户列的表 = 静默丢关联。本脚本用 drizzle 元数据遍历 models.ts 全部表，
 * 要求「用户引用列全集」与 RENAME_COLUMN_MAP 严格相等（双向），
 * 新表带 user_id/username/owner 列而未登记 → CI 红。审计表例外见下方注释。
 */
import { getTableColumns, getTableName, isTable } from 'drizzle-orm'
import * as models from '../server/src/models.js'
import { CASCADE_FK_TABLES, NON_ORM_RENAME_TABLES, RENAME_COLUMN_MAP } from '../server/src/admin/renameUser.js'

/** 有用户列但有意不参与改名的表及原因（运行时同款豁免，见 renameUser.ts） */
const INTENTIONALLY_EXCLUDED: Record<string, string> = {
  users: '改名主体：username 本体在端点内单独更新',
  audit_records: '操作审计是历史记录，保留改名前用户名',
}

const USER_COLUMNS = new Set(['user_id', 'username', 'owner'])

function collectSchemaColumns(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const value of Object.values(models)) {
    if (!isTable(value)) continue
    const columns = getTableColumns(value)
    const hits = Object.values(columns)
      .map(c => (c as { name?: string }).name ?? '')
      .filter(n => USER_COLUMNS.has(n))
    if (hits.length) found.set(getTableName(value), hits.sort())
  }
  return found
}

const schema = collectSchemaColumns()
const expected = new Map<string, string[]>()
for (const { table, column } of [...RENAME_COLUMN_MAP, ...CASCADE_FK_TABLES]) {
  const list = expected.get(table) ?? []
  list.push(column)
  expected.set(table, list)
}
for (const [table, columns] of expected) expected.set(table, columns.sort())

const problems: string[] = []
for (const [table, columns] of schema) {
  if (INTENTIONALLY_EXCLUDED[table]) {
    if (expected.has(table)) problems.push(`${table}：已在豁免名单却同时登记在 RENAME_COLUMN_MAP`)
    continue
  }
  const want = expected.get(table)
  if (!want) problems.push(`${table}（${columns.join('/')}）：未登记到 RENAME_COLUMN_MAP —— 改名会丢这张表的关联`)
  else if (want.join(',') !== columns.join(',')) problems.push(`${table}：清单列 [${want}] 与 schema 列 [${columns}] 不一致`)
}
for (const table of expected.keys()) {
  if (schema.has(table) || INTENTIONALLY_EXCLUDED[table]) continue
  if (NON_ORM_RENAME_TABLES.has(table)) continue // 迁移建表的表由改名时 information_schema 实测兜底
  problems.push(`${table}：已登记但 models.ts 中不存在（表已更名/删除，或漏标 NON_ORM_RENAME_TABLES）`)
}

if (problems.length) {
  console.error('user-rename-map-check 失败：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
const ormTables = [...expected.keys()].filter(t => !NON_ORM_RENAME_TABLES.has(t))
// CASCADE_FK_TABLES 登记在清单并集里，但其在库中的 ON UPDATE CASCADE 由 0036 迁移与 e2e 保证（静态无法验证 FK）
const total = [...expected.values()].reduce((sum, cols) => sum + cols.length, 0)
console.log(`user-rename-map-check 通过：ORM 比对 ${ormTables.length} 表；非 ORM 声明 ${[...NON_ORM_RENAME_TABLES].join('、')}（运行时实测兜底）；清单共 ${expected.size} 表 ${total} 列；豁免 ${Object.keys(INTENTIONALLY_EXCLUDED).join('、')}`)
