// The attestation mark.
//
// One component draws the seal that every attested document carries: a circular
// blue or gold stamp with the platform mark and the words "electronically
// attested", beside a QR code that opens the public verification page for that
// document code.
//
// It is deliberately drawn with strokes and text — no background images, no
// theme dependent colours — so it survives printing exactly as it looks on
// screen. The small marks that travel with it (status chip, code chip, copy
// button) live here too, so every screen shows one code the same way.

import { useEffect, useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { verifyUrl } from '../../lib/routing';
import { STATUS_LABEL_KEYS } from '../../data/verificationService';
import EntityQrCode from '../platform/EntityQrCode';

const TONE_BY_STATUS = {
  Active: 'valid',
  Draft: 'neutral',
  PendingApproval: 'pending',
  Revoked: 'invalid',
  Expired: 'warning',
};

/**
 * The QR square on its own — used inside certificates and beside the seal.
 * Built on Platform Core's shared QR renderer (EntityQrCode); this wrapper
 * only adds the verify-URL transform and the verification-specific aria
 * label, so there is still exactly one QR implementation, not two.
 */
export const VerificationQr = ({ code, size = 96, className = '' }) => {
  const { t } = useLanguage();
  if (!code) return null;

  return (
    <EntityQrCode
      className={`vf-qr ${className}`}
      value={verifyUrl(code)}
      size={size}
      title={t('vf_qr_aria', { code })}
    />
  );
};

/**
 * @param {object} props
 * @param {string} props.code       the document code the seal certifies
 * @param {'Blue'|'Gold'} [props.sealStyle]
 * @param {number} [props.size]     seal diameter in pixels
 * @param {boolean} [props.showQr]  hide it when the layout carries its own QR
 * @param {boolean} [props.showCode]
 */
const VerifiedSeal = ({
  code,
  sealStyle = 'Blue',
  size = 118,
  qrSize = 96,
  showQr = true,
  showCode = true,
  showHint = true,
  className = '',
}) => {
  const { t } = useLanguage();
  const arcId = useId().replace(/:/g, '');
  const tone = sealStyle === 'Gold' ? 'gold' : 'blue';

  return (
    <div className={`vf-seal-block tone-${tone} ${className}`}>
      <svg
        className="vf-seal-mark"
        viewBox="0 0 120 120"
        width={size}
        height={size}
        role="img"
        aria-label={t('vf_seal_aria', { code: code || '' })}
      >
        <defs>
          <path
            id={`vf-arc-${arcId}`}
            d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"
            fill="none"
          />
        </defs>

        <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2.5 4" />

        <text className="vf-seal-arc" fill="currentColor">
          <textPath href={`#vf-arc-${arcId}`} startOffset="25%" textAnchor="middle">
            {t('vf_seal_word')}
          </textPath>
        </text>

        <path
          d="M46 61 l9.5 9.5 L75 50"
          fill="none"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text className="vf-seal-brand" x="60" y="88" textAnchor="middle" fill="currentColor">
          {t('platform_brand')}
        </text>
        <path d="M42 95 H78" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      </svg>

      {showQr && code && (
        <div className="vf-seal-qr">
          <VerificationQr code={code} size={qrSize} />
          {showCode && <span className="verify-code">{code}</span>}
          {showHint && <small>{t('vf_scan_hint')}</small>}
        </div>
      )}
    </div>
  );
};

/** Status of a verifiable document, always rendered from its stored code. */
export const DocumentStatusChip = ({ status }) => {
  const { t } = useLanguage();
  const code = status || 'Draft';
  const key = STATUS_LABEL_KEYS[code] || 'status_draft';
  return <span className={`vf-chip tone-${TONE_BY_STATUS[code] || 'neutral'}`}>{t(key)}</span>;
};

/** Copies any value and says so, without leaving the button unlabelled. */
export const CopyButton = ({ value, label, copiedLabel, icon: Icon = Copy, variant = 'icon' }) => {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value || ''));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const text = copied ? (copiedLabel || t('action_copied')) : (label || t('action_copy'));

  if (variant === 'button') {
    return (
      <button type="button" className="secondary-button" onClick={copy} disabled={!value}>
        {copied ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
        {text}
      </button>
    );
  }

  return (
    <button type="button" className="icon-button" onClick={copy} disabled={!value} title={text} aria-label={text}>
      {copied ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
    </button>
  );
};

/** The document code, always left to right, with its copy affordance. */
export const CodeChip = ({ code, label }) => {
  const { t } = useLanguage();
  if (!code) return <span className="vf-code-chip empty">{t('label_none')}</span>;

  return (
    <span className="vf-code-chip">
      <code className="verify-code" dir="ltr">{code}</code>
      <CopyButton value={code} label={label || t('vf_copy_code')} />
    </span>
  );
};

export default VerifiedSeal;
