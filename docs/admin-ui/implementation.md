# 管理端组件化迁移与验收

状态：implemented（独立部分持续迁移；W4 首页整合 pending，未标记完整 verified）。

## 边界

- 独立工作树从 a3d4e46 建立；不得引入主工作区未提交的官网/服务端改动。
- 第一批：独立主题、路由注册、开发 HTML 回退、登录退出、响应式壳层、实际模块图隔离、生产 Caddy 3201 修正。
- 后续批次：知识库、AI 会话、Agent、提示词、评测。W4 合并后才整合管理首页，保留账号开通、随机密码交付、额度、官网设置。
- 每批形成独立提交；基础批次通过其验收即可单独发 patch，不等待 W4。每个交付批次前同步 main，长于一周时至少每周同步一次并重跑回归。同步必须基于已提交代码。
- 旧样式仅在 LegacyBoundary 生效；过渡期不做旧页面的审美微调。删除样式前确认所有消费者已迁移。
- 注册表只持有路由元数据与惰性页面入口。API、状态、表单规则在各领域模块内；壳层不引用注册表或业务 API。

## 开发与验证

```
pnpm install --frozen-lockfile
pnpm --filter biance-vision-brooks build
BV_ADMIN_API_TARGET=http://127.0.0.1:3201 pnpm --dir web dev:admin
pnpm --dir web build
pnpm --dir web test:admin
pnpm check:i18n
pnpm admin:gate-check
pnpm login:regression
pnpm release:gate
```

管理端 `/admin/` 与深链均必须由 admin.html 进入，API 代理必须显式指向 health.entry=admin-api 的进程。未配置代理时禁止回落 user-api。测试使用受控 API，不连接生产数据。

两个 Vite 构建使用 Rollup 实际模块 ID 做隔离断言；用户构建拒绝 Ant Design 与管理端功能模块，管理构建拒绝用户行情 Provider、机器人 Context 与 Header。输出 build-modules.json 供复核，CI 常驻执行。

Playwright 覆盖六页导航、高亮、深链、登录错误/返回/退出、资料标题/复选框/统计、360/768/1024/1440/1920 视口和 AI 表单。后续迁移批次扩展领域操作/竞态/轮询验收。

## 发布

既有 v0.16.2 不覆盖。使用下一可用 patch；记录旧 admin-api 镜像 digest 与有效 Compose 配置。生产仅验登录、导航和只读展示，写操作由隔离测试环境验收。仅升级通过该批验收的管理端服务；失败恢复旧管理镜像，不回滚共享数据库。W4 首页待合并事项不能计入完整验收。
