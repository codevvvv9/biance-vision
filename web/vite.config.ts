import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 端口由 scripts/dev.ts 启动器探测后通过环境变量注入（被占用时自动切换），
// 手动运行 `npm run dev:web` 时使用下面的默认值
const apiPort = process.env.BV_API_PORT || 3200
const webPort = Number(process.env.BV_WEB_PORT || 17834)

export default defineConfig({
  plugins: [react()],
  build: {
    // 项目无需支持 2020 年前的浏览器（现代 evergreen），提升 target 去掉降级转换
    target: 'es2020',
    rollupOptions: {
      output: {
        // chunk 文件名带内容稳定的短哈希之外的稳定段：vendor/markdown 与业务 chunk 分开缓存
        chunkFileNames: 'assets/[name]-[hash].js',
        // 函数式分包按模块路径精确归属（对象式会把 react/jsx-runtime 错误吸进
        // markdown chunk，导致入口被迫预加载 433KB 富文本库）：
        // - vendor：react 全家桶 + react/jsx-runtime 子路径 → 业务发版时命中缓存
        // - kline：klinecharts 图表库
        // - markdown：react-markdown/katex 及其解析器传递依赖（micromark/mdast/hast/unist…），
        //   只被懒加载页面（AI 助手/研究台/admin）引用，不进首屏关键路径
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
    port: webPort,
    strictPort: true, // 端口被占时直接报错退出，由启动器负责换端口
    allowedHosts: ['.tunnel.otun.dev'], // 前缀点号 = 允许该域名下所有子域（otun 隧道）
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
})
