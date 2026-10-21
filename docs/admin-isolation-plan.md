# 管理端域名隔离与双系统演进方案（三步走）

> 状态：定稿待执行（2026-10-21）。执行者按本文档逐步操作，**每步验收全绿才进下一步**。
> 本文是入库版：所有域名 / IP / 密码一律用占位符（`<主域名>` `<admin域名>` `<VPS_IP>` `<duckdns_token>`），
> 真实值对照表见仓库根 `LOCAL_NOTES.md`（gitignore，不入库）末尾「admin 域名隔离真实值」一节。

---

## 0. 阅读指引

### 0.1 三步总览与依赖关系

| 步骤 | 内容 | 解决什么 | 风险 | 预计工作量 | 依赖 |
|---|---|---|---|---|---|
| 第一步 | VPS 磁盘清理 | 磁盘 91% 红线：PG 写入失败/日志爆/镜像拉不动 | 低（只删未运行镜像） | 10 分钟 | 无，**立即执行** |
| 第二步 | admin 域名隔离+网络防护（方案 B）+ 2026-10-21 补丁 | 防爬虫攻击面收敛（入口/路由/登录/编码绕过） | 中（涉及一次容器重启） | 已完成（v0.9.3~v0.9.5） | 第一步 |
| 第三步 | 双系统拆分（**目标态，分批必做**） | 用户端与管理端成为独立系统：独立构建/部署/域名，用户 API 不注册任何管理能力 | 中高 | 3~4 个 PR 批次 | 第二步稳定运行 |

**关键认知**（2026-10-21 审查修正后的定论）：拆域名/拆系统提供的是**架构隔离**，网络层门禁
（Caddy Basic Auth + 主域名 404）提供**攻击面收敛**——两者都做才算达成完整目标。第二步上线后
经代码审查发现三处缺口（主站可签发超管会话、/api/ai 管理端点漏过门禁、编码路径绕过 server 门禁），
已在 v0.9.5 补丁修复（登录入口分离 + AI 端点迁入 /api/admin/ai/* + gatePath 规范化，
自测 27 项钉住）。当前安全闭环成立，但**双系统独立部署（第三步）不再是可选项**——它是原始
目标的直接要求，升格为分批必做。

### 0.2 全局红线（每一步都适用）

1. **用户在线期间禁止部署**：容器重启（`compose up -d`）会造成秒级 502/SSE 断流。执行任何涉及容器
   重启的操作前，先确认当前无用户使用（`ssh <VPS> 'docker inspect biance-vision-app --format "{{.State.StartedAt}}"'`
   对照时间，并在群内/口头确认）。`systemctl reload caddy` 是热加载，不断连接，随时可做。
2. **每步验收清单全绿才进下一步**；任何一项红，先执行该步的「回滚」小节。
3. **公开仓库纪律**：真实域名、IP、duckdns token、任何密码/哈希**绝不写入 git 追踪的文件**。
   本文档与 `deploy/` 模板只用占位符；真实值只记 `LOCAL_NOTES.md`。
4. **每一步都有独立回滚路径**，动手前先通读该步的回滚小节。
5. SSH 操作统一走别名 `bv-prod`（配置见 LOCAL_NOTES）。粘贴命令时逐条执行，不要整块盲跑。

---

## 1. 第一步：VPS 磁盘清理（立即执行）

### 1.1 现状与风险（2026-10-21 实测）

- 磁盘 40G 已用 34G（**91%**，剩 3.7G）。磁盘写满的后果：PostgreSQL 写入失败（研究运行/审计全部报错）、
  Docker 日志失败、新镜像拉不下来（发版直接卡死）。
- 元凶是 Docker 历史镜像：34 个镜像共 27.91GB，其中 **16.21GB 可回收**。大头是 research-py 的两个
  Docling 重镜像（0.9.1 = 9.54GB、0.9.2 = 10.4GB，当前运行只用 0.9.2），外加 0.6.x~0.9.1 期间每次
  发版累积的旧版 app/research-py 镜像（app 每版 335MB、research-py 轻量版每版 592MB）。
- **删本地旧镜像不影响回滚能力**：所有历史版本都在 GHCR（`ghcr.io/codevvvv9/biance-vision:<tag>` 与
  `-research-py:<tag>`），回滚=重新 pull 对应 tag（app 335MB 秒级；research-py 大版本回滚要重拉
  ~10GB，视网络几分钟到十几分钟）。

### 1.2 清理策略二选一

- **推荐（激进清理）**：删除全部未运行镜像，回收约 16.2GB。回滚靠重拉 GHCR。
- **保守（保留上一版）**：先手动保留 `0.9.1` 两个镜像作快速回滚位（多占 ~9.9GB），其余清理。
  磁盘清完后仍占 ~55%，下次发版会继续涨。**只在磁盘清完仍紧张或近期预期频繁回滚时选这个。**

### 1.3 操作步骤（逐条执行，带解释）

```bash
# ① 记录基线（验收时对比）
ssh bv-prod 'df -h / && docker system df'

# ② 确认当前运行中的 5 个容器与镜像（清理保护它们，不会被删）
ssh bv-prod 'docker ps --format "{{.Names}}  {{.Image}}  {{.Status}}"'
# 预期：biance-vision-app / worker / postgres / minio / research-py 全部 Up，
#       镜像 tag 均为 0.9.2。若有 Exited 或镜像 tag 不是最新版，停下来先弄清楚再继续。

# ③（仅保守策略）给 0.9.1 两个镜像打 keep 标记防止误删——本方案默认推荐策略，跳过此条

# ④ 清理所有未被任何容器引用的镜像（-a 连有 tag 的一起删，-f 跳过确认）
ssh bv-prod 'docker image prune -a -f'

# ⑤ 顺手清掉悬空的构建层/容器可写层残留（如有）
ssh bv-prod 'docker system prune -f'
# 注意：不带 --volumes，不会碰数据卷（pgdata/minio-data/research-models 安全）。

# ⑥ 验收读数
ssh bv-prod 'df -h / && docker system df && docker images'
```

### 1.4 长效机制（治「每次发版涨一堆」的根）

发版流程固定加一步：**`compose up -d` 成功、健康检查通过之后**，立即执行 `docker image prune -a -f`
（此刻新镜像已被容器引用，绝对安全，删的是所有旧版）。把它写进每次发版的操作习惯（deploy/vps/README
的发布步骤里已注明）；等价做法是在 VPS 加一条每周日 04:00 的 cron
`docker image prune -a -f --filter "until=168h"`（只删 7 天前创建的镜像），但发版后顺手清是主策略，
cron 是兜底，二者取一即可。

### 1.5 验收清单

- [ ] `df -h /` 使用率从 91% 降到 **≤50%**（推荐策略预期 ~18G/40G≈45%）
- [ ] `docker ps` 五个容器全部仍为 Up（清理动作零影响）
- [ ] `docker images` 只剩 5 个运行中镜像（保守策略为 7 个）
- [ ] `curl -s https://<主域名>/api/health | head -c 200` 返回正常 JSON（站点无感）
- [ ] `docker logs --tail 5 biance-vision-app` 无新增报错

---

## 2. 第二步：admin 域名隔离 + 网络防护（方案 B）

### 2.1 目标架构与流量矩阵

```
                    ┌─ https://<主域名> ──── Caddy ──┬─ 用户端页面 + /api/*（用户）
                    │                               └─ /admin*、/api/admin/* → 404（Caddy 层第一刀）
公网 ──── 443 ──────┤
                    └─ https://<admin域名> ─ Caddy ──┬─ Basic Auth 门禁（无账密=401，扫描器止步于此）
                                                    └─ 全应用（管理端 /admin + /api/admin/*）
                        server 层第二刀：Host 不在 ADMIN_HOSTS → /admin*、/api/admin/* 一律 404
                        应用层第三刀：requireSuperadmin（原有，不变）
```

| 域名 | 用户端页面 | 用户 API | admin 页面 | admin API |
|---|---|---|---|---|
| `<主域名>` | ✅ | ✅ | ❌ 404（Caddy+server 双层） | ❌ 404 |
| `<admin域名>` | ✅（Basic Auth 门内，顺手可用） | ✅（同左） | ✅ | ✅ |

设计要点：

- **两域名各自登录**：session cookie 是 host-only（无 Domain 属性），主域名与 admin 域名的登录态天然
  隔离互不串——这正是我们要的，不改。
- **admin 域名豁免地域封锁**：运营者可能从中国大陆直连 admin 域名（不挂代理），geoBlock 拦的是大陆
  IPv4。admin 域名已有 Basic Auth 门禁，应用层地域封锁对它没有意义，在 server 改动里按 Host 豁免。
- **`<admin域名>` 是 duckdns 的独立二级域名**（不是 `<主域名>` 的子域），Caddy 用常规 HTTP-01 验证
  自动签发 Let's Encrypt 证书即可，**不需要** DNS 插件/重编 Caddy（已核实宿主机 Caddy v2.11.7）。

### 2.2 已核实的事实基础（2026-10-21）

- 宿主机 Caddy v2.11.7（systemd，active），配置 `/etc/caddy/Caddyfile`，目前只有 `<主域名>` 一个站点块。
- duckdns 每周自动更新 cron 只含主域名，需补 `<admin域名>`（见 2.6 步骤⑤）。
- app 容器端口映射是 `"3200:3200"`（绑 0.0.0.0）；公网直连 `<VPS_IP>:3200` 实测不通（腾讯云安全组
  挡住），但按纵深防御仍应收口为仅本机回环（与 postgres/minio 的处理一致）。
- server 代码关键锚点（以当前 main 为准）：CORS `server/src/index.ts:275`；静态托管+SPA 回退
  `index.ts:283-292`；登录门 `index.ts:306`；`requireSuperadmin` `index.ts:642-648`；散落的超管
  端点 `/api/ai/config|test|prompt|models` `index.ts:650-721`；知识库路由注册 `index.ts:876`；
  Admin 路由注册 `index.ts:885`；geoBlock 钩子 `server/src/geoblock.ts:435-443`。
- 前端 admin 路由 `/admin/*`（`web/src/App.tsx:91`，懒加载 chunk）。

### 2.3 改动总览

一次代码 PR（入库，占位符）+ 三项线上配置（真实值只落 VPS 与 LOCAL_NOTES）：

| # | 改动 | 位置 | 性质 |
|---|---|---|---|
| 1 | server 新增 `ADMIN_HOSTS` 环境变量与 Host 门禁钩子；geoBlock 按 Host 豁免 | `server/src/` | 代码 PR |
| 2 | Caddyfile 模板更新为双站点块（含主域名 admin 404 屏蔽 + admin 域名 Basic Auth 骨架） | `deploy/vps/Caddyfile`、`deploy/oracle/` 同步 | 代码 PR（占位域名） |
| 3 | compose 覆盖层：app 端口收口回环 + 传 `ADMIN_HOSTS` | `deploy/vps/compose.override.yml`、oracle 同步 | 代码 PR |
| 4 | VPS 真实 Caddyfile 双站点块 + Basic Auth 账密 | `/etc/caddy/Caddyfile` | 线上配置 |
| 5 | duckdns cron 补第二个域名 | VPS crontab | 线上配置 |
| 6 | 发版（PR 合并 → tag → VPS 升版并带 `ADMIN_HOSTS`） | 走既有发版流程 | 线上配置 |

### 2.4 代码改动明细（PR 内容定义）

#### 2.4.1 server：Host 门禁 + geoBlock 豁免

新增 `server/src/adminGate.ts`：

```ts
/**
 * 管理端域名门禁（纵深防御第二层；第一层是 Caddy 主域名 404 屏蔽）。
 * 环境变量 ADMIN_HOSTS：逗号分隔的 host 列表（如 "admin.example.com"）。
 * - 未配置（默认）：门禁关闭，admin 路由在所有 Host 可用 —— 本地开发/未升级部署行为完全不变；
 * - 已配置：仅列出的 Host 放行 /admin* 与 /api/admin/*，其余 Host 一律 404。
 */
const ADMIN_HOSTS = (process.env.ADMIN_HOSTS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

export const adminGateEnabled = ADMIN_HOSTS.length > 0
export function isAdminHost(host: string | undefined): boolean {
  return !!host && ADMIN_HOSTS.includes(host.trim().toLowerCase())
}
```

`server/src/index.ts` 两处接线（注册顺序必须早于静态托管/路由，放在 geoBlock 注册之后紧接着）：

```ts
import { isAdminHost, adminGateEnabled } from './adminGate.js'
// ...
// ---- 管理端域名门禁：ADMIN_HOSTS 未配置时零行为变化 ----
if (adminGateEnabled) {
  app.addHook('onRequest', async (req, reply) => {
    if (isAdminHost(req.headers.host)) return
    const p = req.url.split('?')[0]
    // /api/admin 与前端路由 /admin 全部 404；注意 /admin 的 GET 不能落到 SPA 回退
    // （setNotFoundHandler 会回退 index.html），必须在这里直接短路
    if (p === '/api/admin' || p.startsWith('/api/admin/') || p === '/admin' || p.startsWith('/admin/')) {
      void reply.code(404).send({ statusCode: 404, message: 'Not Found' })
    }
  })
  log.ok('server', '管理端域名门禁已启用', kv({ hosts: ADMIN_HOSTS.join(',') }))
}
```

`server/src/geoblock.ts` 的 `registerGeoBlock` 加可选豁免回调（默认不传=行为不变）：

```ts
export function registerGeoBlock(
  app: FastifyInstance,
  ipOf: (req: FastifyRequest) => string,
  skipIf?: (req: FastifyRequest) => boolean,   // 新增：管理端域名豁免（有 Basic Auth 门禁在前）
): void {
  app.addHook('onRequest', async (req, reply) => {
    if (skipIf?.(req)) return
    const ip = ipOf(req)
    if (isRegionBlocked(ip)) replyBlocked(ip, req, reply)
  })
}
```

`index.ts` 调用处改为 `registerGeoBlock(app, clientIp, (req) => isAdminHost(req.headers.host))`。
`index.ts:891` 的 `/ws` 内嵌地域兜底同样加 `!isAdminHost(req.headers.host) &&` 前置条件。

> ⚠️ 以上为设计示意，实施时以类型检查/自测为准（`pnpm typecheck && pnpm test`，若项目有
> release:gate 则跑 `pnpm release:gate`）。验收断言（必须写成测试）：配置 ADMIN_HOSTS 后
> ①错误 Host 访问 /api/admin/users 得 404；②正确 Host 得 401/403（未登录/非超管）而非 404；
> ③未配置 ADMIN_HOSTS 时一切如旧。

#### 2.4.2 Caddyfile 模板（`deploy/vps/Caddyfile`，oracle 同步）

```caddyfile
# 用户端：admin 路径在 Caddy 层直接 404（第一层屏蔽；server 的 ADMIN_HOSTS 是第二层兜底）
bv.example.com {
	encode zstd gzip
	@admin path /admin /admin/* /api/admin /api/admin/*
	respond @admin 404
	reverse_proxy 127.0.0.1:3200 {
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}
}

# 管理端：整站在 Basic Auth 门禁之后（caddy hash-password 生成哈希；
# 真实用户名/哈希只写 VPS 上的 /etc/caddy/Caddyfile，不入库）
admin.example.com {
	encode zstd gzip
	basic_auth {
		admin <bcrypt哈希占位>
	}
	reverse_proxy 127.0.0.1:3200 {
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}
}
```

要点：`basic_auth` 是 Caddy v2.11 的指令名（`basicauth` 旧名仍兼容）；Basic Auth 盖整个站点而非仅
/api，静态资源同在门内，浏览器输一次凭据后会记住；SSE/WebSocket 不受影响（flush_interval -1 保留）。

#### 2.4.3 compose 覆盖层（`deploy/vps/compose.override.yml`，oracle 同步）

```yaml
services:
  app:
    build: !reset null
    image: ghcr.io/codevvvv9/biance-vision:${BV_VERSION:-latest}
    ports: !override
      # 收口回环：公网入口只有 Caddy 的 80/443（原先 0.0.0.0:3200 虽被安全组挡住，
      # 但按纵深防御与 postgres/minio 同标准收口，防未来安全组误开放）
      - "127.0.0.1:3200:3200"
    environment:
      ADMIN_HOSTS: ${ADMIN_HOSTS:-}
```

#### 2.4.4 可选加固（同一 PR 顺手，可拆可不做）

CORS 收紧：`index.ts:275` 的 `origin: true`（反射任意来源）改为白名单
`origin: [主域名, admin域名, http://localhost:17834]`（本地 dev 必须在列，否则 Vite dev 跨 3201/3200
调试会挂）。同源请求不受 CORS 限制，本站前端零影响。**若不确定就单独拆 PR，出问题随时可回退这一行。**

### 2.5 线上配置步骤（真实值操作，不入库）

前提：第一步磁盘清理已完成；`<admin域名>` DNS 已指向 VPS（duckdns 已确认 success）。

```bash
# ① 生成 Basic Auth 密码哈希（在 VPS 上执行；密码用强随机串，存进个人密码管理器，不落任何文档）
ssh bv-prod 'caddy hash-password'
# 提示输入两遍密码 → 输出 $2a$14$.... 的 bcrypt 哈希

# ② 编辑 /etc/caddy/Caddyfile，先只【新增】admin 站点块（此刻不动主域名块！顺序见 2.6）
#    把下面内容的 <bcrypt哈希> 替换为 ① 的输出；用户名自定（如 bvadmin）
ssh bv-prod 'sudo nano /etc/caddy/Caddyfile'
# 追加：
#   <admin域名> {
#       encode zstd gzip
#       basic_auth { bvadmin <bcrypt哈希> }
#       reverse_proxy 127.0.0.1:3200 { flush_interval -1 }
#       header { Strict-Transport-Security "max-age=31536000"
#                X-Content-Type-Options nosniff
#                Referrer-Policy no-referrer }
#   }

# ③ 校验配置语法并热加载（不断连接；首次访问 admin 域名时自动签发证书）
ssh bv-prod 'sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy'

# ④ 验证 admin 域名证书与门禁（无凭据必须 401；此处会首次触发签证书，稍等几秒再 curl）
curl -I https://<admin域名>            # 预期 HTTP/2 401
curl -I -u bvadmin:<密码> https://<admin域名>   # 预期 HTTP/2 200（回到应用）

# ⑤ duckdns cron 补第二个域名（把 domains= 参数改成两个）
ssh bv-prod 'crontab -l'
# 把  0 3 * * 1 curl -s "https://www.duckdns.org/update?domains=<主域名前缀>&token=<duckdns_token>&ip=" ...
# 改为 domains=<主域名前缀>,<admin域名前缀>（duckdns 支持逗号分隔），crontab -e 编辑后 crontab -l 复核

# ⑥ 发版：走既有流程（PR 合并 main → 打 tag v0.x.y → Release 工作流出镜像），
#    VPS 升版时带上 ADMIN_HOSTS（deploy 命令示例）：
ssh bv-prod 'cd ~/biance-vision && BV_VERSION=0.x.y ADMIN_HOSTS=<admin域名> \
  docker compose -f docker-compose.yml -f deploy/vps/compose.override.yml pull && \
  BV_VERSION=0.x.y ADMIN_HOSTS=<admin域名> \
  docker compose -f docker-compose.yml -f deploy/vps/compose.override.yml up -d'
# ❗ up -d 会重启 app 容器（秒级 502）：确认无用户在线再执行（红线 0.2-1）
# ❗ 建议把 ADMIN_HOSTS= 写进 VPS 上 ~/biance-vision/.env（compose 自动读），以后发版不用每次带

# ⑦ 最后一步：主域名块加 404 屏蔽（此刻 admin 域名已全通，才敢关主域名入口）
ssh bv-prod 'sudo nano /etc/caddy/Caddyfile'
# 在主域名块内 reverse_proxy 之前插入两行：
#   @adminpath path /admin /admin/* /api/admin /api/admin/*
#   respond @adminpath 404
ssh bv-prod 'sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

### 2.6 操作顺序（为什么是这个顺序）

**新增 admin 入口 → 验证全通 → 发版启用 server 门禁 → 最后才关主域名入口。** 任意时刻超管都至少有
一个可用入口，不会把自己锁在门外。第⑦步之前，即使 server 门禁配置失误，主域名 /admin 仍可进（救生通道）。

### 2.7 验收清单

安全验收（核心）：

- [ ] `curl -s -o /dev/null -w "%{http_code}" https://<主域名>/admin` → **404**（Caddy 层）
- [ ] `curl -s -o /dev/null -w "%{http_code}" https://<主域名>/api/admin/users` → **404**
- [ ] `curl -s -o /dev/null -w "%{http_code}" https://<主域名>/admin/anything/deep` → **404**
- [ ] 绕过 Caddy 直连 `curl http://<VPS_IP>:3200/api/admin/users` → 连接超时（端口已收回环）
- [ ] `curl -I https://<admin域名>` → **401**（无账密止步）
- [ ] 错误账密 `curl -I -u bvadmin:wrong https://<admin域名>` → **401**
- [ ] 浏览器开 `https://<admin域名>`：弹原生账密框 → 输入后到应用登录页 → admin 账号登录 →
      `/admin` 六页逐页能开（知识库列表、Agent、评测、审计…）
- [ ] admin 域名 HTTPS 证书正常（地址栏无告警；`curl -vI https://<admin域名> 2>&1 | grep -i expire`）

功能无回归（用户端）：

- [ ] 主域名：普通账号登录、大盘总览、行情 WS 推送（K 线有数据）、研究终端跑一轮完整 run 出结果卡
- [ ] 主域名 SSE 正常（研究运行进度条实时推进，非卡死后一次性出）
- [ ] admin 域名下 geoBlock 豁免生效：大陆网络直连 admin 域名，过 Basic Auth 后**不出现**地域拦截页
- [ ] 主域名地域封锁仍生效：大陆 IP 访问主域名仍 403（拦截页/JSON 双形态任一）
- [ ] `docker logs --tail 30 biance-vision-app` 出现「管理端域名门禁已启用」且无报错
- [ ] `crontab -l` 已含两个域名的 duckdns 更新

### 2.8 回滚

| 症状 | 回滚动作 |
|---|---|
| admin 域名 401 之外全挂/证书签不出 | `sudo nano /etc/caddy/Caddyfile` 删 admin 站点块 → `systemctl reload caddy`；主域名未动过（第⑦步前），秒回原状 |
| server 门禁误伤（admin 打不开/用户端异常） | VPS 上去掉 `ADMIN_HOSTS` 环境变量重新 `up -d`（或临时 `docker exec -e ...` 不行就重启容器），代码层未配置=门禁关闭零影响 |
| 主域名屏蔽误伤 | 删主域名块里 `@adminpath` 两行 → reload（秒级恢复） |
| 整个发版有问题 | 按既有流程回退 BV_VERSION 到上一 tag 重拉（磁盘第一步已清，空间充足） |

---

## 3. 第三步：双系统拆分（目标态，分批必做）

> **定位（2026-10-21 审查修正）**：本步是原始目标「管理端和用户端成为独立系统」的直接要求，
> 不再是安全增强的可选项。第二步+v0.9.5 补丁已把攻击面收敛到网络层门禁之后，本步解决的是
> **代码与部署层的彻底分离**：用户 API 不注册任何管理能力，管理会话不能在用户入口签发，
> 两端独立构建、独立部署、独立配置域名。

### 3.1 目标架构（四包 + 公共包）

```
pnpm workspace
├─ packages/shared（现 shared，保留）     契约（zod schema）+ 领域代码（Brooks 引擎）
├─ packages/shared-ui（新）               两端共用的 UI 组件（fx/ 动效、MiniMarkdown、
│                                        Dropdown/Combobox、登录壳样式体系）——从 web 下沉
├─ apps/user-web（现 web 瘦身）           用户端前端：无 /admin 路由、无 admin chunk、无 AiSettingsModal
├─ apps/admin-web（新）                   管理端前端：独立入口（admin-main），六页 + AI 设置
├─ apps/user-api（现 server index.ts）    用户 API：不注册 registerAdminRoutes/
│                                        registerKnowledgeRoutes/管理 AI 端点，托管 user-web 产物
└─ apps/admin-api（新入口）               管理 API：auth + health + admin/knowledge/AI 配置，
                                         托管 admin-web 产物；登录入口策略固定为「仅超管」
```

共享基础设施：PostgreSQL / MinIO / pg-boss 队列 / worker 均共享（管理动作入队、worker 消费，
本就是跨端协作）；需补齐：数据库账号按端分权（admin-api 用高权限账号，user-api 最小权限——
表级 GRANT 白名单），配置更新机制（ai-config.json 等管理配置只由 admin-api 写）。

部署形态（二选一，建议先 A 后视需要升 B）：

- **A. 单镜像双入口**（起步推荐）：一个镜像含 user-api/admin-api 两个入口与两份前端产物，
  compose 起两个容器（不同 command + 端口 3200/3201），Caddy 分流，运维最简；
  ❗引入四包与双构建后，Docker 构建、根 package.json 脚本与 CI 验证范围**仍需同步调整**
  （多包构建顺序/产物清单/typecheck 范围——「单镜像所以 CI 不动」不成立）；
- **B. 双镜像**（彻底独立发布）：release 工作流出 user/admin 两个镜像，版本节奏完全解耦——
  当两端发版节奏明显分化时再升级。

### 3.2 迁移批次（v2 重排：收敛先于双进程切流；每批独立可发布）

- **S1 公共包与双构建**：workspace 加 shared-ui（组件下沉，按 admin-web 实际引用集切分）+
  user-web/admin-web 双构建（vite 双配置）；主进程暂仍单入口托管双产物（行为不变）；
  Docker 构建、根脚本、CI 验证范围随多包调整。
- **S2 存储与配置收敛（❗必须先于双进程上线）**：users/sessions 真源切 PostgreSQL
  （认证数据 fail-closed：生产 PG 不可用时**拒绝新登录与管理认证**，不降级 JSON 判权；
  JSON 仅备份、**移除「JSON 优先合并回数据库」的初始化逻辑**、不自动反向覆盖 PG）；
  ❗**DB 迁移从服务启动流程分离**（独立迁移命令/容器，为 S4 后 user-api 不承担 DDL 铺路）；
  ❗**存量无用途标记会话批量失效**（升级时要求重登，不猜测用途）；AI 档案（ai-config.json）、
  能力配置与密钥引用**跨进程化**（迁 PG 或共享存储+版本号，admin 修改后 user-api/worker
  的进程内缓存刷新机制先定义再实施——仅给 admin 挂配置卷会让其他进程读不到新配置）；
  会话增加**用途标记**（user/admin），服务端拒绝跨用途使用；登录限速计数入 PG。
- **S3 双进程切流**：index.ts 移除全部管理注册（含 /api/admin/ai/* 物理收口到 admin 路由模块）；
  新增 admin-api 入口（不注册用户路由）；compose 双容器（127.0.0.1:3200/3201）；
  Caddy admin 域名改指 3201；ADMIN_HOSTS 门禁退役（路由物理不存在）。
- **S4 数据库分权收尾**：user-api 专用 DB 账号表级最小权限；管理配置卷只挂 admin 容器（S2 已保证其他进程不依赖该卷）。

### 3.3 已知设计难点（实施前必须想清楚）

**sessions.json / users.json 的双进程写冲突**：现有实现是「内存 Map + JSON 文件镜像，按 mtime
热加载」（`server/src/users.ts`）。两个进程挂同一 `./server/data` 卷时，双方都写 sessions.json
会互相覆盖丢登录态；users.json 同理。**S2 收敛先行**（v2 重排）正是为在双进程上线前消除此冲突：
登录态与用户表以 PostgreSQL 为唯一真源，JSON 镜像仅 user-api 进程负责写。
不做「一处登录两域通用」的跨域 SSO（复杂度高、收益低）。

**shared-ui 下沉的迁移面**：web 的组件被两端共用（Header 部分复用、MiniMarkdown、fx/、表单控件），
下沉时按「admin-web 实际引用集」切分，避免一次性大迁移；未引用的留在 user-web。

**回滚 ≠ 退镜像（v2 新增）**：S2/S3 同时改变存储真源、Compose、Caddy 上游、数据目录与数据库权限，
退回旧 BV_VERSION 不会自动恢复这些。每批保存对应配置与数据备份、明确 DB 迁移兼容范围；
S3 切流上线前在 VPS **实际演练一次回滚**（切流→验证→切回）。

### 3.4 资源评估（2C2G VPS）

admin-api 容器为纯 Node 进程，参照 app 实测 ~60MB；当前发版后水位（2026-10-21）：磁盘 28%
（19G/40G+）、内存 available 约 1.1G——跑双容器无压力。若内存吃紧的降级路径：admin 容器
按需启停（管理低频），或 systemd socket 激活。

### 3.5 验收清单

- [ ] 主域名 dist 产物无任何 admin chunk 与 AiSettingsModal（构建产物清单核查）
- [ ] user-api 进程 `GET /api/admin/users` 返回 404（路由物理不存在，非门禁拦截）
- [ ] user-api 进程源码 grep 无 registerAdminRoutes/registerKnowledgeListeners 引用
- [ ] admin 域名（Basic Auth → 仅超管登录 → 六页 + AI 设置）全功能冒烟，含知识库上传→解析→发布
- [ ] worker 队列跨端正常：admin 域名上传文档 → worker 消费 → 状态回读
- [ ] 主站超管账号登录被拒（提示走管理域名）；管理域名普通账号登录被拒
- [ ] 登录限速跨域名合并计数（admin 域连败 5 次后主站同 IP 也受限）且重启不丢（PG 持久化）
- [ ] user-api 数据库账号无管理表写权限（直连尝试写 users 表被拒）
- [ ] 回滚演练（v2）：按 §3.3 回滚条款执行——保存配置/数据备份、切流→验证→切回全程演练，DB 迁移兼容范围核对；不只是退 BV_VERSION
- [ ] 会话用途标记生效：user 会话访问管理 API 被拒、admin 会话访问用户端按设计判定（服务端校验，非 UI 禁用）

---

## 4. 风险与回滚总表

| 步骤 | 主要风险 | 缓解 | 回滚 |
|---|---|---|---|
| 一 清理 | 误删运行镜像 | prune 只删「无容器引用」镜像，运行中物理不可删 | 无需回滚（GHCR 可重拉任意旧版） |
| 二 方案B | ①把自己锁在 admin 外 ②server 门禁误伤 ③发版窗口撞用户在线 | 操作顺序 2.6（先开后关）；ADMIN_HOSTS 未配置=零行为变化；发版前确认无人在线 | 2.8 表：逐项秒级恢复 |
| 三 方案A | 双进程存储写冲突；迁移期双入口不一致 | PR 分批每批独立可发布；data 目录分离+PG 真源；过渡期双入口并存 | 回退上一 tag 即恢复单容器形态；admin-entry 无状态可随时停 |

## 5. 附录

### 5.1 命令速查（VPS）

```bash
df -h / && free -m                              # 磁盘/内存水位
docker ps --format '{{.Names}} {{.Status}}'     # 容器状态
docker system df                                # 镜像可回收量
docker logs --tail 50 biance-vision-app         # 应用日志
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy   # Caddy 改配置三连
curl -s https://<主域名>/api/health | head -c 200                                  # 健康检查
```

### 5.2 占位符对照

| 占位符 | 真实值所在 |
|---|---|
| `<主域名>` `<admin域名>` `<VPS_IP>` `<duckdns_token>` | `LOCAL_NOTES.md`「admin 域名隔离真实值」节（不入库） |
| Basic Auth 用户名/密码哈希 | VPS `/etc/caddy/Caddyfile`（密码明文只在个人密码管理器） |
| `bv.example.com` / `admin.example.com` | `deploy/vps/Caddyfile` 模板占位（入库版），部署时替换 |

### 5.3 相关既有文档

- 发版流程：`LOCAL_NOTES.md`「发布流程」+ `.github/workflows/release.yml`
- 部署覆盖层：`deploy/vps/README.md`、`deploy/vps/compose.override.yml`
- 地域封锁机制：`server/src/geoblock.ts` 头注释 + `LOCAL_NOTES.md`「地域封锁」节
