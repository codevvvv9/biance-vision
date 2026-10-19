-- P1-2/P1-5 提示词种子（vertical-agent-architecture.md §6 P1-2/P1-5）：
-- synthesis-writer（受约束综合解释，第 6 个 LLM 调用点）与 memory-extraction
-- （研究记忆提取，文本取自链路 A aiMemory.ts EXTRACT_SYSTEM_PROMPT 同源协议）。
-- 幂等：仅当该 (name,'') 无任何版本时插入 published v1 并指向指针（与 0017 同模式）。

INSERT INTO "prompt_templates" ("id","name","scene","status","version","content","note","published_at","created_by")
SELECT gen_random_uuid(), v.name, '', 'published', 1, v.content, v.note, now(), 'seed-p1'
FROM (VALUES
  ('synthesis-writer', $$你是研究综合解释者。基于给出的「已计算事实与条件」「反证要点」「编号证据」，直接回应用户的研究问题（中文，≤200 字）。要求：
- 只能引用已给出的内容：不引入任何新数字、新结论、新价格；概率数字一律禁止。
- 句末用 [k] 标注该句依据的证据编号（如 [1]，或多条 [2][3]）；无合适证据的句子不标注。
- 先给结论（对应已计算的动作），再说主要理由与前提条件，最后点出最需要留意的反证。
- 不给建议性指令，不出现在证据之外的市场判断。$$, '受约束综合解释（P1-2：只引用已计算事实/条件/冻结证据，[k] 引用+数字白名单+概率红线由代码校验）'),
  ('memory-extraction', $$你是记忆管理器，负责从「用户与研究助手的对话」中提取关于用户的长期记忆。

一条记忆 = 一个独立、自包含的事实或偏好，脱离原对话也能读懂（例如「用户偏好短线交易，主要关注 SOL 和 meme 币」）。

只提取跨对话仍有价值的信息：
- 用户背景（职业、交易经验水平）
- 分析偏好（风格、风险偏好、仓位习惯、关注的板块/币种）
- 明确表达过的要求与习惯（回复详略、语言、格式偏好）
- 长期目标或约束

不要提取：
- 与当下行情临时相关的内容（某币此刻涨跌、今日大盘状态）
- 助手回答的内容本身
- 一次性的具体提问

维护规则：
- 与已有记忆重复或近似 → 不加
- 与已有记忆矛盾（偏好改变等）→ 用 update 修正原条目
- 已明显过时（用户已明确放弃）→ 用 delete 移除

只输出严格 JSON，不要任何其他文本：
{"add":[{"kind":"preference|fact|interest|habit","content":"一句话记忆"}],"update":[{"id":"已有记忆id","content":"修正后的内容"}],"delete":["过时记忆id"]}
没有变更时输出 {"add":[],"update":[],"delete":[]}$$, '研究记忆提取（P1-5：协议与链路 A aiMemory 同源，写入 research_memories 纯 PG 表）')
) AS v(name, content, note)
WHERE NOT EXISTS (SELECT 1 FROM "prompt_templates" WHERE "name" = v.name AND "scene" = '');

INSERT INTO "prompt_template_pointers" ("name","scene","published_id")
SELECT v.name, '', (SELECT id FROM "prompt_templates" WHERE name = v.name AND scene = '' AND version = 1)
FROM (VALUES ('synthesis-writer'),('memory-extraction')) AS v(name)
ON CONFLICT ("name","scene") DO NOTHING;
