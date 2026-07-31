import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlarmClock, ArrowRight, Ban, BarChart3, CheckCircle2, ClipboardList, Eye, FileText, Flame,
  History, Inbox, RefreshCcw, Send, ShieldCheck, Timer, Undo2, UserRoundCog, X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  cancelApprovalRequest, loadApprovalCenterFeed, loadApprovalDashboard, loadApprovalFormDetail, recallApproval,
} from '../data/approvalService';
import { ApprovalActionModal, ApprovalChainSection, SendApprovalModal } from './ApprovalChain';
import { approvalErrorMessage, useArabicName } from '../utils/approval';

const SLA_HOURS = 48;

export const ApprovalStatusBadge = ({ status }) => {
  const { t } = useLanguage();
  const map = {
    Draft: [t('draft'), 'draft'],
    Submitted: [t('submitted'), 'submitted'],
    Returned: [t('returned'), 'returned'],
    Cancelled: [t('cancelled'), 'closed'],
    InApproval: [t('status_in_approval'), 'submitted'],
    Approved: [t('status_approved'), 'approved'],
    Rejected: [t('status_rejected'), 'rejected'],
  };
  const [label, tone] = map[status] || [status, 'draft'];
  return <span className={`status-badge status-${tone}`}>{label}</span>;
};

const hoursSince = (value) => {
  if (!value) return 0;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 36e5);
};

const AgingBadge = ({ since }) => {
  const { t } = useLanguage();
  if (!since) return <span>—</span>;
  const hours = hoursSince(since);
  const label = hours >= 24 ? t('aging_days', { count: Math.floor(hours / 24) }) : t('aging_hours', { count: Math.max(1, Math.round(hours)) });
  return <span className={`aging-badge ${hours > SLA_HOURS ? 'late' : hours > SLA_HOURS / 2 ? 'warning' : ''}`}>{label}</span>;
};

// Known data_json fields -> translation keys; everything else falls back to a
// prettified key so any future form renders sensibly without code changes.
const DATA_LABELS = {
  memo_title: 'memo_title', memo_date: 'date', memo_number: 'internal_memo_number',
  from: 'from', to: 'to', cc: 'cc', subject: 'subject', request: 'request',
  justification: 'justification', recommendation: 'recommendation',
  cycle_name: 'evaluation_cycle', evaluation_type: 'evaluation_type',
  start_date: 'starting_from', end_date: 'until_date', evaluation_date: 'evaluation_date',
  objectives_weight: 'objectives_weight', competencies_weight: 'competencies_weight',
  overall_comment: 'overall_comments', overall_score: 'overall_estimate', overall_rate: 'assessment',
  evaluator_name: 'evaluator', requester_name: 'requested_by',
};
const SKIP_KEYS = new Set([
  'reference', 'form_type', 'submission_mode', 'employee', 'goals', 'competencies', 'attachments',
  'evaluator_signature_url', 'requester_signature_url', 'reviewer_name', 'director_name',
  'recommended_by', 'approved_by', 'cycle_id',
]);

const RequestDetailsModal = ({ formId, currentUserId, onClose, onAct, onSend, onCancel }) => {
  const { t, locale } = useLanguage();
  const { roleNameFromRow } = useArabicName();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadApprovalFormDetail(formId)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((loadError) => { if (!cancelled) setError(approvalErrorMessage(t, loadError)); });
    return () => { cancelled = true; };
  }, [formId, t]);

  const form = detail?.form;
  const data = form?.data_json || {};
  const scalarEntries = Object.entries(data).filter(([key, value]) => (
    !SKIP_KEYS.has(key)
    && (typeof value === 'string' || typeof value === 'number')
    && String(value).trim() !== ''
  ));
  const prettify = (key) => {
    const mapped = DATA_LABELS[key];
    if (mapped) return t(mapped);
    return key.replaceAll('_', ' ');
  };
  const formatValue = (value) => (
    typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : String(value)
  );
  // The holder of the request can act on it straight from the read-only view.
  const isHolder = form?.current_assignee_id === currentUserId;
  const isRequester = form?.requested_by === currentUserId;
  const canAct = isHolder && !isRequester && form?.status === 'InApproval';
  const canRoute = isHolder && isRequester && form?.status !== 'Cancelled';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-xwide request-details-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{form?.reference_no || ''}</span>
            <h3>{t('request_details')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose}><X /></button>
        </div>
        {error && <div className="modal-error"><X />{error}</div>}
        {!detail && !error && <p className="field-note">{t('loading')}</p>}
        {form && (
          <div className="request-details-body">
            <div className="request-details-meta">
              <div className="info-field"><span>{t('forms')}</span><b>{form.template_name_ar || form.template_name}</b></div>
              <div className="info-field"><span>{t('status')}</span><b><ApprovalStatusBadge status={form.status} /></b></div>
              <div className="info-field"><span>{t('requested_by')}</span><b>{form.requester_name || '—'}</b></div>
              <div className="info-field"><span>{t('beneficiary_employee')}</span><b>{form.employee_name || data.employee?.full_name || '—'}</b></div>
              <div className="info-field"><span>{t('current_holder')}</span><b>{form.current_assignee_name ? `${form.current_assignee_name}${roleNameFromRow(form) ? ` · ${roleNameFromRow(form)}` : ''}` : '—'}</b></div>
              <div className="info-field"><span>{t('verify_code_label')}</span><b className="verify-code">{form.verify_code || '—'}</b></div>
            </div>

            {scalarEntries.length > 0 && (
              <div className="request-details-fields">
                {scalarEntries.map(([key, value]) => (
                  <div key={key} className="info-field"><span>{prettify(key)}</span><b>{formatValue(value)}</b></div>
                ))}
              </div>
            )}

            {Array.isArray(data.goals) && data.goals.length > 0 && (
              <div className="request-details-table">
                <h4>{t('objectives')}</h4>
                <table className="enterprise-table">
                  <thead><tr><th>{t('objectives')}</th><th>{t('relative_weight')}</th><th>{t('estimation')}</th></tr></thead>
                  <tbody>
                    {data.goals.map((row, index) => (
                      <tr key={index}><td>{row.title}</td><td>{Number(row.relativeWeight || 0).toFixed(1)}%</td><td>{Number(row.score || 0).toFixed(2)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {Array.isArray(data.competencies) && data.competencies.length > 0 && (
              <div className="request-details-table">
                <h4>{t('evaluate_competencies')}</h4>
                <table className="enterprise-table">
                  <thead><tr><th>{t('main_competency')}</th><th>{t('relative_weight')}</th><th>{t('estimation')}</th></tr></thead>
                  <tbody>
                    {data.competencies.map((row, index) => (
                      <tr key={index}><td>{row.title}</td><td>{Number(row.relativeWeight || 0).toFixed(1)}%</td><td>{Number(row.score || 0).toFixed(2)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(detail.attachments || []).length > 0 && (
              <div className="request-details-table">
                <h4>{t('attachments')}</h4>
                <ul className="request-attachments">
                  {detail.attachments.map((file) => (
                    <li key={file.id}><FileText /> {file.file_name} <small>{file.file_size ? `${Math.ceil(file.file_size / 1024)} KB` : ''}</small></li>
                  ))}
                </ul>
              </div>
            )}

            <ApprovalChainSection formId={formId} detail={detail} />
            <p className="field-note">{t('request_details_readonly_note')} · {t('generated_on')}: {new Date(form.created_on).toLocaleDateString(locale)}</p>
          </div>
        )}
        {form && (canAct || canRoute) && (
          <div className="modal-actions request-details-actions">
            <button type="button" className="secondary-button" onClick={onClose}>{t('close')}</button>
            {canAct && <button type="button" className="primary-button" onClick={() => onAct(form)}><ArrowRight /> {t('take_action')}</button>}
            {canRoute && <button type="button" className="primary-button" onClick={() => onSend(form)}><Send /> {t(form.status === 'Approved' ? 'send_additional_approval' : 'send_for_approval')}</button>}
            {canRoute && <button type="button" className="secondary-button danger" onClick={() => onCancel(form)}><Ban /> {t('cancel_request')}</button>}
          </div>
        )}
      </div>
    </div>
  );
};

const FeedTable = ({ items, kind, heldByMe, onView, onAct, onSendNext, onCancel, onRecall }) => {
  const { t, locale } = useLanguage();
  const { roleNameFromRow } = useArabicName();
  if (!items.length) {
    return (
      <div className="empty-table approval-empty">
        <ClipboardList />
        <b>{t(kind === 'inbox' ? 'no_inbox_items' : kind === 'outbox' ? 'no_outbox_items' : 'no_history_items')}</b>
        <span>{t('approval_empty_hint')}</span>
      </div>
    );
  }
  return (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('forms')}</th>
            <th>{kind === 'inbox' ? t('requested_by') : t('current_holder')}</th>
            <th>{t('approval_role')}</th>
            <th>{t('status')}</th>
            <th>{t('aging')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <div className="form-name-cell">
                  <FileText />
                  <div>
                    <b>{item.template_name_ar || item.template_name}</b>
                    <small>{item.reference_no || item.id.slice(0, 8)}</small>
                  </div>
                </div>
              </td>
              <td>
                {kind === 'inbox'
                  ? <div className="holder-cell"><b>{item.requester_name || '—'}</b>{item.last_actor_name && item.last_action !== 'Submit' && <small>{item.last_actor_name}</small>}</div>
                  : <div className="holder-cell"><b>{item.status === 'InApproval' ? item.assignee_name || '—' : '—'}</b><small>{(item.updated_on || item.pending_since) ? new Date(item.updated_on || item.pending_since).toLocaleDateString(locale) : '—'}</small></div>}
              </td>
              <td>
                {item.is_review
                  ? <span className="status-badge status-returned">{t('review_requested')}</span>
                  : roleNameFromRow(item) || (item.is_own_return ? t('returned_to_you') : '—')}
              </td>
              <td><ApprovalStatusBadge status={item.status} /></td>
              <td>{item.status === 'InApproval' ? <AgingBadge since={item.pending_since} /> : '—'}</td>
              <td>
                <div className="table-actions">
                  <button onClick={() => onView(item)} title={t('view_details')}><Eye /></button>
                  {kind === 'inbox' && !item.is_own_return && (
                    <button className="approve-action" onClick={() => onAct(item)} title={t('take_action')}><ArrowRight /></button>
                  )}
                  {kind === 'inbox' && item.is_own_return && (
                    <button className="approve-action" onClick={() => onSendNext(item)} title={t('send_next_stage')}><Send /></button>
                  )}
                  {kind === 'outbox' && heldByMe?.(item) && (
                    <>
                      <button className="approve-action" onClick={() => onSendNext(item)} title={t('send_additional_approval')}><Send /></button>
                      <button className="danger" onClick={() => onCancel(item)} title={t('cancel_request')}><Ban /></button>
                    </>
                  )}
                  {kind === 'outbox' && item.can_recall && (
                    <button onClick={() => onRecall(item)} title={t('recall')}><Undo2 /></button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Dashboard = () => {
  const { t, lang } = useLanguage();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadApprovalDashboard()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((loadError) => { if (!cancelled) setError(approvalErrorMessage(t, loadError)); });
    return () => { cancelled = true; };
  }, [t]);

  const stats = useMemo(() => {
    if (!data) return null;
    const pending = data.pending || [];
    const completed = data.completed || [];
    const transactions = data.transactions || [];
    const today = new Date().toDateString();
    const approvedDurations = completed
      .filter((row) => row.status === 'Approved' && row.approval_started_on && row.approval_completed_on)
      .map((row) => (new Date(row.approval_completed_on) - new Date(row.approval_started_on)) / 36e5);
    const avgHours = approvedDurations.length ? approvedDurations.reduce((sum, value) => sum + value, 0) / approvedDurations.length : 0;
    const longest = [...pending].sort((a, b) => new Date(a.pending_since || 0) - new Date(b.pending_since || 0))[0];
    const approversMap = new Map();
    transactions.filter((tx) => tx.action === 'Approve').forEach((tx) => {
      const entry = approversMap.get(tx.actor_name) || 0;
      approversMap.set(tx.actor_name, entry + 1);
    });
    const topApprovers = [...approversMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const departmentMap = new Map();
    transactions.filter((tx) => tx.action === 'Approve').forEach((tx) => {
      const dept = tx.department || t('not_specified');
      departmentMap.set(dept, (departmentMap.get(dept) || 0) + 1);
    });
    const byDepartment = [...departmentMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 6 }, () => 0));
    transactions.forEach((tx) => {
      const date = new Date(tx.created_on);
      heat[date.getDay()][Math.floor(date.getHours() / 4)] += 1;
    });
    const heatMax = Math.max(1, ...heat.flat());
    return {
      pending,
      avgHours,
      approvalsToday: transactions.filter((tx) => tx.action === 'Approve' && new Date(tx.created_on).toDateString() === today).length,
      pendingCount: pending.length,
      rejectedCount: completed.filter((row) => row.status === 'Rejected').length,
      longest,
      slaViolations: pending.filter((row) => hoursSince(row.pending_since) > SLA_HOURS),
      topApprovers,
      byDepartment,
      heat,
      heatMax,
    };
  }, [data, t]);

  if (error) return <div className="inline-message error"><X />{error}</div>;
  if (!stats) return <p className="field-note">{t('loading')}</p>;

  const dayNames = lang === 'ar' || lang === 'ur'
    ? ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="approval-dashboard">
      <div className="kpi-grid">
        <div className="kpi-card"><Timer /><div><span>{t('avg_approval_time')}</span><b>{stats.avgHours >= 24 ? t('aging_days', { count: (stats.avgHours / 24).toFixed(1) }) : t('aging_hours', { count: stats.avgHours.toFixed(1) })}</b></div></div>
        <div className="kpi-card"><CheckCircle2 /><div><span>{t('approvals_today')}</span><b>{stats.approvalsToday}</b></div></div>
        <div className="kpi-card"><Inbox /><div><span>{t('pending_requests')}</span><b>{stats.pendingCount}</b></div></div>
        <div className="kpi-card"><X /><div><span>{t('rejected_requests')}</span><b>{stats.rejectedCount}</b></div></div>
        <div className="kpi-card"><AlarmClock /><div><span>{t('longest_waiting')}</span><b>{stats.longest ? `${stats.longest.reference_no || ''} · ${Math.floor(hoursSince(stats.longest.pending_since))}${t('hour_symbol')}` : '—'}</b></div></div>
        <div className="kpi-card sla"><Flame /><div><span>{t('sla_violations')}</span><b>{stats.slaViolations.length}</b></div></div>
      </div>

      <div className="dashboard-panels">
        <div className="dashboard-panel">
          <h3><BarChart3 /> {t('approvals_by_department')}</h3>
          {stats.byDepartment.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stats.byDepartment}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
                <YAxis allowDecimals={false} width={28} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--brand, #1b4f82)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="field-note">{t('no_data_yet')}</p>}
        </div>
        <div className="dashboard-panel">
          <h3><UserRoundCog /> {t('most_active_approvers')}</h3>
          {stats.topApprovers.length ? (
            <ul className="top-approvers">
              {stats.topApprovers.map(([name, count]) => (
                <li key={name}><b>{name}</b><span>{t('approvals_count', { count })}</span></li>
              ))}
            </ul>
          ) : <p className="field-note">{t('no_data_yet')}</p>}
        </div>
      </div>

      <div className="dashboard-panel">
        <h3><Flame /> {t('activity_heatmap')}</h3>
        <div className="heatmap">
          {stats.heat.map((row, day) => (
            <div key={day} className="heatmap-row">
              <small>{dayNames[day]}</small>
              {row.map((value, slot) => (
                <span
                  key={slot}
                  className="heatmap-cell"
                  style={{ opacity: value ? 0.25 + (0.75 * value) / stats.heatMax : undefined }}
                  data-empty={!value}
                  title={`${dayNames[day]} ${slot * 4}:00–${slot * 4 + 4}:00 · ${value}`}
                />
              ))}
            </div>
          ))}
          <div className="heatmap-row heatmap-legend">
            <small />
            {Array.from({ length: 6 }, (_, slot) => <span key={slot} className="heatmap-hour">{slot * 4}</span>)}
          </div>
        </div>
      </div>

      {stats.slaViolations.length > 0 && (
        <div className="dashboard-panel">
          <h3><AlarmClock /> {t('sla_violations')}</h3>
          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead><tr><th>{t('forms')}</th><th>{t('current_holder')}</th><th>{t('approval_role')}</th><th>{t('aging')}</th></tr></thead>
              <tbody>
                {stats.slaViolations.map((row) => (
                  <tr key={row.id}>
                    <td><b>{row.reference_no}</b> <small>{row.template_name_ar || row.template_name}</small></td>
                    <td>{row.assignee_name || '—'}</td>
                    <td>{row.role_name_ar || '—'}</td>
                    <td><AgingBadge since={row.pending_since} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

const OUTBOX_FILTERS = ['All', 'Pending', 'ReturnedToMe', 'Approved', 'Rejected'];

const ApprovalCenter = () => {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const isAdmin = profile?.role_code === 'PLATFORM_ADMIN' || profile?.role_code === 'SYSTEM_ADMIN';
  const [tab, setTab] = useState('inbox');
  const [feed, setFeed] = useState({ inbox: [], outbox: [], history: [] });
  const [message, setMessage] = useState('');
  const [detailsFor, setDetailsFor] = useState(null);
  const [actionFor, setActionFor] = useState(null);
  const [sendFor, setSendFor] = useState(null);
  const [cancelFor, setCancelFor] = useState(null);
  const [outboxFilter, setOutboxFilter] = useState('All');

  const refresh = useCallback(() => {
    loadApprovalCenterFeed(profile?.id)
      .then((data) => setFeed({ inbox: data.inbox || [], outbox: data.outbox || [], history: data.history || [] }))
      .catch((error) => setMessage(approvalErrorMessage(t, error)));
  }, [profile?.id, t]);

  useEffect(() => {
    refresh();
    window.addEventListener('shalfa-forms-updated', refresh);
    return () => window.removeEventListener('shalfa-forms-updated', refresh);
  }, [refresh]);

  const outboxItems = feed.outbox.filter((item) => {
    if (outboxFilter === 'Pending') return item.status === 'InApproval' && item.assignee_id !== profile?.id;
    if (outboxFilter === 'ReturnedToMe') return item.status === 'InApproval' && item.assignee_id === profile?.id;
    if (outboxFilter === 'Approved') return item.status === 'Approved';
    if (outboxFilter === 'Rejected') return item.status === 'Rejected';
    return true;
  });

  const recall = async (item) => {
    try {
      await recallApproval(item.id);
      setMessage(t('recall_success'));
      window.dispatchEvent(new Event('shalfa-forms-updated'));
    } catch (error) {
      setMessage(approvalErrorMessage(t, error));
    }
  };

  const openSendNext = async (item) => {
    setDetailsFor(null);
    if (item.template_id) {
      setSendFor({ formId: item.id, templateId: item.template_id });
      return;
    }
    try {
      const detail = await loadApprovalFormDetail(item.id);
      setSendFor({ formId: item.id, templateId: detail.form.template_id });
    } catch (error) {
      setMessage(approvalErrorMessage(t, error));
    }
  };

  const confirmCancel = async () => {
    const target = cancelFor;
    setCancelFor(null);
    try {
      await cancelApprovalRequest({ formId: target.id });
      setMessage(t('request_cancelled'));
      window.dispatchEvent(new Event('shalfa-forms-updated'));
      refresh();
    } catch (error) {
      setMessage(approvalErrorMessage(t, error));
    }
  };

  const tabs = [
    { id: 'inbox', icon: Inbox, label: t('inbox'), count: feed.inbox.length },
    { id: 'outbox', icon: Send, label: t('outbox'), count: feed.outbox.filter((item) => item.status === 'InApproval').length },
    { id: 'history', icon: History, label: t('history'), count: null },
    ...(isAdmin ? [{ id: 'dashboard', icon: BarChart3, label: t('dashboard'), count: null }] : []),
  ];

  return (
    <main className="app-main approval-center">
      <div className="forms-heading">
        <div>
          <span className="section-kicker"><ShieldCheck size={14} /> {t('employee_services')}</span>
          <h1>{t('approval_center')}</h1>
          <p>{t('approval_center_intro')}</p>
        </div>
        <button className="secondary-button" onClick={refresh}><RefreshCcw /> {t('refresh')}</button>
      </div>

      {message && <div className="inline-message"><CheckCircle2 />{message}<button onClick={() => setMessage('')}><X /></button></div>}

      <div className="segmented approval-tabs">
        {tabs.map(({ id, icon: Icon, label, count }) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={16} /> {label}{count ? <span className="tab-count">{count}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'inbox' && (
        <FeedTable
          items={feed.inbox}
          kind="inbox"
          onView={(item) => setDetailsFor(item.id)}
          onAct={(item) => setActionFor(item.id)}
          onSendNext={openSendNext}
        />
      )}
      {tab === 'outbox' && (
        <>
          <div className="segmented outbox-filters">
            {OUTBOX_FILTERS.map((value) => (
              <button key={value} className={outboxFilter === value ? 'active' : ''} onClick={() => setOutboxFilter(value)}>
                {t(`outbox_filter_${value.toLowerCase()}`)}
              </button>
            ))}
          </div>
          <FeedTable
            items={outboxItems}
            kind="outbox"
            heldByMe={(item) => item.held_by_me ?? (['InApproval', 'Approved'].includes(item.status) && item.assignee_id === profile?.id)}
            onView={(item) => setDetailsFor(item.id)}
            onSendNext={openSendNext}
            onCancel={(item) => setCancelFor(item)}
            onRecall={recall}
          />
        </>
      )}
      {tab === 'history' && (
        <FeedTable
          items={feed.history}
          kind="history"
          onView={(item) => setDetailsFor(item.id)}
        />
      )}
      {tab === 'dashboard' && isAdmin && <Dashboard />}

      {detailsFor && (
        <RequestDetailsModal
          formId={detailsFor}
          currentUserId={profile?.id}
          onClose={() => setDetailsFor(null)}
          onAct={(form) => { setDetailsFor(null); setActionFor(form.id); }}
          onSend={(form) => openSendNext({ id: form.id, template_id: form.template_id })}
          onCancel={(form) => { setDetailsFor(null); setCancelFor({ id: form.id, reference_no: form.reference_no }); }}
        />
      )}
      {cancelFor && (
        <div className="modal-backdrop" onClick={() => setCancelFor(null)}>
          <div className="modal-card confirm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="section-kicker">{cancelFor.reference_no || ''}</span><h3>{t('cancel_request')}</h3></div>
              <button type="button" className="icon-button" onClick={() => setCancelFor(null)}><X /></button>
            </div>
            <div className="confirm-body"><Ban /><p>{t('cancel_request_confirm')}</p></div>
            <p className="field-note">{t('cancel_request_note')}</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setCancelFor(null)}>{t('no_keep_request')}</button>
              <button type="button" className="secondary-button danger" onClick={confirmCancel}><Ban /> {t('yes_cancel_request')}</button>
            </div>
          </div>
        </div>
      )}
      {actionFor && (
        <ApprovalActionModal
          formId={actionFor}
          currentUserId={profile?.id}
          onClose={() => setActionFor(null)}
          onDone={() => { setActionFor(null); setMessage(t('action_recorded')); refresh(); }}
        />
      )}
      {sendFor && (
        <SendApprovalModal
          formId={sendFor.formId}
          templateId={sendFor.templateId}
          currentUserId={profile?.id}
          onClose={() => setSendFor(null)}
          onSent={() => { setSendFor(null); setMessage(t('request_sent')); refresh(); }}
        />
      )}
    </main>
  );
};

export default ApprovalCenter;
