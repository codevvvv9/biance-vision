import { ImageResponse } from 'next/og'
import { brand, duck } from '@biance/brand/identity'

export const alt = `${brand.name} — ${brand.promise.en}`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function Image() {
  return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '72px 80px', color: '#eff5f8', background: '#0c1520' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 34, marginBottom: 45 }}>
      <svg width="66" height="66" viewBox="0 0 64 64" fill="none"><path d={duck.body} fill={brand.yellow} /><path d={duck.beak} fill="#ed9949" /><path d={duck.wing} stroke="#b88726" strokeWidth="2" /><circle cx="36" cy="16" r="2.2" fill="#182125" /></svg>{brand.name}
    </div>
    <div style={{ display: 'flex', fontSize: 68, letterSpacing: -2 }}>Navigate risk.</div>
    <div style={{ display: 'flex', fontSize: 68, letterSpacing: -2, color: brand.yellow }}>Make informed decisions.</div>
    <div style={{ display: 'flex', fontSize: 23, color: '#91a4b5', marginTop: 35 }}>{brand.positioning.en}</div>
    <div style={{ display: 'flex', fontSize: 16, color: '#728797', marginTop: 22 }}>{brand.domain} · Evidence. Counterevidence. Conditions.</div>
  </div>, size)
}
