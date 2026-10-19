# Specs 索引与约定

本目录是 Brooks 金融研究 Agent 的正式规格（spec）。实现以 spec 为准；spec 未覆盖的行为不得自行发明，先补 spec 再写代码。

## 索引

| 文件 | 分类 | 一句话 | 状态 |
| --- | --- | --- | --- |
| [product.md](product.md) | 产品与场景 | 用户角色、永续/事件/教学流程、支持范围与术语表 | planned |
| [architecture.md](architecture.md) | 系统架构 | 六服务拓扑、模块职责、分析时序、Lumen 复用映射与技术选型 | implemented |
| [market-data.md](market-data.md) | 行情数据 | 四类价格契约、收盘约束、幂等写入、补洞、快照与数据质量 | implemented |
| [brooks-engine.md](brooks-engine.md) | 结构引擎 | 规则来源分级、三层状态机、knownAt、失效事件与因果性 | implemented |
| [perpetual.md](perpetual.md) | 永续研究 | 持仓输入、动作域、计划盈亏、费用、资金费率与仓位上限 | partial |
| [event-contracts.md](event-contracts.md) | 事件合约 | 手动报价、EV/盈亏平衡、期限桶匹配、到期结算 | partial |
| [prediction.md](prediction.md) | 预测与校准 | 特征/标签、分位数 GBM、样本划分、校准与模型注册表 | partial |
| [knowledge-rag.md](knowledge-rag.md) | 知识库与 RAG | 导入、解析、规则卡、混合检索、引用与权限 | implemented |
| [agent-orchestration.md](agent-orchestration.md) | Agent 编排 | 查询规划、角色、流水线、预算、失败恢复与校验器 | partial |
| [ui.md](ui.md) | UI 与交互 | 工作台布局、表单、图表联动、移动端与异常状态 | partial |
| [api-storage.md](api-storage.md) | API 与存储 | 端点清单、SSE 协议、共享 zod schema、实体与迁移 | partial |
| [admin-security.md](admin-security.md) | Admin 与安全 | 能力配置、知识绑定、发布、密钥、授权与审计 | partial |
| [evaluation-deployment.md](evaluation-deployment.md) | 评测与部署 | 测试集、回放、上线门槛、Docker、监控与实施顺序 | partial |
| [evaluation-harness.md](evaluation-harness.md) | 评测台 | 独立评测域、确定性校验器、Subject 适配器、按条目审计与发布门禁 | planned |

## 状态流转规则

- 每份 spec 顶部一行状态标记，形如 `> 状态：planned`，可选值仅 `planned` / `partial` / `implemented` / `verified`。
- `planned`：决策已拍板，尚未实现。
- `partial`：部分实现，核心链路已通但验收用例未全部覆盖，或存在已列明的未完成项；文件内需注明剩余范围。
- `implemented`：代码已按 spec 实现，`pnpm typecheck` 与相关自测通过。
- `verified`：该 spec 的「验收用例」已逐条核对通过（含评测/回放证据）。
- 状态只允许 `planned → partial → implemented → verified` 单调前进；发现实现偏离 spec 时，先修订 spec，再改代码，不允许静默分叉。

## 七段结构约定

每份 spec 正文固定七段，标题用二级：

1. `## 目标` —— 本领域要解决什么。
2. `## 已确定决策` —— 只写已拍板的内容，决策式语句，不写待定项。
3. `## 数据与接口` —— 共享契约/表/端点的名字与关键字段，不粘贴大段代码。
4. `## 流程` —— 主要处理流程的步骤与输入输出。
5. `## 边界与失败处理` —— 明确不做什么，以及各类失败的对外行为。
6. `## 验收用例` —— `- [ ]` 形式的检查清单，可逐条核对。
7. `## 参考来源` —— 只列真实 URL 与仓库内路径，不得编造。
