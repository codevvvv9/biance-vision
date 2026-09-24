# Biance Vision · 币安大盘监控终端

暗色科技风的币安（Binance）行情监控网站：实时大盘行情、历史 K 线、价格突破 / 涨跌幅预警，触发时页面弹窗 + 系统通知 + 提示音 + Webhook 实时推送。

## 技术栈

- **语言**：全栈 TypeScript（strict 模式），`pnpm typecheck` 一键检查
- **前端**：React 18 + Vite 5 + [klinecharts 9.8](https://klinecharts.com)（K 线图）+ React Router
- **后端**：Node.js + Fastify 4 + @fastify/websocket（开发用 `tsx watch`，生产 `tsc` 编译到 `dist/`）
- **存储**：Drizzle ORM + PostgreSQL 17（Docker，5434 端口）为主存储，JSON 文件为镜像与降级备份
- **数据源**：Binance 公开接口（免费、无需 API Key）
  - REST：`data-api.binance.vision`（K 线、24h 行情，多主机自动回退）
  - WebSocket：`!miniTicker@arr` 全市场行情流（每秒推送，涨跌幅由 `(close-open)/open` 计算）+ 按需订阅 `symbol@kline_{interval}` 实时 K 线

## 快速开始

```bash
pnpm install          # 安装依赖（npm workspaces 也兼容，但建议统一 pnpm）
docker compose up -d  # 启动 PostgreSQL（可选；不启动则自动降级为 JSON 文件存储）
pnpm dev              # 启动器自动探测端口，被占用则自动换端口
```

打开启动日志里给出的地址（默认 http://localhost:17834）。

启动器（`scripts/dev.js`）行为：
- 后端从 3200、前端从 17834 开始探测（lsof + 试绑定双重检测），被占用就自动 +1 递增，最多尝试 100 个
- 前端代理会自动指向后端实际端口，两端联动，无需手动改配置
- 也可手动指定起点：`PORT=3300 npm run dev`
- 任一进程崩溃会停掉全部，Ctrl+C 一键停止

> 若浏览器访问前端端口被公司网关劫持（重定向到登录页），用 `BV_WEB_PORT=xxxx npm run dev` 换一个冷门端口。

单独启动：

```bash
npm run dev:server   # 后端 API + WebSocket，http://127.0.0.1:3200（tsx watch 热重启）
npm run dev:web      # 前端开发服务器
npm run typecheck    # 服务端 + 前端 TypeScript 类型检查
npm run build        # 服务端 tsc 编译 + 前端生产构建
npm run start        # 只启动后端（生产模式，运行 dist/ 编译产物）
```

## 功能

### 0. 登录（全站鉴权）
- 打开任意页面未登录时自动跳转 `/login`；所有 `/api/*`（除 `/api/health`、`/api/auth/*`）与 `/ws` 均要求有效会话
- 会话基于 HttpOnly Cookie（7 天有效），服务重启不掉线（`server/data/sessions.json` 镜像）
- **不开放自助注册**：`/register` 页面仅提示联系超级管理员；新账号由管理员在服务端执行脚本创建（见下）
- 密码使用 scrypt + 随机盐哈希存储，不存明文
- 内置账号（首次启动自动写入）：`xxx`（普通用户）、`xxx`（超级管理员，密码 `xxx`）
- 添加用户 / 修改密码脚本：

```bash
pnpm user:add <用户名> [密码] [--super]  # --super 创建超级管理员；密码省略则生成 12 位随机密码
pnpm user:passwd <用户名> [新密码]        # 改密码；省略则生成随机密码；改后该用户所有会话立即失效
# 例：pnpm user:add zhangsan pass1234
# 写入 users.json + PostgreSQL，正在运行的服务自动热加载，无需重启
```

### 1. 大盘总览（/）
- 顶部 BTC/ETH/BNB 快价 + 连接状态 + 系统通知/提示音开关
- 实时行情滚动条（成交额前 22，悬停暂停）
- 统计卡片：BTC/ETH 价格、市场情绪（涨跌家数比例条）、24h 总成交额
- K 线图：蜡烛 + MA(7/25/99) + 成交量，1m~日线 六档周期，点击行情表行即可切换交易对，实时增量更新
- 行情表：成交额前 150 的 USDT 交易对，搜索、点列排序、价格跳动闪烁

### 2. 异动榜（/movers）
- 可配置 24h 涨跌幅阈值（0.5%~20% 滑块），涨幅榜 / 跌幅榜
- 「新上榜推送」开启后，某个币首次冲进阈值榜单时弹窗提醒（落榜后再次上榜才会再提醒）

### 3. 预警中心（/alerts）
- 规则类型：**价格突破 / 价格跌破 / 24h 涨幅超过 / 24h 跌幅超过**，可配交易对、目标值、备注，随时启停/删除
- 触发逻辑（服务端每秒评估）：
  - 价格类按「突破/跌破」**边缘触发**：创建时若价格已在目标位另一侧，需回落复位后再次突破才提醒，避免重复轰炸
  - 涨跌幅类在超过阈值时立即提醒一次，回落低于阈值后重新布防
- 触发推送四件套：页面右下角弹窗 + 浏览器系统通知（需授权，点顶栏铃铛）+ WebAudio 提示音 + Webhook
- 触发历史持久化（最近 200 条）

### 4. Webhook 推送接口
预警设置里填一个 URL（如 Server 酱、企业微信/飞书机器人中转），触发时服务端会 POST：

```json
{ "event": "alert.fired", "data": { "symbol": "BTCUSDT", "message": "BTCUSDT 突破 90,000，现价 90,012.5，24h +3.20%", "price": 90012.5, "changePct": 3.2, "triggeredAt": 1790143121341 } }
```

## 存储架构（PostgreSQL 主 + JSON 镜像）

预警规则、触发历史、Webhook 设置、登录用户均采用双写存储：

| 场景 | 行为 |
|---|---|
| 数据库可用 | 每次变更同时写 PostgreSQL 和 `server/data/*.json`；启动时自动执行迁移建表，首次接入自动把 JSON 存量导入 |
| 数据库宕机/未启动 | 自动降级为纯 JSON 运行（功能完全可用，启动日志有黄色提示），变更只写 JSON |
| 数据库恢复重启 | 按规则 id 合并：宕机期间新增/修改的规则保留（JSON 必更新），期间删除的移除；历史按 id 并集合并 |

- 数据库连接：`DATABASE_URL`（默认 `postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision`，与 docker-compose 一致；可在 `server/.env` 覆盖，参考 `server/.env.example`）
- 表结构：`server/src/models.ts`（alert_rules / alert_history / app_settings / users），迁移文件在 `server/drizzle/`
- 数据库脚本（server workspace）：`db:generate`（改表生成迁移）/ `db:migrate` / `db:push` / `db:studio`（可视化查库）
- `/api/health` 的 `storage` 字段显示当前存储模式（`postgres` / `json`）
- 前端偏好（异动榜阈值、提示音等）仍在浏览器 localStorage

## 目录结构

```text
biance-vision/
├── docker-compose.yml      # PostgreSQL 17（5434，避让本机 5432/5433）
├── docker/postgres-init.sql# 初始化非超管角色 biance_app
├── pnpm-workspace.yaml
├── scripts/dev.ts          # 开发启动器：端口探测/自动切换/进程管理/数据库提示
├── scripts/add-user.ts     # 添加登录用户（pnpm user:add <用户名> [密码] [--super]）
├── scripts/passwd.ts       # 修改登录密码（pnpm user:passwd <用户名> [新密码]）
├── server/                 # Fastify 后端（TypeScript, NodeNext）
│   ├── drizzle/            # drizzle-kit 生成的 SQL 迁移（启动时自动执行）
│   ├── drizzle.config.ts
│   ├── src/
│   │   ├── index.ts        # REST 路由 / 登录鉴权 / 前端 WS / 行情广播
│   │   ├── binance.ts      # 币安 REST 客户端 + 行情流管理（动态订阅/断线重连）
│   │   ├── alerts.ts       # 预警规则、边缘触发评估、历史、Webhook、存储初始化
│   │   ├── users.ts        # 登录用户（scrypt 哈希）+ Cookie 会话，JSON 热加载
│   │   ├── db.ts           # Drizzle 连接 + PostgreSQL/JSON 双写数据访问层
│   │   ├── models.ts       # drizzle 表定义（alert_rules / alert_history / app_settings / users）
│   │   ├── store.ts        # JSON 文件持久化
│   │   └── types.ts        # 服务端数据结构定义
│   └── data/               # JSON 镜像：rules.json / history.json / settings.json / users.json / sessions.json
└── web/                     # React 前端（TypeScript + Vite）
    └── src/
        ├── types.ts                     # 前端数据结构定义（与服务端对应）
        ├── market/MarketContext.tsx     # 全局状态：WS 连接/行情/弹窗/K线订阅分发
        ├── components/                  # Header / TickerTape / StatCards / MarketTable / KlineChart / Toasts
        └── pages/                       # Dashboard / MoversPage / AlertsPage
```

## API 一览（后端 :3200）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 登录（用户名 + 密码，成功后下发会话 Cookie） |
| POST | `/api/auth/logout` | 退出登录（销毁会话） |
| GET | `/api/auth/me` | 当前登录用户信息 |
| GET | `/api/health` | 健康检查（币安流连接状态、缓存交易对数、存储模式） |
| GET | `/api/tickers?limit=100` | 24h 行情快照（按成交额降序，**需登录**，下同） |
| GET | `/api/klines?symbol=&interval=&limit=` | 历史 K 线 |
| GET/POST/PUT/DELETE | `/api/alerts` | 预警规则 CRUD |
| GET | `/api/alerts/history?limit=50` | 触发历史 |
| GET/PUT | `/api/settings` | Webhook 设置 |
| POST | `/api/settings/test` | 发送测试推送 |
| WS | `/ws` | 前端实时通道：`market` 行情每秒推、`kline` 按需订阅、`alert` 预警推送（需登录，未登录以 4001 关闭） |

## 说明

- 仅使用币安**公开行情接口**，不涉及下单/账户，无需 API Key
- K 线数据使用 klinecharts 9.8（注意该版本 KLineData 字段为 `timestamp` 而非旧版 `time`）
- 仅供学习研究，不构成投资建议
