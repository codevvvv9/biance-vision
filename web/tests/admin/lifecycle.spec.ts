import { test, expect } from "./fixtures";

test("slow research responses cannot overwrite a newly selected user", async ({
  page,
}) => {
  await page.route("**/api/admin/users", (route) =>
    route.fulfill({
      json: { users: [{ username: "alice" }, { username: "bob" }] },
    }),
  );
  let releaseAlice!: () => void;
  const aliceWait = new Promise<void>((resolve) => {
    releaseAlice = resolve;
  });
  await page.route("**/api/admin/conversations?**", async (route) => {
    const username = new URL(route.request().url()).searchParams.get(
      "username",
    );
    if (username === "alice") await aliceWait;
    await route.fulfill({
      json: {
        conversations: [
          {
            id: `${username}-1`,
            title: `${username} conversation`,
            messageCount: 1,
            updatedAt: 1792800000000,
            context: {},
          },
        ],
      },
    });
  });
  await page.goto("/admin/ai");
  const choose = page.getByRole("combobox", { name: "选择用户", exact: true });
  await choose.click();
  const requested = page.waitForRequest((request) =>
    request.url().includes("username=alice"),
  );
  await page.getByTitle("alice", { exact: true }).click();
  await requested;
  await choose.click();
  await page.getByTitle("bob", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "bob conversation", exact: true }),
  ).toBeVisible();
  const returned = page.waitForResponse((response) =>
    response.url().includes("username=alice"),
  );
  releaseAlice();
  await returned;
  await expect(
    page.getByRole("button", { name: "alice conversation", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "bob conversation", exact: true }),
  ).toBeVisible();
});

test("evaluation polling stops on tab change, route change and session expiry", async ({
  page,
  apiFixture,
}) => {
  await page.clock.install();
  await page.goto("/admin/evals");
  const count = () =>
    apiFixture.requests.filter(
      (request) => request.path === "/api/admin/evaluations/runs",
    ).length;
  await expect.poll(count).toBe(1);
  await page.clock.runFor(8100);
  await expect.poll(count).toBeGreaterThan(1);
  await page.getByRole("tab", { name: "数据集", exact: true }).click();
  const stopped = count();
  await page.clock.runFor(20000);
  expect(count()).toBe(stopped);
  await page.getByRole("tab", { name: "评测运行", exact: true }).click();
  await expect.poll(count).toBeGreaterThan(stopped);
  await page.route("**/api/admin/evaluations/runs", (route) =>
    route.fulfill({ status: 401, json: { message: "Session expired" } }),
  );
  await page.clock.runFor(8100);
  await expect(page.getByLabel("账号", { exact: true })).toBeVisible();
  const expired = count();
  await page.clock.runFor(20000);
  expect(count()).toBe(expired);
});

test("ordinary users see the access-denied boundary without mounting business pages", async ({
  page,
  apiFixture,
}) => {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user: { username: "ordinary", role: "user" } } }),
  );
  await page.goto("/admin/knowledge");
  await expect(page.locator(".ant-result")).toContainText("非管理员账号");
  expect(
    apiFixture.requests.some((request) =>
      request.path.startsWith("/api/admin/knowledge"),
    ),
  ).toBe(false);
});

test("failed logout displays revocation warning; successful login clears stale warnings", async ({
  page,
}) => {
  await page.route("**/api/auth/logout", (route) => route.abort("failed"));
  await page.goto("/admin/knowledge");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("撤销");
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("correct");
  await page.getByRole("button", { name: "登录管理后台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "管理面板", exact: true }),
  ).toBeVisible();
});

test("English language switches application and Ant Design pagination locale together", async ({
  page,
}) => {
  await page.goto("/admin/knowledge");
  await page.getByRole("combobox", { name: "语言", exact: true }).click();
  await page.getByTitle("English", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Knowledge base", exact: true }),
  ).toBeVisible();
  await expect(page.getByTitle("Next Page", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload documents", exact: true }),
  ).toBeVisible();
});

test("AI profile save explicitly refreshes the active feature without a user AI provider", async ({
  page,
  apiFixture,
}) => {
  await page.goto("/admin/ai?view=legacy");
  const overviewCount = () =>
    apiFixture.requests.filter(
      (request) => request.path === "/api/admin/ai/overview",
    ).length;
  await expect.poll(overviewCount).toBe(1);
  await page.getByRole("button", { name: "AI 配置", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "AI 配置", exact: true });
  await expect(drawer.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://example.invalid/v1",
  );
  await drawer
    .getByLabel("Base URL", { exact: true })
    .fill("https://changed.invalid/v1");
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect.poll(overviewCount).toBe(2);
  expect(
    apiFixture.requests.filter(
      (request) =>
        request.method === "PUT" && request.path === "/api/admin/ai/config",
    ),
  ).toHaveLength(1);
});
