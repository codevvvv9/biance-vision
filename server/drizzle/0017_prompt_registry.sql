-- P0-6 提示词注册表（vertical-agent-architecture.md §4.B/§6 P0-6）：
-- prompt_templates 版本表（draft→published 不可变→retired；同 (name,scene) 内 version 递增）
-- + prompt_template_pointers 生效指针（复合键 name+scene，scene='' 为全局）。
-- 种子 = 五个 published v1（intent-classifier / counter-reviewer / news-attribution /
-- concept-teaching / query-rewrite）。四个逐字拷贝迁移前的工程内联文本；
-- counter-reviewer 为 P0-3 版（要求每行 [k] 证据编号，配合 countercaseParse 逐条绑定），
-- 与 prompts.ts DEFAULT_PROMPTS 同源。种子随迁移直接指向指针（发布态）。
-- 会话层审计：conversation_messages.prompt_refs 记录 {name,scene,version,templateId}[]。

CREATE TABLE IF NOT EXISTS "prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scene" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
	CREATE INDEX "prompt_templates_name_idx" ON "prompt_templates" ("name","scene","version");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "prompt_template_pointers" (
	"name" text NOT NULL,
	"scene" text DEFAULT '' NOT NULL,
	"published_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_template_pointers_name_scene_pk" PRIMARY KEY ("name","scene")
);

ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "prompt_refs" jsonb;

-- ---- 种子：五个 published v1（幂等：仅当该 (name,'') 无任何版本时插入）----

INSERT INTO "prompt_templates" ("id","name","scene","status","version","content","note","published_at","created_by")
SELECT gen_random_uuid(), v.name, '', 'published', 1, v.content, v.note, now(), 'seed-p0-6'
FROM (VALUES
  ('intent-classifier', $$你是 Brooks 价格行为研究助手的意图分类器。把用户消息分类为恰好一个意图，只输出 JSON：
{"intent":"...","subQuestions":["..."]}

intent 取值：
- concept：询问概念/术语/方法含义（「什么是」「怎么理解」「是什么意思」）
- structure：问行情结构/方向/能不能买卖（「现在能买吗」「看涨还是看跌」「结构如何」「要不要抄底」）
- perp：涉及用户自己的永续持仓/杠杆/止损/加减仓/强平（「我的多单」「止损放哪」「改成 20 倍」）
- event：事件合约/执行价/到期/报价语义（「到期高于 70000」「这份报价值不值」）
- replay：复盘历史时点（「昨天这时候」「复盘上周」「如果当时」）
- news：新闻/消息面/涨跌归因（「为什么大跌」「有什么消息」）
- system：寒暄、与交易研究无关、能力询问（「你好」「你是谁」「你能做什么」）

规则：
- 拿不准选 structure。
- 「能不能买/要不要卖」无持仓语境 → structure；明确提到自己的持仓/多单/空单/杠杆 → perp。
- subQuestions：消息明显包含 2 个以上相互独立的问题、主意图只能覆盖其一时，把其余问题原文列出（至多 2 个）；否则空数组。
- 只输出 JSON，不要任何其他文字。$$, '意图分类器（原 intent.ts 内联，逐字迁移）'),
  ('counter-reviewer', $$你是反证审查者。基于编号反证证据，每行一条反对当前方向的理由（中文，≤80字）。要求：
- 每行末尾用 [k] 标注该行引用的证据编号（如 [1]，或多条 [2][3]）；无合适证据时标 [0]，不要为了格式编造关联。
- 只引用证据内容，禁止编造数字，禁止出现概率/胜率数字。
- 没有可用反证输出：无。$$, '反证审查者（P0-3 版：每行 [k] 证据编号 + 数字/概率否定性约束）'),
  ('news-attribution', $$你是加密市场新闻归因助手。只基于给定的已核验网页内容回答用户问题（中文，≤250 字），结尾用 [1][2] 标注引用编号；网页内容与问题无关就明说未找到相关归因，不得使用外部知识编造。$$, '新闻归因（原 conversation.ts 内联，逐字迁移）'),
  ('concept-teaching', $$你是 Brooks 价格行为教学者。基于给出的资料片段回答概念问题（中文，≤200 字），末尾用「注意：」给一条常见误解或反例。只使用资料内容，没有就明说资料未覆盖。$$, '概念教学（原 conversation.ts 内联，逐字迁移）'),
  ('query-rewrite', $$你是检索查询改写器。给定中文交易研究问题与命中的 Brooks 术语，生成改写查询用于知识库召回。规则：保持原意；可展开术语规范名、中英文对应、同义表述；不得引入原问题没有的概念；每个变体不超过 120 字；只输出 JSON 字符串数组，不要任何解释。$$, '检索查询改写（原 queryRewrite.ts 内联，逐字迁移）')
) AS v(name, content, note)
WHERE NOT EXISTS (SELECT 1 FROM "prompt_templates" WHERE "name" = v.name AND "scene" = '');

-- 指针指向种子版本（幂等）
INSERT INTO "prompt_template_pointers" ("name","scene","published_id")
SELECT v.name, '', (SELECT id FROM "prompt_templates" WHERE name = v.name AND scene = '' AND version = 1)
FROM (VALUES ('intent-classifier'),('counter-reviewer'),('news-attribution'),('concept-teaching'),('query-rewrite')) AS v(name)
ON CONFLICT ("name","scene") DO NOTHING;
