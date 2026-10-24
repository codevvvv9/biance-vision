import { buildIsolation } from './build-isolation'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * W3-S1 管理端独立构建（admin-web）：入口 admin.html → src/admin-main.tsx，
 * 产物 web/dist-admin（与用户端 dist 分离——用户端产物零 admin chunk）。
 * base '/admin/'：产物经 server 以 /admin 前缀托管（资源路径随之正确）；
 * dev 模式跑在 /admin/ 路径下（vite dev:admin，默认端口 17844）。
 */
const adminApiTarget = process.env.BV_ADMIN_API_TARGET
const adminWebPort = Number(process.env.BV_ADMIN_WEB_PORT || 17844)

const webDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [buildIsolation('admin'), react(), {
    name: 'admin-html-fallback',
    configureServer(server) {
      // Multi-page Vite otherwise falls back to the user index.html.
      server.middlewares.use((req, _res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const base = server.config.base.replace(/\/$/, '')
        if ((url.pathname === base || url.pathname.startsWith(`${base}/`)) && req.headers.accept?.includes('text/html') && !/\.[a-z0-9]+$/i.test(url.pathname)) req.url = `${base}/admin.html${url.search}`
        next()
      })
      if (!adminApiTarget) server.config.logger.warn('BV_ADMIN_API_TARGET is not set: admin API proxy disabled (never falls back to user-api).')
      else void fetch(new URL('/api/health', adminApiTarget)).then(async response => {
        const health = await response.json() as { entry?: string }
        if (!response.ok || health.entry !== 'admin-api') server.config.logger.error('BV_ADMIN_API_TARGET must point to admin-api (health.entry=admin-api).')
      }).catch(() => server.config.logger.warn('admin-api health check unavailable; start the configured admin-api.'))
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const base = server.config.base.replace(/\/$/, '')
        if ((url.pathname === base || url.pathname.startsWith(`${base}/`)) && req.headers.accept?.includes('text/html') && !/\.[a-z0-9]+$/i.test(url.pathname)) req.url = `${base}/admin.html${url.search}`
        next()
      })
    },
  } satisfies Plugin],
  base: '/admin/',
  resolve: {
    alias: { '@biance/shared-ui': path.resolve(webDir, '../packages/shared-ui/src') },
  },
  define: {
    // 独立 admin 入口标记（AdminLayout 据此隐藏「返回主站」等嵌入态元素）
    'import.meta.env.ADMIN_ENTRY': '"1"',
  },
  build: {
    target: 'es2020',
    outDir: 'dist-admin',
    rollupOptions: {
      // Vite keeps the source HTML filename: admin.html (also used by admin-api fallback).
      input: { index: path.resolve(webDir, 'admin.html') },
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        // 与用户端同款分包策略（管理端也用 MiniMarkdown → markdown chunk）
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]react[\\/]|[\\/]react-dom[\\/]|[\\/]scheduler[\\/]|[\\/]react-router/.test(id)) return 'vendor'
          if (id.includes('klinecharts')) return 'kline'
          if (
            /[\\/]katex|[\\/]react-markdown|[\\/]remark|[\\/]rehype|[\\/]micromark|[\\/]mdast|[\\/]hast|[\\/]unist|[\\/]unified|[\\/]vfile|[\\/]devlop|[\\/]bail|[\\/]trough|[\\/]is-plain-obj|[\\/]decode-named-character-reference|[\\/]character-entities|[\\/]property-information|[\\/]space-separated-tokens|[\\/]comma-separated-tokens|[\\/]trim-lines|[\\/]longest-streak/.test(id)
          ) {
            return 'markdown'
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: adminWebPort,
    strictPort: true,
    proxy: adminApiTarget ? { '/api': { target: adminApiTarget, changeOrigin: true } } : undefined,
  },
})
