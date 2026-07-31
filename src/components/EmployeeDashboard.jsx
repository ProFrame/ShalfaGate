import { useEffect, useState } from 'react';
import { ArrowLeft, BellRing, CalendarDays, FileText, Files, Inbox, Megaphone, Palette, Plus, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { loadPendingApprovals } from '../data/approvalService';
import { useArabicName } from '../utils/approval';

const PendingApprovalsCard = () => {
  const { profile } = useAuth();
  const { t, isRtl } = useLanguage();
  const { roleNameFromRow } = useArabicName();
  const [pending, setPending] = useState({ count: 0, items: [], lateCount: 0 });

  useEffect(() => {
    if (!profile?.id) return undefined;
    let cancelled = false;
    const refresh = () => loadPendingApprovals(profile.id)
      .then((data) => { if (!cancelled) setPending(data); })
      .catch(() => {});
    refresh();
    window.addEventListener('shalfa-forms-updated', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('shalfa-forms-updated', refresh);
    };
  }, [profile?.id]);

  if (!pending.count) return null;

  return (
    <div className="pending-approvals-panel">
      <div className="pending-approvals-head">
        <span className="pending-approvals-icon"><Inbox /></span>
        <div>
          <span className="section-kicker">{t('approval_center')}</span>
          <h2>{t('awaiting_your_approval')}</h2>
        </div>
        <b className="pending-approvals-count">{pending.count}</b>
      </div>
      <p>{pending.lateCount ? t('awaiting_approval_late', { count: pending.lateCount }) : t('awaiting_approval_hint')}</p>
      <ul className="pending-approvals-list">
        {pending.items.map((item) => (
          <li key={item.id}>
            <FileText />
            <div>
              <b>{item.template_name_ar || item.template_name}</b>
              <small>
                {item.is_own_return ? t('returned_to_you') : item.is_review ? t('review_requested') : roleNameFromRow(item) || item.requester_name}
                {item.requester_name && !item.is_own_return ? ` · ${item.requester_name}` : ''}
              </small>
            </div>
          </li>
        ))}
      </ul>
      <Link href="/app/approvals" className="primary-button">
        {t('open_approval_center')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={16} />
      </Link>
    </div>
  );
};

const EmployeeDashboard = ({ siteData }) => {
  const { profile } = useAuth();
  const { t, locale, lang, isRtl } = useLanguage();
  const displayName = lang === 'en' && profile?.full_name_en ? profile.full_name_en : profile?.full_name || profile?.full_name_ar || t('employee');
  const firstName = displayName.split(' ')[0];
  const greeting = new Date().getHours() < 12 ? t('good_morning') : t('good_evening');
  const formattedDate = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const counts = {
    documents: siteData?.documents?.length || 0,
    circulars: siteData?.circulars?.length || 0,
    designs: siteData?.designs?.length || 0,
  };
  const modules = [
    { to: '/app/forms', icon: FileText, tone: 'emerald', title: t('forms'), description: t('forms_description'), count: t('forms_count', { count: 3 }), meta: t('active_requests', { count: 3 }) },
    { to: '/app/documents', icon: Files, tone: 'blue', title: t('docs'), description: t('docs_description'), count: t('documents_count', { count: counts.documents }), meta: t('last_updated_today') },
    { to: '/app/circulars', icon: Megaphone, tone: 'amber', title: t('circulars'), description: t('circulars_description'), count: t('circulars_count', { count: counts.circulars }), meta: t('last_updated_today') },
    { to: '/app/designs', icon: Palette, tone: 'rose', title: t('designs'), description: t('designs_description'), count: t('designs_count', { count: counts.designs }), meta: t('last_updated_today') },
  ];

  return (
    <main className="app-main dashboard-page">
      <section className="welcome-strip">
        <div>
          <span>{greeting}</span>
          <h1>{t('dashboard_question', { name: firstName })}</h1>
          <p>{t('dashboard_intro')}</p>
        </div>
        <div className="welcome-meta"><CalendarDays /><span>{formattedDate}</span><small>{t('last_login_today')}</small></div>
      </section>

      <section className="dashboard-layout">
        <div className="dashboard-primary">
          <div className="section-heading"><div><span className="section-kicker">{t('workspace')}</span><h2>{t('portal_services')}</h2></div></div>
          <div className="module-grid">
            {modules.map(({ to, icon: Icon, tone, title, description, count, meta }) => (
              <Link href={to} key={to} className={`module-tile tone-${tone}`}>
                <div className="module-top"><span className="module-icon"><Icon /></span><ArrowLeft className={`module-arrow ${isRtl ? '' : 'flip-ltr'}`} /></div>
                <h3>{title}</h3><p>{description}</p>
                <div className="module-footer"><b>{count}</b><span>{meta}</span></div>
              </Link>
            ))}
          </div>

          <div className="dashboard-section">
            <div className="section-heading">
              <div><span className="section-kicker">{t('work_tracking')}</span><h2>{t('recent_requests')}</h2></div>
              <Link href="/app/forms">{t('view_all')} <ArrowLeft className={isRtl ? '' : 'flip-ltr'} size={16} /></Link>
            </div>
            <div className="activity-table">
              <div className="activity-head"><span>{t('request')}</span><span>{t('reference')}</span><span>{t('last_updated')}</span><span>{t('status')}</span></div>
              <div className="activity-row"><span><FileText /> {t('forms')}</span><span>EV-2026-0041</span><span>{t('last_updated_today')}</span><span className="status-badge status-draft">{t('draft')}</span></div>
              <div className="activity-row"><span><Files /> {t('docs')}</span><span>CR-2026-0188</span><span>{t('last_updated_today')}</span><span className="status-badge status-approved">{t('completed')}</span></div>
              <div className="activity-row"><span><BellRing /> {t('circulars')}</span><span>TR-2026-0093</span><span>{t('last_updated_today')}</span><span className="status-badge status-submitted">{t('submitted')}</span></div>
            </div>
          </div>
        </div>

        <aside className="dashboard-side">
          <PendingApprovalsCard />
          <div className="quick-action-panel">
            <span className="section-kicker">{t('quick_action')}</span><h2>{t('start_request')}</h2>
            <Link href="/app/forms" className="primary-button"><Plus size={18} /> {t('browse_forms')}</Link>
          </div>
          <div className="insight-panel"><Sparkles /><div><b>{t('todays_tip')}</b><p>{t('tip_text')}</p></div></div>
        </aside>
      </section>
    </main>
  );
};

export default EmployeeDashboard;
