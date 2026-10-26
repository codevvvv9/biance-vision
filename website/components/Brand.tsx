import { brand } from '@biance/brand/identity'

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand">
    <img src="/site-assets/mark.svg" width="38" height="38" alt="" />
    {!compact && <span className="brand-name">{brand.name}</span>}
  </span>
}
