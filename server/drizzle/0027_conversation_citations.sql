-- 聊天引用角标化（docs/knowledge-ui-redesign-plan.md 流程 7 预留契约的落地）：
-- assistant 消息可选携带结构化引用数组（只增字段；文本版「来源」行保留，旧客户端不受影响）。
-- 结构：[{ n, kind: 'knowledge_chunk' | 'web_page', title, pageNo?, url?, snippet }]
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "citations" jsonb;
