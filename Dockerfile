# ---------- 构建阶段：装依赖 + 编译前后端 ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile
COPY . .
# shared（Brooks 结构引擎）必须先构建：server 与 web 都消费其 dist 产物
RUN pnpm --filter biance-vision-brooks run build && pnpm --filter biance-vision-server run build && pnpm --filter biance-vision-web run build

# ---------- 运行阶段：只带生产依赖与构建产物，镜像尽量小 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY shared/package.json shared/
RUN pnpm --filter biance-vision-server install --frozen-lockfile --prod
# shared 源码/编译器不进镜像，只带 dist（server 经 workspace 软链消费）
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/web/dist ./web/dist
# 容器内必须监听 0.0.0.0，宿主/隧道才能访问到
ENV HOST=0.0.0.0 PORT=3200
EXPOSE 3200
CMD ["node", "server/dist/index.js"]
