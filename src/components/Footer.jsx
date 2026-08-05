// The public footer of a company address.
//
// Everything in it belongs to the company that owns the address: its logo, its
// sentence, its contact channels and its social link. Nothing that is absent
// leaves a gap, and the language switcher stays reachable here because the
// footer is the last place a visitor looks for it.

import { ExternalLink } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import LanguageSwitcher from './LanguageSwitcher';
import ContactChannels from './branding/ContactChannels';
import { safeExternalUrl } from '../utils/safeUrl';
import TenantLogo, { useTenantLogo } from './branding/TenantLogo';
import './branding/branding.css';

const Footer = () => {
  const { t } = useLanguage();
  const { branding, tenantName, contacts } = useTenant();
  const { hasLogo } = useTenantLogo('dark');

  const linkedinUrl = safeExternalUrl(branding?.linkedin_url);
  const hasContacts = Array.isArray(contacts)
    && contacts.some((contact) => contact?.channel && String(contact.value || '').trim());

  return (
    <footer id="contact" className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          {hasLogo && <TenantLogo variant="dark" className="site-footer-logo" />}
          <p>
            {tenantName
              ? t('about_company_portal', { company: tenantName })
              : t('about_portal_generic')}
          </p>
        </div>

        {hasContacts && (
          <div className="site-footer-contact">
            <h2>{t('contact_info')}</h2>
            <ContactChannels compact />
          </div>
        )}
      </div>

      <div className="site-footer-bottom">
        <LanguageSwitcher className="site-footer-language" />
        {linkedinUrl && (
          <a
            className="site-footer-social"
            href={linkedinUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink size={15} aria-hidden="true" />
            <span>{t('contact_linkedin')}</span>
          </a>
        )}
      </div>
    </footer>
  );
};

export default Footer;
