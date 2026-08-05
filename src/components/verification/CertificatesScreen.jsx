// Issuing certificates.
//
// Two doors to the same factory: a form generated from the template fields for
// a single certificate, and an Excel sheet for a whole cohort. Both end in
// public.certificate_issue, which mints one verifiable document per row, so a
// certificate issued either way carries the same code, seal and QR.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import readXlsxFile from 'read-excel-file/browser';
import writeXlsxFile from 'write-excel-file/browser';
import {
  Award, CheckCircle2, Download, ExternalLink, FileSpreadsheet, Link2, Loader2,
  Printer, Search, ShieldAlert, Sparkles, Table2, Upload, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import { verifyUrl } from '../../lib/routing';
import {
  MAX_SHEET_ROWS, issueCertificates, loadCertificates, loadEmployees, loadTemplateFields,
  loadTemplates, normaliseHeader, verificationErrorKey,
} from '../../data/verificationService';
import { CertificateCanvas } from './CertificateDesigner';
import VerifiedSeal, { CodeChip, CopyButton } from './VerifiedSeal';

const PREVIEW_ROWS = 30;

/** Fields that are filled from data — QR and Code are produced by the platform. */
const dataFields = (fields) => fields.filter((field) => !['QR', 'Code'].includes(field.field_type));

const asDateValue = (value) => {
  if (!value && value !== 0) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

// ---------------------------------------------------------------------------
// Column model — one description used by the sample sheet, the importer and
// the validator, so the three can never disagree.
// ---------------------------------------------------------------------------

const buildColumns = (fields, t, lang) => {
  const recipientField = fields.find((field) => field.field_key === 'recipient_name');

  const columns = [{
    key: 'recipient_name',
    label: recipientField ? pickLocalized(recipientField, 'label', lang, t('vf_col_recipient_name')) : t('vf_col_recipient_name'),
    type: 'Text',
    required: true,
    aliases: ['recipient_name', 'name', 'full_name'],
  }];

  dataFields(fields)
    .filter((field) => field.field_key !== 'recipient_name')
    .forEach((field) => {
      columns.push({
        key: field.field_key,
        label: pickLocalized(field, 'label', lang, field.field_key),
        type: field.field_type,
        required: Boolean(field.is_required),
        aliases: [field.field_key, field.label_ar, field.label_en].filter(Boolean),
      });
    });

  columns.push({
    key: 'valid_until',
    label: t('vf_col_valid_until'),
    type: 'Date',
    required: false,
    aliases: ['valid_until'],
  });

  return columns;
};

const validateRow = (row, columns, t) => {
  const errors = [];
  columns.forEach((column) => {
    const value = row[column.key];
    const empty = value == null || String(value).trim() === '';

    if (column.required && empty) {
      errors.push(column.key === 'recipient_name'
        ? t('vf_err_recipient_name_required')
        : t('vf_err_field_required', { field: column.label }));
      return;
    }
    if (empty) return;
    if (column.type === 'Date' && asDateValue(value) === undefined) {
      errors.push(t('vf_err_bad_date', { field: column.label }));
    }
    if (column.type === 'Number' && !Number.isFinite(Number(value))) {
      errors.push(t('vf_err_bad_number', { field: column.label }));
    }
  });
  return errors;
};

// ---------------------------------------------------------------------------

const TemplatePicker = ({ templates, value, onChange }) => {
  const { t, lang } = useLanguage();

  return (
    <label className="field-label vf-template-picker" htmlFor="vf-cert-template">
      {t('vf_cert_template')}
      <select
        id="vf-cert-template"
        className="form-input"
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('vf_cert_choose_template')}</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {pickLocalized(template, 'name', lang, template.code)}
          </option>
        ))}
      </select>
    </label>
  );
};

const SingleIssueForm = ({ columns, employees, busy, onIssue }) => {
  const { t, lang } = useLanguage();
  const [values, setValues] = useState({});
  const [employeeId, setEmployeeId] = useState('');

  const set = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  const submit = (event) => {
    event.preventDefault();
    onIssue({ ...values, recipient_employee_id: employeeId || undefined }, () => {
      setValues({});
      setEmployeeId('');
    });
  };

  const errors = validateRow(values, columns, t);

  return (
    <form className="vf-panel" onSubmit={submit}>
      <div className="vf-panel-head"><h2>{t('vf_cert_mode_single')}</h2></div>

      <div className="form-grid">
        <label className="field-label" htmlFor="vf-cert-employee">
          {t('vf_cert_recipient_employee')}
          <select
            id="vf-cert-employee"
            className="form-input"
            value={employeeId}
            onChange={(event) => {
              setEmployeeId(event.target.value);
              const employee = employees.find((row) => row.id === event.target.value);
              if (employee) set('recipient_name', pickLocalized(employee, 'full_name', lang, ''));
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

        {columns.map((column) => (
          <label className="field-label" key={column.key} htmlFor={`vf-cert-${column.key}`}>
            {column.label}
            {column.required && <span className="sr-only">{t('label_required')}</span>}
            <input
              id={`vf-cert-${column.key}`}
              className="form-input"
              type={column.type === 'Date' ? 'date' : column.type === 'Number' ? 'number' : 'text'}
              value={values[column.key] || ''}
              onChange={(event) => set(column.key, event.target.value)}
              placeholder={column.label}
              required={column.required}
            />
          </label>
        ))}
      </div>

      <div className="modal-actions">
        <button type="submit" className="primary-button" disabled={busy || errors.length > 0}>
          {busy ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Award aria-hidden="true" />}
          {t('vf_cert_issue')}
        </button>
      </div>
    </form>
  );
};

const BulkIssuePanel = ({ columns, sheet, busy, reading, onFile, onClear, onDownloadSample, onIssue }) => {
  const { t } = useLanguage();
  const fileRef = useRef(null);

  return (
    <section className="vf-panel">
      <div className="vf-panel-head">
        <h2>{t('vf_cert_mode_bulk')}</h2>
        <div className="vf-inline-actions">
          <button type="button" className="secondary-button" onClick={onDownloadSample}>
            <Download aria-hidden="true" /> {t('vf_cert_download_sample')}
          </button>
          <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()} disabled={reading}>
            {reading ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
            {reading ? t('vf_cert_reading_sheet') : t('vf_cert_upload_sheet')}
          </button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept=".xlsx"
            aria-label={t('vf_cert_upload_sheet')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onFile(file);
            }}
          />
        </div>
      </div>

      <p className="field-note">{t('vf_cert_sheet_hint')}</p>

      {!sheet && (
        <div className="empty-table compact">
          <FileSpreadsheet aria-hidden="true" />
          <b>{t('vf_cert_preview_rows')}</b>
          <span>{t('vf_cert_sheet_hint')}</span>
        </div>
      )}

      {sheet && (
        <>
          <div className="kpi-grid compact">
            <div className="kpi-card">
              <Table2 aria-hidden="true" />
              <div><span>{t('vf_cert_rows_valid')}</span><b>{sheet.validCount}</b></div>
            </div>
            <div className="kpi-card sla">
              <ShieldAlert aria-hidden="true" />
              <div><span>{t('vf_cert_rows_invalid')}</span><b>{sheet.rows.length - sheet.validCount}</b></div>
            </div>
          </div>

          {sheet.unmatched.length > 0 && (
            <p className="field-note">{t('vf_cert_unmatched_columns', { columns: sheet.unmatched.join(' · ') })}</p>
          )}

          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead>
                <tr>
                  <th>{t('vf_cert_row_no')}</th>
                  {columns.map((column) => <th key={column.key}>{column.label}</th>)}
                  <th>{t('vf_cert_row_status')}</th>
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(0, PREVIEW_ROWS).map((row) => (
                  <tr key={row.index} className={row.errors.length ? 'row-late' : ''}>
                    <td>{row.index}</td>
                    {columns.map((column) => <td key={column.key}>{String(row.values[column.key] ?? '')}</td>)}
                    <td>
                      {row.errors.length === 0
                        ? <span className="vf-chip tone-valid">{t('vf_cert_row_ok')}</span>
                        : <span className="vf-chip tone-invalid">{row.errors.join(' · ')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClear}>
              <X aria-hidden="true" /> {t('vf_cert_clear_sheet')}
            </button>
            <button type="button" className="primary-button" onClick={onIssue} disabled={busy || sheet.validCount === 0}>
              {busy ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Award aria-hidden="true" />}
              {t('vf_cert_issue_count', { count: sheet.validCount })}
            </button>
          </div>
        </>
      )}
    </section>
  );
};

const IssueSummary = ({ summary, onClose }) => {
  const { t } = useLanguage();

  return (
    <section className="vf-panel vf-summary">
      <div className="vf-panel-head">
        <h2><Sparkles aria-hidden="true" /> {t('vf_cert_summary_title')}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="kpi-grid compact">
        <div className="kpi-card">
          <Table2 aria-hidden="true" />
          <div><span>{t('vf_cert_summary_total')}</span><b>{summary.total_rows}</b></div>
        </div>
        <div className="kpi-card">
          <CheckCircle2 aria-hidden="true" />
          <div><span>{t('vf_cert_summary_generated')}</span><b>{summary.generated_rows}</b></div>
        </div>
        <div className="kpi-card sla">
          <ShieldAlert aria-hidden="true" />
          <div><span>{t('vf_cert_summary_failed')}</span><b>{summary.failed_rows}</b></div>
        </div>
      </div>

      {summary.codes?.length > 0 && (
        <ul className="vf-code-list">
          {summary.codes.map((entry) => (
            <li key={entry.code}>
              <b>{entry.recipient_name}</b>
              <CodeChip code={entry.code} />
              <CopyButton value={verifyUrl(entry.code)} label={t('vf_copy_link')} icon={Link2} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const CertificatePreview = ({ certificate, template, fields, onClose }) => {
  const { t } = useLanguage();
  const frameRef = useRef(null);
  const [scale, setScale] = useState(0.4);
  const [printing, setPrinting] = useState(false);

  const pageWidth = Number(template?.page_width_px) || 1123;
  const pageHeight = Number(template?.page_height_px) || 794;
  const landscape = pageWidth >= pageHeight;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const measure = () => {
      const width = frame.clientWidth - 8;
      setScale(Math.max(Math.min(width / pageWidth, 1), 0.1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [pageWidth]);

  // Printing needs its own scale: the paper is A4, the design is in pixels, and
  // 96 dpi is the bridge between them. The page box is declared for this print
  // only, then withdrawn so no other screen inherits it.
  const printScale = useMemo(() => {
    const usableMm = (landscape ? 297 : 210) - 16;
    return Math.min((usableMm / 25.4) * 96 / pageWidth, 3);
  }, [landscape, pageWidth]);

  useEffect(() => {
    if (!printing) return undefined;

    const style = document.createElement('style');
    style.textContent = `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 8mm; }`;
    document.head.appendChild(style);
    document.body.classList.add('vf-printing');

    const timer = setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 60);

    return () => {
      clearTimeout(timer);
      document.body.classList.remove('vf-printing');
      style.remove();
    };
  }, [printing, landscape]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card modal-xwide vf-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('vf_cert_preview')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading no-print">
          <div>
            <span className="section-kicker">{t('module_certificates')}</span>
            <h3>{certificate.recipient_name}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="vf-print-area">
          <div className="vf-canvas-frame" ref={frameRef}>
            <CertificateCanvas
              template={template}
              fields={fields}
              values={certificate.data_json || {}}
              code={certificate.code || ''}
              scale={printing ? printScale : scale}
            />
          </div>
          <VerifiedSeal
            code={certificate.code || ''}
            sealStyle={certificate.seal_style || template?.seal_style}
            size={96}
            qrSize={80}
            className="vf-preview-seal"
          />
        </div>

        <div className="modal-actions no-print">
          <CopyButton value={verifyUrl(certificate.code)} label={t('vf_copy_link')} icon={Link2} variant="button" />
          <button type="button" className="primary-button" onClick={() => setPrinting(true)} disabled={printing}>
            <Printer aria-hidden="true" /> {t('action_print')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------

const CertificatesScreen = ({ onDesignTemplates }) => {
  const { t, lang, locale } = useLanguage();

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [fields, setFields] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [certificates, setCertificates] = useState([]);

  const [mode, setMode] = useState('single');
  const [sheet, setSheet] = useState(null);
  const [summary, setSummary] = useState(null);
  const [query, setQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [preview, setPreview] = useState(null);    // { certificate, template, fields }

  const template = templates.find((row) => row.id === templateId) || null;
  const columns = useMemo(() => buildColumns(fields, t, lang), [fields, t, lang]);

  const refreshCertificates = useCallback(async () => {
    const { data, error } = await loadCertificates({});
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setCertificates(data);
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadTemplates({ activeOnly: true }), loadEmployees(), loadCertificates({})])
      .then(([templateResult, employeeResult, certificateResult]) => {
        if (cancelled) return;
        setLoading(false);
        if (templateResult.error) {
          setNotice({ tone: 'error', text: t(verificationErrorKey(templateResult.error)) });
        } else {
          setTemplates(templateResult.data);
          setTemplateId((current) => current || templateResult.data[0]?.id || '');
        }
        if (employeeResult.data) setEmployees(employeeResult.data);
        if (certificateResult.data) setCertificates(certificateResult.data);
      });
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => {
    if (!templateId) return undefined;
    let cancelled = false;
    loadTemplateFields(templateId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
        return;
      }
      setFields(data);
      setSheet(null);
    });
    return () => { cancelled = true; };
  }, [templateId, t]);

  // ---- issuing ------------------------------------------------------------

  const issue = async (rows, onDone) => {
    setBusy(true);
    setNotice(null);
    const { data, error } = await issueCertificates(templateId, rows);
    setBusy(false);
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setSummary(data);
    onDone?.();
    refreshCertificates();
  };

  const issueSingle = (values, reset) => {
    const row = { ...values };
    if (row.valid_until) row.valid_until = asDateValue(row.valid_until) || undefined;
    issue([row], reset);
  };

  const issueSheet = () => {
    if (!sheet) return;
    const rows = sheet.rows
      .filter((row) => row.errors.length === 0)
      .map((row, index) => (index === 0
        ? { ...row.payload, batch_name: sheet.fileName, source_file_name: sheet.fileName }
        : row.payload));
    issue(rows, () => setSheet(null));
  };

  // ---- the spreadsheet ----------------------------------------------------

  const downloadSample = async () => {
    const header = columns.map((column) => ({ value: column.label, fontWeight: 'bold' }));
    const example = columns.map((column) => ({
      // An ISO date is unambiguous whichever locale opens the sheet.
      value: column.key === 'recipient_name' ? t('vf_sample_name')
        : column.type === 'Date' ? new Date().toISOString().slice(0, 10)
          : column.type === 'Number' ? '100' : t('vf_sample_text'),
    }));

    try {
      await writeXlsxFile([header, example], { fileName: `${t('vf_cert_sample_file_name')}.xlsx` });
    } catch (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
    }
  };

  const readSheet = async (file) => {
    setReading(true);
    setNotice(null);
    try {
      const raw = await readXlsxFile(file);
      const grid = Array.isArray(raw?.[0]?.data) ? raw[0].data : raw;
      if (!Array.isArray(grid) || grid.length < 2) throw new Error('NO_ROWS');

      const headers = grid[0].map((cell) => normaliseHeader(cell));
      const mapping = columns.map((column) => ({
        column,
        index: headers.findIndex((header) => header && column.aliases
          .concat(column.label)
          .some((alias) => normaliseHeader(alias) === header)),
      }));

      if (mapping.every((entry) => entry.index === -1)) throw new Error('NO_COLUMNS');

      const matched = new Set(mapping.filter((entry) => entry.index >= 0).map((entry) => entry.index));
      const unmatched = grid[0]
        .map((cell, index) => (matched.has(index) ? null : String(cell ?? '').trim()))
        .filter(Boolean);

      const rows = grid.slice(1)
        .filter((line) => line.some((cell) => cell != null && String(cell).trim() !== ''))
        .slice(0, MAX_SHEET_ROWS)
        .map((line, index) => {
          const values = mapping.reduce((all, entry) => (
            entry.index >= 0 ? { ...all, [entry.column.key]: line[entry.index] ?? '' } : all
          ), {});

          const errors = validateRow(values, columns, t);
          const payload = Object.entries(values).reduce((all, [key, value]) => {
            const column = columns.find((item) => item.key === key);
            if (value == null || String(value).trim() === '') return all;
            if (column?.type === 'Date') return { ...all, [key]: asDateValue(value) };
            return { ...all, [key]: String(value).trim() };
          }, {});

          return { index: index + 1, values, errors, payload };
        });

      setSheet({
        fileName: file.name,
        rows,
        unmatched,
        validCount: rows.filter((row) => row.errors.length === 0).length,
      });
    } catch (error) {
      // Anything the reader itself threw is a malformed workbook; only the two
      // shapes we raise deliberately carry their own wording.
      const known = ['NO_ROWS', 'NO_COLUMNS'].includes(error?.message) ? error : new Error('SHEET_UNREADABLE');
      setNotice({ tone: 'error', text: t(verificationErrorKey(known)) });
    } finally {
      setReading(false);
    }
  };

  // ---- issued list --------------------------------------------------------

  const visibleCertificates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return certificates;
    return certificates.filter((row) => [row.recipient_name, row.code]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)));
  }, [certificates, query]);

  const openPreview = async (certificate) => {
    const found = templates.find((row) => row.id === certificate.template_id) || template;
    const { data } = await loadTemplateFields(certificate.template_id);
    setPreview({ certificate, template: found, fields: data || [] });
  };

  if (!loading && templates.length === 0) {
    return (
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <span className="section-kicker">{t('module_certificates')}</span>
            <h1>{t('vf_cert_title')}</h1>
            <p>{t('vf_cert_intro')}</p>
          </div>
        </div>
        <div className="empty-table">
          <Award aria-hidden="true" />
          <b>{t('vf_cert_no_templates')}</b>
          <span>{t('vf_cert_no_templates_hint')}</span>
          {onDesignTemplates && (
            <button type="button" className="primary-button" onClick={onDesignTemplates}>
              {t('vf_cert_design_now')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="vf-screen">
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_certificates')}</span>
          <h1>{t('vf_cert_title')}</h1>
          <p>{t('vf_cert_intro')}</p>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="vf-issue-controls">
        <TemplatePicker
          templates={templates}
          value={templateId}
          onChange={(id) => {
            setTemplateId(id);
            setSheet(null);
            if (!id) setFields([]);
          }}
        />
        <div className="segmented">
          <button type="button" className={mode === 'single' ? 'active' : ''} aria-pressed={mode === 'single'} onClick={() => setMode('single')}>
            {t('vf_cert_mode_single')}
          </button>
          <button type="button" className={mode === 'bulk' ? 'active' : ''} aria-pressed={mode === 'bulk'} onClick={() => setMode('bulk')}>
            {t('vf_cert_mode_bulk')}
          </button>
        </div>
      </div>

      {summary && <IssueSummary summary={summary} onClose={() => setSummary(null)} />}

      {templateId && mode === 'single' && (
        <SingleIssueForm columns={columns} employees={employees} busy={busy} onIssue={issueSingle} />
      )}

      {templateId && mode === 'bulk' && (
        <BulkIssuePanel
          columns={columns}
          sheet={sheet}
          busy={busy}
          reading={reading}
          onFile={readSheet}
          onClear={() => setSheet(null)}
          onDownloadSample={downloadSample}
          onIssue={issueSheet}
        />
      )}

      <section className="vf-panel">
        <div className="vf-panel-head">
          <h2>{t('vf_cert_list_title')}</h2>
          <div className="search-control compact">
            <Search aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('vf_cert_search_placeholder')}
              aria-label={t('action_search')}
            />
          </div>
        </div>

        <div className="data-table-wrap">
          <table className="enterprise-table">
            <thead>
              <tr>
                <th>{t('vf_cert_recipient_name')}</th>
                <th>{t('vf_cert_template')}</th>
                <th>{t('vf_document_code')}</th>
                <th>{t('vf_cert_issued_on')}</th>
                <th>{t('vf_valid_until')}</th>
                <th>{t('label_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleCertificates.map((row) => {
                const rowTemplate = templates.find((item) => item.id === row.template_id);
                return (
                  <tr key={row.id}>
                    <td><b>{row.recipient_name}</b></td>
                    <td>{rowTemplate ? pickLocalized(rowTemplate, 'name', lang, rowTemplate.code) : '—'}</td>
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

              {!loading && visibleCertificates.length === 0 && (
                <tr>
                  <td colSpan="6">
                    <div className="empty-table">
                      <Award aria-hidden="true" />
                      <b>{t('vf_cert_no_certificates')}</b>
                      <span>{t('vf_cert_no_certificates_hint')}</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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

export default CertificatesScreen;
