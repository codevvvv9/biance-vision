export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand">
    <svg width="36" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m20 3 14.7 8.5v17L20 37 5.3 28.5v-17L20 3Z" stroke="currentColor" strokeWidth="1.7" /><path d="M14 13v12m6-8v14m6-22v13" stroke="currentColor" strokeWidth="1.7" /><path d="M14 16v5m6 0v6m6-14v5" stroke="currentColor" strokeWidth="3.8" /></svg>
    {!compact && <span className="brand-name">BIANCE<span>VISION</span></span>}
  </span>
}
