import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 端口由 scripts/dev.ts 启动器探测后通过环境变量注入（被占用时自动切换），
// 手动运行 `npm run dev:web` 时使用下面的默认值
const apiPort = process.env.BV_API_PORT || 3200
const webPort = Number(process.env.BV_WEB_PORT || 17834)

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true, // 端口被占时直接报错退出，由启动器负责换端口
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
})
