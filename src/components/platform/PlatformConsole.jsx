import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { motion } from 'framer-motion';
import {
  Activity, Boxes, Building2, ChartColumn, HardDrive, Info, LifeBuoy, Lock, Mail,
  MessageSquare, RefreshCcw, ShieldCheck, Users,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { canOperatePlatform, errorCode, isPreviewMode, loadPlatformOverview } from '../../data/platformService';
import { codeLabel, formatBytes, formatDate, formatDateTime, formatNumber, pickFromMap } from '../../utils/localize';
import TenantsScreen from './TenantsScreen';
import StorageManagement from './StorageManagement';
import SupportConsole from './SupportConsole';
import SystemHealth from './SystemHealth';
import UsageStatistics from './UsageStatistics';
import './platform.css';

// The console is one route with a section segment: /app/platform/:section.
// `overview` is the implicit section so the bare address still lands somewhere.
const SECTIONS = [
  { code: 'overview', labelKey: 'pc_tab_overview', Icon: ChartColumn },
  { code: 'companies', labelKey: 'pc_tab_companies', Icon: Building2 },
  { code: 'storage', labelKey: 'pc_tab_storage', Icon: HardDrive },
  { code: 'support', labelKey: 'pc_tab_support', Icon: LifeBuoy },
  { code: 'health', labelKey: 'pc_tab_health', Icon: Activity },
  { code: 'usage', labelKey: 'pc_tab_usage', Icon: Boxes },
];

const MONTH_KEY = (value) => String(value || '').slice(0, 7);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const HeadlineCard = ({ Icon, label, value, hint }) => (
  <div className="kpi-card">
    <Icon aria-hidden="true" />
    <div>
      <span>{label}</span>
      <b>{value}</b>
      {hint ? <small>{hint}</small> : null}
    </div>
  </div>
);

const SignupsChart = ({ tenants, locale }) => {
  const { t } = useLanguage();

  const series = useMemo(() => {
    const buckets = new Map();
    tenants.forEach((row) => {
      const key = MONTH_KEY(row.created_on);
      if (!key) return;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    });
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, count]) => ({
        month,
        label: formatDate(`${month}-01T00:00:00Z`, locale, { month: 'short', year: '2-digit' }),
        count,
      }));
  }, [tenants, locale]);

  return (
    <section className="pc-panel">
      <header>
        <div>
          <h2>{t('pc_chart_signups')}</h2>
          <p>{t('pc_chart_signups_hint')}</p>
        </div>
      </header>
      {series.length === 0 ? (
        <p className="field-note">{t('label_no_results')}</p>
      ) : (
        <div className="pc-chart">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pcSignups" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} width={34} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(value) => [formatNumber(value, locale), t('pc_metric_companies')]}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}
              />
              <Area type="monotone" dataKey="count" name={t('pc_metric_companies')} stroke="var(--brand)" strokeWidth={2} fill="url(#pcSignups)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
};

const TopTenantsChart = ({ tenants, lang, locale }) => {
  const { t } = useLanguage();

  const series = useMemo(() => (
    [...tenants]
      .sort((a, b) => Number(b.storage_bytes || 0) - Number(a.storage_bytes || 0))
      .slice(0, 8)
      .map((row) => ({
        label: pickFromMap(row.names, lang, 'ar', row.slug),
        bytes: Number(row.storage_bytes || 0),
      }))
  ), [tenants, lang]);

  return (
    <section className="pc-panel">
      <header>
        <div>
          <h2>{t('pc_chart_top')}</h2>
          <p>{t('pc_chart_top_hint')}</p>
        </div>
      </header>
      {series.length === 0 ? (
        <p className="field-note">{t('label_no_results')}</p>
      ) : (
        <div className="pc-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} layout="vertical" margin={{ top: 4, right: 14, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} tickFormatter={(value) => formatBytes(value, locale)} />
              <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(value) => [formatBytes(value, locale), t('pc_metric_storage')]}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}
              />
              <Bar dataKey="bytes" name={t('pc_metric_storage')} fill="var(--brand)" radius={[0, 5, 5, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
};

const SettingsLevels = () => {
  const { t } = useLanguage();
  return (
    <section className="pc-panel">
      <header>
        <div>
          <h2>{t('pc_levels_title')}</h2>
        </div>
      </header>
      <div className="pc-levels">
        <article className="pc-level">
          <b>{t('pc_level_platform')}</b>
          <p>{t('pc_level_platform_body')}</p>
        </article>
        <article className="pc-level">
          <b>{t('pc_level_tenant')}</b>
          <p>{t('pc_level_tenant_body')}</p>
        </article>
        <article className="pc-level">
          <b>{t('pc_level_user')}</b>
          <p>{t('pc_level_user_body')}</p>
        </article>
      </div>
    </section>
  );
};

const OverviewScreen = ({ overview }) => {
  const { t, lang, locale } = useLanguage();
  const tenants = overview?.tenants || {};
  const users = overview?.users || {};
  const storage = overview?.storage || {};
  const forms = overview?.forms || {};
  const emails = overview?.emails || {};
  const support = overview?.support || {};
  const list = overview?.top_tenants || [];

  const number = (value) => formatNumber(Number(value || 0), locale);

  return (
    <div className="pc-console">
      <div className="kpi-grid">
        <HeadlineCard
          Icon={Building2}
          label={t('pc_kpi_companies')}
          value={number(tenants.total)}
          hint={t('pc_kpi_companies_hint', {
            active: number(tenants.active),
            pending: number(tenants.pending),
            suspended: number(tenants.suspended),
            disabled: number(tenants.disabled),
          })}
        />
        <HeadlineCard Icon={Users} label={t('pc_kpi_users')} value={number(users.total)} hint={t('pc_kpi_users_hint', { active: number(users.active) })} />
        <HeadlineCard Icon={Activity} label={t('pc_kpi_active_users')} value={number(users.active_30d)} hint={t('pc_kpi_active_users_hint', { never: number(users.never_logged_in) })} />
        <HeadlineCard Icon={HardDrive} label={t('pc_kpi_storage')} value={formatBytes(storage.bytes, locale)} hint={t('pc_kpi_storage_hint', { files: number(storage.files) })} />
        <HeadlineCard Icon={ChartColumn} label={t('pc_kpi_forms')} value={number(forms.submitted)} hint={t('pc_kpi_forms_hint', { recent: number(forms.submitted_30d) })} />
        <HeadlineCard Icon={MessageSquare} label={t('pc_kpi_chat')} value={overview?.chat_messages == null ? t('label_unavailable') : number(overview.chat_messages)} />
        <HeadlineCard Icon={Mail} label={t('pc_kpi_emails')} value={number(emails.sent)} hint={t('pc_kpi_emails_hint', { pending: number(emails.pending), failed: number(emails.failed) })} />
        <HeadlineCard Icon={LifeBuoy} label={t('pc_kpi_tickets')} value={number(support.open)} hint={t('pc_kpi_tickets_hint', { unanswered: number(support.unanswered) })} />
      </div>

      <div className="pc-grid-2">
        <SignupsChart tenants={list} locale={locale} />
        <TopTenantsChart tenants={list} lang={lang} locale={locale} />
      </div>

      <SettingsLevels />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Console shell
// ---------------------------------------------------------------------------

const NotAuthorised = () => {
  const { t } = useLanguage();
  return (
    <main className="app-main empty-state">
      <Lock aria-hidden="true" />
      <h1>{t('pc_not_authorised')}</h1>
      <p>{t('pc_not_authorised_help')}</p>
    </main>
  );
};

const PlatformConsole = () => {
  const { t, locale } = useLanguage();
  const { profile } = useAuth();
  const { isPlatform } = useTenant();
  const params = useParams();

  const section = SECTIONS.some((item) => item.code === params?.section) ? params.section : 'overview';
  const allowed = canOperatePlatform({ roleCode: profile?.role_code, isPlatformTenant: isPlatform });

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [readAt, setReadAt] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  /** Re-reads the overview; safe to hand to a child that changed something. */
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!allowed) return undefined;

    let cancelled = false;
    loadPlatformOverview().then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) {
        setError(loadError);
        setOverview(null);
      } else {
        setError(null);
        setOverview(data);
        setReadAt(new Date().toISOString());
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [allowed, reloadToken]);

  if (!allowed) return <NotAuthorised />;

  const heading = SECTIONS.find((item) => item.code === section);

  return (
    <main className="app-main">
      <motion.div
        className="pc-console"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
      >
        <div className="pc-head">
          <div>
            <span className="section-kicker">{t('pc_console_eyebrow')}</span>
            <h1>{t('pc_console_title')}</h1>
            <p>{t('pc_console_subtitle')}</p>
          </div>
          <div className="pc-head-actions">
            {readAt ? <span className="pc-stamp">{t('pc_read_at', { time: formatDateTime(readAt, locale) })}</span> : null}
            <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
              <RefreshCcw aria-hidden="true" /> {t('action_refresh')}
            </button>
          </div>
        </div>

        {isPreviewMode() ? (
          <p className="pc-note"><Info aria-hidden="true" />{t('pc_demo_notice')}</p>
        ) : null}

        <nav className="pc-tabs" aria-label={t('pc_sections_nav')}>
          {SECTIONS.map(({ code, labelKey, Icon }) => (
            <Link
              key={code}
              href={code === 'overview' ? '/app/platform' : `/app/platform/${code}`}
              className={code === section ? 'active' : ''}
              aria-current={code === section ? 'page' : undefined}
            >
              <Icon aria-hidden="true" width={16} height={16} />
              {t(labelKey)}
            </Link>
          ))}
        </nav>

        <h2 className="sr-only">{t(heading?.labelKey || 'pc_tab_overview')}</h2>

        <div aria-live="polite" className={`pc-status-line ${error ? 'pc-error' : ''}`}>
          {loading ? t('label_loading') : ''}
          {error ? `${t('pc_loading_failed')} ${codeLabel(t, 'pc_err', errorCode(error), t('error_generic'))}` : ''}
        </div>

        {section === 'overview' && !error ? <OverviewScreen overview={overview} /> : null}
        {section === 'companies' ? <TenantsScreen tenants={overview?.top_tenants || []} loading={loading} onChanged={refresh} /> : null}
        {section === 'storage' ? <StorageManagement /> : null}
        {section === 'support' ? <SupportConsole /> : null}
        {section === 'health' ? <SystemHealth /> : null}
        {section === 'usage' ? <UsageStatistics /> : null}

        {section === 'overview' && !error && !loading && !overview ? (
          <p className="pc-note pc-note-warn"><ShieldCheck aria-hidden="true" />{t('label_no_results')}</p>
        ) : null}
      </motion.div>
    </main>
  );
};

export default PlatformConsole;
