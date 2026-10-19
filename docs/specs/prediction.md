# Spec：预测与校准（prediction）

> 状态：partial

> 评审修复（2026-10-13，F2/F8）：(F2) 事件预测参考价与起点一致——`predictForTarget` 的 `indexRefPrice` 优先消费快照冻结的实时指数参考价（snapshot 阶段 ≤5s 时效门控），历史复盘落回输入包内 asOf 前最后收盘（与 asOf 起点一致）；`marketSnapshot` 时效检查从仅 trade 扩展到预测实际消费的 index 基础周期，并新增 index 特征窗口缺口检查。(F8) 特征窗口下限修正：`MIN_BARS` 240→241（`ret_240` 需 `closes[i-240]`，恰 240 根时静默补零已修复）；`stages.ts` 两处 `< 240` 门槛改引用 `MIN_BARS` 常量同源。回归锚点：`scripts/p1-regression-check.ts` [评审 F8]。

> 修复验收（2026-10-09 九轮，P1）：校准映射真正落地并闭环——(1) 训练时在 calibration split 拟合 **isotonic 分位 level 重映射**（名义分位水平 → 经验覆盖率，`research-py/app/modeling.py` `_fit_level_calibrator`），随工件持久化（`calibrator` 字段）；映射未拟合（calibration 样本 <2）→ 训练 gateFails，不进 candidate。(2) 推理应用——`/tasks/predict` 返回 `calibratedQuantiles`（重映射后 level→预测值），py 端 probabilityUp 与 Node 端 EV/三分支/方向概率内插（`prediction.ts predictForTarget`）全部用校准后网格；旧工件无映射时恒等退化（calibratedQuantiles=原始网格）。(3) 发布门控——`confirmCalibrationAndPublish` 第四重验证：工件探测响应 `calibration.kind==='isotonic'` 且 `calRows≥gate.cal`，无映射工件即使指标达标也拒绝发布（隔离验证：手工去除 calibrator 的工件 predict 返回 calibration=null → 拒绝）。六轮验收记录中「isotonic 等校准未落地时没有可验证产物」自此由代码保证而非仅依赖指标缺失。回归锚点见 `scripts/p1-regression-check.ts` [九轮-4]。

> 修复验收（2026-10-09 八轮）：(C1) 流水线预测落库——事件/方向研究的概率产出写入 `predictions` 表（特征向量与 snapshotId 随记录冻结），结果 `probabilityBlock.predictionId` 回填。(C2) `GET /api/predictions/stats`——`summarizePredictionStats` 纯函数按 estimated/user_confirmed 两轨分列命中率（预测方向=probabilityUp≥0.5?'above':'below'；tie 恒不算命中；空轨 hitRate=null；回归锚点见 `scripts/p1-regression-check.ts` [八轮-C2]）。(C5) 模型状态契约对齐——`PredictionModelInfoSchema.status` 改为 `training|candidate|published|retired`（与注册表实际状态机一致），`toModelInfo` 去 `as` 强转改 zod parse。(C6) 注释纠偏——分位网格实为 research-py 训练默认 `[0.05,0.1,0.25,0.5,0.75,0.9,0.95]`（modeling.py），超出网格首尾覆盖的阈值 → null（tail_unvalidated），此前注释误写 .01~.99。

> 修复验收（2026-10-08 六轮，P1）：校准确认三重代码验证闭环——confirmCalibrationAndPublish 不再只看 status：(1) 注册表 metrics 复验（ECE≤0.05、90% 覆盖 85–95%、Brier 改善>0 且 bootstrap 下界>0、test/calibration 样本量达标，缺任一指标=校准未完成 → 拒绝）；(2) research-py /tasks/predict 工件可用性验证（工件丢失/损坏 → 拒绝）；(3) 通过后回写 metrics.calibrationConfirmedAt 可追溯。isotonic 等校准未落地时没有可验证产物，无法通过该接口发布。

> 修复验收（2026-10-08 三轮，P1）：(1) 三分支互斥概率——结算精度已知时 probabilityUp=P(高于平价区间上界)、pTie=平价区间、pDown=1−pUp−pTie，由 `mutuallyExclusiveThreeWay` 从同一结算规则生成（`probabilityUp` 不再取执行价中心阈值，平价不得被双重计入制造虚假正 EV；回归锚点 0.49/0.02/0.49 → EV=0，见 `scripts/p1-regression-check.ts`）；精度未知时 probabilityUp 保持中心阈值仅作研究展示，pTie=null → EV 禁用不变。(2) 周期统一——featureVersion 由 `featureVersionFor(horizon, targetType)` 唯一生成并编码基础周期（fv-evt-r-1m / fv-dir-x-1h 等），训练（training.ts）、流水线（stages.ts 按期限取指数/成交序列）与预测 API（productRoutes.ts）三处同源；模型注册表新增 `baseInterval` 列参与门控，1d/1w 事件的指数特征在 1h 上取（不再固定 1m）。(3) 发布门控——`trainedUntil` 记录最后样本**标签结束时间**（asOf 门控保证标签已可得），新增 `publishedAt`/`calibratedAt`：数值门槛通过只到 candidate，published 必须管理端 `POST /api/admin/models/:modelVersion/calibrate-confirm` 显式确认分布校准；回放时 `publishedAt <= asOf` 才可用（不得使用当时尚不存在的模型）。(4) 1w 不再无条件 retired——与其它期限同一门槛，方向研究（return_positive）走同一训练/发布链路；产品层保留研究模式标识。

> 修复验收（2026-10-08 二轮）：预测目标对齐事件合约——有执行价时 probabilityUp=P(到期结算价高于执行价)（分位数曲线在 strike/entry−1 处积分，probAboveFromQuantiles），无执行价才退化为 P(上涨)；特征模块按期限伸缩基础周期（10m~1h→1m，1d/1w→1h，featureVersion 编码 fv-min-1m/1h）；训练 readCandlesPaged 按目标样本数倒推取数；发布门槛=test 样本≥15 且有 Brier 才 ready（1w 恒研究档 stale）。实测 10m/1d ready（75 样本/test 17），1w stale。〔三轮起 1w 改为正常门槛，featureVersion 格式升级为 fv-{evt|dir}-{r|x}-{1m|1h}，旧格式模型被门控自然拒绝、需重训〕

> 实现状态（2026-10-01）：全链路已验证——训练管线（Node 构建数据集 + 时间切分 70/15/15 → research-py /tasks/train → 注册表 ready）经 /api/admin/models/train 触发产出 qgb-10m-001（109 样本，测试 Brier 0.408），/api/predictions 产出真实 probabilityUp=0.478；门控链任一环不可用均显式 unavailable。

## 目标

定义统计预测模块的特征、标签、模型、样本划分、校准报告、模型注册表与不可用纪律。预测概率**唯一来自本统计模块**（scikit-learn 分位数梯度提升），LLM 不生成或修改概率；模型未就绪、期限未验证、数据过期时明确返回不可用，概率字段保持为空而非编造。

## 已确定决策

- 模型形态：分位数梯度提升（scikit-learn `GradientBoostingRegressor(loss='quantile')`，多分位），训练/推理/校准报告在 `research-py` 固定 HTTP 任务端点完成（`/tasks/train`、`/tasks/predict`、`/tasks/calibration-report`），**不提供任意代码执行入口**；Node worker（pg-boss）负责编排调用。
- 特征由 Node 侧 `server/src/research/prediction/features.ts` 从冻结快照计算，`featureVersion` 随特征 schema 变更递增，特征向量随预测记录冻结保存：

| 特征类别 | 示例 | 因果约束 |
| --- | --- | --- |
| Brooks 结构 | 已确认结构事件、setup/触发状态、多周期共振 | 只用 `knownAt <= asOf` 的已确认事件 |
| 波动 | ATR、已实现波动、区间宽度 | 只用 `closeTime <= asOf` 的已收盘 K 线 |
| 收益序列 | 各窗口对数收益、动量 | 同上 |
| 多周期上下文 | 高一级周期的趋势/震荡状态 | 各周期分别取 `closeTime <= asOf` 的最后收盘 |

- 标签：到期收益分布（事件合约场景为到期时刻标的价格相对执行价的高/低及收益分布）。
- 样本划分：按时间顺序切分 dev / calibration / sealed-test；重叠标签的样本使用 purge/embargo 防止跨窗口泄漏；sealed-test 只在最终评估使用，不参与调参。
- 校准报告：分位覆盖率、Brier score、样本量、置信区间，随模型版本入库；样本量不足时如实标注，模型不进入 published。
- 期限桶：模型按期限桶（10m/30m/1h/1d/1w）分别训练与验证，适用期限写入模型注册表；期限未验证或与剩余期限不匹配（容差默认 20%）→ 返回 `unavailable`。
- Brooks 经验统计（H2≈60%、80% 规则族）是其在美股股指期货的口径，**不得作为本工具的预测胜率输出**；本地统计未验证前概率输出为空。
- 无未来泄漏：特征只能使用 `closeTime <= asOf` 的已收盘数据；因果性检查复用 `scripts/causality-check.ts` 的方法论（前缀一致性、逐根一致性、未收盘拒绝）。

## 数据与接口

- 表 `prediction_models`（模型注册表）：

| 字段 | 说明 |
| --- | --- |
| `modelVersion` | 模型版本号 |
| `featureVersion` | 配套特征版本（含基础周期：fv-evt-r-1m / fv-dir-x-1h 等） |
| `baseInterval` | 基础周期（1m/1h），与 featureVersion 一起做「期限↔周期↔特征」三元组门控 |
| `trainedUntil` | 最后样本的**标签结束时间**（asOf 门控：早于该时刻的回放不使用此模型，保证标签已可得） |
| 适用期限桶 | 10m/30m/1h/1d/1w 子集 |
| 误差与校准指标 | 分位覆盖、Brier、样本量、置信区间 |
| 状态 | training / candidate / published / retired（门槛通过=candidate；published 需校准确认） |
| `publishedAt` / `calibratedAt` | 发布与分布校准确认时刻（回放门控：`publishedAt <= asOf` 才可用） |
| 工件路径 | MinIO 中的 joblib 工件位置 |

- 表 `predictions`：`snapshotId`、`featureVersion`、`modelVersion`、冻结特征向量、概率与分位输出、`outcomeSource`（estimated|user_confirmed）。
- 模型插件：`ModelPlugin` 接口（features → 分位数分布），首版实现 `quantile-gbm`（调用 research-py）；新增模型 = 新增插件实现并注册，不改编排代码。
- 编排：worker pg-boss 任务调用 `research-py` 固定端点；训练/校准为离线任务，预测为在线任务。
- API：`/api/predictions/*`（查询预测记录与模型状态，共享 zod schema，见 `docs/specs/api-storage.md`）。

## 流程

1. 训练（离线）：worker 按期限桶收集样本（基础周期由期限决定：10m/30m/1h→1m，1d/1w→1h；训练与推理同周期）→ 计算特征（`featureVersionFor` 统一生成，编码周期）→ 生成到期收益分布标签 → 按时间切分 dev/calibration/sealed-test（重叠标签 purge/embargo）→ 调用 `research-py /tasks/train` → `/tasks/calibration-report` 产出校准报告 → 工件存 MinIO、元数据入 `prediction_models`。
2. 验证与发布（双门控）：样本外数值门槛（样本量 + Brier 优于频率基线 + bootstrap 下界>0 + ECE + 区间覆盖）通过 → candidate；未通过 → retired。candidate 需管理端显式确认分布校准（`POST /api/admin/models/:modelVersion/calibrate-confirm`）→ published（`publishedAt`/`calibratedAt` 落库）。任何一环缺失概率能力保持关闭，不得因补齐历史数据自动放开。
3. 预测（在线）：产品分析器（perp/event/1w 方向研究）请求预测 → 检查期限桶匹配、`featureVersion`+`baseInterval` 三元组、`trainedUntil<=asOf`（标签已可得）与 `publishedAt<=asOf`（模型当时已发布）、剩余期限验证范围 → 按模型基础周期从冻结快照取特征序列 → 调用 `/tasks/predict` → 概率与分位结果随 `predictions` 记录冻结。事件概率为互斥三分支（见三轮修复记录）。
4. 结算回流：到期后按 `docs/specs/event-contracts.md` 的纪律追加结果，研究估算与用户确认分别统计，作为后续训练样本的来源之一。

## 边界与失败处理

- 模型未就绪（无 published 版本覆盖该期限桶）→ 概率返回 `unavailable`，注明原因。
- 期限未验证或剩余期限超出 20% 容差 → 返回 `unavailable`，不复用其他期限模型。
- 数据过期或快照缺失 → 返回 `unavailable`；不以陈旧数据出概率。
- 样本量不足 → 校准报告如实标注，模型保持非 published。
- `research-py` 不可用 → 预测任务失败并落 `run_steps` 失败原因，界面显示实际可用状态；不影响其他研究模块。
- 特征 schema 变更 → `featureVersion` 递增（基础周期同样编码其中），旧版本模型与新特征不混用；跨周期错配（如 1h 训练模型吃 1m 特征）被版本门控直接拒绝。
- 校验器拒绝 LLM 输出中的任何概率数值；概率字段只能由本模块写入。
- 历史回放双重时点门控：`trainedUntil`（标签结束时间）与 `publishedAt`（发布时刻）都不晚于回放 asOf，否则该模型对当次回放不可见。

## 验收用例

- [ ] 特征计算只读取 `closeTime <= asOf` 的已收盘数据；因果性检查（前缀一致性、逐根一致性、未收盘拒绝）通过。
- [ ] 同一 `featureVersion` + `modelVersion` + 冻结快照重复预测，结果完全一致（可复现）。
- [ ] 样本划分按时间排序且 dev/calibration/sealed-test 无重叠标签泄漏（purge/embargo 生效）。
- [ ] 校准报告包含分位覆盖、Brier、样本量、置信区间，并随模型版本入库可查。
- [ ] 模型注册表字段齐全（特征版本/训练截止/适用期限/误差/状态/MinIO 工件路径）。
- [ ] 未就绪、期限未验证、数据过期三种场景分别返回 `unavailable` 及明确原因，概率字段为空。
- [ ] 特征 schema 变更后 `featureVersion` 递增，旧模型不被新特征调用。
- [ ] 全部输出中不出现 Brooks 经验数值充当预测胜率；LLM 编造的概率被校验器拒绝。
- [ ] `research-py` 只暴露固定任务端点，不存在任意代码执行入口。

## 参考来源

- `docs/specs/event-contracts.md`（期限桶、EV、结算纪律）
- `docs/specs/perpetual.md`（永续场景的预测消费方）
- `docs/specs/market-data.md`（快照与收盘约束）
- `docs/specs/api-storage.md`（`predictions` / `prediction_models` 实体）
- `docs/specs/evaluation-deployment.md`（样本外回放、校准门槛与上线标准）
- `docs/references/financial-agent-patterns.md`（Freqtrade 前视偏差检查、FinRL 样本划分方法的适配说明；2026-10-16 增补 Qlib RollingGen、MLflow alias/tag、mlfinpy CPCV/唯一性权重，均仅作方法论参考）
- `docs/brooks-price-action-manual.md`（Brooks 经验统计的原始口径说明）
