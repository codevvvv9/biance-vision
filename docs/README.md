# 文档索引

本目录收录 Brooks 金融研究 Agent 的全部文档。**规范性内容以 `docs/specs/` 为准**；历史文档保留调研价值，但与 spec 冲突时以 spec 为准。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [user-manual-v2.md](user-manual-v2.md) | **用户手册 v2（v0.9.x 现行界面）**：双语切换、经典版/新版研究工作台双布局、三场景操作、翻译三种用法（消息按钮/会话指令/slash）、异常与 FAQ |
| [admin-manual-v2.md](admin-manual-v2.md) | **管理手册 v2（v0.9.x 现行界面）**：六页后台速查、提示词与文案页（八模板版本治理/免责/输入配置）、翻译能力运维、意图升级红线 |
| [knowledge-rag-guide.md](knowledge-rag-guide.md) | **知识库 RAG 完全指南**：上传 Brooks PDF → 解析(Docling) → 切分/向量化 → 发布(知识版本) → 三层检索(RRF+精排) → 证据引用全链路逐步讲解 + 批量导入最佳实践 |
| [user-manual.md](user-manual.md) | 用户手册 v0.8 版：三场景操作细节与 AI Brooks 原理展开（v2 保留索引） |
| [admin-manual.md](admin-manual.md) | 管理手册 v0.8 版：AI 设置/管控/知识库/Agent/评测完整操作（v2 保留索引） |

## specs（正式规格）

每份 spec 顶部带状态标记（`planned` / `partial` / `implemented` / `verified`），结构与流转规则见 [specs/README.md](specs/README.md)。状态以 [specs/README.md](specs/README.md) 索引为权威源，本表与其保持一致。

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [specs/product.md](specs/product.md) | 产品定位、用户角色、永续/事件/教学三类研究流程、支持边界与术语表 | planned |
| [specs/architecture.md](specs/architecture.md) | 六服务进程拓扑、模块职责、分析时序、Lumen 复用映射、技术选型与 OCP 扩展点 | implemented |
| [specs/market-data.md](specs/market-data.md) | K 线契约、现货/永续分存、收盘约束、幂等写入、补洞游标、快照与数据质量 | implemented |
| [specs/brooks-engine.md](specs/brooks-engine.md) | Brooks 结构引擎：规则来源分级、三层状态机、knownAt、失效事件与因果性纪律 | implemented |
| [specs/perpetual.md](specs/perpetual.md) | 永续研究：结构化持仓输入、计划盈亏矩阵、费用、资金费率情景与仓位上限 | partial |
| [specs/event-contracts.md](specs/event-contracts.md) | 事件合约：手动报价字段、EV 与盈亏平衡、期限桶匹配、到期结算与研究模式 | partial |
| [specs/prediction.md](specs/prediction.md) | 统计预测：特征/标签、分位数梯度提升、样本划分、校准报告与模型注册表 | partial |
| [specs/knowledge-rag.md](specs/knowledge-rag.md) | 知识库与 RAG：三类资料层、三种导入通道、解析、规则卡、混合检索与引用冻结 | implemented |
| [specs/agent-orchestration.md](specs/agent-orchestration.md) | Agent 编排：查询规划、问题路由、固定流水线、三角色、预算、校验器与失败恢复 | partial |
| [specs/ui.md](specs/ui.md) | 研究工作台布局、永续/事件表单与结果卡、证据联动、异常状态与移动端 | partial |
| [specs/api-storage.md](specs/api-storage.md) | 新 API 族端点、SSE 事件协议、共享 zod schema、实体清单与迁移策略 | partial |
| [specs/admin-security.md](specs/admin-security.md) | Admin 能力配置、知识绑定、发布版本、密钥管理、授权模型与审计 | partial |
| [specs/evaluation-deployment.md](specs/evaluation-deployment.md) | 测试集、评测指标、回放口径、上线门槛、Docker Compose 部署与监控恢复 | partial |

## 设计方案

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [website-nextjs-architecture-plan.md](website-nextjs-architecture-plan.md) | Next.js 双语官网与 SEO；含获客演示、人工联系开通、草稿与中断恢复、终端首次研究，以及 W3 排期、部署边界和技术 / 用户试用验收 | implemented，首版本地验收中，未部署（同域路径分流） |
| [website-geo-sgo-implementation-plan.md](website-geo-sgo-implementation-plan.md) | GEO/SGO：双语身份 / 方法 / 深入指南 / 独立案例、抓取、语言、日志与 12 题观测 | 工程已实现；未部署，平台 / 用户验收待执行 |
| [website-geo-sgo-qa-2026-10-24.md](references/website-geo-sgo-qa-2026-10-24.md) | GEO/SGO 内容、生产构建、日志隐私、浏览器验证与观测边界 | 本地验收记录；AI 引用未观测 |
| [website-implementation-qa-2026-10-24.md](references/website-implementation-qa-2026-10-24.md) | 首版官网、同域入口、人工开通与硬额度本地验收记录 | 本地检查通过；完整发布门槛阻塞，未部署 |

## references（参考资料）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [references/brooks-sources.md](references/brooks-sources.md) | Brooks 官方资料入口清单：资料类型、访问方式、来源等级、核验日期与使用范围 | 参考资料，不参与状态流转 |
| [references/financial-agent-patterns.md](references/financial-agent-patterns.md) | 开源金融 Agent（TradingAgents/FinRobot/Freqtrade/FinRL）与公开产品的模式研究及适配差异 | 参考资料，不参与状态流转 |
| [references/binance-products-and-apis.md](references/binance-products-and-apis.md) | 币安现货与 USDⓈ-M 永续 API 端点契约、限流说明、事件合约无 API 的限制依据 | 参考资料，不参与状态流转 |
| [references/knowledge-source-manifest.json](references/knowledge-source-manifest.json) | Admin 批量导入用的资料清单初值（JSON，合法可解析） | 参考资料，不参与状态流转 |

## 历史文档

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [brooks-agent-architecture.md](brooks-agent-architecture.md) | 2026-09-30 的初版设计方案。调研结论与问题清单仍然有效；**其规范性内容已被 `docs/specs/` 最终方案替代**（逐节映射见文首状态说明） | 已归档，保留调研价值 |
| [brooks-agent-improvement-plan.md](brooks-agent-improvement-plan.md) | 2026-10-08 的最终改进方案：会话层、统一业务服务、预测目标纠正与交付验收；实际完成状态以 [specs/README.md](specs/README.md) 索引管理 | 现行改进方案 |
| [brooks-price-action-manual.md](brooks-price-action-manual.md) | Brooks 价格行为理论手册与现有引擎规则映射底稿；其中经验统计数值仅为 Brooks 美股股指期货口径，不构成本工具预测胜率 | 保留 |
