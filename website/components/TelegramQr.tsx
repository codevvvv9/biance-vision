import QRCode from 'qrcode'
import { text, type Locale } from '@/lib/site'

/** Generated from the same validated username as the contact button. No remote QR service. */
export async function TelegramQr({ username, locale }: { username: string; locale: Locale }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) return null
  const svg = await QRCode.toString(`https://t.me/${username}`, { type: 'svg', margin: 2, width: 112, errorCorrectionLevel: 'M', color: { dark: '#102a22', light: '#e9f4ef' } })
  return <div className="telegram-qr"><div role="img" aria-label={text(locale, `Scan to contact @${username} on Telegram`, `扫码在 Telegram 联系 @${username}`)} dangerouslySetInnerHTML={{ __html: svg }} /><span>{text(locale, 'Or scan with your phone', '也可使用手机扫码')}</span></div>
}
