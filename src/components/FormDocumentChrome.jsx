import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import { VerificationQr } from './verification/VerifiedSeal';

// The printed document carries the company's own identity and a QR code that
// resolves to the public verification page, so a paper copy can always be
// checked against its real state.
export const FormDocumentHeader = ({ moduleName, title, code, reference, verifyCode }) => {
  const { t } = useLanguage();
  const { branding, tenantName } = useTenant();
  const logoSrc = branding?.logo_light_url || branding?.logo_dark_url || null;

  return (
    <header className="evaluation-header form-document-header">
      {logoSrc ? <img src={logoSrc} alt={tenantName || t('employee_portal_brand')} /> : null}
      <div>{moduleName && <span>{moduleName}</span>}<h1>{title}</h1></div>
      <div className="document-meta">
        <b>{code}</b>
        <small>{reference}</small>
        {verifyCode && <small className="verify-code" dir="ltr">{verifyCode}</small>}
        {verifyCode && <VerificationQr code={verifyCode} size={54} />}
      </div>
    </header>
  );
};

export const FormDocumentFooter = ({ product, title, generatedLabel, generatedDate, printedByLabel, printedBy, pageLabel }) => {
  const { t } = useLanguage();
  const { tenantName } = useTenant();
  const productName = product || tenantName || t('employee_portal_brand');

  return (
    <footer className="document-footer print-only">
      <span>{productName} · {title}</span>
      <span>{generatedLabel}: {generatedDate}</span>
      <span>{printedByLabel}: {printedBy || '—'}</span>
      <span>{pageLabel} <b className="page-number" /></span>
    </footer>
  );
};
