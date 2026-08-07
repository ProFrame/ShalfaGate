// The public digital business card page — bbnovix.com/card/{code}. Answers
// one question for a stranger holding a link or a scanned QR: whose card is
// this, and what did they choose to share? Everything comes from one
// anonymous RPC, public.card_public_view, which already applies the owner's
// visibility rule and per-field overrides server-side — nothing here decides
// what to hide, it only renders what the RPC already allowed through.

import { useEffect, useState } from 'react';
import { useParams } from 'wouter';
import { Download, Link2, ShieldAlert } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { parseLocation, publicPath, tenantPath } from '../lib/routing';
import { downloadVcfFile, identityErrorKey, loadPublicCard, trackCardEvent } from '../data/digitalIdentityService';
import BusinessCard from './identity/BusinessCard';
import './identity/identity.css';

const PublicCardPage = () => {
  const { t, lang } = useLanguage();
  const params = useParams();
  const code = params?.code ? decodeURIComponent(params.code) : '';

  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(Boolean(code));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code) return undefined;
    let cancelled = false;
    loadPublicCard(code).then(({ data, error: failure }) => {
      if (cancelled) return;
      setLoading(false);
      if (failure) { setError(t(identityErrorKey(failure))); return; }
      setCard(data?.found ? data : null);
    });
    return () => { cancelled = true; };
  }, [code, t]);

  const track = (eventType) => trackCardEvent(code, eventType);

  const downloadVcf = () => {
    track('vcf_download');
    downloadVcfFile(card, lang);
  };

  const { slug } = parseLocation();
  const homeHref = slug ? tenantPath(slug) : publicPath('portal');

  return (
    <div className="di-public-page">
      {loading && <div className="page-loader inline-loader"><span /></div>}

      {!loading && error && (
        <div className="inline-message error"><ShieldAlert aria-hidden="true" />{error}</div>
      )}

      {!loading && !error && !card && (
        <div className="empty-table">
          <ShieldAlert aria-hidden="true" />
          <b>{t('di_public_notfound')}</b>
          <span>{t('di_public_notfound_hint')}</span>
        </div>
      )}

      {!loading && card && (
        <>
          <span className="section-kicker">{t('di_public_intro')}</span>
          <BusinessCard card={card} lang={lang} publicUrl={window.location.href} onInteract={track} />
          <div className="di-share-actions">
            <button type="button" className="primary-button" onClick={downloadVcf}>
              <Download aria-hidden="true" /> {t('di_download_vcf')}
            </button>
          </div>
        </>
      )}

      <a className="field-note" href={homeHref}><Link2 aria-hidden="true" /> bbnovix</a>
    </div>
  );
};

export default PublicCardPage;
