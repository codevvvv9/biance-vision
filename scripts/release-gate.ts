/**
 * 上线门槛（release gate，docs/specs/evaluation-deployment.md）：
 * 依次执行 typecheck → 纯引擎自测（causality/selftest/calc-check）→ DB 集成自测
 * （knowledge/research smoke，需 docker compose 的 PostgreSQL 与库内行情）→ web 生产构建。
 * 任一环节失败即退出非零，不发布。
 *
 * 运行：pnpm release:gate
 * 可选：GATE_SKIP_DB=1 跳过 DB 集成自测（纯前端/引擎发版场景）
 */
import { spawnSync } from 'node:child_process'

interface Step {
  name: string
  cmd: string
  skip?: boolean
}

const skipDb = process.env.GATE_SKIP_DB === '1'

const steps: Step[] = [
  { name: 'typecheck（全仓）', cmd: 'pnpm typecheck' },
  { name: '结构引擎因果性（456 项）', cmd: 'pnpm brooks:causality' },
  { name: '结构引擎自测（36 项）', cmd: 'pnpm brooks:selftest' },
  { name: '产品计算锚点（30 项）', cmd: 'pnpm research:calc-check' },
  { name: '管理端域名门禁（35 项）', cmd: 'pnpm admin:gate-check' },
  { name: '登录回归（入口同构/计数/锁定，需 PG）', cmd: 'pnpm login:regression', skip: skipDb },
  { name: '知识库集成（需 PG）', cmd: 'pnpm knowledge:smoke', skip: skipDb },
  { name: '知识库权限底座（需 PG）', cmd: 'pnpm knowledge:access-check', skip: skipDb },
  { name: '双入口切分（W3-S3，21 项，需 PG）', cmd: 'pnpm admin:dual-check', skip: skipDb },
  { name: '数据库分权（W3-S4，12 项，需 PG）', cmd: 'pnpm db:grants-check', skip: skipDb },
  { name: '研究流程集成（需 PG+行情）', cmd: 'pnpm research:smoke', skip: skipDb },
  { name: '管理端受控浏览器回归', cmd: 'pnpm --dir web test:admin' },
  { name: 'web 生产构建', cmd: 'pnpm --dir web build' },
]

let failed = 0
for (const s of steps) {
  if (s.skip) {
    console.log(`⏭ SKIP ${s.name}`)
    continue
  }
  console.log(`\n━━ ${s.name}：${s.cmd}`)
  const r = spawnSync(s.cmd, { shell: true, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`✖ FAIL ${s.name}`)
    failed++
    break // 门槛串行：首个失败即止
  }
  console.log(`✔ PASS ${s.name}`)
}

if (failed > 0) {
  console.error('\n上线门槛未通过 ✖ —— 修复后重试；不得带伤发布')
  process.exit(1)
}
console.log('\n上线门槛全部通过 ✔（可打 tag 触发 Release）')
