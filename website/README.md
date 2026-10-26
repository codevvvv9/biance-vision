# DuckStrat 公开官网

独立 Next.js App Router / React 19 应用；现有终端继续使用 React 18。

## URL 与部署边界

官网与终端共用**既有用户域名**，域名由 `WEBSITE_ORIGIN` 配置。没有新增终端子域名，也不把当前部署地址写死在代码内。

| 路径 | 服务 |
| --- | --- |
| `/` | Next 按 Accept-Language → 可信 IPv4 地域 → 英文选择语言，302，禁止缓存 |
| `/en`、`/zh` 及其内容页 | Next，公开内容预生成；联系页动态读取公开配置 |
| `/dashboard`、`/research`、`/brooks`、`/movers`、`/alerts`、`/login`、`/register` | 原 React SPA / Fastify，按会话鉴权 |
| `/api/*`、`/ws`、`/assets/*` | 原用户服务；管理路径优先 404 |
| 未知路径 | Next，真实 404 |
| 独立管理域名 | 既有 Basic Auth + 独立 admin-api，不变 |

`WEBSITE_ORIGIN` 在**构建和运行时使用相同值**，发布流程使用 GitHub 仓库变量 `WEBSITE_ORIGIN`。更改 origin 后重新构建官网，使静态 canonical、hreflang、sitemap 和分享图片一致。官网进程不读取登录 Cookie，不设置会话 Cookie，不依赖研究 API。`Path=/` 的 Cookie 仍由浏览器发送到同域官网，应用不会据此改变公开内容；当前没有新增 Caddy HTML 缓存。

## 本地查看

在仓库根目录执行 `pnpm install --frozen-lockfile`，然后执行 `pnpm dev:website`；官网地址为 `http://localhost:3100/en` 或 `/zh`。此端口只用于官网预览，完整登录链路使用下方同源网关。

另一个终端执行 `pnpm dev` 启动原 API 与 Vite，再运行：

```sh
docker run --rm --name bv-website-dev \
  -p 127.0.0.1:3310:3310 -p 127.0.0.1:3311:3311 \
  -v "$PWD/deploy/local/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2
```

完整用户入口为 `http://localhost:3310/en`。启动器如果自动切换 API / Vite 端口，请向该 Docker 命令传入 `-e BV_API_PORT=实际端口 -e BV_WEB_PORT=实际端口`。本地管理端使用另起的 admin-api（3201）与 admin Vite（17835），网关入口为 `http://localhost:3311/admin`，需要独立管理会话。生产仅使用 VPS / Oracle 配置；本地 Vite 专属路径不进入生产。

## 联系方式

管理端“官网联系方式”保存 Telegram 用户名及公开邮箱。admin-api 原子写入 `server/data/website-public/contact.json`；官网只读挂载这一子目录。**禁止挂载整个 `server/data`**，里面有账号、会话和 AI Key。

联系页与 `/site-config.json` 每次读取该公开快照，不需重建官网；损坏或暂不可读时沿用进程内最后有效值，首次启动使用环境配置或用户提供的邮箱 `codevvvv9@gmail.com`。Telegram 未配置时显示明确占位；配置后生成同一 `t.me` 地址的按钮、复制用户名和桌面二维码，不调用外部二维码服务。页脚链接统一指向联系页，避免静态页保留旧联系方式。

`WEBSITE_PUBLIC_CONFIG_DIR` 可覆盖只读目录。生产 compose 已配置独立挂载；官网容器无数据库凭据、AI Key 或用户目录访问权限。Caddy 专属入口传入客户端 IP，Next 端口仅绑回环，`WEBSITE_TRUST_PROXY=1` 才读取该头；IPv4 名单是已公开的 CIDR 文件，更新后应重新构建官网镜像。

## 验证

```sh
pnpm website:check
pnpm build:website
pnpm website:browser-check
WEBSITE_GATEWAY_TEST_URL=http://localhost:3310 WEBSITE_ADMIN_TEST_URL=http://localhost:3311 pnpm website:browser-check
pnpm access:check
```

浏览器检查在 macOS 使用已安装 Chrome，其他平台运行 `pnpm --dir website exec playwright install chromium`，也可设置 `CHROME_PATH`。终端衔接检查需本地网关，API 使用受控响应；并发硬额度检查另建临时 PostgreSQL 数据库与数据目录，不使用真实模型 Key。完整发布仍需原有 `pnpm release:gate`、真实账号/worker 验证、用户试用和部署资源检查。

生产构建用 `website/Dockerfile`（standalone），运行 `node --import ./website/runtime/origin-guard.mjs --import ./website/runtime/access-log.mjs website/server.js`。普通 `pnpm --dir website start` 用于本地构建预览，生产不使用 `next start`。发布前执行 `WEBSITE_ORIGIN=https://既有用户域名 pnpm --dir website check:release`，并在实际部署核查联系渠道、同域路由、管理隔离、SSE、WebSocket、地区策略和资源预算。


## GEO/SGO 内容维护与观测

正文在 `content/en` 与 `content/zh` 的可信 MDX 中；`content/manifest.json` 显式配对翻译，维护标题、摘要、主题、署名、核对日期、实质修改日期、来源和发布状态。新增文章需要同一 ID 的双语内容；只在实质修改时更新日期。`draft` 不进入公开路由、Sitemap、正文加载表或日志白名单，不应使用私有研究内容作为任何状态的官网 MDX。

`pnpm --dir website check:content` 校验清单 / 正文 / CIDR 并生成加载表与日志白名单；`build` 自动先运行此检查。MDX 不从 URL、用户上传或私有知识库加载。来源注册表在 `lib/publications.ts`，原创图例在 `components/ResearchFigure.tsx`，页面直接输出 HTML，无 JS 也可读。

Google / Bing meta 验证值分别通过公开构建参数 `GOOGLE_SITE_VERIFICATION`、`BING_SITE_VERIFICATION` 注入；Compose 与发版 workflow 同时支持。无需 meta 验证时留空。站长平台账户、密码、OAuth 凭据不能放入这两个公开标签。Sitemap 与 canonical 仍只使用同一个 `WEBSITE_ORIGIN`；构建与运行的 origin 必须一致。

生产默认启用 `WEBSITE_ACCESS_LOG_DIR=/app/website-logs`，写入专用 volume，14 天保留、总计 20 MiB、单文件 1 MiB、256 条队列上限。只记已批准的公开页面 GET/HEAD，六个字段；无 IP / 查询参数 / 请求头 / Cookie / 正文。分块大小为 null，HEAD 为 0；日志故障不阻断响应。本地缺省未设目录时不开启。日志不可作为用户计数或付费转化统计。

固定 12 题在 `evaluation/prompts.json`。可执行 `pnpm --dir website exec tsx scripts/prepare-observations.ts baseline /absolute/new.csv`，生成 48 行未观测表；独立会话人工填写实际证据，不以脚本生成表格冒充已检查平台。生产提交与复查步骤、技术 QA、待执行的站长 / 真实用户任务见 [GEO/SGO QA](../docs/references/website-geo-sgo-qa-2026-10-24.md)。


## DuckStrat 品牌与首屏

公开名称、定位、承诺和原创鸭子轮廓由 `@biance/brand/identity` 维护，兼容 React 18/19。
`check:release` 与 `build` 都检查当前文案无旧品牌残留、SVG 副本一致；历史材料不在扫描范围。
首屏采用 SVG + Motion；三段叙事仅播放一次，支持暂停/重播、键盘和触控。
离开视口或切到后台暂停；减少动态效果、无 JS 或可选动画模块失败时展示静态结尾。
全部内容为品牌教学示意，不调用行情/研究 API。来源和验收见 `docs/duckstrat-brand.md`。

构建产生 `.next/build-identity.json`；生产镜像嵌入该身份并在启动前校验运行时 origin。
只修改容器环境不能替换静态页面中的旧 origin；发现不一致应重新构建，不能跳过守卫。
