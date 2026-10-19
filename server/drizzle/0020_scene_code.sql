-- P1-1 场景注册表（vertical-agent-architecture.md §4.A/§6 P1-1）：
-- 任务场景维度（TaskScene 六值）落列——conversation_messages.scene_code（意图路由后
-- resolveScene 推导）与 research_runs.scene_code（会话创建携带或直建按产品推导）。
-- sceneCode 只统一任务场景配置，不绕过产品级校验（perp run 持仓归属校验在 routes.ts）。

ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "scene_code" text;
ALTER TABLE "research_runs" ADD COLUMN IF NOT EXISTS "scene_code" text;
