---
name: knowledge-rag
description: 维护知识库与 RAG 检索链路时使用。当任务涉及资料导入（文件上传/URL/清单批量）、Docling 解析、切分与索引、knowledge_* 表、混合检索（术语归一/向量/词项/RRF/精排）、引用快照、规则卡或 /api/admin/knowledge/* 时，应使用本技能。
---

# 知识库与 RAG 维护

## 职责

- 三类资料层：原始资料、规则卡、案例（案例的决策可见内容与未来结果标签分开存储防泄漏）。
- 三种导入通道：超管文件上传、单 URL 导入、资料清单批量导入。
- 解析与索引：PDF/DOCX 走 research-py 的 Docling 固定端点，TXT/MD/HTML 走 Node 原生解析；保留页码/图号/原文/资料版本。
- 检索流水线：术语归一 → 权限/版本过滤 → 向量召回（pgvector）+ 词项召回 → RRF → 可配置精排 → 邻接上下文 → 引用快照冻结。
- 资料清单：维护 `docs/references/knowledge-source-manifest.json` 的条目与语义。

## 维护时必须遵守的纪律

- **引用必须可溯源**：每条引用携带 `documentVersion/chunkId/page/figure/contentHash`，发布回答时冻结实际使用的引用快照；**不许伪造页码**，来源不足、解析失败、权限不足分别返回明确三态。
- **术语归一覆盖短词**：H2/L2/ii/ioi 等短词必须进同义词表与精确词项召回，不能只靠向量相似度；相似度分数不等于事实正确率。
- **检索参数是起始值不是常数**：原问题 + ≤2 变体、候选 30–50、精排后 6–10 只是工程起始值，最终由标注查询集选择，不得写死为「最佳实践」。
- **支持/反证双路检索**：检索必须分别覆盖支持依据与反例，反例覆盖不足时结论降级。
- **规则卡与规则代码解耦**：规则卡由 LLM 草拟、管理员审核发布；资料正文更新不得自动改动线上规则代码（`ruleId` 关联仅作映射）。
- **图文相邻关联**：书中图示与解释文字相邻组织；图片中估算的价格只用于知识理解，不得进入交易数据。
- **使用权边界**：商业书籍/会员资料仅通过用户上传有使用权的文件导入；URL 导入不绕过访问限制；manifest 中 `access: purchase/member` 的条目 `importMethod` 必须为 `user_upload`。
- **Lumen 复用的适配差异**：复用其解析结构/切分/RRF/查询改写/引用快照的形态，但本项目去身份服务、去 Milvus 耦合，以 pgvector + 应用侧词项索引替代，中文分词在应用侧处理。
- **manifest 格式纪律**：`knowledge-source-manifest.json` 必须是合法 JSON（可被 `JSON.parse`），顶层 `{version, updatedAt, entries}`，每条含 id/url/type/topics/access/sourceTier/importMethod/enabled/notes；JSON 不支持注释，禁止在文件里写 `//`。

## 正式 spec 与格式文件

- `docs/specs/knowledge-rag.md` — 导入、解析、规则卡、混合检索、引用、权限
- `docs/references/knowledge-source-manifest.json` — 资料清单初值与字段格式
- `docs/references/brooks-sources.md` — Brooks 官方资料入口与来源等级

## 常用校验命令

- `pnpm typecheck` — 全仓类型检查
- `node -e "JSON.parse(require('fs').readFileSync('docs/references/knowledge-source-manifest.json','utf8'))"` — manifest 合法性快查
