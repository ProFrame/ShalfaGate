import { ArrowLeft, BellRing, ExternalLink, FileCheck2, FolderLock, MapPinned, ShieldCheck } from 'lucide-react';
import { Link } from 'wouter';
import Footer from './Footer';
import LanguageSwitcher from './LanguageSwitcher';
import { useLanguage } from '../context/LanguageContext';
import logo from '../assets/logo.png';
import portalHero from '../assets/portal-hero.png';

const LandingPage = () => {
  const { t, isRtl } = useLanguage();
  const highlights = [
    { icon: FileCheck2, title: t('faster_actions'), text: t('faster_actions_text') },
    { icon: FolderLock, title: t('approved_content'), text: t('approved_content_text') },
    { icon: BellRing, title: t('stay_informed'), text: t('stay_informed_text') },
  ];

  return (
    <div className="public-site">
      <header className="public-header">
        <Link href="/" className="public-logo"><img src={logo} alt="Shalfa" /></Link>
        <nav>
          <a href="#about">{t('about_platform')}</a>
          <a href="#services">{t('services')}</a>
          <a href="#support">{t('support')}</a>
        </nav>
        <div className="public-header-actions">
          <LanguageSwitcher />
          <Link href="/login" className="primary-button">
            {t('login')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={17} />
          </Link>
        </div>
      </header>

      <main>
        <section className="landing-hero" style={{ backgroundImage: `url(${portalHero})` }}>
          <div className="landing-scrim" />
          <div className="landing-copy">
            <span className="eyebrow">{t('portal_eyebrow')}</span>
            <h1>{t('landing_title')}</h1>
            <p>{t('landing_subtitle')}</p>
            <div className="landing-actions">
              <Link href="/login" className="primary-button primary-button-lg">
                {t('enter_portal')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={19} />
              </Link>
              <a href="#about" className="secondary-button">{t('discover_platform')}</a>
            </div>
          </div>
          <div className="hero-trust"><ShieldCheck size={19} /><span>{t('employee_only')}</span></div>
        </section>

        <section id="about" className="landing-intro">
          <div>
            <span className="section-kicker">{t('built_for_work')}</span>
            <h2>{t('less_search_more_done')}</h2>
          </div>
          <p>{t('landing_about')}</p>
        </section>

        <section id="services" className="feature-band">
          {highlights.map(({ icon: Icon, title, text }, index) => (
            <article key={title} className="landing-feature">
              <span className="feature-number">0{index + 1}</span>
              <Icon size={26} />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </section>

        <section id="support" className="landing-cta">
          <div><span className="section-kicker">{t('login')}</span><h2>{t('unified_experience')}</h2></div>
          <Link href="/login" className="secondary-button">
            {t('open_login')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={18} />
          </Link>
        </section>

        <a className="company-map" href="https://maps.app.goo.gl/RbXYTwhnx2hdHhoG9" target="_blank" rel="noreferrer">
          <div className="company-map-copy">
            <span className="company-map-icon"><MapPinned /></span>
            <div><span className="section-kicker">{t('company_location')}</span><h2>{t('company_location_text')}</h2><p>{t('open_in_google_maps')} <ExternalLink /></p></div>
          </div>
          <div className="company-map-frame">
            <iframe title={t('company_location')} loading="lazy" src="https://www.google.com/maps?q=Shalfa+Facility+Management+Riyadh&output=embed" />
          </div>
        </a>
      </main>
      <Footer />
    </div>
  );
};

export default LandingPage;
