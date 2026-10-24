import { readPublicContacts } from '@/lib/public-config'
export const dynamic = 'force-dynamic'
export async function GET() {
  return Response.json(await readPublicContacts(), { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } })
}
