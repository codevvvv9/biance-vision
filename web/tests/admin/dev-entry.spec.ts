import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import path from "node:path";

test("development HTML fallback always serves the independent admin entry", async () => {
  const server = await createServer({
    configFile: path.resolve("vite.admin.config.ts"),
    server: { host: "127.0.0.1", port: 17848, strictPort: true },
    logLevel: "error",
  });
  await server.listen();
  try {
    for (const route of [
      "/admin/",
      "/admin/knowledge",
      "/admin/ai?view=legacy",
      "/admin/not-a-page",
    ]) {
      const response = await fetch(`http://127.0.0.1:17848${route}`, {
        headers: { accept: "text/html" },
      });
      const html = await response.text();
      expect(response.ok).toBe(true);
      expect(html).toContain("src/admin-main.tsx");
      expect(html).not.toContain("src/main.tsx");
    }
  } finally {
    await server.close();
  }
});

test("development proxy rejects a user-api target before forwarding business requests", async () => {
  const { createServer: createHttpServer } = await import("node:http");
  let businessRequests = 0;
  const target = createHttpServer((request, response) => {
    if (request.url !== "/api/health") businessRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ entry: "user-api" }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address() as { port: number };
  const previous = process.env.BV_ADMIN_API_TARGET;
  process.env.BV_ADMIN_API_TARGET = `http://127.0.0.1:${address.port}`;
  const server = await createServer({
    configFile: path.resolve("vite.admin.config.ts"),
    server: { host: "127.0.0.1", port: 17848, strictPort: true },
    logLevel: "silent",
  });
  try {
    await server.listen();
    const response = await fetch("http://127.0.0.1:17848/api/admin/users");
    expect(response.status).toBe(502);
    expect(businessRequests).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.BV_ADMIN_API_TARGET;
    else process.env.BV_ADMIN_API_TARGET = previous;
    await server.close();
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
