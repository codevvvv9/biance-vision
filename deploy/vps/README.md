# 境外 VPS 部署手册（腾讯/阿里香港轻量 · Vultr/DO · Hetzner 通用）

与 `deploy/oracle/`（免费层路线）平行的付费路线：**买一台境外 VPS → 装 Docker →
同一套 compose 覆盖层起栈 → Caddy + 域名**。部署文件与云厂商无关，只在本手册里讲选型与各家的差异。

> 栈很轻：实测六容器常驻内存合计约 430MB（PG 195M + MinIO 102M + app 56M + worker 56M + research-py 23M）。
> **2GB 内存起步即可**，预算够直接 2C4G（research-py 偶尔训练会到 1–2GB）。

## 0. 选型

| 提供商 | 档位/价格（约） | 大陆访问 | 适用 |
| --- | --- | --- | --- |
| **腾讯云香港轻量** | 2C2G ¥30–50/月 | 最好 | 付费首选：购买无门槛（无需外币信用卡）、控制台中文、月流量额度充足 |
| 阿里云香港轻量/国际 ECS | 2C2G ¥30–80/月 | 好 | 同上 |
| Vultr 东京 | 1C2G $6/月 | 中上 | 按小时计费、支持支付宝，适合先试跑一天再决定 |
| DigitalOcean 东京 | 1C2G $6–12/月 | 中上 | 同 Vultr |
| Hetzner（欧洲） | 2C4G €4/月 | 差（绕美） | 仅适合用户在海外时 |

共同前提：**必须境外区域**（币安 API 直连 + 免备案）。大陆服务器不可行（行情采集被墙 + ICP 过不了）。

## 1. 各家差异速查（相对 Oracle 手册省掉的部分）

- **无抢机问题**：付钱即开，不用像 Oracle A1 那样等容量。
- **无内置 iptables 坑**：OCI 的 Ubuntu 镜像自带 REJECT 规则是 Oracle 特有；标准 VPS 只需处理提供商防火墙一层。
- **防火墙入口**：
  - 腾讯云轻量：控制台 → 防火墙 → 放行 22（限源 IP）/80/443；
  - 阿里云轻量：同理；国际版 ECS 用「安全组」；
  - Vultr/DO：面板 Firewall（或系统内 ufw 自管）；
  - Hetzner：云防火墙或 ufw。
- **支付**：腾讯/阿里直接人民币；Vultr 支持支付宝；DO/Hetzner 需外币卡或 PayPal。
- **流量**：轻量套餐含月流量额度（香港档通常 1TB+/月，本项目页面/API 用量远够）；超额按 GB 计费，留意账单页。
- **IP 固定**：常规 VPS 的公网 IP 天生固定，无 Oracle「临时 IP 换保留 IP」一步。

## 2. 起栈（与 Oracle 路线同构）

```bash
# 1) 服务器：装 Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 2) GHCR 登录（GitHub PAT 勾 read:packages）
echo $GHCR_PAT | docker login ghcr.io -u codevvvv9 --password-stdin

# 3) 拉仓库
git clone https://github.com/codevvvv9/biance-vision.git && cd biance-vision

# 4) 起栈（镜像来自 tag 发版：本地 pnpm release:gate → git tag v0.2.x → push）
# 注意：GHCR 镜像 tag 由 docker/metadata-action 生成，不带 v 前缀（git tag v0.6.1 → 镜像 :0.6.1）
BV_VERSION=0.2.x docker compose \
  -f docker-compose.yml -f deploy/vps/compose.override.yml up -d
curl -s http://127.0.0.1:3200/api/health   # 验证
```

覆盖层内容与 `deploy/oracle/compose.override.yml` 一致：镜像切 GHCR、PG 端口收敛到 127.0.0.1（公网机器绝不暴露弱口令 PG）。两份需同步修改。

## 3. 数据迁移（本机 → 服务器）

```bash
# 本机：
bash deploy/vps/migrate-local.sh ubuntu@服务器IP
# 服务器（仓库根目录，前提：第 2 步已成功起过一次栈）：
bash deploy/vps/migrate-remote.sh
```

迁移后验证：登录 admin → `/research` 左栏有历史 run、admin 知识库文档列表完整。

## 4. 域名 + HTTPS（Caddy）

1. DNS：A 记录 → 服务器公网 IP（域名在国内注册商买的也行，解析到境外无需备案）。
2. 装 Caddy（官方 apt 源），拷贝本目录 `Caddyfile` 到 `/etc/caddy/Caddyfile`，替换域名后 `sudo systemctl reload caddy`。证书自动签发续期；SSE/WebSocket 原生支持。
3. 不想开入站端口可改用 cloudflared tunnel（服务器上跑 `cloudflared` 即可）。

## 5. 地域封锁（默认屏蔽中国大陆）

产品面向海外运营：app 内置应用层 GeoIP（`server/src/geoblock.ts`），命中中国大陆 IPv4 名单的请求一律 403（浏览器返回中英双语提示页），**默认开启**。名单文件为 `server/data/cn-ip-list.txt`（17mon 源，约 7400 条 CIDR，不入库）。

- **首次启用**：本机执行 `pnpm geo:update` 生成名单（随 `server/data` 挂载进容器）；服务器上无 node，直接 curl：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt -o server/data/cn-ip-list.txt
  ```
- **每月自动更新**（app 每 60s 检测文件 mtime 自动热加载，无需重启）：
  ```
  # crontab -e
  17 4 1 * * curl -fsSL https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt -o /home/ubuntu/biance-vision/server/data/cn-ip-list.txt
  ```
- **名单缺失/异常时 fail-open**（全部放行 + 启动告警）。确认真的在拦：`curl -s http://127.0.0.1:3200/api/health` 的 `geoBlock` 字段应为 `active:true` 且 `ranges>0`。
- **关闭**：app 服务加环境变量 `GEO_BLOCK_CN=off`；**白名单**（自己在国内管理站点用）：`GEO_BLOCK_ALLOW=你的固定出口IP`。
- **务必保持防火墙只开 80/443（22 限源）**：3200 若对公网开放，可绕过 Caddy 直连并伪造 X-Forwarded-For 头绕过封锁。
- 已知边界：仅 IPv4 名单（站点无 AAAA 记录时 IPv6 天然不可达，将来开 IPv6 需扩展 v6 名单）；挂 VPN 的国内用户在网络层面就是海外，属预期范围。

## 6. 日常运维

- **升级**：本地过 `pnpm release:gate` → 打 tag → 服务器 `BV_VERSION=0.2.y docker compose -f docker-compose.yml -f deploy/vps/compose.override.yml pull && ... up -d`（镜像 tag 不带 v 前缀）。
- **备份**：cron 每周 `docker exec biance-vision-postgres pg_dump -U postgres -d biance_vision -Fc | gzip > /var/backups/biance-$(date +%F).dump.gz`；轻量套餐自带快照功能，换机/重装前先打一张。
- **到期与流量**：轻量套餐到期停机（记得续费）；流量超额按量计费，偶尔看一眼用量页。
- **embedding 服务**（内部embedding代理，国内 IP）从香港/日本访问可达，延迟约 50–100ms，只影响知识入库/检索；行情链路不经它。

## 7. 与 Oracle 免费层怎么选

- 想长期 $0、能接受抢机与注册风控 → `deploy/oracle/`；
- 要稳定、随开随用、大陆访问质量优先 → 本手册（腾讯云香港轻量最省心）；
- 两者部署文件同构，先在任何一台上跑通，迁移到另一家只是重复第 3 步的数据迁移。
