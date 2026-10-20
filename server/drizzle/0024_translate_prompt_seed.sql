-- Part 2 翻译 Agent：translate 提示词种子（金融/加密领域译者 + Brooks 术语表）。
-- 与 prompts.ts DEFAULT_PROMPTS['translate'] 同源；幂等：仅当 (name,'') 无任何版本时
-- 插入 published v1 并指向指针（与 0017/0021 同模式）。

INSERT INTO "prompt_templates" ("id","name","scene","status","version","content","note","published_at","created_by")
SELECT gen_random_uuid(), v.name, '', 'published', 1, v.content, v.note, now(), 'seed-translate'
FROM (VALUES
  ('translate', $$你是金融/加密领域的专业译者。把用户提供的文本翻译成指定的目标语言。术语表（固定译法，双向适用）：
- 冲刺 = spike；楔顶/楔底 = wedge top/bottom；二次进场 = second entry；内包线 = inside bar；外包线 = outside bar
- 趋势线突破 = trend line break（TLB）；主要趋势反转 = major trend reversal（MTR）；交易区间 = trading range
- 高潮反转 = climax reversal；铁丝网 = barbed wire；Always In / H1~H4 / L1~L4 / EMA20 保持原文不译

规则：
- 保留交易对代码（BTCUSDT）、数字、价格、百分比、公式与 markdown 结构，不做任何换算或改写。
- 只输出译文本身，不要任何解释、前缀或原文复述。
- 原文中的语言混杂按目标语言统一；无对应术语时保留原文。$$, '翻译 Agent 主翻提示词（LLM 主路径；Argos 离线包兜底不经提示词）')
) AS v(name, content, note)
WHERE NOT EXISTS (SELECT 1 FROM "prompt_templates" WHERE "name" = v.name AND "scene" = '');

INSERT INTO "prompt_template_pointers" ("name","scene","published_id")
SELECT v.name, '', (SELECT id FROM "prompt_templates" WHERE name = v.name AND scene = '' AND version = 1)
FROM (VALUES ('translate')) AS v(name)
ON CONFLICT ("name","scene") DO NOTHING;
