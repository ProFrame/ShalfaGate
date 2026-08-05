// The company landing page served at /{slug}/.
//
// Nothing on this page names a company in a string: the logo, the cover image,
// the name inside every sentence, the head-office card and the contact channels
// all come from the company that owns the address, in the language the visitor
// is reading. A company that supplied none of them still gets a complete page —
// the parts it did not provide simply do not exist.

import { ArrowLeft, BellRing, ExternalLink, FileCheck2, FolderLock, MapPinned, ShieldCheck } from 'lucide-react';
import { motion } from 'framer-motion';
import { Link } from 'wouter';
import Footer from './Footer';
import LanguageSwitcher from './LanguageSwitcher';
import TenantLogo, { useTenantLogo } from './branding/TenantLogo';
import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import { safeExternalUrl } from '../utils/safeUrl';
import portalHero from '../assets/portal-hero.webp';
import './branding/branding.css';

// A stored head-office link is normally a shareable Google Maps link, which
// cannot be framed. Only a real embed link goes into the iframe; anything else
// keeps the card and shows a plain panel beside the copy.
const isEmbeddableMap = (url) => /\/maps\/embed|[?&]output=embed/i.test(url);

const CompanyLocation = ({ mapUrl, companyName }) => {
  const { t } = useLanguage();

  return (
    <a className="company-map" href={mapUrl} target="_blank" rel="noreferrer noopener">
      <div className="company-map-copy">
        <span className="company-map-icon" aria-hidden="true"><MapPinned /></span>
        <div>
          <span className="section-kicker">{t('company_location')}</span>
          <h2>
            {companyName
              ? t('company_location_of', { company: companyName })
              : t('company_head_office')}
          </h2>
          <p>{t('open_in_maps')} <ExternalLink aria-hidden="true" /></p>
        </div>
      </div>
      <div className="company-map-frame">
        {isEmbeddableMap(mapUrl) ? (
          <iframe title={t('company_location')} loading="lazy" src={mapUrl} />
        ) : (
          <span className="company-map-placeholder" aria-hidden="true"><MapPinned /></span>
        )}
      </div>
    </a>
  );
};

const LandingPage = () => {
  const { t, isRtl } = useLanguage();
  const { branding, tenantName } = useTenant();
  const { hasLogo } = useTenantLogo('light');

  const heroImage = branding?.hero_image_url?.trim() || portalHero;
  const mapUrl = safeExternalUrl(branding?.map_url);

  const highlights = [
    { icon: FileCheck2, title: t('faster_actions'), text: t('faster_actions_text') },
    { icon: FolderLock, title: t('approved_content'), text: t('approved_content_text') },
    { icon: BellRing, title: t('stay_informed'), text: t('stay_informed_text') },
  ];

  return (
    <div className="public-site">
      <header className="public-header">
        {hasLogo ? (
          <Link href="/" className="public-logo"><TenantLogo variant="light" /></Link>
        ) : (
          <span className="public-logo public-logo-empty" aria-hidden="true" />
        )}
        <nav>
          <a href="#about">{t('about_platform')}</a>
          <a href="#services">{t('services')}</a>
          <a href="#support">{t('support')}</a>
        </nav>
        <div className="public-header-actions">
          <LanguageSwitcher />
          <Link href="/login" className="primary-button">
            {t('login')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={17} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <main>
        <section className="landing-hero" style={{ backgroundImage: `url(${heroImage})` }}>
          <div className="landing-scrim" />
          <motion.div
            className="landing-copy"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: .5, ease: 'easeOut' }}
          >
            <span className="eyebrow">{t('landing_eyebrow')}</span>
            <h1>
              {tenantName
                ? t('landing_title_company', { company: tenantName })
                : t('landing_title_generic')}
            </h1>
            <p>{t('landing_subtitle_generic')}</p>
            <div className="landing-actions">
              <Link href="/login" className="primary-button primary-button-lg">
                {t('enter_portal')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={19} aria-hidden="true" />
              </Link>
              <a href="#about" className="secondary-button">{t('discover_platform')}</a>
            </div>
          </motion.div>
          <div className="hero-trust"><ShieldCheck size={19} aria-hidden="true" /><span>{t('employee_only')}</span></div>
        </section>

        <section id="about" className="landing-intro">
          <div>
            <span className="section-kicker">{t('built_for_work')}</span>
            <h2>{t('less_search_more_done')}</h2>
          </div>
          <p>{t('landing_about_generic')}</p>
        </section>

        <section id="services" className="feature-band">
          {highlights.map(({ icon: Icon, title, text }, index) => (
            <article key={title} className="landing-feature">
              <span className="feature-number">0{index + 1}</span>
              <Icon size={26} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </section>

        <section id="support" className="landing-cta">
          <div><span className="section-kicker">{t('login')}</span><h2>{t('unified_experience')}</h2></div>
          <Link href="/login" className="secondary-button">
            {t('open_login')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={18} aria-hidden="true" />
          </Link>
        </section>

        {mapUrl && <CompanyLocation mapUrl={mapUrl} companyName={tenantName} />}
      </main>
      <Footer />
    </div>
  );
};

export default LandingPage;
