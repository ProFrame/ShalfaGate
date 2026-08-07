// The employee-facing certificate wallet — the one gap Global Validation's
// independent audit found in an otherwise-closed Verification Service
// (PORTAL_CERTIFICATES registry row, migration 202608040018, deactivated as
// "planned" by migration 202608040022). RLS on public.certificates already
// scopes an unprivileged caller to recipient_employee_id = auth.uid(), so
// loadCertificates()/loadTemplates() are reused exactly as
// CertificatesScreen.jsx (the admin issuing screen) already calls them — no
// new RPC, no new table, no second rendering implementation:
// CertificatePreview/resolveCertificatePreview (exported from
// CertificatesScreen.jsx) is the same preview/print modal an admin sees.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Award, ExternalLink, Link2, Printer, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import { verifyUrl } from '../../lib/routing';
import { loadCertificates, loadTemplates, resolveCertificatePreview, verificationErrorKey } from '../../data/verificationService';
import { CertificatePreview } from './CertificatesScreen';
import { CodeChip, CopyButton } from './VerifiedSeal';
import './verification.css';

const PAGE_SIZE = 300;

const PortalCertificates = () => {
  const { t, lang, locale } = useLanguage();
  const [certificates, setCertificates] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState(null);
  const [preview, setPreview] = useState(null); // { certificate, template, fields }

  const fetchCertificates = useCallback((nextLimit) => loadCertificates({ limit: nextLimit }).then(({ data, error }) => {
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setCertificates(data);
  }), [t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchCertificates(PAGE_SIZE), loadTemplates({})]).then(([, templateResult]) => {
      if (cancelled) return;
      setLoading(false);
      if (templateResult.data) setTemplates(templateResult.data);
      else if (templateResult.error) setNotice({ tone: 'error', text: t(verificationErrorKey(templateResult.error)) });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const templateById = useMemo(() => new Map(templates.map((row) => [row.id, row])), [templates]);

  const openPreview = async (certificate) => setPreview(await resolveCertificatePreview(certificate, templates));

  const loadMore = async () => {
    setLoadingMore(true);
    const nextLimit = limit + PAGE_SIZE;
    await fetchCertificates(nextLimit);
    setLimit(nextLimit);
    setLoadingMore(false);
  };

  return (
    <div className="vf-screen">
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_certificates')}</span>
          <h1>{t('portal_cert_title')}</h1>
          <p>{t('portal_cert_intro')}</p>
        </div>
      </div>

      {notice && (
        <div className="inline-message error" role="status" aria-live="polite">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('vf_cert_template')}</th>
              <th>{t('vf_document_code')}</th>
              <th>{t('vf_cert_issued_on')}</th>
              <th>{t('vf_valid_until')}</th>
              <th>{t('label_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {certificates.map((row) => {
              const rowTemplate = templateById.get(row.template_id);
              return (
                <tr key={row.id}>
                  <td><b>{rowTemplate ? pickLocalized(rowTemplate, 'name', lang, rowTemplate.code) : '—'}</b></td>
                  <td><CodeChip code={row.code} /></td>
                  <td>{formatDate(row.issued_on, locale)}</td>
                  <td>{row.valid_until ? formatDate(row.valid_until, locale) : t('vf_no_expiry')}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title={t('vf_cert_preview')}
                        aria-label={t('vf_cert_preview')}
                        onClick={() => openPreview(row)}
                      >
                        <Printer aria-hidden="true" />
                      </button>
                      <CopyButton value={verifyUrl(row.code)} label={t('vf_copy_link')} icon={Link2} />
                      <a
                        className="icon-button"
                        href={verifyUrl(row.code)}
                        target="_blank"
                        rel="noreferrer"
                        title={t('vf_open_public_page')}
                        aria-label={t('vf_open_public_page')}
                      >
                        <ExternalLink aria-hidden="true" />
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}

            {!loading && certificates.length === 0 && (
              <tr>
                <td colSpan="5">
                  <div className="empty-table">
                    <Award aria-hidden="true" />
                    <b>{t('portal_cert_empty')}</b>
                    <span>{t('portal_cert_empty_hint')}</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!loading && certificates.length >= limit && (
        <button type="button" className="secondary-button" onClick={loadMore} disabled={loadingMore}>
          {t('action_load_more')}
        </button>
      )}

      {preview && (
        <CertificatePreview
          certificate={preview.certificate}
          template={preview.template}
          fields={preview.fields}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};

export default PortalCertificates;
