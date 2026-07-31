import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, BriefcaseBusiness, CheckCircle2, ClipboardList,
  FileText, Goal, Library, LockKeyhole, Paperclip, Plus, Printer, Save, Search, Send, StickyNote, Trash2, X
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { deleteDraftForm, loadFormWorkspace, saveInternalMemo, savePerformanceEvaluation } from '../data/formsService';
import { FormDocumentFooter, FormDocumentHeader } from './FormDocumentChrome';
import { ApprovalChainSection, SendApprovalModal } from './ApprovalChain';

// Content is frozen once the request enters the chain — people have signed it.
// Routing stays open: an approved request can still be sent to further
// approvers (a second or third holder of the same role, or an extra role).
const APPROVAL_LOCKED_STATUSES = ['InApproval', 'Approved'];
const canSendStatus = (form, userId) => (
  ['Draft', 'Submitted', 'Returned', 'Rejected'].includes(form.status)
  || (['InApproval', 'Approved'].includes(form.status) && form.current_assignee_id === userId)
);

const cycles = [
  { id: 'annual-2026', code: 'APR-2026', name: 'التقييم السنوي 2026', start: '2026-01-01', end: '2026-12-31', active: true, objectives_weight: 60, competencies_weight: 40 },
  { id: 'probation-2026', code: 'PROB-2026', name: 'تقييم فترة التجربة 2026', start: '2026-01-01', end: '2026-12-31', active: true, objectives_weight: 50, competencies_weight: 50 },
];

const fallbackGoals = [
  { id: 'goal-sla', code: 'OPS-001', category: 'تشغيلي', goal: 'رفع الالتزام بمستوى الخدمة', measurement: 'نسبة الالتزام SLA', default_weight: 25 },
  { id: 'goal-cost', code: 'FIN-001', category: 'مالي', goal: 'خفض تكلفة التشغيل', measurement: 'نسبة الخفض المحققة', default_weight: 20 },
  { id: 'goal-safety', code: 'SAF-001', category: 'السلامة', goal: 'تحسين الامتثال للسلامة', measurement: 'نسبة الامتثال', default_weight: 25 },
  { id: 'goal-quality', code: 'QUA-001', category: 'الجودة', goal: 'رفع جودة الخدمة', measurement: 'نتيجة تدقيق الجودة', default_weight: 20 },
];

const fallbackCompetencies = [
  { id: 'comp-communication', code: 'CORE-001', category: 'أساسية', parent: 'التواصل', name: 'التواصل الفعال', description: 'نقل واستقبال المعلومات بوضوح واحترافية.' },
  { id: 'comp-teamwork', code: 'CORE-002', category: 'أساسية', parent: 'التعاون', name: 'العمل الجماعي', description: 'التعاون مع الآخرين لتحقيق أهداف مشتركة.' },
  { id: 'comp-service', code: 'CORE-003', category: 'أساسية', parent: 'خدمة المستفيد', name: 'خدمة العملاء الداخليين', description: 'تقديم خدمة عالية الجودة للإدارات والزملاء.' },
  { id: 'comp-planning', code: 'CORE-004', category: 'أساسية', parent: 'التنفيذ', name: 'التخطيط والتنظيم', description: 'تنظيم العمل والأولويات والمواعيد بفعالية.' },
];

const blankForm = (profile) => ({
  id: null,
  status: 'Draft',
  reference: `EV-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`,
  submission_mode: 'Self',
  evaluation_type: 'Cycle',
  cycle_id: '',
  cycle_name: '',
  start_date: '',
  end_date: '',
  evaluation_date: new Date().toISOString().slice(0, 10),
  evaluator_name: profile?.full_name || profile?.name_ar || '',
  evaluator_signature_url: profile?.signature_url || '',
  reviewer_name: '',
  director_name: '',
  objectives_weight: 60,
  competencies_weight: 40,
  overall_comment: '',
  employee: profile,
  goals: [],
  competencies: [],
});

const blankMemo = (profile) => ({
  id: null,
  status: 'Draft',
  reference: `MEM-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`,
  submission_mode: 'Self',
  employee: profile,
  memo_title: '',
  memo_date: new Date().toISOString().slice(0, 10),
  memo_number: '',
  from: profile?.department || '',
  to: '',
  cc: '',
  subject: '',
  request: '',
  justification: '',
  recommendation: '',
  requester_name: profile?.full_name || profile?.name_ar || '',
  requester_signature_url: profile?.signature_url || '',
  recommended_by: '',
  approved_by: '',
  attachments: [],
});

const clampScore = (target, actual) => {
  const targetValue = Number(target);
  const actualValue = Number(actual);
  if (!targetValue || actual === '') return 0;
  return Math.min(5, Math.max(0, (actualValue / targetValue) * 5));
};

const enrichRows = (rows, scoreResolver) => {
  const totalPriority = rows.reduce((sum, row) => sum + Number(row.priority || 0), 0);
  return rows.map((row) => {
    const relativeWeight = totalPriority ? (Number(row.priority || 0) / totalPriority) * 100 : 0;
    const score = scoreResolver(row);
    return { ...row, relativeWeight, score, weighted: (relativeWeight * score) / 100 };
  });
};

const assessmentLabel = (score, t) => {
  if (score >= 4.5) return t('assessment_outstanding');
  if (score >= 3.5) return t('assessment_very_good');
  if (score >= 2.5) return t('assessment_good');
  if (score >= 1.5) return t('assessment_needs_improvement');
  if (score >= 0.1) return t('assessment_below_expectations');
  return t('assessment_incomplete');
};

const FormsPortal = () => {
  const { profile } = useAuth();
  const { t, lang } = useLanguage();
  const [view, setView] = useState('catalog');
  const [workspace, setWorkspace] = useState({ templates: [], goals: fallbackGoals, competencies: fallbackCompetencies, cycles: [], forms: [], employees: [profile] });
  const [form, setForm] = useState(() => blankForm(profile));
  const [memo, setMemo] = useState(() => blankMemo(profile));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('All');
  const [sendTarget, setSendTarget] = useState(null);
  const [chainRefresh, setChainRefresh] = useState(0);

  const refresh = async () => {
    try {
      const data = await loadFormWorkspace(profile.id);
      setWorkspace({
        ...data,
        goals: data.goals?.length ? data.goals : fallbackGoals,
        competencies: data.competencies?.length ? data.competencies : fallbackCompetencies,
      });
    } catch (error) {
      setMessage(error.message);
    }
  };

  useEffect(() => {
    let cancelled = false;
    loadFormWorkspace(profile.id)
      .then((data) => {
        if (!cancelled) {
          setWorkspace({
            ...data,
            goals: data.goals?.length ? data.goals : fallbackGoals,
            competencies: data.competencies?.length ? data.competencies : fallbackCompetencies,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error.message);
      });
    return () => { cancelled = true; };
  }, [profile.id]);

  const computedGoals = useMemo(() => enrichRows(form.goals, (row) => clampScore(row.target, row.actual)), [form.goals]);
  const computedCompetencies = useMemo(() => enrichRows(form.competencies, (row) => Number(row.score || 0)), [form.competencies]);
  const availableCycles = workspace.cycles?.length
    ? workspace.cycles.map((cycle) => ({
        id: cycle.id,
        code: cycle.code,
        name: (lang === 'ar' || lang === 'ur') ? cycle.name_ar : cycle.name_en || cycle.name_ar,
        start: cycle.start_date,
        end: cycle.end_date,
        active: cycle.is_active && cycle.status === 'Active',
        objectives_weight: 60,
        competencies_weight: 40,
      }))
    : cycles;
  const objectiveScore = computedGoals.reduce((sum, row) => sum + row.weighted, 0);
  const competencyScore = computedCompetencies.reduce((sum, row) => sum + row.weighted, 0);
  const overallScore = ((objectiveScore * Number(form.objectives_weight || 0)) + (competencyScore * Number(form.competencies_weight || 0))) / 100;

  const selectCycle = (cycleId) => {
    const cycle = availableCycles.find((item) => item.id === cycleId);
    setForm((current) => ({
      ...current,
      cycle_id: cycle?.id || '',
      cycle_name: cycle?.name || '',
      start_date: cycle?.start || '',
      end_date: cycle?.end || '',
      objectives_weight: cycle?.objectives_weight ?? current.objectives_weight,
      competencies_weight: cycle?.competencies_weight ?? current.competencies_weight,
    }));
  };

  const setEvaluationType = (evaluationType) => {
    setForm((current) => ({
      ...current,
      evaluation_type: evaluationType,
      cycle_id: '',
      cycle_name: '',
      start_date: '',
      end_date: '',
      objectives_weight: evaluationType === 'Cycle' ? current.objectives_weight : 60,
      competencies_weight: evaluationType === 'Cycle' ? current.competencies_weight : 40,
    }));
  };

  const setSubmissionMode = (submissionMode) => {
    setForm((current) => ({
      ...current,
      submission_mode: submissionMode,
      employee: submissionMode === 'Self' ? profile : null,
    }));
  };

  const selectBeneficiary = (employeeId) => {
    const employee = workspace.employees.find((item) => item.id === employeeId);
    setForm((current) => ({ ...current, employee: employee || null }));
  };

  const startEvaluation = () => {
    setForm(blankForm(profile));
    setView('editor');
    setMessage('');
  };
  const startMemo = () => {
    setMemo(blankMemo(profile));
    setView('memo');
    setMessage('');
  };

  const addGoal = (goalId) => {
    const goal = workspace.goals.find((item) => item.id === goalId);
    if (!goal || form.goals.some((row) => row.goal_id === goal.id)) return;
    const useArabic = lang === 'ar' || lang === 'ur';
    const title = useArabic
      ? goal.title_ar || goal.name_ar || goal.goal || goal.title
      : goal.title_en || goal.name_en || goal.goal || goal.title;
    const measurement = useArabic
      ? goal.measurement_unit_ar || goal.measurement_ar || goal.measurement
      : goal.measurement_unit_en || goal.measurement_en || goal.measurement;
    setForm((current) => ({
      ...current,
      goals: [...current.goals, {
        goal_id: goal.id,
        code: goal.code,
        title,
        measurement: measurement || t('achievement_rate'),
        priority: 3,
        target: 100,
        actual: '',
        comments: '',
      }],
    }));
  };

  const addCompetency = (competencyId) => {
    const competency = workspace.competencies.find((item) => item.id === competencyId);
    if (!competency || form.competencies.some((row) => row.competency_id === competency.id)) return;
    const useArabic = lang === 'ar' || lang === 'ur';
    const title = useArabic
      ? competency.name_ar || competency.title_ar || competency.name || competency.title
      : competency.name_en || competency.title_en || competency.name || competency.title;
    const parent = useArabic
      ? competency.parent_name_ar || competency.category_ar || competency.parent || competency.category
      : competency.parent_name_en || competency.category_en || competency.parent || competency.category;
    setForm((current) => ({
      ...current,
      competencies: [...current.competencies, {
        competency_id: competency.id,
        code: competency.code,
        parent,
        title,
        priority: 3,
        score: 3,
        comments: '',
      }],
    }));
  };

  const updateRow = (group, index, key, value) => setForm((current) => ({ ...current, [group]: current[group].map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row) }));
  const removeRow = (group, index) => setForm((current) => ({ ...current, [group]: current[group].filter((_, rowIndex) => rowIndex !== index) }));

  const save = async (status) => {
    if (!form.employee?.id) {
      setMessage(t('validation_select_employee'));
      return;
    }
    if (form.cycle_id && workspace.forms.some((item) => item.id !== form.id && item.data_json?.cycle_id === form.cycle_id && item.data_json?.employee?.id === form.employee.id)) {
      setMessage(t('validation_duplicate_cycle'));
      return;
    }
    const periodIsInvalid = form.evaluation_type === 'Cycle'
      ? !form.cycle_id
      : !form.start_date || !form.end_date || form.end_date < form.start_date;
    const weightsAreInvalid = Number(form.objectives_weight) + Number(form.competencies_weight) !== 100;
    if (status === 'Submitted' && (periodIsInvalid || weightsAreInvalid || !form.goals.length || !form.competencies.length || computedGoals.some((row) => row.score <= 0))) {
      setMessage(t('validation_evaluation_submit'));
      return;
    }
    setBusy(true);
    try {
      await savePerformanceEvaluation({
        profile,
        template: workspace.templates.find((item) => item.code === 'FM-SH-PER-O-24-0053\\V1.3' || item.code === 'PERFORMANCE') || {
          id: 'performance',
          code: 'FM-SH-PER-O-24-0053\\V1.3',
          name: t('performance_review'),
        },
        status,
        form: { ...form, overall_score: overallScore, overall_rate: assessmentLabel(overallScore, t) },
        selectedGoals: computedGoals,
        selectedCompetencies: computedCompetencies,
      });
      await refresh();
      window.dispatchEvent(new Event('shalfa-forms-updated'));
      setMessage(status === 'Draft' ? t('draft_saved') : t('form_submitted'));
      setView('mine');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const openSaved = (saved) => {
    const data = saved.data_json || {};
    if (data.form_type === 'INTERNAL_MEMO' || saved.templates?.code === 'FM-SH-INM-R-23-0025\\V1.2') {
      setMemo({
        ...blankMemo(profile),
        ...data,
        id: saved.id,
        status: saved.status,
        template_id: saved.template_id,
        verify_code: saved.verify_code || null,
        current_assignee_id: saved.current_assignee_id || null,
        reference: data.reference || saved.reference_no || saved.id.slice(0, 8),
        requester_signature_url: data.requester_signature_url || profile?.signature_url || '',
        attachments: data.attachments || [],
      });
      setView('memo');
      return;
    }
    setForm({
      ...blankForm(profile),
      ...data,
      id: saved.id,
      status: saved.status,
      template_id: saved.template_id,
      verify_code: saved.verify_code || null,
      current_assignee_id: saved.current_assignee_id || null,
      reference: data.reference || saved.reference_no || saved.id.slice(0, 8),
      goals: data.goals || [],
      competencies: data.competencies || [],
      evaluator_signature_url: data.evaluator_signature_url || profile?.signature_url || '',
    });
    setView('editor');
  };

  const saveMemo = async (status) => {
    if (!memo.employee?.id || !memo.memo_title || !memo.to || !memo.subject || !memo.request) {
      setMessage(t('validation_internal_memo'));
      return;
    }
    const template = workspace.templates.find((item) => item.code === 'FM-SH-INM-R-23-0025\\V1.2') || {
      id: 'internal-memo',
      code: 'FM-SH-INM-R-23-0025\\V1.2',
      name: t('internal_memo_form'),
    };
    setBusy(true);
    try {
      await saveInternalMemo({ profile, template, status, memo });
      await refresh();
      window.dispatchEvent(new Event('shalfa-forms-updated'));
      setMessage(status === 'Draft' ? t('draft_saved') : t('saved_successfully'));
      setView('mine');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const visibleForms = workspace.forms.filter((item) => filter === 'All' || item.status === filter);

  const resolveTemplateId = (codes, fallbackTemplateId) => (
    fallbackTemplateId
    || workspace.templates.find((item) => codes.includes(item.code))?.id
    || null
  );

  const openSend = (formId, templateId) => {
    if (!formId || !templateId) {
      setMessage(t('save_before_send'));
      return;
    }
    setSendTarget({ formId, templateId });
  };

  return (
    <main className="forms-page app-main">
      <div className="forms-heading no-print">
        <div><span className="section-kicker">{t('employee_services')}</span><h1>{t('forms')}</h1><p>{t('forms_intro')}</p></div>
      </div>
      <div className="forms-workspace">
        <aside className="forms-sidebar no-print">
          <button className={view === 'catalog' ? 'active' : ''} onClick={() => setView('catalog')}><Library /><span><b>{t('choose_form')}</b><small>{t('start_new_request')}</small></span></button>
          <button className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')}><ClipboardList /><span><b>{t('my_requests')}</b><small>{t('saved_requests', { count: workspace.forms.length })}</small></span></button>
        </aside>

        <section className="forms-content">
          {message && <div className="inline-message no-print"><CheckCircle2 />{message}<button onClick={() => setMessage('')}><X /></button></div>}
          {view === 'catalog' && <Catalog onStartEvaluation={startEvaluation} onStartMemo={startMemo} />}
          {view === 'mine' && <MyForms forms={visibleForms} filter={filter} setFilter={setFilter} onOpen={openSaved} onSend={(item) => openSend(item.id, item.template_id)} canSend={(item) => canSendStatus(item, profile.id)} onDelete={async (id) => { await deleteDraftForm(id); refresh(); }} />}
          {view === 'editor' && (
            <EvaluationForm
              form={form} setForm={setForm} cycles={availableCycles} selectCycle={selectCycle}
              setEvaluationType={setEvaluationType} employees={workspace.employees}
              setSubmissionMode={setSubmissionMode} selectBeneficiary={selectBeneficiary}
              goals={workspace.goals} competencies={workspace.competencies}
              addGoal={addGoal} addCompetency={addCompetency}
              computedGoals={computedGoals} computedCompetencies={computedCompetencies}
              updateRow={updateRow} removeRow={removeRow}
              objectiveScore={objectiveScore} competencyScore={competencyScore}
              overallScore={overallScore} save={save} busy={busy}
              chainRefresh={chainRefresh}
              onSendForApproval={() => openSend(form.id, resolveTemplateId(['FM-SH-PER-O-24-0053\\V1.3', 'PERFORMANCE'], form.template_id))}
            />
          )}
          {view === 'memo' && (
            <InternalMemoForm
              memo={memo} setMemo={setMemo} employees={workspace.employees} save={saveMemo} busy={busy}
              chainRefresh={chainRefresh}
              onSendForApproval={() => openSend(memo.id, resolveTemplateId(['FM-SH-INM-R-23-0025\\V1.2', 'INTERNAL_MEMO'], memo.template_id))}
            />
          )}
        </section>
      </div>
      {sendTarget && (
        <SendApprovalModal
          formId={sendTarget.formId}
          templateId={sendTarget.templateId}
          currentUserId={profile?.id}
          onClose={() => setSendTarget(null)}
          onSent={async () => {
            setSendTarget(null);
            setMessage(t('request_sent'));
            setChainRefresh((value) => value + 1);
            await refresh();
            setView('mine');
          }}
        />
      )}
    </main>
  );
};

const Catalog = ({ onStartEvaluation, onStartMemo }) => {
  const { t } = useLanguage();
  const templates = [
    { icon: Goal, title: t('performance_review'), category: t('performance_management'), description: t('performance_review_desc'), available: true, count: t('active_cycles'), onStart: onStartEvaluation },
    { icon: StickyNote, title: t('internal_memo_form'), category: t('organization_development'), description: t('internal_memo_desc'), available: true, count: t('available_now'), onStart: onStartMemo },
    { icon: BriefcaseBusiness, title: t('business_trip_request'), category: t('administrative'), description: t('business_trip_desc'), available: false, count: t('coming_soon') },
    { icon: FileText, title: t('certificate_request'), category: t('human_resources'), description: t('certificate_request_desc'), available: false, count: t('coming_soon') },
  ];
  return <div><div className="catalog-tools"><div className="search-control"><Search /><input placeholder={t('search_forms')} /></div><div className="segmented"><button className="active">{t('all')}</button><button>{t('human_resources')}</button><button>{t('administrative')}</button></div></div><div className="template-grid">{templates.map(({ icon: Icon, title, category, description, available, count, onStart }) => <article key={title} className={!available ? 'disabled' : 'clickable'} role={available ? 'button' : undefined} tabIndex={available ? 0 : undefined} onClick={available ? onStart : undefined} onKeyDown={available ? (event) => { if (event.key === 'Enter' || event.key === ' ') onStart(); } : undefined}><div className="template-icon"><Icon /></div><span>{category}</span><h2>{title}</h2><p>{description}</p><div><small>{count}</small><button disabled={!available} onClick={(event) => { event.stopPropagation(); if (available) onStart(); }}>{available ? t('start_form') : t('unavailable')}</button></div></article>)}</div></div>;
};

const MyForms = ({ forms, filter, setFilter, onOpen, onSend, canSend, onDelete }) => {
  const { t, locale } = useLanguage();
  const filters = [['All', t('all')], ['Draft', t('drafts')], ['InApproval', t('status_in_approval')], ['Approved', t('status_approved')], ['Rejected', t('status_rejected')], ['Submitted', t('submitted_requests')], ['Returned', t('returned')], ['Cancelled', t('cancelled')]];
  return <div><div className="list-toolbar"><div className="segmented">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="search-control compact"><Search /><input placeholder={t('search_reference')} /></div></div><div className="data-table-wrap"><table className="enterprise-table"><thead><tr><th>{t('forms')}</th><th>{t('cycle')}</th><th>{t('last_updated')}</th><th>{t('score')}</th><th>{t('status')}</th><th /></tr></thead><tbody>{forms.map((item) => { const isMemo = item.data_json?.form_type === 'INTERNAL_MEMO' || item.templates?.code === 'FM-SH-INM-R-23-0025\\V1.2'; return <tr key={item.id}><td><div className="form-name-cell"><FileText /><div><b>{isMemo ? t('internal_memo_form') : t('performance_review')}</b><small>{item.data_json?.reference || item.id.slice(0, 8)}</small></div></div></td><td>{isMemo ? item.data_json?.memo_title || t('internal_memo') : item.data_json?.cycle_name || t('independent_review')}</td><td>{new Date(item.updated_on).toLocaleDateString(locale)}</td><td>{isMemo ? '—' : item.data_json?.overall_score?.toFixed?.(2) || item.performance_evaluations?.[0]?.overall_score || '—'}</td><td><Status status={item.status} /></td><td><div className="table-actions"><button onClick={() => onOpen(item)} title={t('open')}><ArrowRight /></button>{canSend(item) && <button className="approve-action" onClick={() => onSend(item)} title={t('send_for_approval')}><Send /></button>}<button onClick={() => { onOpen(item); setTimeout(() => window.print(), 100); }} title={t('print')}><Printer /></button>{item.status === 'Draft' && <button className="danger" onClick={() => onDelete(item.id)} title={t('delete')}><Trash2 /></button>}</div></td></tr>; })}{!forms.length && <tr><td colSpan="6"><div className="empty-table"><ClipboardList /><b>{t('no_matching_requests')}</b><span>{t('saved_forms_appear_here')}</span></div></td></tr>}</tbody></table></div></div>;
};

const Status = ({ status }) => {
  const { t } = useLanguage();
  const map = {
    Draft: [t('draft'), 'draft'], Submitted: [t('submitted'), 'submitted'], Returned: [t('returned'), 'returned'], Cancelled: [t('cancelled'), 'closed'],
    InApproval: [t('status_in_approval'), 'submitted'], Approved: [t('status_approved'), 'approved'], Rejected: [t('status_rejected'), 'rejected'],
  };
  const [label, tone] = map[status] || [status, 'draft'];
  return <span className={`status-badge status-${tone}`}>{label}</span>;
};

const ApprovalLockBanner = ({ status }) => {
  const { t } = useLanguage();
  if (!APPROVAL_LOCKED_STATUSES.includes(status)) return null;
  return (
    <div className="inline-message approval-lock no-print">
      <LockKeyhole />
      {status === 'Approved' ? t('form_locked_approved') : t('form_locked_in_approval')}
    </div>
  );
};

const InternalMemoForm = ({ memo, setMemo, employees, save, busy, chainRefresh, onSendForApproval }) => {
  const { profile } = useAuth();
  const { t, lang, locale } = useLanguage();
  const employeeName = (employee) => (
    lang === 'en' || lang === 'hi' || lang === 'tl'
      ? employee?.name_en || employee?.full_name
      : employee?.name_ar || employee?.full_name
  );
  const field = (key) => (event) => setMemo({ ...memo, [key]: event.target.value });
  const setSubmissionMode = (mode) => setMemo((current) => ({
    ...current,
    submission_mode: mode,
    employee: mode === 'Self' ? profile : null,
    requester_name: mode === 'Self' ? profile?.full_name || profile?.name_ar || '' : '',
    requester_signature_url: mode === 'Self' ? profile?.signature_url || '' : '',
  }));
  const selectBeneficiary = (id) => {
    const employee = employees.find((item) => item.id === id);
    setMemo((current) => ({ ...current, employee: employee || null }));
  };
  const addAttachments = (files) => setMemo((current) => ({
    ...current,
    attachments: [...current.attachments, ...Array.from(files || [])].slice(0, 10),
  }));
  const locked = APPROVAL_LOCKED_STATUSES.includes(memo.status);
  const sendable = canSendStatus({ status: memo.status, current_assignee_id: memo.current_assignee_id }, profile?.id);
  return <article className="evaluation-document memo-document print-area">
    <FormDocumentHeader title={t('internal_memo_form')} code="FM-SH-INM-R-23-0025\V1.2" reference={memo.reference} verifyCode={memo.verify_code} />
    <ApprovalLockBanner status={memo.status} />
    <SubmissionScope form={memo} employees={employees} employeeName={employeeName} setSubmissionMode={setSubmissionMode} selectBeneficiary={selectBeneficiary} />
    <section className="evaluation-section">
      <SectionTitle number="01" title={t('memo_information')} />
      <div className="memo-form-grid">
        <label className="field-label field-span-2">{t('memo_title')}<input required className="form-input" value={memo.memo_title} onChange={field('memo_title')} /></label>
        <label className="field-label">{t('date')}<input type="date" className="form-input" value={memo.memo_date} onChange={field('memo_date')} /></label>
        <label className="field-label">{t('internal_memo_number')}<input className="form-input" value={memo.memo_number} onChange={field('memo_number')} /></label>
        <label className="field-label">{t('from')}<input className="form-input" value={memo.from} onChange={field('from')} /></label>
        <label className="field-label">{t('to')}<input required className="form-input" value={memo.to} onChange={field('to')} /></label>
        <label className="field-label field-span-2">{t('cc')}<input className="form-input" value={memo.cc} onChange={field('cc')} /></label>
        <label className="field-label field-span-2">{t('subject')}<input required className="form-input" value={memo.subject} onChange={field('subject')} /></label>
      </div>
    </section>
    <section className="evaluation-section">
      <SectionTitle number="02" title={t('request_data')} />
      <div className="memo-text-fields">
        <label className="field-label">{t('request')}<textarea required className="form-input" value={memo.request} onChange={field('request')} /></label>
        <label className="field-label">{t('justification')}<textarea className="form-input" value={memo.justification} onChange={field('justification')} /></label>
        <label className="field-label">{t('recommendation')}<textarea className="form-input" value={memo.recommendation} onChange={field('recommendation')} /></label>
      </div>
    </section>
    <section className="evaluation-section memo-attachments">
      <SectionTitle number="03" title={t('attachments')} />
      <label className="attachment-picker no-print"><Paperclip /> {t('choose_attachments')}<input hidden type="file" multiple onChange={(event) => { addAttachments(event.target.files); event.target.value = ''; }} /></label>
      <div className="attachment-list">{memo.attachments.map((file, index) => <div key={`${file.name}-${index}`}><Paperclip /><span>{file.name}</span><small>{file.size ? `${Math.ceil(file.size / 1024)} KB` : ''}</small><button type="button" className="no-print" onClick={() => setMemo({ ...memo, attachments: memo.attachments.filter((_, itemIndex) => itemIndex !== index) })}><X /></button></div>)}</div>
    </section>
    <section className="workflow-signatures">
      <div className="signature-box"><b>{t('requested_by')}</b><input value={memo.requester_name} onChange={field('requester_name')} placeholder={t('name')} />{memo.requester_signature_url && <img className="form-signature-image" src={memo.requester_signature_url} alt={t('signature')} />}<span>{t('date')}</span></div>
      <div className="signature-box"><b>{t('recommended')}</b><input value={memo.recommended_by} onChange={field('recommended_by')} placeholder={t('name')} /><span>{t('signature')} · {t('date')}</span></div>
      <div className="signature-box"><b>{t('approval')}</b><input value={memo.approved_by} onChange={field('approved_by')} placeholder={t('name')} /><span>{t('signature')} · {t('date')}</span></div>
    </section>
    <ApprovalChainSection formId={memo.id} refreshToken={chainRefresh} />
    <FormDocumentFooter title={t('internal_memo_form')} generatedLabel={t('generated_on')} generatedDate={new Date().toLocaleDateString(locale)} printedByLabel={t('printed_by')} printedBy={profile?.full_name || profile?.full_name_ar || profile?.email} pageLabel={t('page')} />
    <div className="evaluation-actions no-print">
      <div><button className="secondary-button" onClick={() => window.print()}><Printer /> {t('preview_print')}</button></div>
      <div>
        {!locked && <button disabled={busy} className="secondary-button" onClick={() => save('Draft')}><Save /> {t('save_draft')}</button>}
        {!locked && <button disabled={busy} className="primary-button" onClick={() => save('Submitted')}><Save /> {t('save')}</button>}
        {memo.id && sendable && <button disabled={busy} className="primary-button" onClick={onSendForApproval}><Send /> {t(locked ? 'send_additional_approval' : 'send_for_approval')}</button>}
      </div>
    </div>
  </article>;
};

const EvaluationForm = ({
  form, setForm, cycles: cycleOptions, selectCycle, setEvaluationType, employees,
  setSubmissionMode, selectBeneficiary, goals, competencies, addGoal, addCompetency,
  computedGoals, computedCompetencies, updateRow, removeRow, objectiveScore,
  competencyScore, overallScore, save, busy, chainRefresh, onSendForApproval,
}) => {
  const { t, lang, locale } = useLanguage();
  const { profile } = useAuth();
  const isCycle = form.evaluation_type === 'Cycle';
  const locked = APPROVAL_LOCKED_STATUSES.includes(form.status);
  const sendable = canSendStatus({ status: form.status, current_assignee_id: form.current_assignee_id }, profile?.id);
  const employeeName = (employee) => (
    lang === 'en' || lang === 'hi' || lang === 'tl'
      ? employee?.name_en || employee?.full_name
      : employee?.name_ar || employee?.full_name
  );
  const updateWeight = (key, value) => {
    const next = Math.min(100, Math.max(0, Number(value)));
    setForm({ ...form, [key]: next });
  };

  return (
    <article className="evaluation-document print-area">
      <FormDocumentHeader moduleName={t('performance_management')} title={t('employee_performance_evaluation')} code="FM-SH-PER-O-24-0053\V1.3" reference={form.reference} verifyCode={form.verify_code} />
      <ApprovalLockBanner status={form.status} />

      <SubmissionScope
        form={form}
        employees={employees}
        employeeName={employeeName}
        setSubmissionMode={setSubmissionMode}
        selectBeneficiary={selectBeneficiary}
      />

      <section className="evaluation-section">
        <SectionTitle number="01" title={t('employee_data_period')} />
        <div className="employee-info-grid">
          <Info label={t('employee_number')} value={form.employee?.employee_no} />
          <Info label={t('name')} value={employeeName(form.employee)} wide />
          <Info label={t('nationality')} value={form.employee?.nationality} />
          <Info label={t('job_title')} value={form.employee?.job_title} />
          <Info label={t('gender')} value={form.employee?.gender} />
          <Info label={t('national_id')} value={form.employee?.national_id} />
          <Info label={t('project')} value={form.employee?.project} />
          <Info label={t('sector')} value={form.employee?.sector} />
          <Info label={t('site')} value={form.employee?.site} />
          <Info label={t('department')} value={form.employee?.department} />
        </div>
        <div className="cycle-grid no-print">
          <label className="field-label">{t('evaluation_type')}
            <select className="form-input" value={form.evaluation_type} onChange={(event) => setEvaluationType(event.target.value)}>
              <option value="Cycle">{t('cycle_based')}</option>
              <option value="Independent">{t('independent_evaluation')}</option>
            </select>
          </label>
          <label className="field-label">{t('evaluation_cycle')}
            <select className={`form-input ${!isCycle ? 'readonly' : ''}`} disabled={!isCycle} value={form.cycle_id} onChange={(event) => selectCycle(event.target.value)}>
              <option value="">{t('select_evaluation_cycle')}</option>
              {cycleOptions.filter((cycle) => cycle.active).map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
            </select>
          </label>
          <label className="field-label">{t('starting_from')}
            <input className={`form-input ${isCycle ? 'readonly' : ''}`} type="date" readOnly={isCycle} value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
          </label>
          <label className="field-label">{t('until_date')}
            <input className={`form-input ${isCycle ? 'readonly' : ''}`} type="date" readOnly={isCycle} value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
          </label>
          <label className="field-label">{t('evaluation_date')}
            <input className="form-input" type="date" value={form.evaluation_date} onChange={(event) => setForm({ ...form, evaluation_date: event.target.value })} />
          </label>
        </div>
        <div className="print-only cycle-print">
          <Info label={t('evaluation_type')} value={isCycle ? t('cycle_based') : t('independent_evaluation')} />
          <Info label={t('evaluation_cycle')} value={form.cycle_name || t('not_specified')} wide />
          <Info label={t('starting_from')} value={form.start_date} />
          <Info label={t('until_date')} value={form.end_date} />
        </div>
        <div className={`weight-policy ${!isCycle ? 'editable' : ''}`}>
          <label><span>{t('objectives_weight')}</span>{isCycle ? <b>{form.objectives_weight}%</b> : <input type="number" min="0" max="100" value={form.objectives_weight} onChange={(event) => updateWeight('objectives_weight', event.target.value)} />}</label>
          <label><span>{t('competencies_weight')}</span>{isCycle ? <b>{form.competencies_weight}%</b> : <input type="number" min="0" max="100" value={form.competencies_weight} onChange={(event) => updateWeight('competencies_weight', event.target.value)} />}</label>
          <p>{isCycle ? t('cycle_policy_weights') : t('weights_total_note')}</p>
        </div>
      </section>

      <EvaluationRows type="goals" number="02" library={goals} onAdd={addGoal} rows={computedGoals} updateRow={updateRow} removeRow={removeRow} total={objectiveScore} />
      <EvaluationRows type="competencies" number="03" library={competencies} onAdd={addCompetency} rows={computedCompetencies} updateRow={updateRow} removeRow={removeRow} total={competencyScore} />

      <section className="evaluation-summary">
        <div><span>{t('objectives_total')}</span><b>{objectiveScore.toFixed(2)}</b></div>
        <div><span>{t('competencies_total')}</span><b>{competencyScore.toFixed(2)}</b></div>
        <div className="overall-score"><span>{t('overall_estimate')}</span><b>{overallScore.toFixed(2)} / 5</b></div>
        <p>{assessmentLabel(overallScore, t)}</p>
      </section>

      <section className="evaluation-section comments-section">
        <SectionTitle number="04" title={t('overall_comments')} />
        <textarea value={form.overall_comment} onChange={(event) => setForm({ ...form, overall_comment: event.target.value })} placeholder={t('comments_placeholder')} />
      </section>
      <section className="workflow-signatures">
        <div className="signature-box">
          <b>{t('evaluator')}</b>
          <input value={form.evaluator_name} onChange={(event) => setForm({ ...form, evaluator_name: event.target.value })} placeholder={t('name')} />
          {form.evaluator_signature_url && <img className="form-signature-image" src={form.evaluator_signature_url} alt={t('signature')} />}
          <span>{t('date')}</span>
        </div>
        <div className="signature-box">
          <b>{t('recommendation')}</b>
          <input value={form.reviewer_name || ''} onChange={(event) => setForm({ ...form, reviewer_name: event.target.value })} placeholder={t('name')} />
          <span>{t('signature')} · {t('date')}</span>
        </div>
        <div className="signature-box">
          <b>{t('approval')}</b>
          <input value={form.director_name || ''} onChange={(event) => setForm({ ...form, director_name: event.target.value })} placeholder={t('name')} />
          <span>{t('signature')} · {t('date')}</span>
        </div>
      </section>

      <ApprovalChainSection formId={form.id} refreshToken={chainRefresh} />
      <FormDocumentFooter title={t('employee_performance_evaluation')} generatedLabel={t('generated_on')} generatedDate={new Date().toLocaleDateString(locale)} printedByLabel={t('printed_by')} printedBy={profile?.full_name || profile?.full_name_ar || profile?.email} pageLabel={t('page')} />
      <div className="evaluation-actions no-print">
        <div><button className="secondary-button" onClick={() => window.print()}><Printer /> {t('preview_print')}</button></div>
        <div>
          {!locked && <button disabled={busy} className="secondary-button" onClick={() => save('Draft')}><Save /> {t('save_draft')}</button>}
          {!locked && <button disabled={busy} className="primary-button" onClick={() => save('Submitted')}><Save /> {t('save')}</button>}
          {form.id && sendable && <button disabled={busy} className="primary-button" onClick={onSendForApproval}><Send /> {t(locked ? 'send_additional_approval' : 'send_for_approval')}</button>}
        </div>
      </div>
    </article>
  );
};

const SubmissionScope = ({ form, employees, employeeName, setSubmissionMode, selectBeneficiary }) => {
  const { t } = useLanguage();
  return (
    <section className="evaluation-section submission-scope no-print">
      <SectionTitle number="00" title={t('submission_scope')} />
      <div className="submission-scope-controls">
        <div className="segmented">
          <button type="button" className={form.submission_mode === 'Self' ? 'active' : ''} onClick={() => setSubmissionMode('Self')}>{t('request_for_self')}</button>
          <button type="button" className={form.submission_mode === 'OnBehalf' ? 'active' : ''} onClick={() => setSubmissionMode('OnBehalf')}>{t('request_on_behalf')}</button>
        </div>
        {form.submission_mode === 'OnBehalf' && (
          <label className="field-label">{t('select_employee')}
            <select className="form-input" value={form.employee?.id || ''} onChange={(event) => selectBeneficiary(event.target.value)}>
              <option value="">{t('select_employee_placeholder')}</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employeeName(employee)} · {employee.employee_no}</option>)}
            </select>
          </label>
        )}
      </div>
    </section>
  );
};

const SectionTitle = ({ number, title }) => <div className="bilingual-title"><div><span>{number}</span><h2>{title}</h2></div></div>;
const Info = ({ label, value, wide }) => <div className={`info-field ${wide ? 'wide' : ''}`}><span>{label}</span><b>{value || '—'}</b></div>;

const SearchableLibrarySelect = ({ items, value, onChange, getLabel, placeholder }) => {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selectedItem = items.find((item) => String(item.id) === String(value));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = items.filter((item) => {
    const searchable = `${item.code || ''} ${getLabel(item)} ${item.category || ''} ${item.parent || ''}`.toLocaleLowerCase();
    return !normalizedQuery || searchable.includes(normalizedQuery);
  }).slice(0, 50);

  return (
    <div
      className="searchable-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Search size={18} />
      <input
        className="form-input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={open ? query : selectedItem ? `${selectedItem.code ? `${selectedItem.code} · ` : ''}${getLabel(selectedItem)}` : ''}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); if (value) onChange(''); }}
      />
      {open && (
        <div className="searchable-options" role="listbox">
          {visibleItems.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={String(item.id) === String(value)}
              key={item.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onChange(item.id); setOpen(false); setQuery(''); }}
            >
              <b>{getLabel(item)}</b>
              <small>{[item.code, item.category].filter(Boolean).join(' · ')}</small>
            </button>
          ))}
          {!visibleItems.length && <div className="searchable-empty">{t('no_search_results')}</div>}
        </div>
      )}
    </div>
  );
};

const EvaluationRows = ({ type, number, library, onAdd, rows, updateRow, removeRow, total }) => {
  const { t, lang } = useLanguage();
  const [selected, setSelected] = useState('');
  const isGoals = type === 'goals';
  const localizedName = (item) => {
    if (lang === 'ar' || lang === 'ur') return item.title_ar || item.name_ar || item.goal || item.name || item.title;
    return item.title_en || item.name_en || item.goal || item.name || item.title;
  };
  const addSelected = () => {
    if (!selected) return;
    onAdd(selected);
    setSelected('');
  };
  return (
    <section className="evaluation-section evaluation-table-section">
      <SectionTitle number={number} title={isGoals ? t('evaluate_objectives') : t('evaluate_competencies')} />
      <div className="add-library-row no-print">
        <SearchableLibrarySelect
          items={library}
          value={selected}
          onChange={setSelected}
          getLabel={localizedName}
          placeholder={isGoals ? t('search_goal_library') : t('search_competency_library')}
        />
        <button className="secondary-button" onClick={addSelected} disabled={!selected}><Plus /> {t('add')}</button>
      </div>
      <div className="evaluation-table-wrap">
        <table className="evaluation-table">
          <thead>{isGoals ? (
            <tr><th>#</th><th>{t('objectives')}</th><th>{t('priority')}</th><th>{t('relative_weight')}</th><th>{t('measurement')}</th><th>{t('target')}</th><th>{t('actual')}</th><th>{t('estimation')}</th><th>{t('weighted')}</th><th className="no-print" /></tr>
          ) : (
            <tr><th>#</th><th>{t('main_competency')}</th><th>{t('sub_competency')}</th><th>{t('priority')}</th><th>{t('relative_weight')}</th><th>{t('estimation')}</th><th>{t('weighted')}</th><th className="no-print" /></tr>
          )}</thead>
          <tbody>
            {rows.map((row, index) => isGoals ? (
              <tr key={row.goal_id}><td>{index + 1}</td><td><b>{row.title}</b><small>{row.code}</small></td><td><ScoreSelect value={row.priority} onChange={(value) => updateRow(type, index, 'priority', value)} /></td><td className="calculated">{row.relativeWeight.toFixed(2)}%</td><td>{row.measurement}</td><td><input type="number" value={row.target} onChange={(event) => updateRow(type, index, 'target', event.target.value)} /></td><td><input type="number" value={row.actual} onChange={(event) => updateRow(type, index, 'actual', event.target.value)} /></td><td className="calculated">{row.score.toFixed(2)}</td><td className="weighted-cell">{row.weighted.toFixed(3)}</td><td className="no-print"><button title={t('delete')} onClick={() => removeRow(type, index)}><Trash2 /></button></td></tr>
            ) : (
              <tr key={row.competency_id}><td>{index + 1}</td><td><b>{row.parent}</b><small>{row.code}</small></td><td>{row.title}</td><td><ScoreSelect value={row.priority} onChange={(value) => updateRow(type, index, 'priority', value)} /></td><td className="calculated">{row.relativeWeight.toFixed(2)}%</td><td><ScoreSelect value={row.score} onChange={(value) => updateRow(type, index, 'score', value)} /></td><td className="weighted-cell">{row.weighted.toFixed(3)}</td><td className="no-print"><button title={t('delete')} onClick={() => removeRow(type, index)}><Trash2 /></button></td></tr>
            ))}
            {!rows.length && <tr><td colSpan={isGoals ? 10 : 8}><div className="empty-table compact"><Goal /><b>{t('no_items_added')}</b><span>{t('choose_library_item')}</span></div></td></tr>}
            <tr className="total-row"><td colSpan={isGoals ? 8 : 6}>{t('total_weighted_estimate')}</td><td>{total.toFixed(2)}</td><td className="no-print" /></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
};

const ScoreSelect = ({ value, onChange }) => <select value={value} onChange={(e) => onChange(Number(e.target.value))}>{[1,2,3,4,5].map((score) => <option key={score} value={score}>{score}</option>)}</select>;

export default FormsPortal;
