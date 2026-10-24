import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const phase = process.argv[2]
const output = process.argv[3]
if (!['baseline','post-index'].includes(phase) || !output) throw new Error('Usage: tsx scripts/prepare-observations.ts baseline|post-index /absolute/new-file.csv')
const prompts = JSON.parse(await readFile(new URL('../evaluation/prompts.json', import.meta.url), 'utf8')) as { id: string; locale: string; question: string }[]
const platforms = ['ChatGPT Search', 'Perplexity', 'Google AI Search', 'Bing / Copilot']
const headers = ['phase','observed_at','platform','prompt_id','locale','question','status','search_triggered','brand_mentioned','citation_urls','misstatement','evidence_reference','reason']
const quote = (v: string) => `"${v.replace(/"/g, '""')}"`
const rows = platforms.flatMap(platform => prompts.map(p => [phase,'',platform,p.id,p.locale,p.question,'未观测','','','','','','等待独立会话人工检查；不得将空白解释为未提及或未引用']))
await writeFile(resolve(output), [headers, ...rows].map(row => row.map(quote).join(',')).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
console.log(`Prepared ${rows.length} unobserved rows. No platform was queried and no result was inferred.`)
