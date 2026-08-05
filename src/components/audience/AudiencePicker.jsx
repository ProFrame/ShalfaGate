/* eslint-disable react-refresh/only-export-components */
// The single audience-targeting component every module uses.
//
// Circulars, documents, designs, form templates, announcements, surveys,
// calendar events and certificates all decide "who sees this" here, so none of
// them owns targeting logic of its own.
//
// The component is CONTROLLED: it never saves. It renders `value`, emits the
// next rule through `onChange`, and the owning screen persists it with
// saveAudienceRule() next to its own save, so one button saves one record.
//
// Rule shape, identical to what public.audience_save stores:
//
//   {
//     is_everyone: boolean,
//     match_mode: 'All' | 'Any',
//     groups: [ { group_no: 1, terms: [
//       { operator: 'AND'|'OR'|'NOT', dimension: '…', value_id, value_text }
//     ] } ]
//   }
//
// Internally one editor line holds several values of the same dimension, which
// is friendlier than one line per value. A line expands to one stored term per
// value on the way out and consecutive terms sharing an operator and dimension
// collapse back into one line on the way in, so the round trip is exact.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check, ChevronDown, ChevronUp, CircleSlash, Layers, ListFilter, Plus, Search,
  Trash2, UserCheck, Users, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { pickLocalized } from '../../utils/localize';
import {
  AUDIENCE_DIMENSIONS,
  AUDIENCE_MATCH_MODES,
  AUDIENCE_OPERATORS,
  DIMENSION_LABEL_KEYS,
  audienceErrorMessage,
  loadDimensionOptions,
  normalizeRule,
  saveRule,
  searchEmployees,
  testRule,
} from '../../data/audienceService';
import AudienceSummary, { audienceValueLabel } from './AudienceSummary';
import './audience.css';

/** The save helper the owning screen calls; the picker itself never persists. */
export { saveRule as saveAudienceRule };

const MATCH_MODE_KEYS = { All: 'audience_match_all', Any: 'audience_match_any' };
const MATCH_MODE_HELP_KEYS = { All: 'audience_match_all_help', Any: 'audience_match_any_help' };
const OPERATOR_KEYS = { AND: 'audience_op_and', OR: 'audience_op_or', NOT: 'audience_op_not' };
const OPERATOR_HELP_KEYS = {
  AND: 'audience_op_and_help', OR: 'audience_op_or_help', NOT: 'audience_op_not_help',
};

let lineCounter = 0;
const nextLineId = () => {
  lineCounter += 1;
  return `aud-line-${lineCounter}`;
};

const valueKey = (value) => value?.value_id || value?.value_text || '';

// ---------------------------------------------------------------------------
// Rule <-> editor model
// ---------------------------------------------------------------------------

const linesFromTerms = (terms) => {
  const lines = [];
  terms.forEach((term) => {
    const value = {
      value_id: term.value_id ?? null,
      value_text: term.value_text ?? null,
      label_ar: term.label_ar ?? null,
      label_en: term.label_en ?? null,
    };
    const last = lines[lines.length - 1];
    if (last && last.operator === term.operator && last.dimension === term.dimension) {
      last.values.push(value);
      return;
    }
    lines.push({ id: nextLineId(), operator: term.operator, dimension: term.dimension, values: [value] });
  });
  return lines;
};

const editorFromRule = (rule) => {
  const normalized = normalizeRule(rule);
  return {
    is_everyone: normalized.is_everyone,
    match_mode: normalized.match_mode,
    groups: normalized.groups.map((group) => ({ id: nextLineId(), lines: linesFromTerms(group.terms) })),
  };
};

const ruleFromEditor = (editor) => ({
  is_everyone: editor.is_everyone,
  match_mode: editor.match_mode,
  groups: editor.is_everyone
    ? []
    : editor.groups
      .map((group) => group.lines.flatMap((line) => line.values.map((value) => ({
        operator: line.operator,
        dimension: line.dimension,
        value_id: value.value_id ?? null,
        value_text: value.value_text ?? null,
        label_ar: value.label_ar ?? null,
        label_en: value.label_en ?? null,
      }))))
      .filter((terms) => terms.length > 0)
      .map((terms, index) => ({
        group_no: index + 1,
        terms: terms.map((term) => ({ ...term, group_no: index + 1 })),
      })),
});

const newLine = () => ({ id: nextLineId(), operator: 'AND', dimension: 'Department', values: [] });
const newGroup = () => ({ id: nextLineId(), lines: [newLine()] });

const moved = (items, index, delta) => {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

// ---------------------------------------------------------------------------
// Option loading
// ---------------------------------------------------------------------------

const useDimensionOptions = (dimension) => {
  const [state, setState] = useState({ dimension: null, options: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    loadDimensionOptions(dimension).then(({ data, error }) => {
      if (cancelled) return;
      setState({ dimension, options: data || [], loading: false, error: error || null });
    });
    return () => { cancelled = true; };
  }, [dimension]);

  // The list already in state belongs to the previous dimension until the new
  // one arrives; reporting it as "loading" is cheaper and truer than clearing
  // state from inside the effect.
  if (state.dimension !== dimension) return { options: [], loading: true, error: null };
  return state;
};

const optionLabel = (option, t, lang) => (
  option?.label_key ? t(option.label_key) : pickLocalized(option, 'name', lang)
);

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const EveryoneSwitch = ({ checked, onChange, disabled }) => {
  const { t } = useLanguage();
  const labelId = useId();

  return (
    <div className="aud-everyone">
      <span className="aud-everyone-icon" aria-hidden="true"><Users /></span>
      <span className="aud-everyone-copy">
        <b id={labelId}>{t('audience_everyone_label')}</b>
        <small>{t(checked ? 'audience_everyone_help' : 'audience_targeted_help')}</small>
      </span>
      <button
        type="button"
        role="switch"
        className="aud-switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
};

const MatchModeControl = ({ mode, onChange, disabled }) => {
  const { t } = useLanguage();

  return (
    <div className="aud-match">
      <span className="aud-match-label">{t('audience_match_mode_label')}</span>
      <div className="segmented aud-segmented" role="radiogroup" aria-label={t('audience_match_mode_label')}>
        {AUDIENCE_MATCH_MODES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={mode === value ? 'active' : ''}
            disabled={disabled}
            onClick={() => onChange(value)}
          >
            {t(MATCH_MODE_KEYS[value])}
          </button>
        ))}
      </div>
      <p className="field-note">{t(MATCH_MODE_HELP_KEYS[mode] || MATCH_MODE_HELP_KEYS.All)}</p>
    </div>
  );
};

/** Searchable multi-select bound to one dimension's list. */
const ValueSelect = ({ dimension, values, onChange, disabled }) => {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { options, loading, error } = useDimensionOptions(dimension);
  const boxRef = useRef(null);
  const panelId = useId();
  const searchId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedKeys = useMemo(() => new Set(values.map(valueKey)), [values]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${optionLabel(option, t, lang)} ${option.hint || ''}`
      .toLocaleLowerCase().includes(needle));
  }, [options, query, t, lang]);

  const toggle = (option) => {
    const key = option.value_id || option.value_text || '';
    if (selectedKeys.has(key)) {
      onChange(values.filter((value) => valueKey(value) !== key));
      return;
    }
    onChange([...values, {
      value_id: option.value_id ?? null,
      value_text: option.value_text ?? null,
      label_ar: option.label_key ? null : option.name_ar ?? null,
      label_en: option.label_key ? null : option.name_en ?? null,
    }]);
  };

  return (
    <div className="aud-values" ref={boxRef}>
      <button
        type="button"
        className="aud-values-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('audience_select_values')}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <ListFilter aria-hidden="true" />
        <span className="aud-values-text">
          {values.length
            ? t('audience_selected_count', { count: values.length })
            : t('audience_select_values')}
        </span>
        <ChevronDown aria-hidden="true" className={open ? 'is-open' : ''} />
      </button>

      {values.length > 0 && (
        <ul className="aud-chips">
          {values.map((value) => {
            const label = audienceValueLabel(value, dimension, t, lang);
            return (
              <li key={valueKey(value)} className="aud-chip">
                <span>{label}</span>
                <button
                  type="button"
                  aria-label={t('audience_remove_value', { value: label })}
                  disabled={disabled}
                  onClick={() => onChange(values.filter((item) => valueKey(item) !== valueKey(value)))}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <div className="aud-panel" id={panelId}>
          <div className="aud-panel-search">
            <Search aria-hidden="true" />
            <label className="sr-only" htmlFor={searchId}>{t('audience_search_values')}</label>
            <input
              id={searchId}
              type="search"
              className="aud-panel-input"
              placeholder={t('audience_search_values')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {loading && <p className="aud-panel-note">{t('label_loading')}</p>}
          {!loading && error && <p className="aud-panel-note is-error">{t('audience_options_error')}</p>}
          {!loading && !error && filtered.length === 0 && (
            <p className="aud-panel-note">{t('audience_no_options')}</p>
          )}

          {filtered.length > 0 && (
            <ul className="aud-option-list">
              {filtered.map((option) => (
                <li key={option.key}>
                  <label className="aud-option">
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(option.key)}
                      disabled={disabled}
                      onChange={() => toggle(option)}
                    />
                    <span className="aud-option-name">{optionLabel(option, t, lang)}</span>
                    {option.hint && <span className="aud-option-hint">{option.hint}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

/** One condition: operator + dimension + the values it targets. */
const ConditionLine = ({
  line, index, total, disabled, onOperator, onDimension, onValues, onMove, onRemove,
}) => {
  const { t } = useLanguage();
  const operatorId = useId();
  const dimensionId = useId();

  return (
    <li className={`aud-line${line.operator === 'NOT' ? ' is-excluded' : ''}`}>
      <div className="aud-line-field">
        <label className="sr-only" htmlFor={operatorId}>{t('audience_operator_label')}</label>
        <select
          id={operatorId}
          className="form-input aud-select aud-select-operator"
          value={line.operator}
          disabled={disabled}
          onChange={(event) => onOperator(event.target.value)}
        >
          {AUDIENCE_OPERATORS.map((operator) => (
            <option key={operator} value={operator}>{t(OPERATOR_KEYS[operator])}</option>
          ))}
        </select>
      </div>

      <div className="aud-line-field">
        <label className="sr-only" htmlFor={dimensionId}>{t('audience_dimension_label')}</label>
        <select
          id={dimensionId}
          className="form-input aud-select"
          value={line.dimension}
          disabled={disabled}
          onChange={(event) => onDimension(event.target.value)}
        >
          {AUDIENCE_DIMENSIONS.map((dimension) => (
            <option key={dimension} value={dimension}>{t(DIMENSION_LABEL_KEYS[dimension])}</option>
          ))}
        </select>
      </div>

      <div className="aud-line-field aud-line-values">
        {/* Keyed by dimension: changing the target starts a fresh selector
            rather than carrying the previous search and open state over. */}
        <ValueSelect
          key={line.dimension}
          dimension={line.dimension}
          values={line.values}
          disabled={disabled}
          onChange={onValues}
        />
        {line.values.length === 0 && <p className="field-note">{t('audience_no_values')}</p>}
      </div>

      <div className="aud-line-tools">
        <button
          type="button"
          className="aud-tool"
          title={t('audience_move_condition_up')}
          aria-label={t('audience_move_condition_up')}
          disabled={disabled || index === 0}
          onClick={() => onMove(-1)}
        >
          <ChevronUp aria-hidden="true" />
        </button>
        <button
          type="button"
          className="aud-tool"
          title={t('audience_move_condition_down')}
          aria-label={t('audience_move_condition_down')}
          disabled={disabled || index === total - 1}
          onClick={() => onMove(1)}
        >
          <ChevronDown aria-hidden="true" />
        </button>
        <button
          type="button"
          className="aud-tool is-danger"
          title={t('audience_remove_condition')}
          aria-label={t('audience_remove_condition')}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>

      <p className="aud-line-help">{t(OPERATOR_HELP_KEYS[line.operator])}</p>
    </li>
  );
};

const GroupCard = ({ group, index, total, disabled, onChange, onMove, onRemove }) => {
  const { t } = useLanguage();

  const updateLine = (lineIndex, patch) => onChange({
    ...group,
    lines: group.lines.map((line, position) => (position === lineIndex ? { ...line, ...patch } : line)),
  });

  return (
    <motion.li
      className="aud-group"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <header className="aud-group-head">
        <span className="aud-group-icon" aria-hidden="true"><Layers /></span>
        <div className="aud-group-title">
          <b>{t('audience_group_title', { number: index + 1 })}</b>
          <small>{t('audience_group_help')}</small>
        </div>
        <div className="aud-line-tools">
          <button
            type="button"
            className="aud-tool"
            title={t('audience_move_group_up')}
            aria-label={t('audience_move_group_up')}
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            <ChevronUp aria-hidden="true" />
          </button>
          <button
            type="button"
            className="aud-tool"
            title={t('audience_move_group_down')}
            aria-label={t('audience_move_group_down')}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
          >
            <ChevronDown aria-hidden="true" />
          </button>
          <button
            type="button"
            className="aud-tool is-danger"
            title={t('audience_remove_group')}
            aria-label={t('audience_remove_group')}
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      </header>

      <ul className="aud-lines">
        {group.lines.map((line, lineIndex) => (
          <ConditionLine
            key={line.id}
            line={line}
            index={lineIndex}
            total={group.lines.length}
            disabled={disabled}
            onOperator={(operator) => updateLine(lineIndex, { operator })}
            onDimension={(dimension) => updateLine(lineIndex, { dimension, values: [] })}
            onValues={(values) => updateLine(lineIndex, { values })}
            onMove={(delta) => onChange({ ...group, lines: moved(group.lines, lineIndex, delta) })}
            onRemove={() => onChange({
              ...group,
              lines: group.lines.filter((_, position) => position !== lineIndex),
            })}
          />
        ))}
      </ul>

      <button
        type="button"
        className="text-button aud-add-line"
        disabled={disabled}
        onClick={() => onChange({ ...group, lines: [...group.lines, newLine()] })}
      >
        <Plus aria-hidden="true" /> {t('audience_add_condition')}
      </button>
    </motion.li>
  );
};

/** "Would this employee see it?" — asks the engine about the SAVED rule. */
const RuleTester = ({ entityType, entityId, disabled }) => {
  const { t, lang } = useLanguage();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [status, setStatus] = useState({ busy: false, tone: '', message: '' });
  const searchId = useId();
  const available = Boolean(entityType && entityId);

  useEffect(() => {
    if (!available || chosen) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchEmployees(query).then(({ data }) => {
        if (!cancelled) setMatches((data || []).slice(0, 8));
      });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, chosen, available]);

  const run = async () => {
    if (!chosen) {
      setStatus({ busy: false, tone: 'error', message: t('audience_test_needs_employee') });
      return;
    }
    setStatus({ busy: true, tone: '', message: t('audience_test_running') });
    const name = pickLocalized(chosen, 'name', lang) || chosen.hint || '';
    const { data, error } = await testRule(entityType, entityId, chosen.value_id);
    if (error) {
      setStatus({ busy: false, tone: 'error', message: audienceErrorMessage(t, error) });
      return;
    }
    setStatus({
      busy: false,
      tone: data ? 'ok' : 'warn',
      message: t(data ? 'audience_test_yes' : 'audience_test_no', { name }),
    });
  };

  return (
    <section className="aud-tester">
      <header className="aud-tester-head">
        <span className="aud-group-icon" aria-hidden="true"><UserCheck /></span>
        <div className="aud-group-title">
          <b>{t('audience_test_title')}</b>
          <small>{t(available ? 'audience_test_help' : 'audience_test_needs_save')}</small>
        </div>
      </header>

      {available && (
        <div className="aud-tester-body">
          {chosen ? (
            <div className="aud-tester-chosen">
              <b>{pickLocalized(chosen, 'name', lang) || chosen.hint}</b>
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => { setChosen(null); setQuery(''); setStatus({ busy: false, tone: '', message: '' }); }}
              >
                {t('audience_test_clear')}
              </button>
            </div>
          ) : (
            <div className="aud-tester-search">
              <div className="aud-panel-search">
                <Search aria-hidden="true" />
                <label className="sr-only" htmlFor={searchId}>{t('audience_test_search')}</label>
                <input
                  id={searchId}
                  type="search"
                  className="aud-panel-input"
                  placeholder={t('audience_test_search')}
                  value={query}
                  disabled={disabled}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {matches.length > 0 && (
                <ul className="aud-tester-matches">
                  {matches.map((option) => (
                    <li key={option.key}>
                      <button type="button" disabled={disabled} onClick={() => setChosen(option)}>
                        <span>{pickLocalized(option, 'name', lang)}</span>
                        {option.hint && <small>{option.hint}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            type="button"
            className="secondary-button aud-tester-run"
            disabled={disabled || status.busy}
            onClick={run}
          >
            <Check aria-hidden="true" /> {t('audience_test_run')}
          </button>
        </div>
      )}

      <p className={`aud-tester-status${status.tone ? ` is-${status.tone}` : ''}`} aria-live="polite">
        {status.message}
      </p>
    </section>
  );
};

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/**
 * @param {object}   props
 * @param {string}   props.entityType  one of AUDIENCE_ENTITY_TYPES
 * @param {string}   [props.entityId]  the saved record; enables the rule tester
 * @param {object}   [props.value]     the rule object being edited
 * @param {Function} props.onChange    receives the next rule object
 * @param {boolean}  [props.disabled]
 */
const AudiencePicker = ({ entityType, entityId = null, value = null, onChange, disabled = false }) => {
  const { t } = useLanguage();
  const [editor, setEditor] = useState(() => editorFromRule(value));
  const emitted = useRef(JSON.stringify(normalizeRule(value)));

  // Re-read the incoming rule only when it is genuinely different from the one
  // this component last emitted, so an echoing parent never resets the editor.
  useEffect(() => {
    const incoming = JSON.stringify(normalizeRule(value));
    if (incoming === emitted.current) return;
    emitted.current = incoming;
    setEditor(editorFromRule(value));
  }, [value]);

  const apply = useCallback((next) => {
    setEditor(next);
    const rule = ruleFromEditor(next);
    emitted.current = JSON.stringify(normalizeRule(rule));
    if (typeof onChange === 'function') onChange(rule);
  }, [onChange]);

  const liveRule = useMemo(() => ruleFromEditor(editor), [editor]);

  const setEveryone = (checked) => apply({
    ...editor,
    is_everyone: checked,
    groups: checked || editor.groups.length ? editor.groups : [newGroup()],
  });

  const setGroups = (groups) => apply({ ...editor, groups });

  return (
    <section className="aud-picker" aria-label={t('audience_title')}>
      <header className="aud-head">
        <div>
          <span className="section-kicker">{t('audience_section_rules')}</span>
          <h3>{t('audience_title')}</h3>
          <p className="field-note">{t('audience_intro')}</p>
        </div>
      </header>

      <EveryoneSwitch checked={editor.is_everyone} disabled={disabled} onChange={setEveryone} />

      {!editor.is_everyone && (
        <div className="aud-body">
          <MatchModeControl
            mode={editor.match_mode}
            disabled={disabled}
            onChange={(match_mode) => apply({ ...editor, match_mode })}
          />

          {editor.groups.length === 0 ? (
            <p className="aud-empty">
              <CircleSlash aria-hidden="true" /> {t('audience_no_groups')}
            </p>
          ) : (
            <ul className="aud-groups">
              {editor.groups.map((group, index) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  index={index}
                  total={editor.groups.length}
                  disabled={disabled}
                  onChange={(nextGroup) => setGroups(editor.groups.map((item, position) => (
                    position === index ? nextGroup : item
                  )))}
                  onMove={(delta) => setGroups(moved(editor.groups, index, delta))}
                  onRemove={() => setGroups(editor.groups.filter((_, position) => position !== index))}
                />
              ))}
            </ul>
          )}

          <button
            type="button"
            className="secondary-button aud-add-group"
            disabled={disabled}
            onClick={() => setGroups([...editor.groups, newGroup()])}
          >
            <Plus aria-hidden="true" /> {t('audience_add_group')}
          </button>
        </div>
      )}

      <div className="aud-summary-block">
        <span className="aud-summary-label">{t('audience_summary_label')}</span>
        <AudienceSummary value={liveRule} />
      </div>

      <RuleTester entityType={entityType} entityId={entityId} disabled={disabled} />
    </section>
  );
};

export default AudiencePicker;
