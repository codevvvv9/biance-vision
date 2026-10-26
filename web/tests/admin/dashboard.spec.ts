import { test, expect } from "./fixtures";

// v0.18.4 大盘（默认首页）与各 tab 顶部图表：渲染层面断言（canvas 数 + 关键文案），
// 数据形状由 fixtures 提供；option 语义的正确性依赖人工截图核验。

test("dashboard is the default landing page with KPIs, sections and charts", async ({ page }) => {
  await page.goto("/admin/");
  await expect(page).toHaveURL(/\/admin\/?$/);
  // KPI 行与两个分 section 的中文标题
  for (const label of ["总用户", "今日活跃", "今日消息", "今日研究", "24h 请求", "队列积压", "业务洞察", "系统健康"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // 图表画布：业务 4 图（用户/消息/热力/词云）+ 系统 5 图（HTTP/队列/研究/事件/文档；心跳 gauge 视 overview 加载）
  await expect(page.locator("canvas").first()).toBeVisible();
  const canvasCount = await page.locator("canvas").count();
  expect(canvasCount).toBeGreaterThanOrEqual(9);
});

test("queues page renders backlog chart above the table", async ({ page }) => {
  await page.goto("/admin/queues");
  await expect(page.getByRole("heading", { name: "队列状态分布" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("observability page renders http traffic trend card", async ({ page }) => {
  await page.goto("/admin/observability");
  await expect(page.getByText("HTTP 流量与延迟", { exact: true }).first()).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("evals page renders success trend when runs exist", async ({ page }) => {
  await page.goto("/admin/evals");
  await expect(page.getByRole("heading", { name: "评测成功率趋势" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("knowledge page renders document status doughnut", async ({ page }) => {
  await page.goto("/admin/knowledge");
  await expect(page.getByRole("heading", { name: "知识库文档状态" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("ai page renders per-user activity chart", async ({ page }) => {
  await page.goto("/admin/ai");
  // 图表在「旧版会话」分视图（AI 概览数据源所在）
  await page.getByRole("tab", { name: "旧版会话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "用户消息量 Top10" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});
