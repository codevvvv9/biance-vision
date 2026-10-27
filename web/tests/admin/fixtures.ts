import { plan as membershipPlan, refresh as membershipRefresh } from './membership-data'
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
            // 对齐真实服务端契约（authRoutes failLogin 统一出口）：401 必带
            // invalid_credentials 码，前端 errors 词典按码出文案
            data = { statusCode: 401, error: "Unauthorized", message: "用户名或密码错误", code: "invalid_credentials" };
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
        else if (path === "/api/admin/membership/plans") data = { plans: [membershipPlan], refresh: membershipRefresh };
        else if (path === "/api/admin/membership/stats") data = { stats: { active: 1, managed: 1, received: '15' }, refresh: membershipRefresh };
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
        else if (path === "/api/admin/evaluations/runs") {
          const day = (offset: number) => Date.now() - offset * 86_400_000;
          data = {
            runs: [
              { id: "run-1", datasetId: "ds-1", configVersion: "v1", status: "completed", metrics: { pass: 1 }, startedAt: day(2), endedAt: day(2) + 1000 },
              { id: "run-2", datasetId: "ds-1", configVersion: "v1", status: "completed", metrics: { pass: 1 }, startedAt: day(2) + 3600_000, endedAt: day(2) + 3600_000 + 1000 },
              { id: "run-3", datasetId: "ds-1", configVersion: "v1", status: "failed", metrics: null, startedAt: day(1), endedAt: day(1) + 1000 },
            ],
          };
        }
        else if (path === "/api/admin/models/train") data = { ok: true };
        else if (path === "/api/admin/models")
          data = { models: [], researchPy: { healthy: true } };
        else if (path === "/api/admin/ai/overview")
          data = {
            stats: [
              { username: "fixture-user", conversations: 2, messages: 12, memories: 3, lastActiveAt: Date.now(), profileName: "default" },
              { username: "fixture-admin", conversations: 1, messages: 5, memories: 0, lastActiveAt: Date.now() - 3600_000, profileName: "default" },
            ],
          };
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
        else if (path === "/api/admin/insights") {
          // v0.18.4 大盘业务洞察：3 天窗口样例（用户增长/DAU/消息/热点/词云）
          const d = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
          data = {
            days: 3,
            users: {
              total: 2,
              days: [
                { day: d(2), newUsers: 0, cumulative: 2 },
                { day: d(1), newUsers: 1, cumulative: 3 },
                { day: d(0), newUsers: 0, cumulative: 3 },
              ],
            },
            activity: {
              days: [
                { day: d(2), dau: 1 },
                { day: d(1), dau: 2 },
                { day: d(0), dau: 1 },
              ],
            },
            messages: {
              days: [
                { day: d(2), ai: 4, research: 2 },
                { day: d(1), ai: 6, research: 3 },
                { day: d(0), ai: 2, research: 1 },
              ],
            },
            hotspots: {
              cells: [
                { symbol: "BTCUSDT", horizon: "1h", count: 4 },
                { symbol: "BTCUSDT", horizon: "1d", count: 2 },
                { symbol: "ETHUSDT", horizon: "30m", count: 3 },
              ],
              products: [
                { product: "perp", count: 7 },
                { product: "event", count: 2 },
              ],
            },
            wordcloud: {
              words: [
                { name: "行情", value: 9 },
                { name: "BTC", value: 7 },
                { name: "仓位", value: 5 },
                { name: "止损", value: 4 },
                { name: "趋势", value: 3 },
              ],
            },
            observedAt: new Date().toISOString(),
          };
        }
        else if (path === "/api/admin/observability/timeseries") {
          const hour = (offset: number) =>
            new Date(Date.now() - offset * 3_600_000).toISOString().slice(0, 13) + ":00:00+08:00";
          data = {
            dbAvailable: true,
            http: {
              buckets: Array.from({ length: 24 }, (_, i) => ({
                hour: hour(23 - i),
                total: 10 + i,
                byClass: { c2xx: 8 + i, c4xx: 2, c5xx: i > 20 ? 1 : 0 },
                p95Ms: i > 20 ? 500 : 100,
              })),
            },
            events: {
              buckets: Array.from({ length: 24 }, (_, i) => ({
                hour: hour(23 - i),
                count: i % 5,
              })),
            },
            observedAt: new Date().toISOString(),
          };
        }
        else if (path === "/api/admin/research/stats") {
          const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
          data = {
            days: Array.from({ length: 14 }, (_, i) => ({
              day: day(13 - i),
              total: i % 4,
              completed: i % 4 === 3 ? 2 : i % 4,
              failed: i % 4 === 3 ? 1 : 0,
            })),
            observedAt: new Date().toISOString(),
          };
        }
        else if (path === "/api/admin/observability/overview")
          data = {
            dbAvailable: true,
            sink: { queueItems: 0, queued: 0, dropped: 0, lastFlushAt: Date.now(), lastErrorAt: null },
            inbox: { recent15m: 3, total: 30 },
            errorGroups: { recent15m: 0, open: 0 },
            workerHeartbeat: { at: Date.now(), ageMs: 5000, stale: false },
            observedAt: new Date().toISOString(),
          };
        else if (path === "/api/admin/observability/errors")
          data = { items: [], nextCursor: null, observedAt: new Date().toISOString() };
        else if (path === "/api/admin/observability/alerts")
          data = { items: [], observedAt: new Date().toISOString() };
        else if (path === "/api/admin/observability/logs")
          data = { items: [], note: "diagnostic-sampled", observedAt: new Date().toISOString() };
        else if (path === "/api/admin/queue-health")
          data = {
            queues: [
              {
                name: "market:ingest",
                created: 0,
                active: 0,
                retry: 0,
                completed: 12,
                failed: 0,
                oldestCreatedAgeSeconds: null,
                retentionMinutes: 30,
                purgeable: true,
              },
              {
                name: "knowledge:parse",
                created: 0,
                active: 0,
                retry: 0,
                completed: 3,
                failed: 0,
                oldestCreatedAgeSeconds: null,
                retentionMinutes: null,
                purgeable: false,
              },
            ],
          };
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
