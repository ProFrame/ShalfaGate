// Digital Identity's own two screens, switched by address
// (/app/card/:section?) the same way every other multi-screen module in
// this codebase links/bookmarks its sections.

import { Link, useParams } from 'wouter';
import { useLanguage } from '../../context/LanguageContext';
import MyCardScreen from './MyCardScreen';
import EmailSignatureScreen from './EmailSignatureScreen';

const SECTIONS = ['settings', 'signature'];

const IdentityCenter = () => {
  const { t } = useLanguage();
  const params = useParams();
  const active = SECTIONS.includes(params?.section) ? params.section : 'settings';

  return (
    <div className="app-main">
      <div className="segmented" role="tablist" aria-label={t('module_identity')}>
        <Link href="/app/card/settings" role="tab" aria-selected={active === 'settings'} className={active === 'settings' ? 'active' : ''}>
          {t('di_my_card')}
        </Link>
        <Link href="/app/card/signature" role="tab" aria-selected={active === 'signature'} className={active === 'signature' ? 'active' : ''}>
          {t('di_email_signature')}
        </Link>
      </div>

      {active === 'settings' && <MyCardScreen />}
      {active === 'signature' && <EmailSignatureScreen />}
    </div>
  );
};

export default IdentityCenter;
