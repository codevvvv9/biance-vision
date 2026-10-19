# Spec：独立评测台（evaluation-harness）

> 状态：planned

## 目标

定义一套独立于研究流水线的评测能力：用版本化数据集、确定性校验器、受控 Subject 适配器、可复现报告与发布门禁，持续回答「系统是否可信」。评测台只观测和判定，不改正研究结论、不生成交易数值、不把 LLM 评分当成硬门禁；任何能力结论必须来自本评测台的样本、回放与门禁记录，而不是外部项目自述收益或通用榜单。

本文补齐 `docs/specs/evaluation-deployment.md` 的高层要求，重点覆盖当前缺口：引用支持度、数值契约、拒答正确性、伪造概率泄漏、证据时效与按条目的审计追踪。

## 已确定决策

- 评测台是独立 bounded context：代码收敛在 `server/src/evaluation/`，不并入 `server/src/research/orchestrator/`；现有 `server/src/research/evalRunner.ts` 只作为迁移来源，最终由评测台的 runner 接管 `eval:run` 任务。
- 物理部署保持简单：首版不新增微服务，控制面在 `app` 的 Admin API，执行面在 `worker` 的 pg-boss 消费；逻辑上通过接口与独立表结构解耦，后续如需独立服务可直接搬移 `server/src/evaluation/`。
- 判定优先级固定为：`schema_contract` → `temporal_leakage` / `forbidden_numeric_probability` → `numeric_recompute` → `citation_existence` → `citation_support` → `required_refusal` → 其他指标。任一硬校验失败，该 case 立即标记失败；后续 checker 可继续运行用于诊断，但不得反转 hardFail。LLM judge / 过程奖励模型只能输出辅助信号，不得单独改变 pass/fail。
- 数据集条目（case）统一包络，领域差异放入 `input/expected/checkers`，不再让 `kind` 决定任意 JSON 形状；现有 `structure/rag/dialog/replay` 映射为 suite 模板，新能力优先新增 checker 与 subject adapter，而不是扩散数据集结构。
- 外部基准只作协议或旁路对照：FinQA/ConvFinQA 借可执行标准答案思想，FinanceBench 借「答案 + 引文 + 页码」协议，FinBen/PIXIU 作回归旁路，RAGTruth 借词级幻觉标注方法，Fin-PRM/Fin-R1 仅作辅助过程信号。CC-BY-NC 或未声明许可的数据不得进入商用门禁数据集。
- 评测报告必须可复现：记录 `datasetId/version`、`checkerRegistryVersion`、Subject 输出的 `snapshotId/configVersion/knowledgeVersion/ruleVersion/modelVersion`、prompt 版本、代码 gitSha、随机种子、费用与耗时；同一 recorded subject output 重跑 deterministic checker 必须得到同一判定。
- 硬门禁与质量指标分离：门禁只接受布尔规则（如伪造概率数 = 0、决策 claim 引用存在率 = 100%、数值复算不匹配 = 0）；hit@k/MRR/judgeScore/延迟/费用进入趋势报告，不单独充当发布许可。
- 评测产物归档优先于被测 run 清理：live 模式可先运行真实流水线，但必须在清理前把结果摘要、证据引用、判定明细归档到评测台自有存储；禁止出现「报告存在但证据无法复查」。

## 数据与接口

### 模块边界

| 模块 | 职责 | 不允许做的事 |
| --- | --- | --- |
| `server/src/evaluation/datasets/` | 数据集与 case 的 zod schema、版本化、许可字段校验 | 不读取研究业务表作为数据集来源；只接受显式导入/录入 |
| `server/src/evaluation/checkers/` | 确定性 checker 注册表与实现 | 不调用 LLM；不修改 Subject 输出；不做网络抓取 |
| `server/src/evaluation/judges/` | 可选 LLM/过程模型辅助评分 | 不得写入硬门禁结果；失败只能降级为 missing signal |
| `server/src/evaluation/subjects/` | Subject adapter：把数据集输入转成可评测输出 | 不直接改研究结论；不绕过研究 API 写库 |
| `server/src/evaluation/runner/` | 任务编排、并发限制、预算、重试、归档 | 不把 subject 失败吞成评测成功；不做未声明重试 |
| `server/src/evaluation/report/` | 指标聚合、门禁判定、报告装配 | 不二次计算业务数值；只聚合 checker 输出 |
| `server/src/evaluation/gates/` | 发布门禁策略与结果解释 | 不用平均分掩盖硬失败；不接受提示词覆盖 |

### 核心接口

```ts
type EvalCase = {
  schemaVersion: string
  caseId: string
  title: string
  domain: 'structure' | 'rag' | 'dialog' | 'replay' | 'answer_support' | 'numeric_contract' | 'refusal' | 'prediction'
  task: string
  input: Record<string, unknown>
  expected: Record<string, unknown>
  checkers: { type: string; params?: Record<string, unknown>; gate?: boolean }[]
  tags: string[]
  source: { kind: 'manual' | 'imported' | 'derived'; license: string; uri?: string }
}

type SubjectOutput = {
  subjectKind: 'research_run' | 'retrieval' | 'structure' | 'model' | 'recorded_fixture'
  status: 'completed' | 'failed' | 'refused' | 'unavailable'
  result?: unknown
  evidence?: unknown[]
  steps?: unknown[]
  metrics?: Record<string, number>
  versions: {
    snapshotId?: string
    configVersion?: string
    knowledgeVersion?: string
    ruleVersion?: string
    modelVersion?: string
    promptVersions?: Record<string, string>
    gitSha?: string
  }
  usage?: { runtimeMs?: number; llmCalls?: number; toolCalls?: number; costUsd?: number }
}

type CheckerContext = {
  dataset: { id: string; version: number }
  run: { id: string; configVersion: string }
  now: number
  frozenAt?: number
}

type Checker = {
  type: string
  version: string
  deterministic: true
  check(evalCase: EvalCase, output: SubjectOutput, ctx: CheckerContext): CheckerVerdict
}

type CheckerVerdict = {
  pass: boolean
  hardFail?: boolean
  score?: number
  issues: { code: string; message: string; evidenceRef?: string }[]
  observations?: Record<string, number | string | boolean>
}

type JudgeSignal = {
  type: 'llm_rubric' | 'process_reward' | 'hallucination_classifier'
  deterministic: false
  score?: number
  label?: string
  rationale?: string
  unavailableReason?: string
}
```

### 表与存储演进

保留现有 `eval_datasets` / `eval_runs` 作为集合与汇总入口；新增评测台自有的按条目结果与工件归档，避免把大报告塞进单个 jsonb 后无法审计。

| 表 | 职责 | 关键字段 |
| --- | --- | --- |
| `eval_datasets`（现有，扩展） | 数据集集合与版本 | `kind/name/version/itemCount/items` 保留；新增 `schemaVersion`、`checkerRegistryVersion`、`gatePolicyVersion`、`licenseSummary` |
| `eval_runs`（现有，扩展） | 评测运行汇总 | 保留 `datasetId/configVersion/status/metrics/report`；新增 `subjectKind`、`gateStatus`、`gateSummary`、`artifactPrefix` |
| `eval_case_results`（新增） | 每条 case 的判定与证据 | `runId`、`datasetId`、`caseId`、`status(pass/fail/error/skipped)`、`hardFail`、`verdicts[]`、`judgeSignals[]`、`subjectRef`、`artifactKeys[]`、`durationMs`、`costUsd` |
| `eval_artifacts`（新增） | 大工件与 recorded subject output 索引 | `runId`、`caseId`、`kind(result/evidence/steps/raw_output/fixture)`、`blobKey`、`contentHash`、`schemaVersion` |

约束：

- `eval_case_results` 按 `(runId, caseId)` 唯一；报告汇总可由它重算，禁止只改汇总不改明细。
- `eval_artifacts` 只增不改；归档内容带 `contentHash`；引用业务证据时优先存 `evidence_items.id` 与片段哈希，live run 清理后仍可复查。
- 外部导入数据集必须带 `source.license`；`CC-BY-NC*`、`NOASSERTION`、缺失许可默认只能进入 `internal_only` suite，不得进入发布门禁。

### API 与队列

沿用 `/api/admin/evaluations/*` 的 Admin 边界，端点语义扩展而非另起公开 API：

| 方法 | 路径 | 要点 |
| --- | --- | --- |
| GET/POST/PUT/DELETE | `/api/admin/evaluations/datasets(/:id)` | 数据集 CRUD 与版本化；导入时校验许可与 schemaVersion |
| POST | `/api/admin/evaluations/runs` | 触发评测；支持 `mode: live | recorded`、`subjectKind`、`budget` |
| GET | `/api/admin/evaluations/runs/:id` | 汇总报告 + 门禁结果 |
| GET | `/api/admin/evaluations/runs/:id/cases?status=&tag=` | 按条目查询判定明细 |
| GET | `/api/admin/evaluations/runs/:id/artifacts/:artifactId` | 读取归档工件；不暴露密钥与原始敏感输入 |

执行仍走 pg-boss `eval:run`；任务负载只带 `evalRunId`，不带大数据集正文。

## 流程

### Suite 模板与 case 生命周期

1. 建数据集：选择 domain/task → 导入或录入 case → 校验包络、许可、期望字段 → 生成新版本。旧版本不可变；修订 = 新版本。
2. 触发运行：Admin 选择数据集版本、subjectKind、live/recorded 与预算；runner 冻结 `checkerRegistryVersion/gatePolicyVersion`。
3. Subject 执行：adapter 负责产出 `SubjectOutput`。live 研究走真实 `createRun/executeRun/getRun`；recorded 只读取已归档输出，不重新调用 LLM。
4. Checker 判定：按固定优先级执行；硬失败短路记录，后续 checker 仍可运行但不得反转 hardFail。
5. Judge 辅助：仅当硬校验通过后采集信号；不可用记录 `unavailableReason`，不影响 pass/fail。
6. 聚合与门禁：report 按 domain/task/tag/configVersion/knowledgeVersion/modelVersion 聚合；gates 只消费布尔规则。
7. 归档：先写 `eval_case_results` 与 `eval_artifacts`，再更新 `eval_runs` 汇总；live 被测 run 的清理发生在归档成功之后。

### Subject 适配器

| Adapter | 输入 | 输出 | 适用 |
| --- | --- | --- | --- |
| `ResearchRunSubject` | 问题/symbol/marketType/horizon/asOf/持仓或报价夹具 | 研究 run 结果 + evidence + steps + usage | answer_support、numeric_contract、refusal、dialog |
| `RetrievalSubject` | query/检索策略冻结值 | hits/chunk ids/scores | rag、引用召回趋势 |
| `StructureSubject` | symbol/interval/from/to | 结构事件与 regime 序列 | structure、replay |
| `ModelSubject` | feature fixture/期限/模型版本 | quantiles/probability/unavailableReason | prediction、校准门禁 |
| `RecordedFixtureSubject` | 已归档 SubjectOutput | 原样回放 | 回归复跑、checker 升级后的历史重判 |

### 首批 checker

| Checker | 判定内容 | 硬门禁 |
| --- | --- | --- |
| `schema_contract` | 输出满足 shared zod 契约，product 负载判别联合合法 | 是 |
| `temporal_leakage` | 结构/证据/模型发布时间均不晚于 asOf；knownAt/publishedAt/trainedUntil 违规即失败 | 是 |
| `forbidden_numeric_probability` | 非 fact 文本不得出现概率/胜率数字；概率字段只能来自预测记录 | 是 |
| `numeric_recompute` | 费用、EV、盈亏平衡、保证金、仓位上限由代码复算并在容差内一致 | 是 |
| `citation_existence` | 决策/事实 claim 的 evidenceIds 全部存在且属于本 run | 是 |
| `citation_support` | 引用片段与期望 quote/page/chunk 匹配；网页证据必须是已核验原页快照 | 是 |
| `required_refusal` | 模型未就绪/期限不匹配/报价缺失/数据过期时必须 unavailable 或 insufficient_evidence | 是 |
| `direction_logic` | entry/stop/target 与方向一致；已触发止损优先于风险上限 | 是 |
| `prediction_gate` | probabilityBlock 必须由已发布模型、匹配期限桶与冻结特征产生 | 是 |
| `rag_quality` | hit@k/MRR/反例覆盖/无答案拒答 | 否（趋势） |
| `efficiency_budget` | 运行时间、工具调用、费用是否超预算 | 门禁可选，默认报告 |

### 指标与门禁

指标只陈述可复核事实，不预设收益：

- 正确性：`numericMismatchCount`、`citationMissingCount`、`unsupportedDecisionClaimCount`、`forbiddenNumericLeakCount`。
- 拒答质量：`requiredRefusalAccuracy`、`wrongfulRefusalRate`（仅在标注「应可回答」的 case 上统计）。
- 检索：`hitAtK`、`mrr`、`counterCoverage`、`citationSupportRate`。
- 预测：`brier`、`ece`、`coverage90`、`sampleSize`、`unavailableReasonDistribution`；样本不足保持不可用。
- 成本：`runtimeMsP50/P95`、`llmCalls`、`toolCalls`、`costUsd`。

默认发布门禁（`gatePolicyVersion=v1`）：

```text
forbiddenNumericLeakCount = 0
unsupportedDecisionClaimCount = 0
citationMissingCount = 0
numericMismatchCount = 0
temporalLeakageCount = 0
requiredRefusalViolations = 0
```

任一不满足：`gateStatus=blocked`，报告必须列出首个失败 case 与修复入口；不得用总体平均分豁免。

### 数据集建设顺序

1. `answer_support`（50–100 条）：来自 Brooks 官方资料、规则卡、币安产品规则；每条至少一个「答案 + 引文 + 页码/图号」期望。
2. `numeric_contract`（30–60 条）：EV、盈亏平衡、费用、保证金、仓位上限、资金费率情景；期望以可复算输入表达，必要时记录 FinQA 风格 program 作为人工可读说明，但判定以代码复算为准。
3. `refusal`（30–50 条）：模型未就绪、期限超容差、报价缺失、陈旧数据、权限不足、伪造概率诱导。
4. `dialog`（20–40 条）：追问继承、假设场景不覆盖已确认输入、周期混淆、切币种隔离。
5. `prediction_calibration`（按期限桶滚动）：只在样本量达标后进入硬门禁，否则保持报告态。

## 边界与失败处理

- 评测台不做治疗：发现错误只产生报告与 blocked 门禁，不自动改写研究结论、规则代码或模型权重。
- Subject 失败是结果：live run 失败会映射为 `SubjectOutput.status=failed/refused/unavailable`，由 refusal/contract checker 判定是否符合预期；runner 自身崩溃才把 case 记为 `error`。
- recorded 模式只重判已归档输出；不能用来证明「当前线上仍然正确」，报告必须标记 `mode=recorded`。
- 外部数据集许可不满足商用门禁时，只能进入 `internal_only` suite；导入缺少许可字段直接拒绝。
- 密钥与用户隐私：报告与 artifact 不落 `secrets.json`、API Key、用户密码、完整持仓敏感输入；live 评测使用独立 `eval:*` 用户与夹具持仓/报价。
- 大报告限制：明细走 `eval_case_results` 与 `eval_artifacts`；`eval_runs.report` 只存摘要、聚合与门禁结果，超出阈值的明细引用 artifact key。
- DB 不可用：不启动评测；正在运行的任务按 pg-boss 恢复；归档写入失败时不得删除 live 被测 run 证据。
- LLM judge 不可用：记录 missing signal；不阻塞 deterministic 门禁；报告明示覆盖率下降。
- 版本错配：`checkerRegistryVersion` 与数据集 `schemaVersion` 不兼容时拒绝运行，提示升级数据集或锁定旧 checker。

## 验收用例

- [ ] 同一 recorded SubjectOutput 用同一 `checkerRegistryVersion` 重跑，所有 deterministic verdict 完全一致。
- [ ] 伪造概率文本、缺引用决策 claim、数值复算不一致、未来泄漏、应拒答未拒答五类注入样本全部被硬门禁拦截。
- [ ] 报告可按 domain/task/tag/configVersion/knowledgeVersion/modelVersion 过滤，并能从汇总下钻到单条 case 的 verdict 与 artifact。
- [ ] live 评测产生的被测 run 在归档成功前不会被清理；归档失败时评测运行失败并保留证据。
- [ ] CC-BY-NC / 未声明许可的数据集无法进入发布门禁 suite，只能用于 internal_only。
- [ ] LLM judge 关闭时 deterministic 门禁仍可完整执行；judge 信号只出现在报告的辅助区。
- [ ] `/api/admin/evaluations/runs/:id/cases` 能按 fail/hardFail/tag 过滤；普通用户访问全部评测端点被拒。
- [ ] `eval_runs.report` 不包含超过阈值的巨型明细；明细通过 artifact key 可取回且 contentHash 校验一致。
- [ ] 现有四类评测（structure/rag/dialog/replay）可迁移为 suite 模板，旧数据集版本仍可按原语义查看。

## 参考来源

- 仓库内：docs/specs/evaluation-deployment.md（高层评测与部署口径）、docs/specs/api-storage.md（现有 `/api/admin/evaluations/*` 与实体）、docs/specs/admin-security.md（Admin/审计/密钥边界）、docs/specs/agent-orchestration.md（校验器与冻结配置）、docs/specs/prediction.md（概率唯一来源与模型门控）、docs/specs/knowledge-rag.md（引用冻结）、server/src/research/evalRunner.ts（现有执行器迁移来源）、server/src/models.ts（现有 eval_datasets/eval_runs）。
- 外部协议：FinQA <https://github.com/czyssrs/FinQA>、ConvFinQA <https://github.com/czyssrs/ConvFinQA>（可执行标准答案思想）；FinanceBench <https://huggingface.co/datasets/PatronusAI/financebench>（答案-引文-页码协议，CC-BY-NC 仅借协议）；FinBen <https://github.com/The-FinAI/FinBen> / PIXIU <https://github.com/The-FinAI/PIXIU>（回归旁路与任务注册思想）；RAGTruth <https://github.com/ParticleMedia/RAGTruth>（词级幻觉标注方法）；Qwen DianJin / Fin-PRM <https://github.com/aliyun/qwen-dianjin>（过程奖励模型仅作辅助信号）；TradingAgents <https://github.com/TauricResearch/TradingAgents>（point-in-time 纪律）；ai-hedge-fund <https://github.com/virattt/ai-hedge-fund>（审计归档与宁停勿错哲学）。
