# Oracle 免费层（Always Free）部署手册

目标：一台 ARM A1 4C24G 免费实例跑完整 compose 栈（postgres/app/worker/minio/research-py），
域名 + HTTPS 公网访问。全程 $0（免费额度内）。

## 0. 免费额度与本项目匹配

| Oracle Always Free | 本项目用量 |
| --- | --- |
| ARM A1 合计 4 OCPU / 24GB（每月 3000 OCPU 时 + 18000 GB 时） | 一台 4C24G 全月跑满，六个容器富余 |
| 块存储 200GB | 引导卷 50GB + 数据增长（K 线库按年增长，超 200G 才需付费） |
| 出站流量 10TB/月 | 页面/API/行情推送远用不完 |
| 保留公网 IP ×2 | 用 1 个 |

**不要**在控制台开任何付费资源（付费实例、对象存储超额等），否则开始扣费。

## 1. 注册（国内信用卡实战要点）

- 卡必须是 **Visa / MasterCard 国际信用卡**（银联单标不行）；国内银行的全币种/双币 Visa、MC 都可以。社区成功案例较多的是招行 Visa 全币种、中信 Visa、广发 MC——**银行不是决定因素，信息一致才是**。
- 姓名 = 卡面拼音逐字一致；账单地址写真实地址（拼音/英文均可）；手机号真实。
- 邮箱用 Gmail / Outlook（QQ/163 也有成功的，但前者的通过口碑更好）。
- 网络用自己日常的稳定网络（家宽原生 IP 最佳）；**不要挂数据中心代理/频繁换 IP**，注册时网络地区乱跳会加重风控。
- 验证时预授权约 $1，随后退回。同一张卡短时间反复提交会加重风控：失败后等 24–48h、换邮箱再试；再不行换一张 Visa/MC。
- **Home Region 一旦选定不可改**，免费资源只能开在这个区。推荐东京/大阪/首尔春川（币安 API 直连、大陆访问 80–150ms）；新加坡热门难抢机。
- 不要买现成账号或用虚拟卡（条款违规，大概率封）。

## 2. 开实例

1. 计算 → 创建实例：`VM.Standard.A1.Flex`，**4 OCPU / 24GB**，Ubuntu 22.04+（选最小安装），引导卷 50GB，SSH key 全量粘贴。
2. 热门区报 *Out of capacity*：改抢 1 OCPU/6GB 占坑（**停机状态下可直接改配额升 4C24G，无需重建**），或换可用域重试。
3. 实例详情页把临时公网 IP 换成 **Reserved Public IP**（防重启变 IP）。

## 3. 放行端口（两道墙，缺一不可）

1. OCI 控制台：子网 → 安全列表 → 入站规则放行 22（来源限自己 IP）、80、443。
2. **Ubuntu 镜像内置 iptables 默认 REJECT 22 以外全部端口**（OCI 名坑）：

```bash
ssh ubuntu@服务器IP
sudo iptables -L INPUT --line-numbers   # 看到 REJECT 规则
sudo iptables -D INPUT <编号>            # 删掉 REJECT（或放行 80/443）
sudo netfilter-persistent save
```

## 4. 起栈（走 GHCR 发版镜像）

```bash
# 服务器：装 Docker（官方脚本）+ 登录 GHCR（GitHub PAT 勾 read:packages）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
echo $GHCR_PAT | docker login ghcr.io -u codevvvv9 --password-stdin

# 拉仓库（只需 compose/数据文件，不装 node）
git clone https://github.com/codevvvv9/biance-vision.git && cd biance-vision

# 本机侧：先过发版门槛再打 tag（CI 会推 ghcr.io/codevvvv9/biance-vision 与 -research-py）
# 本地：pnpm release:gate && git tag v0.2.x && git push origin v0.2.x

BV_VERSION=0.2.x docker compose \
  -f docker-compose.yml -f deploy/oracle/compose.override.yml up -d
curl -s http://127.0.0.1:3200/api/health   # 验证
```

覆盖层做了三件事：app/research-py 去本地构建改 GHCR、worker 镜像同步、**PG 端口收敛到 127.0.0.1**（根 compose 的 0.0.0.0 + 弱口令只适合本机开发，公网机器绝不能直接暴露）。

## 5. 数据迁移（本机 → 服务器）

```bash
# 本机（现有栈所在机器）：
bash deploy/oracle/migrate-local.sh ubuntu@服务器IP     # 打包 PG/MinIO/server-data 并 scp
# 服务器（仓库根目录，前提：第 4 步已成功起过一次栈）：
bash deploy/oracle/migrate-remote.sh                     # 恢复三个包并拉起全部服务
```

迁移后验证：登录 admin → `/research` 左栏有历史 run、admin 知识库文档列表完整。

## 6. 域名 + HTTPS（Caddy）

1. DNS：A 记录 → 保留公网 IP。
2. 服务器装 Caddy（官方 apt 源），拷贝本目录 `Caddyfile` 到 `/etc/caddy/Caddyfile`，域名替换后 `sudo systemctl reload caddy`。证书自动签发续期；SSE/WebSocket 反代原生支持（`flush_interval -1` 保证 SSE 实时）。
3. 不想开入站端口可沿用 cloudflared tunnel（服务器上跑 `cloudflared` 即可，不开 80/443）。

## 7. 地域封锁（默认屏蔽中国大陆）

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

## 8. 日常运维

- **升级**：本地 `pnpm release:gate` → 打 tag → 服务器 `BV_VERSION=0.2.y docker compose -f docker-compose.yml -f deploy/oracle/compose.override.yml pull && ... up -d`（镜像 tag 不带 v 前缀）。
- **备份**：cron 每周 `docker exec biance-vision-postgres pg_dump -U postgres -d biance_vision -Fc | gzip > /var/backups/biance-$(date +%F).dump.gz`，另传一份到异机/对象存储。
- **空闲回收**：Oracle 会回收连续 7 天 CPU<20% 的免费 A1 实例——本项目 worker 常驻采集，天然不满足回收条件，无需额外处理。
- **embedding 服务**（内部embedding代理，国内 IP）从日韩区访问可达，延迟约 50–100ms，只影响知识入库/检索；行情链路不经它。长期境外化可考虑把 embedding 一并迁移。

## 9. 与既有方案的衔接

- 原「本机 compose + otun/ngrok/cloudflared 三轨隧道」可保留作演示/备用入口；Oracle 栈独立运行，两者共用同一套发版镜像。
- 上线前记得 `pnpm release:gate` 全绿再打 tag（CI 仅做构建推镜像，质量门槛在本地）。
