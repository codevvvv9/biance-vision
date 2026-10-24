import { test, expect } from "@playwright/test";
import { buildIsolation } from "../../build-isolation";
function check(entry: "user" | "admin", modules: string[]): void {
  const hook = buildIsolation(entry).generateBundle;
  if (typeof hook !== "function") throw new Error("Missing build guard");
  hook.call(
    {
      getModuleIds: () => modules,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      emitFile: () => {},
    } as never,
    {} as never,
    {},
    false,
  );
}
test("user build rejects Ant Design and admin feature imports across package-manager layouts", () => {
  for (const module of [
    "/repo/node_modules/antd/es/button.js",
    "/repo/node_modules/.pnpm/antd@6.6.7_react@18/node_modules/antd/es/index.js",
    "/repo/node_modules/.pnpm/@ant-design+icons@6/node_modules/@ant-design/icons/index.js",
    "C:\\repo\\web\\src\\admin\\features\\ai\\api.ts",
  ])
    expect(() => check("user", [module])).toThrow("isolation violated");
  expect(() =>
    check("user", [
      "/repo/web/src/admin/admin.css",
      "/repo/web/src/styles/tokens.css",
      "/repo/node_modules/react/index.js",
    ]),
  ).not.toThrow();
});
test("admin build rejects user providers and full user style aggregates", () => {
  for (const module of [
    "/repo/web/src/market/MarketContext.tsx",
    "/repo/web/src/ai/AiContext.tsx",
    "/repo/web/src/components/Header.tsx",
    "/repo/web/src/styles/base.css",
    "/repo/web/src/styles/research.css",
  ])
    expect(() => check("admin", [module])).toThrow("isolation violated");
  expect(() =>
    check("admin", [
      "/repo/web/src/styles/tokens.css",
      "/repo/packages/shared-ui/src/components/MiniMarkdown.tsx",
    ]),
  ).not.toThrow();
});
