import { test, expect } from "./fixtures";

test("edited Agent draft is saved from the current editor state; publication requires confirmation", async ({
  page,
}) => {
  const draft = {
    id: "agent-draft",
    label: "Draft A",
    status: "draft",
    config: { original: true },
    createdAt: 1792800000000,
  };
  let saved: unknown;
  let published = 0;
  await page.route("**/api/admin/agents/versions**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({
        json: { versions: [draft], currentVersionId: null },
      });
    if (request.method() === "PUT") saved = request.postDataJSON();
    if (request.url().endsWith("/publish")) published++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/admin/agents/capabilities", (route) =>
    route.fulfill({ status: 503, json: { message: "Capability unavailable" } }),
  );
  await page.goto("/admin/agents");
  await expect(page.getByRole("alert")).toContainText("Capability unavailable");
  await page.getByRole("tab", { name: "版本管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("配置 JSON", { exact: true }).fill('{"edited":42}');
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  expect(saved).toEqual({ config: { edited: 42 } });
  await page.getByRole("button", { name: "发布", exact: true }).click();
  expect(published).toBe(0);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => published).toBe(1);
});

test("template edits survive cancelled navigation and save only the supported API fields", async ({
  page,
}) => {
  let saved: unknown;
  const template = {
    id: "prompt-draft",
    name: "translate",
    scene: "",
    status: "draft",
    version: 2,
    content: "Original",
    note: "",
    createdAt: 1792800000000,
    publishedAt: null,
  };
  await page.route("**/api/admin/prompts**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { templates: [template], pointers: [] } });
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/admin/prompts");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("内容", { exact: true }).fill("Changed translation");
  await drawer.getByRole("button", { name: /close|关闭/i }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(drawer.getByLabel("内容", { exact: true })).toHaveValue(
    "Changed translation",
  );
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  expect(saved).toEqual({ content: "Changed translation" });
  await page.getByRole("tab", { name: "研究文案", exact: true }).click();
  await expect(page).toHaveURL(/view=copy/);
  await page.goBack();
  await expect(
    page.getByRole("tab", { name: "模板版本", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("dataset JSON is validated before the request; training uses the selected horizon", async ({
  page,
}) => {
  await page.goto("/admin/evals?view=datasets");
  await page.getByRole("button", { name: "新建数据集", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill("Fixture dataset");
  await dialog.getByLabel("条目 JSON", { exact: true }).fill("{");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog
    .getByLabel("条目 JSON", { exact: true })
    .fill('[{"query":"test"}]');
  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/evaluations/datasets"),
  );
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  expect((await posted).postDataJSON()).toEqual({
    name: "Fixture dataset",
    kind: "rag",
    items: [{ query: "test" }],
  });
  await expect(dialog).not.toBeVisible();
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "触发训练", exact: true }).click();
  await dialog.getByLabel("版本标签", { exact: true }).fill("fixture-training");
  const training = page.waitForRequest((request) =>
    request.url().endsWith("/models/train"),
  );
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  expect((await training).postDataJSON()).toEqual({
    modelVersion: "fixture-training",
    horizon: "10m",
  });
});

test("partial knowledge batch failures remain selected and successful rows clear", async ({
  page,
}) => {
  await page.goto("/admin/knowledge");
  await page.locator('tr[data-row-key="doc-2"] input[type="checkbox"]').check();
  await page.locator('tr[data-row-key="doc-3"] input[type="checkbox"]').check();
  await page
    .getByRole("button", { name: "重新解析", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText(/成功 1.*失败 1/)).toBeVisible();
  await expect(
    page.locator('tr[data-row-key="doc-2"] input[type="checkbox"]'),
  ).not.toBeChecked();
  await expect(
    page.locator('tr[data-row-key="doc-3"] input[type="checkbox"]'),
  ).toBeChecked();
});

test("upload queue validates and serially uploads; cancellation removes only newly created documents", async ({
  page,
  apiFixture,
}) => {
  await page.goto("/admin/knowledge");
  await page.getByRole("button", { name: "上传资料", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const file = dialog.locator('input[type="file"]');
  await file.setInputFiles([
    {
      name: "wrong.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("invalid"),
    },
    {
      name: "fixture.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Example"),
    },
  ]);
  await expect(dialog.getByText("不可上传", { exact: true })).toBeVisible();
  await expect(dialog.getByText("待上传", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "移除 wrong.exe", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "开始上传（1）", exact: true })
    .click();
  await expect(dialog.getByText("已入队解析", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "取消并回滚已传文档", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    apiFixture.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.path),
  ).toEqual(["/api/admin/knowledge/documents/created-upload?purge=1"]);
});

test("raw preview stays usable after leaving and returning to its tab", async ({
  page,
}) => {
  let fileRequests = 0;
  await page.route(
    "**/api/admin/knowledge/documents/doc-1/file",
    async (route) => {
      fileRequests++;
      await route.fulfill({
        contentType: "text/html",
        body: "<h1>Original source content</h1>",
      });
    },
  );
  await page.goto("/admin/knowledge");
  await page
    .getByRole("button", { name: "结构分析方法与二次入场.pdf", exact: true })
    .click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("tab", { name: "原文", exact: true }).click();
  await expect(drawer.locator("iframe")).toHaveAttribute("src", /^blob:/);
  const blobUrl = await drawer.locator("iframe").getAttribute("src");
  expect(
    await page.evaluate(async (url) => (await fetch(url!)).text(), blobUrl),
  ).toContain("Original source content");
  await drawer.getByRole("tab", { name: /分块/ }).click();
  await drawer.getByRole("tab", { name: "原文", exact: true }).click();
  expect(
    await page.evaluate(async (url) => (await fetch(url!)).text(), blobUrl),
  ).toContain("Original source content");
  expect(fileRequests).toBe(1);
  await drawer.getByRole("button", { name: /close|关闭/i }).click();
  await expect(drawer).not.toBeVisible();
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(url!);
        return true;
      } catch {
        return false;
      }
    }, blobUrl),
  ).toBe(false);
});

test("manifest imports only selected public fetch entries and reports partial failures", async ({
  page,
}) => {
  const entry = {
    id: "public-entry",
    url: "https://example.invalid/public",
    type: "article",
    title: "Public source",
    topics: ["h2"],
    status: "pending",
    docId: null,
    lastError: null,
    enabled: true,
    access: "public",
    sourceTier: "official",
    importMethod: "url_fetch",
    notes: null,
    updatedAt: 1792800000000,
  };
  const restricted = {
    ...entry,
    id: "restricted-entry",
    title: "Restricted source",
    access: "purchase",
    importMethod: "user_upload",
  };
  await page.route("**/api/admin/knowledge/manifest-entries", (route) =>
    route.fulfill({ json: { entries: [entry, restricted] } }),
  );
  let imported: unknown;
  await page.route(
    "**/api/admin/knowledge/documents/import-manifest",
    async (route) => {
      imported = route.request().postDataJSON();
      await route.fulfill({
        json: {
          summary: { imported: 0, duplicates: 0, failed: 1, pendingUpload: 0 },
          failures: [{ id: entry.id, error: "Source unavailable" }],
        },
      });
    },
  );
  await page.goto("/admin/knowledge");
  await page.getByRole("button", { name: "清单导入", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.locator(
      'tr[data-row-key="restricted-entry"] input[type="checkbox"]',
    ),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "导入所选条目", exact: true })
    .click();
  await expect(dialog.getByText(/Source unavailable/)).toBeVisible();
  expect(imported).toEqual({
    entries: [
      {
        id: entry.id,
        url: entry.url,
        type: entry.type,
        title: entry.title,
        topics: entry.topics,
        access: "public",
        sourceTier: "official",
        importMethod: "url_fetch",
        enabled: true,
      },
    ],
  });
});
