FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY website/package.json website/
COPY packages/brand/package.json packages/brand/
COPY server/package.json server/
COPY web/package.json web/
COPY shared/package.json shared/
COPY packages/shared-ui/package.json packages/shared-ui/
RUN pnpm --filter @biance/website... install --frozen-lockfile
COPY website website
COPY packages/brand packages/brand
COPY shared shared
# Only the public IPv4 CIDR list is copied; backend data and keys never enter this image.
COPY website/data/cn-ipv4.txt website/data/cn-ipv4.txt
ARG WEBSITE_ORIGIN=http://localhost:3100
ARG GOOGLE_SITE_VERIFICATION=
ARG BING_SITE_VERIFICATION=
ENV WEBSITE_ORIGIN=$WEBSITE_ORIGIN GOOGLE_SITE_VERIFICATION=$GOOGLE_SITE_VERIFICATION BING_SITE_VERIFICATION=$BING_SITE_VERIFICATION NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter biance-vision-brooks build && pnpm --filter @biance/website build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3100
COPY --from=build --chown=node:node /app/website/.next/standalone ./
COPY --from=build --chown=node:node /app/website/.next/static ./website/.next/static
COPY --from=build --chown=node:node /app/website/public ./website/public
COPY --from=build --chown=node:node /app/website/data ./website/data
COPY --from=build --chown=node:node /app/website/runtime ./website/runtime
RUN mkdir /app/website-logs && chown node:node /app/website-logs && chmod 700 /app/website-logs
USER node
EXPOSE 3100
CMD ["node", "--import", "./website/runtime/access-log.mjs", "website/server.js"]
