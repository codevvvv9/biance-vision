/**
 * Regenerate the Traditional Chinese (zh-TW) tree from the Simplified source.
 *
 * zh-TW is a derived locale: the MDX bodies under content/zh-TW/ and the
 * "zh-TW" translation entries in content/manifest.json are produced here with
 * OpenCC (s2twp — Taiwan phrase-level conversion) and committed, so reviewers
 * see the exact traditional copy in diffs instead of a runtime dictionary.
 *
 * Run after editing any content/zh/*.mdx or the manifest's zh entries:
 *   pnpm --filter @biance/website sync:zh-tw
 *
 * The static UI copy is NOT handled here — it carries explicit traditional
 * variants at every text(locale, en, zh, tw) call site. The runtime converter
 * (lib/zh-tw.ts → @biance/shared-ui/src/zh-tw) is maintained by
 * packages/shared-ui/scripts/sync-zh-tw.ts.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import OpenCC from 'opencc-js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const phraseConverter = OpenCC.Converter({ from: 'cn', to: 'twp' })

/** TW convention prefers 帳號; OpenCC emits 賬號. */
export const toTw = (value: string) => phraseConverter(value).replace(/賬/g, '帳')

async function syncBodies() {
  const dir = join(root, 'content/zh')
  const target = join(root, 'content/zh-TW')
  await mkdir(target, { recursive: true })
  const files = (await readdir(dir)).filter(name => name.endsWith('.mdx'))
  for (const name of files) {
    const source = await readFile(join(dir, name), 'utf8')
    // Embedded figure components receive their locale as an attribute; rewrite it
    // so charts and figures render their traditional labels on this tree.
    await writeFile(join(target, name), toTw(source).replace(/locale="zh"/g, 'locale="zh-TW"'))
  }
  return files.length
}

type ManifestTranslation = Record<string, unknown>

async function syncManifest() {
  const path = join(root, 'content/manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Array<{
    topic: Record<string, string>
    translations: Record<string, ManifestTranslation>
  }>
  for (const item of manifest) {
    const zh = item.translations.zh
    if (!zh) continue
    const source = item.translations.en.url as string
    item.translations['zh-TW'] = {
      ...zh,
      locale: 'zh-TW',
      title: toTw(zh.title as string),
      summary: toTw(zh.summary as string),
      body: (zh.body as string).replace(/^content\/zh\//, 'content/zh-TW/'),
      url: (zh.url as string).replace(/^\/zh(?=\/|$)/, '/zh-TW'),
      translation: source,
      toc: (zh.toc as Array<{ id: string; title: string }>).map(entry => ({ ...entry, title: toTw(entry.title) })),
    }
    item.topic['zh-TW'] = toTw(item.topic.zh)
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  return manifest.length
}

const bodies = await syncBodies()
const entries = await syncManifest()
console.log(`zh-TW synced: ${bodies} MDX bodies, ${entries} manifest entries (converter lives in @biance/shared-ui)`)
