import createMDX from '@next/mdx'
import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'" + (process.env.NODE_ENV === 'development' ? ' ws: wss:' : ''),
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ')

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  trailingSlash: false,
  experimental: { globalNotFound: true },
  outputFileTracingRoot: fileURLToPath(new URL('../', import.meta.url)),
  turbopack: { root: fileURLToPath(new URL('../', import.meta.url)) },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }]
  },
}
export default createMDX({})(config)
