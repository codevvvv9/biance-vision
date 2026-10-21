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
| 第二步 | admin 域名隔离+网络防护（方案 B） | 爬虫攻破 admin 登录的核心诉求 | 中（涉及一次容器重启） | 代码 1 个 PR + 线上配置 30 分钟 | 第一步（磁盘须有余量拉新镜像） |
| 第三步 | 双系统拆分（方案 A，**可选**） | 管理端独立演进的架构诉求 | 中高 | 3~4 个 PR + 配置 | 第二步稳定运行一段时间后 |

**关键认知**（决定为什么这么排序）：拆域名/拆系统本身只提供「隐蔽性」，不提供「安全性」——爬虫扫子域名是基本功。
真正砍掉攻击面的是第二步里的两件事：①主域名上 admin 路由**彻底消失**（404）；②admin 域名入口有
**网络层门禁**（Caddy Basic Auth）。做到这两点，防爬虫目标即达成；第三步是给「管理端长期独立演进」
预留的架构升级，不是安全必需。

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

## 3. 第三步：双系统拆分（方案 A，中期可选）

> **先读 3.1 再决定做不做。** 这一步解决的是「管理端独立演进」的架构问题（独立发布节奏、主站彻底
> 不含管理代码、未来多人后台协作），不是安全问题——第二步已经把安全问题解决完了。不做这步，
> 防爬虫目标同样达成。

### 3.1 决策触发信号（满足任意一条再做）

- 主站要做公开推广/上 CDN，希望主站产物里彻底不含任何管理端代码与路由；
- 管理端开始长出独立功能域（更多后台模块、给协作者用的受限后台角色），发布节奏与主站脱钩；
- 出现主站流量增长，需要给 admin 单独的伸缩/保护策略。

都不满足 → 维持方案 B 形态，本节留档备查。

### 3.2 目标架构：单镜像、双入口、双容器

核心决策：**不拆第三个镜像**。同一份 Docker 镜像内含两套前端产物与两个 server 入口，compose 用
不同 `command` 起两个容器。这样 CI/release 工作流零改动（仍是 app+research-py 双镜像），产物管理
最简单，资源开销最小（admin 容器 ~60MB 内存）。

```
镜像 ghcr.io/.../biance-vision:<tag>（一个）
├─ server/dist/index.js       入口 A：用户端 server（不注册任何 /api/admin 路由），托管 web/dist-user
├─ server/dist/admin-entry.js 入口 B：管理端 server（只注册 auth/health/admin 路由），托管 web/dist-admin
├─ web/dist-user              用户端前端（无 admin chunk）
└─ web/dist-admin             管理端前端（只有 admin 应用）

VPS compose：
  app     : command 默认        → 127.0.0.1:3200 ← Caddy <主域名>
  admin   : command=node server/dist/admin-entry.js → 127.0.0.1:3201 ← Caddy <admin域名>（Basic Auth 保留）
共享：postgres / minio / pg-boss 队列（worker 不动，admin 职责是入队不是消费）
```

第二步的 `ADMIN_HOSTS` Host 门禁在此步**退役**（admin 进程里物理上没有用户路由，主进程里物理上没有
admin 路由，Host 判断不再需要）——保留代码无害，也可随本步删除。

### 3.3 结构定义

**前端**（推荐「同包双构建」而非独立 workspace 包，避免把 fx/MiniMarkdown/Dropdown 等共享组件
下沉成第三个包的大迁移）：

```
web/
├─ vite.config.ts              用户端构建（现状，entry 不变）→ 输出 dist-user
│                              改动：构建配置剔除 /admin 懒加载路由（或构建时注入 VITE_ADMIN_BUNDLE=0
│                              让 App.tsx 不注册 /admin/*）
├─ vite.config.admin.ts        管理端构建：entry=src/admin-main.tsx（只挂 AdminLayout 六页）→ dist-admin
├─ src/admin-main.tsx          新增：admin 应用入口（复用现有样式系统与 App 壳）
└─ src/admin/*                 现有代码不动，两份构建共享同一份源码
```

**server**：

```
server/src/
├─ index.ts          用户入口：删除 L876 registerKnowledgeRoutes、L885 registerAdminRoutes、
│                    L650-721 散落超管端点（/api/ai/config|test|prompt|models）的注册，
│                    静态托管 root 改 web/dist-user
└─ admin-entry.ts    新增：独立 Fastify 实例 = cors + geoBlock(豁免本域) + /api/auth/*（登录必需）
                     + /api/health + requireSuperadmin + registerKnowledgeRoutes + registerAdminRoutes
                     + /api/ai 超管端点簇 + 静态托管 web/dist-admin（SPA 回退同现有实现）
```

**Dockerfile**：build 阶段追加 admin 前端构建（`pnpm --filter biance-vision-web build -- --config
vite.config.admin.ts` 或等价 script），两份 dist 都拷入 runtime；无其他变化。

### 3.4 迁移批次（PR 切分，每批独立可发布）

- **PR-A1 前端双构建**：加 `vite.config.admin.ts` + `admin-main.tsx`，Dockerfile 构建两份 dist；
  主进程/容器行为暂不变（admin-entry 还没接）。验收：镜像内两份 dist 均存在且各自可静态预览。
- **PR-A2 admin-entry**：新增管理端 server 入口（路由从 index.ts 挪出但 index.ts 暂保留注册，
  双入口并存过渡）；compose 加 `admin` 服务（command 覆盖 + `127.0.0.1:3201:3200`）；
  VPS Caddy admin 域名改指 3201。验收：admin 域名走新容器、主域名不受影响。
- **PR-A3 主入口瘦身**：index.ts 移除全部 admin 路由注册与散落超管端点，web 用户构建剔除
  admin chunk，ADMIN_HOSTS 门禁代码删除。验收：主域名 /api/admin/* 返回 404（物理不存在）；
  主站 dist 体积下降（admin chunk 消失）。
- **PR-A4 登录限速入 PG**（见 3.5）+ 存储真源收敛（见 3.6）。

### 3.5 登录限速入 PostgreSQL（顺带修复「重启清零」旧账）

现状：每 IP 每分钟 5 次、连败 10 锁 15 分钟的计数在**进程内存**（`server/src/index.ts:358-487` 一带），
进程重启即清零；拆成两进程后还会各自计数（防护力减半）。迁 PG 方案：

- 新表 `login_rate_limits`（key TEXT PK=ip，window_start TIMESTAMPTZ，count INT，locked_until TIMESTAMPTZ），
  迁移脚本走既有 drizzle 目录（当前 0025+ 顺延）；
- 判定/计数改为一次 UPSERT 事务（`INSERT ... ON CONFLICT (key) DO UPDATE` 原子完成窗口滚动+计数+锁定）；
  读路径失败时降级为进程内存计数（沿用现有实现作 fallback，与项目「PG 主、JSON/内存降级」的存储纪律一致）；
- 两进程（app/admin）共享同一张表 → 合并计数，防爆破能力反而比单进程时强。

### 3.6 已知设计难点（实施前必须想清楚）

**sessions.json / users.json 的双进程写冲突**：现有实现是「内存 Map + JSON 文件镜像，按 mtime 热加载」
（`server/src/users.ts`）。两个进程挂同一 `./server/data` 卷时，双方都写 sessions.json 会互相覆盖丢
登录态；users.json 同理（admin 进程改密码/加用户，主进程读用户）。

推荐解法（按优先序）：

1. **admin 容器独立 data 目录**（`./server/data-admin` 单独卷）：两域名登录态本来就各自独立
   （host-only cookie），互不共享无损；用户/密码表以 **PostgreSQL 为唯一真源**（双写机制里 PG 已是
   主源），admin 进程改密码写 PG，主进程读 PG 拿到新密码哈希——需要核对现有读路径确实 PG 优先、
   JSON 只是降级镜像（记忆口径如此，实施时以代码为准），不满足则把 users 读路径调成 PG 优先。
2. 若登录态想要「一处登录两域通用」→ 需要跨域 SSO，**不建议**（复杂度高、收益低，运营者就一个人）。

### 3.7 资源评估（2C2G VPS）

- 内存：admin 容器为纯 Node 进程，参照 app 实测 ~60MB；当前可用 789MB + swap 已用 235MB，
  **跑得动但不宽裕**（research-py 训练峰值 1~2GB 时会更紧）。磁盘清理完成后空间无虞。
- 如果内存成为瓶颈的降级路径：admin 容器不必常驻，改用 `docker compose run` 按需起（管理是低频操作），
  或用 systemd socket 激活。此为备选，不默认做。

### 3.8 验收清单

- [ ] 主域名 dist 产物无任何 admin chunk（构建产物清单核查），`/admin` 路径 404
- [ ] admin 域名（Basic Auth → 登录 → /admin 六页）全部功能正常，含知识库上传→解析→发布全流程冒烟
- [ ] 主进程 `GET /api/admin/users` 404（路由物理不存在，非门禁拦截）
- [ ] worker 队列（知识库解析、研究 run）跨入口正常：admin 域名上传文档 → worker 消费 → admin 域可查状态
- [ ] 登录限速跨域名合并计数：admin 域名连败 5 次后，主域名同 IP 登录也被窗口限制（PG 表生效）
- [ ] app 容器重启后，登录限速计数不丢（PG 持久化生效）
- [ ] VPS 内存 `free -m` available ≥ 400MB；两容器内存合计增量 ≤ 120MB
- [ ] 回滚演练：BV_VERSION 回上一 tag，双容器形态恢复单容器（compose 配置随 tag 回退）

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
