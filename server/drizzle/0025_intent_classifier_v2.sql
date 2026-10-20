-- 0025：intent-classifier 升级 v2 —— 枚举加入 translate（Part 2 翻译 Agent）。
-- 0017 种子的 v1 提示词没有 translate 枚举，LLM 叠加层会把「把 X 翻译成英文」
-- 纠偏成 system；确定性 classifyIntent 已命中 translate 但会被合法枚举覆盖。
-- 治理规则：published 不可变 → 以 v2 发布并把指针推进到 v2（幂等：仅当无 v2 时插入）。

INSERT INTO "prompt_templates" ("id","name","scene","status","version","content","note","published_at","created_by")
SELECT gen_random_uuid(), v.name, '', 'published', 2, v.content, v.note, now(), 'seed-translate'
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
- translate：翻译请求（「翻译成英文」「把这段译成中文」「translate ... to English」）
- system：寒暄、与交易研究无关、能力询问（「你好」「你是谁」「你能做什么」）

规则：
- 拿不准选 structure。
- 「能不能买/要不要卖」无持仓语境 → structure；明确提到自己的持仓/多单/空单/杠杆 → perp。
- 明确的翻译/译成指令（消息主体是要翻译的文本）→ translate，不是 system。
- subQuestions：消息明显包含 2 个以上相互独立的问题、主意图只能覆盖其一时，把其余问题原文列出（至多 2 个）；否则空数组。
- 只输出 JSON，不要任何其他文字。$$, 'v2：枚举加入 translate（0024 翻译 Agent 配套；确定性 classifyIntent 同步最高优先命中）')
) AS v(name, content, note)
WHERE NOT EXISTS (SELECT 1 FROM "prompt_templates" WHERE "name" = v.name AND "scene" = '' AND "version" = 2);

INSERT INTO "prompt_template_pointers" ("name","scene","published_id")
SELECT 'intent-classifier', '', (SELECT id FROM "prompt_templates" WHERE name = 'intent-classifier' AND scene = '' AND version = 2)
ON CONFLICT ("name","scene") DO UPDATE
SET "published_id" = (SELECT id FROM "prompt_templates" WHERE name = 'intent-classifier' AND scene = '' AND version = 2);
