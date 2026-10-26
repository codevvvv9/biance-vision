import path from 'node:path'
import type { Plugin } from 'vite'
/** CI gate uses Rollup's actual module graph, not minified-string heuristics. */
export function buildIsolation(entry: 'user' | 'admin'): Plugin {
  return { name: 'build-isolation', apply: 'build', generateBundle() {
    const modules = [...this.getModuleIds()].map(id => id.replace(/\\/g, '/')).filter(id => !id.startsWith('\0'))
    const invalid = modules.filter(id => entry === 'user'
      ? /\/node_modules\/(?:\.pnpm\/)?(?:antd[@/]|@ant-design[+/]|echarts[@/]|echarts-wordcloud[@/]|zrender[@/])/.test(id) || /\/src\/admin\/(?!admin\.css(?:$|\?))/.test(id)
      : /\/src\/(?:market\/|ai\/AiContext|components\/Header)/.test(id) || /\/src\/styles\/(?:index|base|research|ai|auth|components)\.css(?:$|\?)/.test(id))
    if (invalid.length) this.error(`${entry} dependency isolation violated:\n${invalid.join('\n')}`)
    this.emitFile({ type: 'asset', fileName: 'build-modules.json', source: JSON.stringify({ entry, modules: modules.map(id => path.relative(process.cwd(), id)) }, null, 2) })
  } }
}
