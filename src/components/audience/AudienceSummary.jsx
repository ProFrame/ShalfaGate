/* eslint-disable react-refresh/only-export-components */
// The read-only face of the Audience Targeting Engine.
//
// Two jobs:
//
//   1. `audienceSentence()` turns a rule object into one plain-language
//      sentence, assembled from translated fragments. No English word order is
//      ever concatenated: every dimension owns a fragment with a {{value}} slot
//      and the joiners are translated too, so Arabic reads as Arabic.
//
//   2. <AudienceSummary /> renders that sentence on a single line for tables
//      and cards, with the full sentence in the tooltip and in aria-label.
//
// The picker imports both, so the wording a manager reads while editing and the
// wording another employee reads in a list can never drift apart.

import { useEffect, useState } from 'react';
import { Target, Users } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { pickLocalized } from '../../utils/localize';
import {
  DIMENSION_FRAGMENT_KEYS,
  isEveryoneRule,
  loadRule,
  normalizeRule,
  ruleTerms,
} from '../../data/audienceService';
import './audience.css';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * The human label of one stored value. Publication levels are codes and are
 * translated; everything else carries the two database names the engine
 * returned, resolved through the shared localisation walk.
 *
 * @param {{value_id?: string|null, value_text?: string|null, label_ar?: string|null, label_en?: string|null}} value
 * @param {string} dimension
 * @param {(key: string, vars?: object) => string} t
 * @param {string} lang
 */
export const audienceValueLabel = (value, dimension, t, lang) => {
  if (!value) return t('audience_value_missing');

  if (dimension === 'PublicationLevel') {
    const code = String(value.value_text || '').toLowerCase();
    const key = `audience_level_${code}`;
    const label = t(key);
    if (label !== key) return label;
    return value.value_text || t('audience_value_missing');
  }

  const localized = pickLocalized(value, 'label', lang);
  return localized || value.value_text || t('audience_value_missing');
};

const termFragment = (term, t, lang) => t(
  DIMENSION_FRAGMENT_KEYS[term.dimension] || 'audience_frag_unknown',
  { value: audienceValueLabel(term, term.dimension, t, lang) },
);

// ---------------------------------------------------------------------------
// Sentence
// ---------------------------------------------------------------------------

/**
 * One group reads the way the engine evaluates it: every AND line must match,
 * one of the OR lines is enough, and anybody matching a NOT line is removed.
 */
const groupPhrase = (group, t, lang) => {
  const required = [];
  const alternatives = [];
  const excluded = [];

  group.terms.forEach((term) => {
    const fragment = termFragment(term, t, lang);
    if (term.operator === 'NOT') excluded.push(fragment);
    else if (term.operator === 'OR') alternatives.push(fragment);
    else required.push(fragment);
  });

  const parts = [];
  if (required.length) parts.push(required.join(t('audience_join_and')));
  if (alternatives.length) {
    parts.push(alternatives.length === 1
      ? alternatives[0]
      : t('audience_any_of', { list: alternatives.join(t('audience_join_or')) }));
  }

  let phrase = parts.join(t('audience_join_and'));

  if (excluded.length) {
    // A group made only of exclusions still starts from the whole company.
    if (!phrase) phrase = t('audience_frag_everyone');
    phrase = t('audience_with_exclusion', {
      phrase,
      exclusion: t('audience_excluding', { list: excluded.join(t('audience_join_or')) }),
    });
  }

  return phrase;
};

/**
 * The whole rule as one sentence.
 *
 * @param {object|null} rule   the canonical rule object
 * @param {(key: string, vars?: object) => string} t
 * @param {string} lang
 * @returns {string}
 */
export const audienceSentence = (rule, t, lang) => {
  const normalized = normalizeRule(rule);
  if (normalized.is_everyone || !normalized.groups.length) return t('audience_summary_everyone');

  const phrases = normalized.groups
    .map((group) => groupPhrase(group, t, lang))
    .filter(Boolean);

  if (!phrases.length) return t('audience_summary_everyone');

  const joiner = normalized.match_mode === 'Any' ? t('audience_join_or') : t('audience_join_and');
  const scope = phrases.length > 1
    ? phrases.map((phrase) => t('audience_group_bracket', { phrase })).join(joiner)
    : phrases[0];

  return t('audience_summary_scope', { scope });
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * One line describing who sees a record.
 *
 * @param {object}  props
 * @param {object}  [props.value]       the rule; when absent it is loaded from
 *                                      entityType + entityId
 * @param {string}  [props.entityType]
 * @param {string}  [props.entityId]
 * @param {boolean} [props.compact]     badge form for a dense table cell
 * @param {string}  [props.className]
 */
const AudienceSummary = ({
  value = null,
  entityType = null,
  entityId = null,
  compact = false,
  className = '',
}) => {
  const { t, lang } = useLanguage();
  // Cached with the record it belongs to, so a row that scrolls into a new
  // entity never shows the previous record's audience for a frame.
  const [fetched, setFetched] = useState(null);

  const cacheKey = !value && entityType && entityId ? `${entityType}:${entityId}` : '';

  useEffect(() => {
    if (!cacheKey) return undefined;
    let cancelled = false;
    loadRule(entityType, entityId).then(({ data }) => {
      if (!cancelled && data) setFetched({ key: cacheKey, rule: data });
    });
    return () => { cancelled = true; };
  }, [cacheKey, entityType, entityId]);

  const rule = value || (fetched && fetched.key === cacheKey ? fetched.rule : null);
  const everyone = isEveryoneRule(rule);
  const sentence = audienceSentence(rule, t, lang);
  const count = ruleTerms(rule).length;
  const Icon = everyone ? Users : Target;

  return (
    <span
      className={`aud-summary${compact ? ' is-compact' : ''}${everyone ? ' is-everyone' : ''}${className ? ` ${className}` : ''}`}
      title={sentence}
      aria-label={sentence}
    >
      <Icon aria-hidden="true" focusable="false" />
      <span className="aud-summary-text">
        {compact
          ? (everyone ? t('audience_chip_everyone') : t('audience_condition_count', { count }))
          : sentence}
      </span>
    </span>
  );
};

export default AudienceSummary;
