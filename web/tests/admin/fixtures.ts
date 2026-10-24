import { test as base, expect } from "@playwright/test";
export const documents = [
  {
    id: "doc-1",
    title: "结构分析方法与二次入场.pdf",
    status: "published",
    sourceType: "file",
    sourceTier: "official",
    access: "public",
    version: 1,
    contentHash: "fixture-1",
    createdAt: 1792800000000,
  },
  {
    id: "doc-2",
    title:
      "A very long document title with multiple words and structured examples.md",
    status: "indexed",
    sourceType: "file",
    sourceTier: "community",
    access: "public",
    version: 0,
    contentHash: "fixture-2",
    createdAt: 1792800000000,
  },
  {
    id: "doc-3",
    title: "解析失败示例.txt",
    status: "failed",
    error: "Parser unavailable",
    sourceType: "file",
    sourceTier: "community",
    access: "public",
    version: 0,
    contentHash: "fixture-3",
    createdAt: 1792800000000,
  },
];
export const capabilities = Object.fromEntries(
  ["chat", "embedding", "rerank", "vision", "search"].map((key) => [
    key,
    { enabled: false },
  ]),
);
export const test = base.extend<{
  apiFixture: {
    setAuthenticated: (value: boolean) => void;
    requests: { method: string; path: string; body: unknown }[];
  };
}>({
  apiFixture: [
    async ({ page }, use) => {
      let authenticated = true;
      const requests: { method: string; path: string; body: unknown }[] = [];
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        requests.push({
          method: request.method(),
          path: path + url.search,
          body: (() => {
            try {
              return request.postDataJSON();
            } catch {
              return "[multipart upload]";
            }
          })(),
        });
        let status = 200,
          data: unknown = {};
        if (path === "/api/auth/me") {
          if (authenticated)
            data = { user: { username: "fixture-admin", role: "superadmin" } };
          else {
            status = 401;
            data = { message: "Unauthorized" };
          }
        } else if (path === "/api/auth/logout") {
          authenticated = false;
          data = { ok: true };
        } else if (path === "/api/auth/login") {
          const body = request.postDataJSON();
          if (body.password !== "correct") {
            status = 401;
            data = { message: "Invalid credentials" };
          } else {
            authenticated = true;
            data = { user: { username: "fixture-admin", role: "superadmin" } };
          }
        } else if (path === "/api/admin/users")
          data = {
            users: [
              {
                username: "fixture-user",
                role: "user",
                createdAt: 1792800000000,
                chatPolicy: { disabled: false, dailyLimit: null },
                chatUsage: { today: 0, limit: null },
                activeRecently: false,
              },
            ],
          };
        else if (path === "/api/admin/audit-logs")
          data = { records: [], usernames: ["fixture-user"] };
        else if (path === "/api/admin/knowledge/documents")
          data =
            request.method() === "POST"
              ? { status: "created", document: { id: "created-upload" } }
              : { documents };
        else if (path === "/api/admin/knowledge/documents/precheck")
          data = { duplicate: false, existingTitle: null };
        else if (
          path === "/api/admin/knowledge/documents/created-upload" &&
          request.method() === "DELETE"
        )
          data = { ok: true };
        else if (path === "/api/admin/knowledge/documents/batch")
          data = {
            succeeded: ["doc-2"],
            failed: [{ id: "doc-3", error: "Parser unavailable" }],
          };
        else if (path === "/api/admin/knowledge/rule-cards")
          data = { cards: [] };
        else if (path === "/api/admin/knowledge/cases") data = { cases: [] };
        else if (path === "/api/admin/knowledge/versions")
          data = { versions: [] };
        else if (path === "/api/admin/knowledge/manifest-entries")
          data = { entries: [] };
        else if (path.endsWith("/preview"))
          data = {
            document: documents[0],
            chunks: [],
            parseMeta: {},
            vector: { support: "none", note: "" },
          };
        else if (path.endsWith("/events"))
          data = {
            title: documents[0].title,
            status: "published",
            events: [],
            hasEvents: false,
            runNo: 0,
            attemptId: null,
          };
        else if (path === "/api/admin/agents/versions")
          data = { versions: [], currentVersionId: null };
        else if (path === "/api/admin/agents/capabilities")
          data = { capabilities, source: "app_settings" };
        else if (path === "/api/admin/prompts")
          data = { templates: [], pointers: [] };
        else if (path === "/api/admin/settings/disclaimers")
          data = { disclaimers: { common: "", perp: "", event: "" } };
        else if (path === "/api/admin/settings/chat-input")
          data = { chatInput: { scenes: {} } };
        else if (path === "/api/admin/evaluations/datasets")
          data = { datasets: [] };
        else if (path === "/api/admin/evaluations/runs") data = { runs: [] };
        else if (path === "/api/admin/models/train") data = { ok: true };
        else if (path === "/api/admin/models")
          data = { models: [], researchPy: { healthy: true } };
        else if (path === "/api/admin/ai/overview") data = { stats: [] };
        else if (path === "/api/admin/ai/config")
          data = {
            profiles: {
              default: {
                baseUrl: "https://example.invalid/v1",
                model: "fixture-model",
                apiKeyMasked: "***fixture",
                enableTools: true,
              },
            },
          };
        else if (path === "/api/admin/ai/models")
          data = { models: ["fixture-model"] };
        else if (path === "/api/admin/ai/prompt")
          data = { prompt: "Fixture prompt" };
        else if (path === "/api/admin/conversations")
          data = { conversations: [] };
        else if (path === "/api/ai/status")
          data = { configured: false, model: "" };
        else {
          status = 404;
          data = { message: `Unmocked: ${request.method()} ${path}` };
        }
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      });
      await use({
        setAuthenticated: (value) => {
          authenticated = value;
        },
        requests,
      });
    },
    { auto: true },
  ],
});
export { expect };
