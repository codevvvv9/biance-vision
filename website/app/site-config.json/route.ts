import { readPublicContacts, readPublicHeroGame } from '@/lib/public-config'
export const dynamic = 'force-dynamic'
export async function GET() {
  const [contacts, heroGame] = await Promise.all([readPublicContacts(), readPublicHeroGame()])
  return Response.json({ contacts, heroGame }, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } })
}
