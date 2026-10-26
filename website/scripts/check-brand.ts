import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname } from 'node:path'
import { brandMarkSvg } from '@biance/brand/identity'

const root = fileURLToPath(new URL('../../', import.meta.url))
// The website Docker build deliberately does not receive server/web source trees.
// Full-repository checks still run before image creation in CI and release gates.
const websiteOnly = process.env.BRAND_CHECK_WEBSITE_ONLY === '1'
const oldBrand = /Biance Vision|BIANCE(?:&nbsp;|\s*)VISION|>VISION<|['"]VISION['"]/u
const oldDomain = /btcpilot(?:-admin)?\.duckdns\.org/u
const errors: string[] = []
async function check(path: string): Promise<void> {
  const entries = await readdir(resolve(root, path), { withFileTypes: true })
  for (const entry of entries) {
    const relative = `${path}/${entry.name}`
    if (entry.isDirectory()) await check(relative)
    else if (/\.(?:tsx?|json|mdx|html)$/.test(extname(relative))) {
      const source = await readFile(resolve(root, relative), 'utf8')
      if (oldBrand.test(source) || oldDomain.test(source)) errors.push(`Retired public identity in ${relative}`)
    }
  }
}
for (const path of ['website/app', 'website/components', 'website/lib', 'website/content', 'website/evaluation', ...(websiteOnly ? [] : ['web/src', 'packages/shared-ui/src/locales', 'server/src'])]) await check(path)
for (const path of websiteOnly ? [] : ['web/index.html', 'web/admin.html']) {
  if (oldBrand.test(await readFile(resolve(root, path), 'utf8'))) errors.push(`Retired title in ${path}`)
}
for (const path of ['packages/brand/mark.svg', 'website/public/site-assets/mark.svg', ...(websiteOnly ? [] : ['web/public/assets/duckstrat-mark.svg'])]) {
  if (await readFile(resolve(root, path), 'utf8') !== brandMarkSvg) errors.push(`Brand asset out of sync: ${path}`)
}
if (errors.length) throw new Error(errors.join('\n'))
console.log('DuckStrat identity checked: public copy and shared marks are consistent; historical records excluded.')
