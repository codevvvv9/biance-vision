import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * W3-S1 管理端独立构建（admin-web）：入口 admin.html → src/admin-main.tsx，
 * 产物 web/dist-admin（与用户端 dist 分离——用户端产物零 admin chunk）。
 * base '/admin/'：产物经 server 以 /admin 前缀托管（资源路径随之正确）；
 * dev 模式跑在 /admin/ 路径下（vite dev:admin，默认端口 17844）。
 */
const apiPort = process.env.BV_API_PORT || 3200
const adminWebPort = Number(process.env.BV_ADMIN_WEB_PORT || 17844)

const webDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
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
      // 入口 key 定为 index：产物 html 名为 index.html（server 以 /admin 前缀托管时
      // 命中 fastifyStatic 默认 index 与 SPA 回退 sendFile('index.html')）
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
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
})
