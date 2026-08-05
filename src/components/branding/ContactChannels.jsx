// The company's public contact channels.
//
// The company decides which channels exist; a channel it did not provide is
// simply absent — nothing is rendered in its place and no "not available" text
// appears. Each channel carries its own icon and its own kind of link:
//
//   email     mailto:
//   mobile    tel:
//   phone     tel:
//   whatsapp  https://wa.me/<digits>
//   website   the site itself, in a new tab
//   address   the company head-office link, in a new tab (plain text without)
//   fax       plain text — a fax number is not dialled from a browser
//
// The label is the company's own wording when it supplied one (label_1 /
// label_2 on the record), otherwise the shared translated channel name.

import { Globe, Mail, MapPin, MessageCircle, Phone, Printer, Smartphone } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { codeLabel, pickLocalized } from '../../utils/localize';
import { safeExternalUrl, safeWebsiteUrl } from '../../utils/safeUrl';
import './branding.css';

const CHANNEL_ICONS = {
  email: Mail,
  mobile: Smartphone,
  whatsapp: MessageCircle,
  phone: Phone,
  fax: Printer,
  address: MapPin,
  website: Globe,
};

// Channels whose value is a number or a Latin address and therefore always
// reads left to right, even on an Arabic page.
const LTR_CHANNELS = new Set(['email', 'mobile', 'whatsapp', 'phone', 'fax', 'website']);

const linkFor = (channel, value, mapUrl) => {
  const text = String(value || '').trim();
  if (!text) return null;

  switch (channel) {
    case 'email':
      return { href: `mailto:${text}`, external: false };
    case 'phone':
    case 'mobile':
      return { href: `tel:${text.replace(/[^\d+]/g, '')}`, external: false };
    case 'whatsapp': {
      const digits = text.replace(/\D/g, '');
      return digits ? { href: `https://wa.me/${digits}`, external: true } : null;
    }
    case 'website':
      { const href = safeWebsiteUrl(text); return href ? { href, external: true } : null; }
    case 'address':
      return safeExternalUrl(mapUrl) ? { href: safeExternalUrl(mapUrl), external: true } : null;
    default:
      return null;
  }
};

const ContactChannel = ({ contact, mapUrl }) => {
  const { t, lang } = useLanguage();
  const Icon = CHANNEL_ICONS[contact.channel] || Globe;
  const value = String(contact.value).trim();
  const label = pickLocalized(contact, 'label', lang) || codeLabel(t, 'contact', contact.channel);
  const link = linkFor(contact.channel, value, mapUrl);
  const direction = LTR_CHANNELS.has(contact.channel) ? 'ltr' : undefined;

  return (
    <li className="contact-channel">
      <span className="contact-channel-icon" aria-hidden="true"><Icon size={16} /></span>
      <span className="contact-channel-body">
        <span className="contact-channel-label">{label}</span>
        {link ? (
          <a
            className="contact-channel-value"
            href={link.href}
            dir={direction}
            aria-label={t('contact_channel_aria', { label, value })}
            {...(link.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
          >
            {value}
          </a>
        ) : (
          <span className="contact-channel-value" dir={direction}>{value}</span>
        )}
      </span>
    </li>
  );
};

const ContactChannels = ({ compact = false, className = '' }) => {
  const { contacts, branding } = useTenant();

  const items = (Array.isArray(contacts) ? contacts : [])
    .filter((contact) => contact?.channel && String(contact.value || '').trim())
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  if (!items.length) return null;

  const mapUrl = typeof branding?.map_url === 'string' ? branding.map_url.trim() : '';

  return (
    <ul className={`contact-channels ${compact ? 'is-compact' : ''} ${className}`.replace(/\s+/g, ' ').trim()}>
      {items.map((contact, index) => (
        <ContactChannel
          key={`${contact.channel}-${contact.value}-${index}`}
          contact={contact}
          mapUrl={mapUrl}
        />
      ))}
    </ul>
  );
};

export default ContactChannels;
