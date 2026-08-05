// The small survey card on the home page: one question, a set of answers, a
// vote button — and once the employee has answered, the same card turns into
// animated result bars with the option to change the vote.

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChartColumn } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, formatNumber, pickLocalized } from '../../utils/localize';
import { engagementErrorMessage, loadCurrentSurvey, submitSurveyVote } from '../../data/engagementService';
import { StatusLine } from '../announcements/engagementUi';
import './surveys.css';

const percentOf = (count, total) => (total > 0 ? Math.round((count / total) * 100) : 0);

const SurveyResults = ({ survey }) => {
  const { t, lang, locale } = useLanguage();
  const total = survey.total_votes || 0;

  return (
    <div className="survey-results">
      {survey.options.map((option) => {
        const share = percentOf(option.vote_count, total);
        const mine = option.id === survey.my_option_id;
        return (
          <div key={option.id} className={`survey-result-row${mine ? ' mine' : ''}`}>
            <div className="survey-result-label">
              <b>{pickLocalized(option, 'label', lang, '')}</b>
              <span>{formatNumber(option.vote_count, locale)}</span>
              <strong>{formatNumber(share / 100, locale, { style: 'percent', maximumFractionDigits: 0 })}</strong>
            </div>
            <div
              className="survey-bar"
              role="meter"
              aria-valuenow={share}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={pickLocalized(option, 'label', lang, '')}
            >
              <motion.span
                initial={{ width: 0 }}
                animate={{ width: `${share}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
            </div>
          </div>
        );
      })}
      <p className="field-note">{t('srv_total_votes', { count: formatNumber(total, locale) })}</p>
    </div>
  );
};

const SurveyWidget = () => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();

  const [survey, setSurvey] = useState(null);
  const [choice, setChoice] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('info');

  useEffect(() => {
    let cancelled = false;
    loadCurrentSurvey().then(({ data, error }) => {
      if (cancelled) return;
      setSurvey(data || null);
      setChoice(data?.my_option_id || '');
      setShowResults(Boolean(data?.my_option_id));
      if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [t]);

  const question = useMemo(
    () => (survey ? pickLocalized(survey, 'question', lang, '') : ''),
    [survey, lang],
  );

  const vote = async () => {
    if (!choice) { setMessage(t('srv_choose_option')); setTone('error'); return; }
    setBusy(true);
    const { data, error } = await submitSurveyVote(survey.id, choice);
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    if (data) setSurvey(data);
    setShowResults(true);
    setMessage(t('srv_thanks'));
    setTone('info');
  };

  if (!hasModule('SURVEY')) return null;

  if (loading) {
    return (
      <section className="survey-widget" aria-busy="true">
        <header className="survey-widget-head">
          <span className="survey-widget-icon"><ChartColumn aria-hidden="true" /></span>
          <div><span className="section-kicker">{t('srv_widget_title')}</span></div>
        </header>
        <p className="field-note">{t('label_loading')}</p>
      </section>
    );
  }

  if (!survey) {
    return (
      <section className="survey-widget">
        <header className="survey-widget-head">
          <span className="survey-widget-icon"><ChartColumn aria-hidden="true" /></span>
          <div>
            <span className="section-kicker">{t('srv_widget_title')}</span>
            <h2>{t('srv_empty_title')}</h2>
          </div>
        </header>
        <p className="field-note">{t('srv_empty_hint')}</p>
      </section>
    );
  }

  return (
    <section className="survey-widget" aria-label={t('srv_widget_title')}>
      <header className="survey-widget-head">
        <span className="survey-widget-icon"><ChartColumn aria-hidden="true" /></span>
        <div>
          <span className="section-kicker">{t('srv_widget_title')}</span>
          <h2>{question}</h2>
        </div>
      </header>

      {showResults ? (
        <SurveyResults survey={survey} />
      ) : (
        <fieldset className="survey-options">
          <legend>{t('srv_choose_option')}</legend>
          {survey.options.map((option) => {
            const id = `survey-option-${option.id}`;
            return (
              <label key={option.id} className={`survey-option${choice === option.id ? ' selected' : ''}`} htmlFor={id}>
                <input
                  id={id}
                  type="radio"
                  name={`survey-${survey.id}`}
                  value={option.id}
                  checked={choice === option.id}
                  onChange={() => setChoice(option.id)}
                />
                <span>{pickLocalized(option, 'label', lang, '')}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      <div className="survey-widget-foot">
        {showResults ? (
          <button type="button" className="secondary-button" onClick={() => setShowResults(false)}>
            {t('srv_change_vote')}
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={vote} disabled={busy}>
            {busy ? t('eng_saving') : t('srv_vote')}
          </button>
        )}
        {survey.ends_on && <small>{t('srv_closes_on', { date: formatDate(survey.ends_on, locale) })}</small>}
      </div>

      <StatusLine message={message} tone={tone} />
    </section>
  );
};

export default SurveyWidget;
