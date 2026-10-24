import type { CSSProperties } from 'react'
export function Arrow({ diagonal = false, className = '' }: { diagonal?: boolean; className?: string }) {
  return <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={diagonal ? { transform: 'rotate(-45deg)' } as CSSProperties : undefined}><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
export function Crosshair() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.4" /><path d="M12 1v7m0 8v7M1 12h7m8 0h7" stroke="currentColor" strokeWidth="1.4" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></svg>
}
