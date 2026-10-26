# DuckStrat

价格行为与策略研究工作台，先避风险，再做判断。提供加密货币行情监控与研究工具：币安（Binance）实时行情与 K 线、异动榜、价格预警，以及一个基于 Brooks 价格行为体系的研究 Agent（结构分析 → 知识检索 → 反证审查 → 结论发布）。

## 大致功能

- **大盘监控**：实时行情、K 线图、涨跌幅异动榜、价格突破/涨跌幅预警推送
- **研究 Agent**：围绕 BTC/ETH 等永续与事件合约的研究流水线，结论只来自代码计算与已发布知识库，附引用与证据
- **知识库**：Brooks 价格行为资料的管理、切分、混合检索与版本化发布
- **管理端**：用户/知识库/Agent 配置与提示词版本/评测的超级管理员后台

## 技术栈

全栈 TypeScript monorepo（pnpm workspace）：React + Vite 前端、Fastify + Node 后端、PostgreSQL（Drizzle ORM）、WebSocket 实时推送、Docker 部署。

## 本地运行

```bash
pnpm install
docker compose up -d postgres   # 可选；不启动则降级为 JSON 文件存储
pnpm dev
```

打开启动日志给出的地址即可（默认 http://localhost:17834）。

## 说明

- 仅使用币安公开行情接口，不涉及交易账户与下单
- 仅供学习研究，所有输出不构成投资建议
