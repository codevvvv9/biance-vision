import { test, expect } from "./fixtures";
test("knowledge filters use complete counts and document titles remain readable", async ({
  page,
}) => {
  await page.goto("/admin/knowledge");
  await expect(
    page.getByRole("button", {
      name: "结构分析方法与二次入场.pdf",
      exact: true,
    }),
  ).toBeVisible();
  const box = await page
    .getByRole("button", { name: "结构分析方法与二次入场.pdf", exact: true })
    .boundingBox();
  expect(box?.width).toBeGreaterThan(100);
  const checkbox = await page
    .locator(".ant-table-selection-column input")
    .first()
    .boundingBox();
  expect(checkbox?.width).toBeLessThan(30);
  await page.getByRole("combobox", { name: "状态", exact: true }).click();
  await page.getByTitle("已发布 (1)", { exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "结构分析方法与二次入场.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "状态", exact: true }).click();
  await expect(page.getByTitle("失败 (1)", { exact: true })).toBeVisible();
});
for (const width of [360, 768, 1024, 1440, 1920])
  test(`layout contains horizontal overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/knowledge");
    await expect(
      page.getByRole("heading", { name: "知识库", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width < 768) {
      await page.getByRole("button", { name: "展开或收起导航" }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("navigation")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(drawer).not.toBeVisible();
      await expect(
        page.getByRole("button", { name: "展开或收起导航" }),
      ).toBeFocused();
    }
  });

test("every page stays within each viewport and produces desktop visual evidence", async ({
  page,
}, testInfo) => {
  for (const width of [360, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of ["", "ai", "knowledge", "agents", "prompts", "evals"]) {
      await page.goto(`/admin/${path}`);
      await expect(page.locator("main h2").first()).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${path || "panel"} at ${width}`,
      ).toBeLessThanOrEqual(width);
      if (width === 1440 || (width === 360 && path === "knowledge")) {
        await expect(
          page.locator(".ant-spin-spinning, .ant-spin-blur"),
        ).toHaveCount(0);
        const screenshot = await page.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`${path || "panel"}-${width}.png`),
          fullPage: true,
        });
        await testInfo.attach(`${path || "panel"}-${width}`, {
          body: screenshot,
          contentType: "image/png",
        });
      }
    }
  }
});
