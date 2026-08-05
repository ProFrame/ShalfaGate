// Attestations and letters — the chamber-of-commerce pattern.
//
// A company writes a letter (or uploads the signed PDF), attests it, and the
// document becomes checkable by anyone holding its code. Everything on this
// screen is one of four verbs: draft, attest, revoke, share.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban, BadgeCheck, ExternalLink, FileSignature, Link2, Loader2, Paperclip,
  Pencil, Plus, Search, ShieldAlert, Upload, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import { verifyUrl } from '../../lib/routing';
import {
  DOCUMENT_STATUSES, DOC_TYPE_LABEL_KEYS, MANUAL_DOC_TYPES, SEAL_STYLES, STATUS_LABEL_KEYS,
  approveAttestation, loadDocuments, loadEmployees, revokeAttestation, saveAttestation,
  uploadVerificationFile, verificationErrorKey,
} from '../../data/verificationService';
import { CodeChip, CopyButton, DocumentStatusChip } from './VerifiedSeal';

const emptyDraft = () => ({
  id: null,
  doc_type: 'Attestation',
  title_1: '',
  title_2: '',
  subject_1: '',
  subject_2: '',
  holder_employee_id: '',
  holder_name: '',
  valid_until: '',
  seal_style: 'Blue',
  file_url: '',
  file_mime: '',
  file_size: null,
  submit: true,
});

const toDraft = (row) => ({
  id: row.id,
  doc_type: MANUAL_DOC_TYPES.includes(row.doc_type) ? row.doc_type : 'Attestation',
  title_1: row.title_ar || '',
  title_2: row.title_en || '',
  subject_1: row.subject_ar || '',
  subject_2: row.subject_en || '',
  holder_employee_id: row.holder_employee_id || '',
  holder_name: row.holder_name || '',
  valid_until: row.valid_until ? String(row.valid_until).slice(0, 10) : '',
  seal_style: SEAL_STYLES.includes(row.seal_style) ? row.seal_style : 'Blue',
  file_url: row.file_url || '',
  file_mime: row.file_mime || '',
  file_size: row.file_size || null,
  submit: row.status === 'PendingApproval',
});

const isEditable = (row) => MANUAL_DOC_TYPES.includes(row.doc_type) && ['Draft', 'PendingApproval'].includes(row.status);

// ---------------------------------------------------------------------------

const AttestationEditor = ({ draft, employees, onChange, onClose, onSave, busy, error, uploading, onUpload }) => {
  const { t, lang } = useLanguage();
  const fileRef = useRef(null);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide vf-editor"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('vf_att_edit') : t('vf_att_new')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSave(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('module_verification')}</span>
            <h3>{draft.id ? t('vf_att_edit') : t('vf_att_new')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label" htmlFor="vf-att-type">
            {t('vf_field_doc_type')}
            <select
              id="vf-att-type"
              className="form-input"
              value={draft.doc_type}
              onChange={(event) => onChange({ doc_type: event.target.value })}
            >
              {MANUAL_DOC_TYPES.map((type) => (
                <option key={type} value={type}>{t(DOC_TYPE_LABEL_KEYS[type])}</option>
              ))}
            </select>
          </label>

          <label className="field-label" htmlFor="vf-att-seal">
            {t('vf_field_seal')}
            <select
              id="vf-att-seal"
              className="form-input"
              value={draft.seal_style}
              onChange={(event) => onChange({ seal_style: event.target.value })}
            >
              {SEAL_STYLES.map((style) => (
                <option key={style} value={style}>{t(style === 'Gold' ? 'vf_seal_gold' : 'vf_seal_blue')}</option>
              ))}
            </select>
          </label>

          <label className="field-label" htmlFor="vf-att-title-1">
            {t('vf_field_title_1')}
            <input
              id="vf-att-title-1"
              className="form-input"
              value={draft.title_1}
              onChange={(event) => onChange({ title_1: event.target.value })}
              placeholder={t('vf_field_title_1')}
              required
            />
          </label>

          <label className="field-label" htmlFor="vf-att-title-2">
            {t('vf_field_title_2')}
            <input
              id="vf-att-title-2"
              className="form-input"
              value={draft.title_2}
              onChange={(event) => onChange({ title_2: event.target.value })}
              placeholder={t('vf_field_title_2')}
            />
          </label>

          <label className="field-label" htmlFor="vf-att-holder">
            {t('vf_field_holder')}
            <select
              id="vf-att-holder"
              className="form-input"
              value={draft.holder_employee_id}
              onChange={(event) => {
                const employee = employees.find((row) => row.id === event.target.value);
                onChange({
                  holder_employee_id: event.target.value,
                  holder_name: employee ? pickLocalized(employee, 'full_name', lang, draft.holder_name) : draft.holder_name,
                });
              }}
            >
              <option value="">{t('vf_holder_none')}</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {pickLocalized(employee, 'full_name', lang, employee.employee_no || employee.email || '')}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label" htmlFor="vf-att-holder-name">
            {t('vf_field_holder_name')}
            <input
              id="vf-att-holder-name"
              className="form-input"
              value={draft.holder_name}
              onChange={(event) => onChange({ holder_name: event.target.value })}
              placeholder={t('vf_field_holder_name')}
            />
            <p className="field-note">{t('vf_field_holder_hint')}</p>
          </label>

          <label className="field-label" htmlFor="vf-att-valid">
            {t('vf_field_valid_until')}
            <input
              id="vf-att-valid"
              className="form-input"
              type="date"
              value={draft.valid_until}
              onChange={(event) => onChange({ valid_until: event.target.value })}
            />
          </label>

          <label className="field-label field-span-2" htmlFor="vf-att-subject-1">
            {t('vf_field_subject_1')}
            <textarea
              id="vf-att-subject-1"
              className="form-input"
              rows={5}
              value={draft.subject_1}
              onChange={(event) => onChange({ subject_1: event.target.value })}
              placeholder={t('vf_field_body_placeholder')}
            />
          </label>

          <label className="field-label field-span-2" htmlFor="vf-att-subject-2">
            {t('vf_field_subject_2')}
            <textarea
              id="vf-att-subject-2"
              className="form-input"
              rows={4}
              value={draft.subject_2}
              onChange={(event) => onChange({ subject_2: event.target.value })}
              placeholder={t('vf_field_subject_2')}
            />
          </label>
        </div>

        <div className="vf-background-row">
          <div>
            <span className="field-label">{t('vf_field_file')}</span>
            <p className="field-note">{t('vf_file_hint')}</p>
          </div>
          <div className="vf-inline-actions">
            {draft.file_url && (
              <a className="secondary-button" href={draft.file_url} target="_blank" rel="noreferrer">
                <Paperclip aria-hidden="true" /> {t('vf_file_attached')}
              </a>
            )}
            <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
              {uploading ? t('vf_file_uploading') : t('action_upload')}
            </button>
            {draft.file_url && (
              <button
                type="button"
                className="secondary-button danger"
                onClick={() => onChange({ file_url: '', file_mime: '', file_size: null })}
              >
                <X aria-hidden="true" /> {t('vf_remove_file')}
              </button>
            )}
            <input
              ref={fileRef}
              hidden
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              aria-label={t('vf_field_file')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onUpload(file);
              }}
            />
          </div>
        </div>

        <label className="content-publish-check">
          <input
            type="checkbox"
            checked={Boolean(draft.submit)}
            onChange={(event) => onChange({ submit: event.target.checked })}
          />
          {t('vf_submit_for_attestation')}
        </label>

        {error && (
          <p className="modal-error" role="alert">
            <ShieldAlert aria-hidden="true" /> {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="submit" className="primary-button" disabled={busy || !draft.title_1.trim()}>
            {busy ? <Loader2 className="vf-spin" aria-hidden="true" /> : <BadgeCheck aria-hidden="true" />}
            {t('action_save')}
          </button>
        </div>
      </form>
    </div>
  );
};

const RevokeDialog = ({ document, reason, onReason, onClose, onConfirm, busy }) => {
  const { t, lang } = useLanguage();

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('vf_revoke_title')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onConfirm(); }}
      >
        <div className="modal-heading">
          <h3>{t('vf_revoke_title')}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="confirm-body">
          <ShieldAlert aria-hidden="true" />
          <p>{pickLocalized(document, 'title', lang, document.code)}</p>
        </div>
        <p className="field-note">{t('vf_revoke_hint')}</p>

        <label className="field-label" htmlFor="vf-revoke-reason">
          {t('vf_revoke_reason')}
          <textarea
            id="vf-revoke-reason"
            className="form-input"
            rows={3}
            value={reason}
            onChange={(event) => onReason(event.target.value)}
            placeholder={t('vf_revoke_reason_placeholder')}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
            {t('vf_action_revoke')}
          </button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------

const AttestationsScreen = () => {
  const { t, lang, locale } = useLanguage();
  const { tenant } = useTenant();

  const [documents, setDocuments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('Manual');
  const [statusFilter, setStatusFilter] = useState('');

  const [draft, setDraft] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [revokeReason, setRevokeReason] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);      // { tone, text }
  const [modalError, setModalError] = useState('');

  const refresh = useCallback(async (types) => {
    const { data, error } = await loadDocuments({
      docTypes: types === 'Manual' ? MANUAL_DOC_TYPES : null,
    });
    setLoading(false);
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setDocuments(data);
  }, [t]);

  // The filter chooses which document types the server sends; everything else
  // is narrowed in the browser, so switching filters costs one request.
  useEffect(() => {
    let cancelled = false;
    loadDocuments({ docTypes: typeFilter === 'Manual' ? MANUAL_DOC_TYPES : null }).then(({ data, error }) => {
      if (cancelled) return;
      setLoading(false);
      if (error) {
        setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
        return;
      }
      setDocuments(data);
    });
    return () => { cancelled = true; };
  }, [typeFilter, t]);

  useEffect(() => {
    let cancelled = false;
    loadEmployees().then(({ data }) => {
      if (!cancelled && data) setEmployees(data);
    });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents.filter((row) => {
      if (statusFilter && row.status !== statusFilter) return false;
      if (typeFilter !== 'Manual' && typeFilter !== 'All' && row.doc_type !== typeFilter) return false;
      if (!needle) return true;
      return [row.title_ar, row.title_en, row.holder_name, row.code]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [documents, query, statusFilter, typeFilter]);

  const upload = async (file) => {
    setUploading(true);
    const { data, error } = await uploadVerificationFile({
      tenantId: tenant?.id,
      area: 'attestations',
      file,
      entityType: 'Document',
      entityId: draft?.id || null,
    });
    setUploading(false);
    if (error) {
      setModalError(t(verificationErrorKey(error)));
      return;
    }
    setDraft((current) => ({
      ...current,
      file_url: data.url,
      file_mime: file.type || '',
      file_size: file.size || null,
    }));
  };

  const save = async () => {
    setBusy(true);
    setModalError('');
    const { error } = await saveAttestation(draft);
    setBusy(false);
    if (error) {
      setModalError(t(verificationErrorKey(error)));
      return;
    }
    setDraft(null);
    setNotice({ tone: 'success', text: t('vf_saved') });
    refresh(typeFilter);
  };

  const attest = async (row) => {
    setBusy(true);
    const { error } = await approveAttestation(row.id);
    setBusy(false);
    setNotice(error
      ? { tone: 'error', text: t(verificationErrorKey(error)) }
      : { tone: 'success', text: t('vf_attested') });
    if (!error) refresh(typeFilter);
  };

  const revoke = async () => {
    setBusy(true);
    const { error } = await revokeAttestation(revoking.id, revokeReason);
    setBusy(false);
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setRevoking(null);
    setRevokeReason('');
    setNotice({ tone: 'success', text: t('vf_revoked_done') });
    refresh(typeFilter);
  };

  return (
    <div className="vf-screen">
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_verification')}</span>
          <h1>{t('vf_att_title')}</h1>
          <p>{t('vf_att_intro')}</p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => { setDraft(emptyDraft()); setModalError(''); }}
        >
          <Plus aria-hidden="true" /> {t('vf_att_new')}
        </button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="data-controls">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('vf_att_search_placeholder')}
            aria-label={t('action_search')}
          />
        </div>

        <label className="sr-only" htmlFor="vf-att-type-filter">{t('vf_filter_type')}</label>
        <select
          id="vf-att-type-filter"
          className="form-input vf-filter"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="Manual">{t('vf_nav_attestations')}</option>
          <option value="All">{t('label_all')}</option>
          {MANUAL_DOC_TYPES.map((type) => (
            <option key={type} value={type}>{t(DOC_TYPE_LABEL_KEYS[type])}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="vf-att-status-filter">{t('vf_filter_status')}</label>
        <select
          id="vf-att-status-filter"
          className="form-input vf-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">{t('label_all')}</option>
          {DOCUMENT_STATUSES.map((status) => (
            <option key={status} value={status}>{t(STATUS_LABEL_KEYS[status])}</option>
          ))}
        </select>

        <span className="result-count">{t('vf_att_count', { count: visible.length })}</span>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('vf_document_title')}</th>
              <th>{t('vf_document_type')}</th>
              <th>{t('vf_holder')}</th>
              <th>{t('label_status')}</th>
              <th>{t('vf_document_code')}</th>
              <th>{t('vf_valid_until')}</th>
              <th>{t('label_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="form-name-cell">
                    <FileSignature aria-hidden="true" />
                    <div>
                      <b>{pickLocalized(row, 'title', lang, row.code)}</b>
                      <small>{formatDate(row.issued_on || row.created_on, locale)}</small>
                    </div>
                  </div>
                </td>
                <td>{t(DOC_TYPE_LABEL_KEYS[row.doc_type] || 'vf_doctype_custom')}</td>
                <td>
                  <div className="holder-cell">
                    <b>{row.holder_name || '—'}</b>
                    {row.revoked_reason && <small>{t('vf_revoked_reason_label')}: {row.revoked_reason}</small>}
                  </div>
                </td>
                <td><DocumentStatusChip status={row.status} /></td>
                <td><CodeChip code={row.code} /></td>
                <td>{row.valid_until ? formatDate(row.valid_until, locale) : t('vf_no_expiry')}</td>
                <td>
                  <div className="table-actions">
                    {isEditable(row) && (
                      <button
                        type="button"
                        className="icon-button"
                        title={t('action_edit')}
                        aria-label={t('action_edit')}
                        onClick={() => { setDraft(toDraft(row)); setModalError(''); }}
                      >
                        <Pencil aria-hidden="true" />
                      </button>
                    )}
                    {isEditable(row) && (
                      <button
                        type="button"
                        className="icon-button approve-action"
                        title={t('vf_action_attest')}
                        aria-label={t('vf_action_attest')}
                        disabled={busy}
                        onClick={() => attest(row)}
                      >
                        <BadgeCheck aria-hidden="true" />
                      </button>
                    )}
                    {row.status === 'Active' && MANUAL_DOC_TYPES.includes(row.doc_type) && (
                      <button
                        type="button"
                        className="icon-button danger"
                        title={t('vf_action_revoke')}
                        aria-label={t('vf_action_revoke')}
                        onClick={() => { setRevoking(row); setRevokeReason(''); }}
                      >
                        <Ban aria-hidden="true" />
                      </button>
                    )}
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
            ))}

            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan="7">
                  <div className="empty-table">
                    <FileSignature aria-hidden="true" />
                    <b>{t('vf_no_documents')}</b>
                    <span>{t('vf_no_documents_hint')}</span>
                  </div>
                </td>
              </tr>
            )}

            {loading && (
              <tr>
                <td colSpan="7"><div className="empty-table compact">{t('label_loading')}</div></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft && (
        <AttestationEditor
          draft={draft}
          employees={employees}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          onClose={() => setDraft(null)}
          onSave={save}
          onUpload={upload}
          uploading={uploading}
          busy={busy}
          error={modalError}
        />
      )}

      {revoking && (
        <RevokeDialog
          document={revoking}
          reason={revokeReason}
          onReason={setRevokeReason}
          onClose={() => setRevoking(null)}
          onConfirm={revoke}
          busy={busy}
        />
      )}
    </div>
  );
};

export default AttestationsScreen;
