import { brand } from '@biance/brand/identity'
import { Brand } from './Brand'
import { Arrow } from './Icons'
import { disclaimer, loginUrl, text, type Locale } from '@/lib/site'

export function Footer({ locale }: { locale: Locale }) {
  return <footer className="site-footer container">
    <div className="footer-top">
      <div><a className="brand-link" href={`/${locale}`} aria-label={brand.name}><Brand /></a><p>{text(locale, 'A clearer view of the market.\nA better question to ask next.', '更清晰地观察市场，\n更有依据地提出下一个问题。', '更清晰地觀察市場，\n更有依據地提出下一個問題。')}</p></div>
      <div className="footer-links"><span>{text(locale, 'EXPLORE', '探索产品', '探索產品')}</span><a href={`/${locale}/about`}>{text(locale, 'About DuckStrat', '关于 DuckStrat', '關於 DuckStrat')}</a><a href={`/${locale}/methodology`}>{text(locale, 'Our approach', '研究方法', '研究方法')}</a><a href={`/${locale}/demo`}>{text(locale, 'Research demo', '研究演示', '研究演示')}</a><a href={`/${locale}/guides`}>{text(locale, 'Field notes', '使用指南', '使用指南')}</a></div>
      <div className="footer-links"><span>{text(locale, 'GET IN TOUCH', '联系与使用', '聯絡與使用')}</span><a href={`/${locale}/contact`}>{text(locale, 'Request access', '申请开通', '申請開通')} <Arrow diagonal /></a><a href={`/${locale}/contact`}>{text(locale, 'Email & Telegram', '邮件与 Telegram', '郵件與 Telegram')}</a><a href={loginUrl(locale)}>{text(locale, 'Already have an account? Log in', '已有账号？登录终端', '已有帳號？登入終端')}</a></div>
    </div>
    <div className="footer-bottom"><span>© {new Date().getUTCFullYear()} DuckStrat</span><p>{disclaimer(locale)}</p><span className="footer-note">BUILT FOR CLARITY.</span></div>
  </footer>
}
