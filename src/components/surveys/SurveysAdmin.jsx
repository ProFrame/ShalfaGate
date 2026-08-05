// Administration of the surveys.
//
// The product rule is that at most one survey is published at any moment. It is
// enforced in the service, but it is also explained here: publishing a second
// survey asks whether the current one should be taken down first.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChartColumn, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, formatNumber, pickLocalized } from '../../utils/localize';
import {
  deleteSurvey,
  engagementErrorMessage,
  loadSurveyResults,
  loadSurveys,
  saveSurvey,
  setSurveyPublished,
} from '../../data/engagementService';
import { loadRule, saveRule } from '../../data/audienceService';
import {
  AudienceField, ConfirmDialog, ModuleOffNotice, StatusLine, WindowBadge, publishingState,
} from '../announcements/engagementUi';
import './surveys.css';

const newOptionId = () => `new-${Math.random().toString(36).slice(2, 9)}`;

const emptyDraft = () => ({
  id: null,
  question_1: '',
  question_2: '',
  is_published: false,
  starts_on: new Date().toISOString().slice(0, 10),
  ends_on: '',
  options: [
    { id: newOptionId(), label_1: '', label_2: '', display_order: 1, vote_count: 0 },
    { id: newOptionId(), label_1: '', label_2: '', display_order: 2, vote_count: 0 },
  ],
  audience: null,
});

const percentOf = (count, total) => (total > 0 ? count / total : 0);

const ResultsPanel = ({ survey, results }) => {
  const { t, lang, locale } = useLanguage();
  const total = results?.total_votes || 0;
  const options = results?.options || [];

  return (
    <div className="survey-results-panel">
      <h3>{t('srv_results_for', { name: pickLocalized(survey, 'question', lang, t('srv_untitled')) })}</h3>
      <p>{t('srv_results_hint')}</p>
      {!total && <p className="field-note">{t('srv_no_votes')}</p>}
      <div className="survey-results">
        {options.map((option) => (
          <div key={option.id} className="survey-result-row">
            <div className="survey-result-label">
              <b>{pickLocalized(option, 'label', lang, '')}</b>
              <span>{formatNumber(option.vote_count, locale)}</span>
              <strong>
                {formatNumber(percentOf(option.vote_count, total), locale, {
                  style: 'percent',
                  maximumFractionDigits: 0,
                })}
              </strong>
            </div>
            <div
              className="survey-bar"
              role="meter"
              aria-valuenow={Math.round(percentOf(option.vote_count, total) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={pickLocalized(option, 'label', lang, '')}
            >
              <span style={{ width: `${Math.round(percentOf(option.vote_count, total) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="field-note">{t('srv_total_votes', { count: formatNumber(total, locale) })}</p>
    </div>
  );
};

const SurveyEditor = ({ draft, onChange, onClose, onSave, busy, conflictName, message, tone }) => {
  const { t } = useLanguage();

  const setOption = (id, patch) => onChange({
    ...draft,
    options: draft.options.map((option) => (option.id === id ? { ...option, ...patch } : option)),
  });

  const addOption = () => onChange({
    ...draft,
    options: [
      ...draft.options,
      { id: newOptionId(), label_1: '', label_2: '', display_order: draft.options.length + 1, vote_count: 0 },
    ],
  });

  const removeOption = (id) => onChange({
    ...draft,
    options: draft.options.filter((option) => option.id !== id),
  });

  const validOptions = draft.options.filter((option) => option.label_1.trim()).length;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card survey-editor"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('srv_edit') : t('srv_new')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('module_survey')}</span>
            <h3>{draft.id ? t('srv_edit') : t('srv_new')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="survey-editor-fields">
          <label className="field-label" htmlFor="srv-question-1">
            {t('srv_question_1')}
            <input
              id="srv-question-1"
              className="form-input"
              value={draft.question_1}
              onChange={(event) => onChange({ ...draft, question_1: event.target.value })}
              placeholder={t('srv_question_1')}
              required
            />
          </label>

          <label className="field-label" htmlFor="srv-question-2">
            {t('srv_question_2')}
            <input
              id="srv-question-2"
              className="form-input"
              value={draft.question_2}
              onChange={(event) => onChange({ ...draft, question_2: event.target.value })}
              placeholder={t('srv_question_2')}
            />
          </label>

          <div className="survey-option-editor">
            <div className="survey-option-editor-head">
              <b>{t('srv_options')}</b>
              <button type="button" className="secondary-button" onClick={addOption}>
                <Plus size={15} aria-hidden="true" />
                {t('srv_add_option')}
              </button>
            </div>
            <p className="field-note">{t('srv_options_hint')}</p>
            <ol>
              {draft.options.map((option, index) => (
                <li key={option.id}>
                  <span aria-hidden="true">{index + 1}</span>
                  <input
                    className="form-input"
                    value={option.label_1}
                    onChange={(event) => setOption(option.id, { label_1: event.target.value })}
                    placeholder={t('srv_option_1')}
                    aria-label={`${t('srv_option_1')} ${index + 1}`}
                  />
                  <input
                    className="form-input"
                    value={option.label_2 || ''}
                    onChange={(event) => setOption(option.id, { label_2: event.target.value })}
                    placeholder={t('srv_option_2')}
                    aria-label={`${t('srv_option_2')} ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeOption(option.id)}
                    aria-label={t('srv_remove_option')}
                    title={t('srv_remove_option')}
                    disabled={draft.options.length <= 2}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
            {validOptions < 2 && <p className="field-note" role="alert">{t('srv_min_options')}</p>}
          </div>

          <div className="form-grid">
            <label className="field-label" htmlFor="srv-start">
              {t('srv_starts_on')}
              <input
                id="srv-start"
                type="date"
                className="form-input"
                value={draft.starts_on || ''}
                onChange={(event) => onChange({ ...draft, starts_on: event.target.value })}
              />
            </label>
            <label className="field-label" htmlFor="srv-end">
              {t('srv_ends_on')}
              <input
                id="srv-end"
                type="date"
                className="form-input"
                value={draft.ends_on || ''}
                onChange={(event) => onChange({ ...draft, ends_on: event.target.value })}
              />
            </label>
          </div>

          <div className="engagement-toggle-row">
            <label className="engagement-toggle" htmlFor="srv-published">
              <input
                id="srv-published"
                type="checkbox"
                checked={draft.is_published}
                onChange={(event) => onChange({ ...draft, is_published: event.target.checked })}
              />
              {t('action_publish')}
            </label>
            <span className="field-note">{t('srv_only_one_published')}</span>
          </div>

          {draft.is_published && conflictName && (
            <p className="field-note" role="alert">
              {t('srv_publish_conflict_body', { name: conflictName })}
            </p>
          )}

          <AudienceField
            entityType="Survey"
            entityId={draft.id}
            value={draft.audience}
            onChange={(audience) => onChange({ ...draft, audience })}
          />
        </div>

        <StatusLine message={message} tone={tone} />

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button
            type="button"
            className="primary-button"
            onClick={onSave}
            disabled={busy || !draft.question_1.trim() || validOptions < 2}
          >
            {busy ? t('eng_saving') : t('action_save')}
          </button>
        </div>
      </div>
    </div>
  );
};

const SurveysAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();

  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingPublish, setPendingPublish] = useState(null);
  const [resultsFor, setResultsFor] = useState(null);
  const [results, setResults] = useState(null);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('info');

  // Reloading is driven by a token rather than by calling a loader from the
  // effect, so the effect body never sets state synchronously.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    loadSurveys().then(({ data, error }) => {
      if (cancelled) return;
      setRows(Array.isArray(data) ? data : []);
      if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  useEffect(() => {
    if (!resultsFor) return undefined;
    let cancelled = false;
    loadSurveyResults(resultsFor.id).then(({ data }) => {
      if (!cancelled) setResults(data);
    });
    return () => { cancelled = true; };
  }, [resultsFor]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => `${row.question_1 || ''} ${row.question_2 || ''}`.toLowerCase().includes(needle));
  }, [rows, search]);

  const publishedElsewhere = useMemo(
    () => rows.find((row) => row.is_published && row.id !== draft?.id) || null,
    [rows, draft],
  );

  const persist = useCallback(async (payload) => {
    setBusy(true);
    const { data, error } = await saveSurvey(payload);
    if (!error) {
      const { error: audienceError } = await saveRule('Survey', data.id, payload.audience);
      if (audienceError) {
        setBusy(false);
        setMessage(engagementErrorMessage(t, audienceError));
        setTone('error');
        return;
      }
    }
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    setMessage(t('srv_saved'));
    setTone('info');
    setDraft(null);
    refresh();
  }, [refresh, t]);

  const openEditor = async (row) => {
    const base = row ? { ...emptyDraft(), ...row, ends_on: row.ends_on || '' } : emptyDraft();
    setDraft(base);
    if (!row) return;
    const { data: audience } = await loadRule('Survey', row.id);
    setDraft((current) => (current && current.id === row.id ? { ...current, audience } : current));
  };

  const save = () => {
    if (draft.is_published && publishedElsewhere) {
      setPendingPublish({ kind: 'save', payload: draft, conflict: publishedElsewhere });
      return;
    }
    persist(draft);
  };

  const togglePublished = (row) => {
    const conflict = rows.find((other) => other.is_published && other.id !== row.id);
    if (!row.is_published && conflict) {
      setPendingPublish({ kind: 'toggle', payload: row, conflict });
      return;
    }
    setSurveyPublished(row.id, !row.is_published).then(({ error }) => {
      if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
      refresh();
    });
  };

  const confirmPublish = async () => {
    const pending = pendingPublish;
    setPendingPublish(null);
    if (!pending) return;
    if (pending.kind === 'save') { await persist({ ...pending.payload, is_published: true }); return; }
    setBusy(true);
    const { error } = await setSurveyPublished(pending.payload.id, true);
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    refresh();
  };

  const confirmDelete = async () => {
    setBusy(true);
    const { error } = await deleteSurvey(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    setMessage(t('srv_deleted'));
    setTone('info');
    refresh();
  };

  if (!hasModule('SURVEY')) return <ModuleOffNotice />;

  return (
    <section className="surveys-admin">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('module_survey')}</span>
          <h1>{t('module_survey')}</h1>
          <p>{t('srv_admin_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={() => openEditor(null)}>
            <Plus size={17} aria-hidden="true" />
            {t('srv_new')}
          </button>
        </div>
      </div>

      <div className="surveys-admin-toolbar">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('srv_search')}
            aria-label={t('srv_search')}
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label={t('action_clear')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <StatusLine message={message} tone={tone} />

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th scope="col">{t('srv_question_1')}</th>
              <th scope="col">{t('srv_options')}</th>
              <th scope="col">{t('eng_period')}</th>
              <th scope="col">{t('srv_votes_column')}</th>
              <th scope="col">{t('label_status')}</th>
              <th scope="col">{t('label_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6}><div className="empty-table compact">{t('label_loading')}</div></td></tr>}
            {!loading && !filtered.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-table compact">
                    <ChartColumn aria-hidden="true" />
                    <b>{t('srv_none_yet')}</b>
                  </div>
                </td>
              </tr>
            )}
            {!loading && filtered.map((row) => (
              <tr key={row.id}>
                <td><b>{pickLocalized(row, 'question', lang, t('srv_untitled'))}</b></td>
                <td>{formatNumber(row.options.length, locale)}</td>
                <td>
                  {row.starts_on ? formatDate(row.starts_on, locale) : '—'}
                  {' · '}
                  {row.ends_on ? formatDate(row.ends_on, locale) : t('eng_always')}
                </td>
                <td>{formatNumber(row.total_votes, locale)}</td>
                <td>
                  <div className="survey-published-cell">
                    <WindowBadge state={publishingState(row, 'starts_on', 'ends_on')} />
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => togglePublished(row)}
                    >
                      {row.is_published ? t('action_unpublish') : t('action_publish')}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      onClick={() => { setResults(null); setResultsFor(row); }}
                      aria-label={t('srv_open_results')}
                      title={t('srv_open_results')}
                    >
                      <ChartColumn aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditor(row)}
                      aria-label={t('action_edit')}
                      title={t('action_edit')}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setPendingDelete(row)}
                      aria-label={t('action_delete')}
                      title={t('action_delete')}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {resultsFor && (
        <div className="modal-backdrop" role="presentation" onClick={() => setResultsFor(null)}>
          <div
            className="modal-card modal-wide"
            role="dialog"
            aria-modal="true"
            aria-label={t('srv_results')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h3>{t('srv_results')}</h3>
              <button
                type="button"
                className="icon-button"
                onClick={() => setResultsFor(null)}
                aria-label={t('action_close')}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {results
              ? <ResultsPanel survey={resultsFor} results={results} />
              : <p className="field-note">{t('label_loading')}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setResultsFor(null)}>
                {t('action_close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <SurveyEditor
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={save}
          busy={busy}
          conflictName={publishedElsewhere ? pickLocalized(publishedElsewhere, 'question', lang, t('srv_untitled')) : ''}
          message={tone === 'error' ? message : ''}
          tone={tone}
        />
      )}

      {pendingPublish && (
        <ConfirmDialog
          title={t('srv_publish_conflict_title')}
          message={t('srv_publish_conflict_body', {
            name: pickLocalized(pendingPublish.conflict, 'question', lang, t('srv_untitled')),
          })}
          confirmLabel={t('srv_publish_and_replace')}
          busy={busy}
          onConfirm={confirmPublish}
          onCancel={() => setPendingPublish(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t('action_delete')}
          message={t('srv_delete_confirm')}
          confirmLabel={t('action_delete')}
          busy={busy}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
};

export default SurveysAdmin;
