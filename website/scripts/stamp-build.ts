import { writeFile } from 'node:fs/promises'
import { brand } from '@biance/brand/identity'
import { publicOrigin } from '../lib/site'

await writeFile(new URL('../.next/build-identity.json', import.meta.url), JSON.stringify({ origin: publicOrigin(), brand: brand.name }) + '\n')
