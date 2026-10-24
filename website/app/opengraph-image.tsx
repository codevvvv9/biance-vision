import { ImageResponse } from 'next/og'
export const alt = 'Biance Vision — Evidence before conviction.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export default function Image() {
  return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '80px', color: '#eff5f8', background: '#0c1520' }}><div style={{ display: 'flex', fontSize: 20, letterSpacing: 6, color: '#8cd5bc', marginBottom: 40 }}>BIANCE VISION</div><div style={{ display: 'flex', fontSize: 82, letterSpacing: -3 }}>Evidence before</div><div style={{ display: 'flex', fontSize: 82, letterSpacing: -3, color: '#9de5c9' }}>conviction.</div><div style={{ display: 'flex', fontSize: 23, color: '#8198ab', marginTop: 35 }}>Market structure. Evidence. A clearer perspective.</div></div>, size)
}
