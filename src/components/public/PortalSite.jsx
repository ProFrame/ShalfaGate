import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, BadgeCheck, Building2, CalendarCheck, ChevronDown, Globe2, Languages,
  Link2, MessageSquareText, Menu, Palette, ScrollText, ShieldCheck, Sparkles,
  SquareStack, Workflow, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import LanguageSwitcher from '../LanguageSwitcher';
import { companyUrl } from '../../lib/routing';
import { formatNumber } from '../../utils/localize';
import './public.css';

// The platform catalogue in docs/bbnovix_contract.md §5; shown as a headline
// figure so the number and the module list can never drift apart silently.
const MODULE_COUNT = 18;
const SETUP_MINUTES = 5;

// Example addresses used by the "your address" demo. These are slugs, not prose:
// they are rendered inside an LTR monospace URL and are never translated.
const SAMPLE_SLUGS = ['gold', 'atlas', 'meridian'];

// ---------------------------------------------------------------------------
// Motion helpers. Every animated block goes through these two so that honouring
// prefers-reduced-motion is a single decision rather than fifteen.
// ---------------------------------------------------------------------------

const useMotionPresets = () => {
  const reduce = useReducedMotion();

  return useMemo(() => ({
    reduce,
    reveal: {
      initial: reduce ? { opacity: 1 } : { opacity: 0, y: 26 },
      whileInView: { opacity: 1, y: 0 },
      viewport: { once: true, amount: 0.25 },
      transition: { duration: reduce ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] },
    },
    stagger: {
      initial: 'hidden',
      whileInView: 'visible',
      viewport: { once: true, amount: 0.2 },
      variants: { visible: { transition: { staggerChildren: reduce ? 0 : 0.07 } } },
    },
    child: {
      variants: {
        hidden: reduce ? { opacity: 1 } : { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0, transition: { duration: reduce ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] } },
      },
    },
    hover: reduce ? undefined : { y: -5 },
  }), [reduce]);
};

const Reveal = ({ children, className, id, as: Tag = motion.div, delay = 0 }) => {
  const { reveal, reduce } = useMotionPresets();
  return (
    <Tag
      id={id}
      className={className}
      {...reveal}
      transition={{ ...reveal.transition, delay: reduce ? 0 : delay }}
    >
      {children}
    </Tag>
  );
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const PortalHeader = () => {
  const { t, isRtl } = useLanguage();
  const { reduce } = useMotionPresets();
  const [menuOpen, setMenuOpen] = useState(false);

  const sections = [
    { href: '#platform', label: t('pub_nav_platform') },
    { href: '#capabilities', label: t('pub_nav_capabilities') },
    { href: '#how', label: t('pub_nav_how') },
    { href: '#address', label: t('pub_nav_address') },
    { href: '#faq', label: t('pub_nav_faq') },
  ];

  const services = [
    { href: '/support', label: t('pub_support') },
    { href: '/verify', label: t('pub_verify') },
  ];

  return (
    <header className="bb-header">
      <div className="bb-shell bb-header-inner">
        {/* Logo slot — the wordmark stands in until a logo file exists. Drop an
            <img> inside .bb-wordmark-slot and nothing else has to change. */}
        <Link href="/portal" className="bb-wordmark" aria-label={t('pub_home')}>
          <span className="bb-wordmark-slot" aria-hidden="true">{t('platform_brand').slice(0, 1)}</span>
          <span>
            <b>{t('platform_brand')}</b>
            <small>{t('platform_tagline')}</small>
          </span>
        </Link>

        <nav className="bb-nav" aria-label={t('pub_nav_platform')}>
          {sections.map((item) => <a key={item.href} href={item.href}>{item.label}</a>)}
          {services.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>

        <div className="bb-header-actions">
          <LanguageSwitcher />
          <button
            type="button"
            className="icon-button bb-menu-toggle"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? t('pub_nav_close_menu') : t('pub_nav_open_menu')}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
          <Link href="/signup" className="primary-button">
            <span>{t('pub_subscribe')}</span>
            <ArrowRight size={16} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {menuOpen && (
          <motion.nav
            className="bb-shell bb-mobile-nav"
            aria-label={t('pub_nav_platform')}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.25 }}
          >
            {sections.map((item) => (
              <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}</a>
            ))}
            {services.map((item) => (
              <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}</Link>
            ))}
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
};

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

const Hero = () => {
  const { t, isRtl } = useLanguage();
  const { reduce } = useMotionPresets();
  const exampleUrl = companyUrl(SAMPLE_SLUGS[0]);

  const lines = [t('pub_hero_card_line_1'), t('pub_hero_card_line_2'), t('pub_hero_card_line_3')];

  return (
    <section className="bb-hero">
      <motion.div
        className="bb-hero-glow"
        aria-hidden="true"
        initial={reduce ? { opacity: 0.5 } : { opacity: 0, scale: 0.9 }}
        animate={reduce ? { opacity: 0.5 } : { opacity: 0.55, scale: 1 }}
        transition={{ duration: reduce ? 0 : 1.1, ease: 'easeOut' }}
      />

      <div className="bb-shell bb-hero-inner">
        <motion.div
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="bb-badge"><Sparkles aria-hidden="true" />{t('pub_hero_badge')}</span>
          <h1>{t('pub_hero_title')}</h1>
          <p className="bb-hero-lead">{t('pub_hero_subtitle')}</p>
          <span className="bb-tagline">{t('platform_tagline')}</span>

          <div className="bb-hero-actions">
            <Link href="/signup" className="primary-button">
              {t('pub_subscribe')}
              <ArrowRight size={18} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
            </Link>
            <a href="#capabilities" className="secondary-button">{t('pub_hero_secondary')}</a>
          </div>

          <p className="bb-hero-note"><ShieldCheck aria-hidden="true" />{t('pub_hero_note')}</p>
        </motion.div>

        <motion.div
          className="bb-hero-card"
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: 30, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: reduce ? 0 : 0.65, delay: reduce ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
          whileHover={reduce ? undefined : { y: -6 }}
        >
          <h2>{t('pub_hero_card_title')}</h2>
          <div className="bb-url-chip">
            <Link2 aria-hidden="true" />
            <span className="sr-only">{t('pub_hero_address_label')}</span>
            <code>{exampleUrl}</code>
          </div>
          <ul className="bb-hero-steps">
            {lines.map((line, index) => (
              <motion.li
                key={line}
                initial={reduce ? { opacity: 1 } : { opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: reduce ? 0 : 0.4, delay: reduce ? 0 : 0.3 + index * 0.12 }}
              >
                <span aria-hidden="true">{index + 1}</span>
                {line}
              </motion.li>
            ))}
          </ul>
        </motion.div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const Metrics = () => {
  const { t, locale, languages } = useLanguage();
  const { stagger, child } = useMotionPresets();

  const metrics = [
    { value: formatNumber(languages.length, locale), label: t('pub_metric_languages') },
    { value: formatNumber(MODULE_COUNT, locale), label: t('pub_metric_modules') },
    { value: formatNumber(SETUP_MINUTES, locale), label: t('pub_metric_setup') },
    { value: t('pub_metric_price_value'), label: t('pub_metric_price') },
  ];

  return (
    <div className="bb-shell">
      <motion.div className="bb-metrics" {...stagger}>
        {metrics.map((metric) => (
          <motion.div key={metric.label} className="bb-metric" {...child}>
            <b>{metric.value}</b>
            <span>{metric.label}</span>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Value proposition
// ---------------------------------------------------------------------------

const ValueSection = () => {
  const { t } = useLanguage();
  const { stagger, child } = useMotionPresets();

  const points = [
    { icon: ShieldCheck, title: t('pub_value_point_1_title'), text: t('pub_value_point_1_text') },
    { icon: Palette, title: t('pub_value_point_2_title'), text: t('pub_value_point_2_text') },
    { icon: Languages, title: t('pub_value_point_3_title'), text: t('pub_value_point_3_text') },
  ];

  return (
    <section className="bb-section" id="platform">
      <div className="bb-shell bb-value">
        <Reveal className="bb-section-head" as={motion.div}>
          <span className="section-kicker">{t('pub_value_kicker')}</span>
          <h2>{t('pub_value_title')}</h2>
          <p>{t('pub_value_body')}</p>
        </Reveal>

        <motion.div className="bb-value-points" {...stagger}>
          {points.map(({ icon: Icon, title, text }) => (
            <motion.article key={title} className="bb-point" {...child}>
              <span className="bb-point-icon"><Icon aria-hidden="true" /></span>
              <div>
                <b>{title}</b>
                <p>{text}</p>
              </div>
            </motion.article>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const Features = () => {
  const { t } = useLanguage();
  const { stagger, child, hover } = useMotionPresets();

  const features = [
    { icon: Building2, title: t('pub_feature_workspace_title'), text: t('pub_feature_workspace_text') },
    { icon: Workflow, title: t('pub_feature_forms_title'), text: t('pub_feature_forms_text') },
    { icon: BadgeCheck, title: t('pub_feature_verification_title'), text: t('pub_feature_verification_text') },
    { icon: CalendarCheck, title: t('pub_feature_engagement_title'), text: t('pub_feature_engagement_text') },
    { icon: MessageSquareText, title: t('pub_feature_chat_title'), text: t('pub_feature_chat_text') },
    { icon: SquareStack, title: t('pub_feature_certificates_title'), text: t('pub_feature_certificates_text') },
    { icon: ScrollText, title: t('pub_feature_knowledge_title'), text: t('pub_feature_knowledge_text') },
    { icon: Sparkles, title: t('pub_feature_free_title'), text: t('pub_feature_free_text') },
  ];

  return (
    <section className="bb-section bb-section-alt" id="capabilities">
      <div className="bb-shell">
        <Reveal className="bb-section-head">
          <span className="section-kicker">{t('pub_features_kicker')}</span>
          <h2>{t('pub_features_title')}</h2>
          <p>{t('pub_features_subtitle')}</p>
        </Reveal>

        <motion.div className="bb-feature-grid" {...stagger}>
          {features.map(({ icon: Icon, title, text }) => (
            <motion.article key={title} className="bb-feature" {...child} whileHover={hover}>
              <span className="bb-feature-icon"><Icon aria-hidden="true" /></span>
              <h3>{title}</h3>
              <p>{text}</p>
            </motion.article>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const HowItWorks = () => {
  const { t } = useLanguage();
  const { stagger, child, hover } = useMotionPresets();

  const steps = [
    { title: t('pub_how_1_title'), text: t('pub_how_1_text') },
    { title: t('pub_how_2_title'), text: t('pub_how_2_text') },
    { title: t('pub_how_3_title'), text: t('pub_how_3_text') },
  ];

  return (
    <section className="bb-section" id="how">
      <div className="bb-shell">
        <Reveal className="bb-section-head">
          <span className="section-kicker">{t('pub_how_kicker')}</span>
          <h2>{t('pub_how_title')}</h2>
        </Reveal>

        <motion.div className="bb-steps" {...stagger}>
          {steps.map((step, index) => (
            <motion.article key={step.title} className="bb-step" {...child} whileHover={hover}>
              <span className="bb-step-no" aria-hidden="true">{index + 1}</span>
              <span>{t('pub_how_step_label', { number: index + 1 })}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </motion.article>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// The address pattern
// ---------------------------------------------------------------------------

const AddressSection = () => {
  const { t } = useLanguage();
  const { reduce } = useMotionPresets();
  const [slug, setSlug] = useState(SAMPLE_SLUGS[0]);

  // companyUrl already knows the deployment base; the slug is highlighted by
  // splitting the string the helper produced rather than by rebuilding it.
  const url = companyUrl(slug);
  const slugStart = url.lastIndexOf(`/${slug}`) + 1;

  const rules = [t('pub_address_rule_1'), t('pub_address_rule_2'), t('pub_address_rule_3')];

  return (
    <section className="bb-section bb-section-alt" id="address">
      <div className="bb-shell bb-address">
        <Reveal className="bb-section-head">
          <span className="section-kicker">{t('pub_address_kicker')}</span>
          <h2>{t('pub_address_title')}</h2>
          <p>{t('pub_address_body')}</p>
          <ul className="bb-address-rules">
            {rules.map((rule) => (
              <li key={rule}><BadgeCheck aria-hidden="true" />{rule}</li>
            ))}
          </ul>
        </Reveal>

        <Reveal className="bb-address-demo" delay={0.1}>
          <p>{t('pub_address_example_caption', { slug })}</p>
          <div className="bb-address-url">
            <Globe2 size={18} aria-hidden="true" />
            <span>{url.slice(0, slugStart)}</span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={slug}
                className="bb-url-slug"
                initial={reduce ? { opacity: 1 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 1 } : { opacity: 0, y: -8 }}
                transition={{ duration: reduce ? 0 : 0.22 }}
              >
                {slug}
              </motion.span>
            </AnimatePresence>
            <span>{url.slice(slugStart + slug.length)}</span>
          </div>
          <div className="bb-address-samples">
            {SAMPLE_SLUGS.map((sample) => (
              <button
                key={sample}
                type="button"
                aria-pressed={sample === slug}
                onClick={() => setSlug(sample)}
              >
                {sample}
              </button>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

const FaqItem = ({ index, question, answer, isOpen, onToggle }) => {
  const { reduce } = useMotionPresets();
  const panelId = `bb-faq-panel-${index}`;
  const buttonId = `bb-faq-button-${index}`;

  return (
    <div className={`bb-faq-item${isOpen ? ' open' : ''}`}>
      <button type="button" id={buttonId} aria-expanded={isOpen} aria-controls={panelId} onClick={onToggle}>
        <span>{question}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            className="bb-faq-answer"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <p>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Faq = () => {
  const { t } = useLanguage();
  const [openIndex, setOpenIndex] = useState(0);

  const items = [1, 2, 3, 4, 5, 6].map((number) => ({
    question: t(`pub_faq_${number}_q`),
    answer: t(`pub_faq_${number}_a`),
  }));

  return (
    <section className="bb-section" id="faq">
      <div className="bb-shell">
        <Reveal className="bb-section-head">
          <span className="section-kicker">{t('pub_faq_kicker')}</span>
          <h2>{t('pub_faq_title')}</h2>
        </Reveal>

        <Reveal className="bb-faq" delay={0.05}>
          {items.map((item, index) => (
            <FaqItem
              key={item.question}
              index={index}
              question={item.question}
              answer={item.answer}
              isOpen={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? -1 : index)}
            />
          ))}
        </Reveal>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Closing call to action + footer
// ---------------------------------------------------------------------------

const ClosingCta = () => {
  const { t, isRtl } = useLanguage();
  return (
    <div className="bb-shell">
      <Reveal className="bb-cta">
        <div>
          <h2>{t('pub_cta_title')}</h2>
          <p>{t('pub_cta_text')}</p>
        </div>
        <Link href="/signup" className="primary-button">
          {t('pub_subscribe')}
          <ArrowRight size={18} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
        </Link>
      </Reveal>
    </div>
  );
};

const PortalFooter = () => {
  const { t } = useLanguage();
  const year = new Date().getFullYear();

  return (
    <footer className="bb-footer">
      <div className="bb-shell">
        <div className="bb-footer-grid">
          <div>
            <span className="bb-wordmark">
              <span className="bb-wordmark-slot" aria-hidden="true">{t('platform_brand').slice(0, 1)}</span>
              <span><b>{t('platform_brand')}</b><small>{t('platform_tagline')}</small></span>
            </span>
            <p>{t('pub_footer_about')}</p>
          </div>

          <div className="bb-footer-col">
            <h3>{t('pub_footer_product')}</h3>
            <a href="#capabilities">{t('pub_nav_capabilities')}</a>
            <a href="#how">{t('pub_nav_how')}</a>
            <a href="#address">{t('pub_nav_address')}</a>
            <a href="#faq">{t('pub_nav_faq')}</a>
          </div>

          <div className="bb-footer-col">
            <h3>{t('pub_footer_services')}</h3>
            <Link href="/signup">{t('pub_subscribe')}</Link>
            <Link href="/support">{t('pub_support')}</Link>
            <Link href="/verify">{t('pub_verify')}</Link>
          </div>

          <div className="bb-footer-col">
            <h3>{t('pub_footer_legal')}</h3>
            <span>{t('pub_footer_privacy')}</span>
            <span>{t('pub_footer_terms')}</span>
            <Link href="/support">{t('pub_footer_contact')}</Link>
          </div>
        </div>

        <div className="bb-footer-bottom">
          <span>{t('pub_footer_rights', { year })}</span>
          <span>{t('platform_tagline')}</span>
        </div>
      </div>
    </footer>
  );
};

// ---------------------------------------------------------------------------

const PortalSite = () => {
  const { t } = useLanguage();

  useEffect(() => {
    document.title = `${t('platform_brand')} · ${t('pub_hero_badge')}`;
  }, [t]);

  return (
    <div className="bb-page">
      <a className="bb-skip" href="#bb-main">{t('pub_skip_to_content')}</a>
      <PortalHeader />

      <main id="bb-main">
        <Hero />
        <Metrics />
        <ValueSection />
        <Features />
        <HowItWorks />
        <AddressSection />
        <Faq />
        <ClosingCta />
      </main>

      <PortalFooter />
    </div>
  );
};

export default PortalSite;
