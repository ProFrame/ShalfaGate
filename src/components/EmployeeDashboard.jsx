import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowLeft, CalendarDays, Check, ClipboardList, FileText, Files, Folder, Image as ImageIcon,
  Inbox, LayoutDashboard, Lightbulb, Megaphone, Network, Palette, Plus, ScanSearch, ScrollText,
  SlidersHorizontal, StickyNote, Sun, TrendingUp, TriangleAlert, Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import { publicPath } from '../lib/routing';
import { codeLabel, formatDate, formatRelative, pickLocalized } from '../utils/localize';
import {
  loadWorkspaceLayout, loadWorkspaceSnapshot, resetWorkspaceLayout, saveWorkspaceLayout, sortWidgets,
} from '../data/workspaceService';
import WidgetGrid from './workspace/WidgetGrid';
import WidgetManager from './workspace/WidgetManager';
import './workspace/workspace.css';

// The catalogue stores an icon name; this is the only place that turns it into
// a component, so adding a widget upstream never needs a code change here.
const ICONS = {
  sun: Sun,
  zap: Zap,
  'file-text': FileText,
  inbox: Inbox,
  megaphone: Megaphone,
  'clipboard-list': ClipboardList,
  calendar: CalendarDays,
  'sticky-note': StickyNote,
  folder: Folder,
  'scroll-text': ScrollText,
  image: ImageIcon,
  network: Network,
  'trending-up': TrendingUp,
  lightbulb: Lightbulb,
};

const STATUS_TONES = {
  Draft: 'draft', Submitted: 'submitted', InApproval: 'submitted', Returned: 'draft',
  Approved: 'approved', Rejected: 'rejected', Cancelled: 'closed', Closed: 'closed',
};

const EMPTY_SNAPSHOT = { requests: [], inbox: { items: [], count: 0, lateCount: 0 } };

// ---------------------------------------------------------------------------
// Widgets owned by other modules.
//
// They are resolved through import.meta.glob rather than a static import: a
// module that has not shipped yet simply resolves to nothing and the card shows
// a quiet placeholder instead of breaking the whole home page.
// ---------------------------------------------------------------------------

const EXTERNAL_SOURCES = {
  ANNOUNCEMENTS: import.meta.glob('./announcements/AnnouncementsWidget.jsx'),
  SURVEY: import.meta.glob('./surveys/SurveyWidget.jsx'),
  CALENDAR: import.meta.glob('./calendar/CalendarWidget.jsx'),
  NOTES: import.meta.glob('./notes/NotesWidget.jsx'),
};

const EXTERNAL_NAMES = {
  ANNOUNCEMENTS: 'AnnouncementsWidget',
  SURVEY: 'SurveyWidget',
  CALENDAR: 'CalendarWidget',
  NOTES: 'NotesWidget',
};

const externalCache = new Map();
const MissingWidget = () => null;

const externalWidget = (code) => {
  if (externalCache.has(code)) return externalCache.get(code);
  const loader = Object.values(EXTERNAL_SOURCES[code] || {})[0];
  const component = loader
    ? lazy(async () => {
        const module = await loader();
        return { default: module?.default || module?.[EXTERNAL_NAMES[code]] || MissingWidget };
      })
    : null;
  externalCache.set(code, component);
  return component;
};

/** One failing card must never take the board down with it. */
class WidgetBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Dashboard widget failed', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * A widget whose module is switched off never renders. While the company's
 * module map is still unknown the server-side filter in workspace_layout() is
 * trusted, so the board is never empty for the wrong reason.
 */
const useModuleGuard = () => {
  const { hasModule, modules } = useTenant();
  const known = Boolean(modules && Object.keys(modules).length);
  return useCallback((code) => !code || !known || hasModule(code), [hasModule, known]);
};

const StatusBadge = ({ status }) => {
  const { t } = useLanguage();
  return <span className={`status-badge status-${STATUS_TONES[status] || 'draft'}`}>{codeLabel(t, 'status', status)}</span>;
};

const MoreLink = ({ href, children }) => {
  const { isRtl } = useLanguage();
  return (
    <Link href={href} className="ws-widget-link">
      {children}
      <ArrowLeft size={15} aria-hidden="true" className={isRtl ? '' : 'flip-ltr'} />
    </Link>
  );
};

// ---------------------------------------------------------------------------
// The cards this screen owns
// ---------------------------------------------------------------------------

const WelcomeWidget = () => {
  const { profile } = useAuth();
  const { t, lang, locale } = useLanguage();
  const displayName = lang === 'en' && profile?.full_name_en
    ? profile.full_name_en
    : profile?.full_name || profile?.full_name_ar || t('employee');
  const firstName = displayName.split(' ')[0];
  const greeting = new Date().getHours() < 12 ? t('good_morning') : t('good_evening');

  return (
    <div className="ws-welcome">
      <div>
        <span className="section-kicker">{greeting}</span>
        <h2>{t('dashboard_question', { name: firstName })}</h2>
        <p>{t('dashboard_intro')}</p>
      </div>
      <div className="ws-welcome-meta">
        <CalendarDays aria-hidden="true" />
        <span>{formatDate(new Date(), locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <small>{t('last_login_today')}</small>
      </div>
    </div>
  );
};

const QuickActionsWidget = () => {
  const { t } = useLanguage();
  const allowModule = useModuleGuard();

  const actions = [
    { key: 'forms', href: '/app/forms', module: 'FORMS', Icon: Plus, title: t('browse_forms'), note: t('forms_description') },
    { key: 'approvals', href: '/app/approvals', module: 'APPROVALS', Icon: Inbox, title: t('open_approval_center'), note: t('awaiting_approval_hint') },
    { key: 'documents', href: '/app/documents', module: 'DOCUMENTS', Icon: Files, title: t('docs'), note: t('docs_description') },
    { key: 'verify', external: publicPath('verify'), module: 'VERIFICATION', Icon: ScanSearch, title: t('open_verify_page'), note: t('verify_shortcut_hint') },
  ].filter((action) => allowModule(action.module));

  if (actions.length === 0) return <p className="ws-empty">{t('label_no_results')}</p>;

  return (
    <div className="ws-actions">
      {actions.map(({ key, href, external, Icon, title, note }) => {
        const body = (
          <>
            <span className="ws-action-icon" aria-hidden="true"><Icon /></span>
            <span><b>{title}</b><small>{note}</small></span>
          </>
        );
        return external
          ? <a key={key} className="ws-action" href={external} target="_blank" rel="noreferrer">{body}</a>
          : <Link key={key} className="ws-action" href={href}>{body}</Link>;
      })}
    </div>
  );
};

const MyRequestsWidget = ({ snapshot }) => {
  const { t, lang, locale } = useLanguage();
  const requests = snapshot?.requests || [];

  if (requests.length === 0) return <p className="ws-empty">{t('ws_no_requests')}</p>;

  return (
    <>
      <ul className="ws-list">
        {requests.map((request) => (
          <li key={request.id}>
            <FileText aria-hidden="true" />
            <div>
              <b>{pickLocalized(request, 'template_name', lang, request.reference_no || '')}</b>
              <small>{[request.reference_no, formatRelative(request.updated_on, locale)].filter(Boolean).join(' · ')}</small>
            </div>
            <StatusBadge status={request.status} />
          </li>
        ))}
      </ul>
      <MoreLink href="/app/forms">{t('view_all')}</MoreLink>
    </>
  );
};

const ApprovalInboxWidget = ({ snapshot }) => {
  const { t, lang } = useLanguage();
  const inbox = snapshot?.inbox || EMPTY_SNAPSHOT.inbox;

  if (!inbox.count) return <p className="ws-empty">{t('ws_no_inbox')}</p>;

  return (
    <>
      <div className="ws-headline">
        <b>{inbox.count}</b>
        <p>{inbox.lateCount ? t('awaiting_approval_late', { count: inbox.lateCount }) : t('awaiting_approval_hint')}</p>
      </div>
      <ul className="ws-list">
        {inbox.items.map((item) => (
          <li key={item.id}>
            <FileText aria-hidden="true" />
            <div>
              <b>{pickLocalized(item, 'template_name', lang, item.reference_no || '')}</b>
              <small>
                {item.is_own_return ? t('returned_to_you') : item.is_review ? t('review_requested') : item.requester_name || ''}
              </small>
            </div>
          </li>
        ))}
      </ul>
      <MoreLink href="/app/approvals">{t('open_approval_center')}</MoreLink>
    </>
  );
};

const LibraryWidget = ({ items = [], href, countKey, Icon }) => {
  const { t, lang, locale } = useLanguage();

  if (items.length === 0) return <p className="ws-empty">{t('ws_library_empty')}</p>;

  return (
    <>
      <p className="ws-widget-note">{t(countKey, { count: items.length })}</p>
      <ul className="ws-list">
        {items.slice(0, 4).map((item) => (
          <li key={item.id || item.url}>
            <Icon aria-hidden="true" />
            <div>
              <b>{pickLocalized(item, 'name', lang, '')}</b>
              <small>{formatDate(item.date, locale) || t('last_updated_today')}</small>
            </div>
          </li>
        ))}
      </ul>
      <MoreLink href={href}>{t('view_all')}</MoreLink>
    </>
  );
};

const DocumentsWidget = ({ siteData }) => (
  <LibraryWidget items={siteData?.documents || []} href="/app/documents" countKey="documents_count" Icon={Files} />
);

const CircularsWidget = ({ siteData }) => (
  <LibraryWidget items={siteData?.circulars || []} href="/app/circulars" countKey="circulars_count" Icon={Megaphone} />
);

const DesignsWidget = ({ siteData }) => (
  <LibraryWidget items={siteData?.designs || []} href="/app/designs" countKey="designs_count" Icon={Palette} />
);

const OrgChartWidget = ({ siteData }) => {
  const { t } = useLanguage();
  const nodes = siteData?.orgChart || [];
  const occupied = nodes.filter((node) => node.status === 'occupied').length;

  return (
    <>
      <div className="ws-stats">
        <div className="ws-stat"><b>{nodes.length}</b><span>{t('ws_org_total', { count: nodes.length })}</span></div>
        <div className="ws-stat"><b>{occupied}</b><span>{t('ws_org_occupied', { count: occupied })}</span></div>
        <div className="ws-stat"><b>{nodes.length - occupied}</b><span>{t('ws_org_vacant', { count: nodes.length - occupied })}</span></div>
      </div>
      <MoreLink href="/app/org">{t('ws_open_org_chart')}</MoreLink>
    </>
  );
};

const PerformanceWidget = () => {
  const { t } = useLanguage();
  return (
    <>
      <div className="ws-action">
        <span className="ws-action-icon" aria-hidden="true"><TrendingUp /></span>
        <span><b>{t('performance_review')}</b><small>{t('ws_performance_hint')}</small></span>
      </div>
      <MoreLink href="/app/forms">{t('ws_open_performance')}</MoreLink>
    </>
  );
};

const TipWidget = () => {
  const { t } = useLanguage();
  return (
    <div className="ws-action">
      <span className="ws-action-icon" aria-hidden="true"><Lightbulb /></span>
      <span><b>{t('todays_tip')}</b><small>{t('tip_text')}</small></span>
    </div>
  );
};

const INLINE_WIDGETS = {
  WELCOME: WelcomeWidget,
  QUICK_ACTIONS: QuickActionsWidget,
  MY_REQUESTS: MyRequestsWidget,
  APPROVAL_INBOX: ApprovalInboxWidget,
  DOCUMENTS: DocumentsWidget,
  CIRCULARS: CircularsWidget,
  DESIGNS: DesignsWidget,
  ORG_CHART: OrgChartWidget,
  PERFORMANCE: PerformanceWidget,
  TIP: TipWidget,
};

const LIVE_DATA_WIDGETS = ['MY_REQUESTS', 'APPROVAL_INBOX'];

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const EmployeeDashboard = ({ siteData }) => {
  const { profile } = useAuth();
  const { t, lang } = useLanguage();
  const allowModule = useModuleGuard();
  const userId = profile?.id;

  const [widgets, setWidgets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [status, setStatus] = useState({ tone: 'idle', message: '' });
  const [managerOpen, setManagerOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);

  const widgetsRef = useRef([]);
  const saveToken = useRef(0);

  // Mirrored so the board callbacks always write from the latest arrangement.
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaceLayout(userId).then(({ data, error }) => {
      if (cancelled) return;
      setWidgets(sortWidgets(data || []));
      setOffline(Boolean(error));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [userId]);

  const catalogue = useMemo(() => sortWidgets(widgets.filter((widget) => allowModule(widget.module_code)))
    .map((widget) => ({
      ...widget,
      title: pickLocalized(widget, 'name', lang, widget.code),
      description: pickLocalized(widget, 'description', lang, ''),
      Icon: ICONS[widget.icon] || LayoutDashboard,
    })), [widgets, allowModule, lang]);

  const board = useMemo(() => catalogue.filter((widget) => widget.is_visible), [catalogue]);

  const needsSnapshot = useMemo(
    () => board.some((widget) => LIVE_DATA_WIDGETS.includes(widget.code)),
    [board],
  );

  useEffect(() => {
    if (!userId || !needsSnapshot) return undefined;
    let cancelled = false;
    const refresh = () => loadWorkspaceSnapshot(userId).then(({ data }) => {
      if (!cancelled && data) setSnapshot(data);
    });
    refresh();
    window.addEventListener('bbnovix-forms-updated', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('bbnovix-forms-updated', refresh);
    };
  }, [userId, needsSnapshot]);

  useEffect(() => {
    if (status.tone !== 'ok') return undefined;
    const timer = setTimeout(() => setStatus({ tone: 'idle', message: '' }), 2600);
    return () => clearTimeout(timer);
  }, [status]);

  // Optimistic: the board moves at once, the write follows, and a failure puts
  // the previous arrangement back.
  const commit = useCallback(async (next) => {
    const previous = widgetsRef.current;
    const board_ = sortWidgets(next);
    setWidgets(board_);
    setStatus({ tone: 'busy', message: t('ws_saving') });

    const token = saveToken.current + 1;
    saveToken.current = token;
    const { data, error } = await saveWorkspaceLayout(userId, board_);
    if (token !== saveToken.current) return;

    if (error) {
      setWidgets(previous);
      setStatus({ tone: 'error', message: t('ws_save_failed') });
      return;
    }
    if (data) setWidgets(data);
    setStatus({ tone: 'ok', message: t('ws_saved') });
  }, [t, userId]);

  const handleUpdate = useCallback((code, patch) => {
    commit(widgetsRef.current.map((widget) => (widget.code === code ? { ...widget, ...patch } : widget)));
  }, [commit]);

  const handleToggleVisible = useCallback((code) => {
    const current = widgetsRef.current.find((widget) => widget.code === code);
    handleUpdate(code, { is_visible: !current?.is_visible });
  }, [handleUpdate]);

  // The dropped order becomes the stored display_order; hidden cards keep their
  // relative order behind the board so switching one back on is predictable.
  const handleReorder = useCallback((orderedCodes) => {
    const positions = new Map(orderedCodes.map((code, index) => [code, (index + 1) * 10]));
    let tail = (orderedCodes.length + 1) * 10;
    commit(widgetsRef.current.map((widget) => {
      if (positions.has(widget.code)) return { ...widget, display_order: positions.get(widget.code) };
      tail += 10;
      return { ...widget, display_order: tail };
    }));
  }, [commit]);

  const handleReset = useCallback(async () => {
    const previous = widgetsRef.current;
    setStatus({ tone: 'busy', message: t('ws_saving') });
    const token = saveToken.current + 1;
    saveToken.current = token;

    const { data, error } = await resetWorkspaceLayout(userId);
    if (token !== saveToken.current) return;

    if (error || !data) {
      setWidgets(previous);
      setStatus({ tone: 'error', message: t('ws_save_failed') });
      return;
    }
    setWidgets(sortWidgets(data));
    setStatus({ tone: 'ok', message: t('ws_saved') });
  }, [t, userId]);

  const renderWidget = useCallback((widget) => {
    const Inline = INLINE_WIDGETS[widget.code];
    if (Inline) return <Inline widget={widget} siteData={siteData} snapshot={snapshot} />;

    const fallback = <p className="ws-empty">{t('ws_widget_unavailable')}</p>;
    const External = externalWidget(widget.code);
    if (!External) return fallback;

    return (
      <WidgetBoundary fallback={fallback}>
        <Suspense fallback={<p className="ws-widget-loading" role="status">{t('label_loading')}</p>}>
          <External />
        </Suspense>
      </WidgetBoundary>
    );
  }, [siteData, snapshot, t]);

  const tone = status.tone !== 'idle' ? status.tone : (offline ? 'error' : 'idle');
  const message = status.message || (offline ? t('ws_offline_layout') : '');

  return (
    <main className="app-main ws-page">
      <header className="ws-header">
        <div>
          <span className="section-kicker">{t('workspace')}</span>
          <h1>{t('ws_home_title')}</h1>
          <p>{t('ws_home_intro')}</p>
        </div>
        <div className="ws-header-actions">
          <button
            type="button"
            className="secondary-button"
            aria-haspopup="dialog"
            aria-expanded={managerOpen}
            onClick={() => setManagerOpen(true)}
          >
            <SlidersHorizontal size={17} aria-hidden="true" /> {t('ws_customize')}
          </button>
        </div>
      </header>

      <p className="ws-status" data-tone={tone} role="status" aria-live="polite">
        {tone === 'ok' && <Check aria-hidden="true" />}
        {tone === 'error' && <TriangleAlert aria-hidden="true" />}
        {message}
      </p>

      {loading && <p className="ws-widget-loading" role="status">{t('ws_loading_board')}</p>}

      {!loading && board.length === 0 && (
        <div className="ws-board-empty">
          <LayoutDashboard aria-hidden="true" />
          <h2>{t('ws_empty_board')}</h2>
          <p>{t('ws_empty_board_hint')}</p>
          <button type="button" className="primary-button" onClick={() => setManagerOpen(true)}>
            <SlidersHorizontal size={17} aria-hidden="true" /> {t('ws_customize')}
          </button>
        </div>
      )}

      {!loading && board.length > 0 && (
        <WidgetGrid
          widgets={board}
          renderWidget={renderWidget}
          onReorder={handleReorder}
          onUpdate={handleUpdate}
        />
      )}

      <WidgetManager
        open={managerOpen}
        widgets={catalogue}
        onClose={() => setManagerOpen(false)}
        onToggleVisible={handleToggleVisible}
        onWidthChange={(code, width) => handleUpdate(code, { width })}
        onReset={handleReset}
      />
    </main>
  );
};

export default EmployeeDashboard;
