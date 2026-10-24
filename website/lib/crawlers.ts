// A dedicated user-agent group does not inherit '*'. Repeat the protected paths.
export const protectedPaths = ['/api', '/admin', '/dashboard', '/research', '/brooks', '/movers', '/alerts', '/login', '/register', '/site-config.json']
export const searchAgents = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'PerplexityBot']
export const crawlerRules = [
  { userAgent: '*', allow: '/', disallow: protectedPaths },
  ...searchAgents.map(userAgent => ({ userAgent, allow: '/', disallow: protectedPaths })),
  { userAgent: 'GPTBot', disallow: '/' },
]
