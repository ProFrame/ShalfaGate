import { useEffect, useMemo, useState } from 'react';
import { Activity, ChartColumn, Clock, HardDrive, Mail, MessageSquare, RefreshCcw, Users } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLanguage } from '../../context/LanguageContext';
import {
  BYTE_METRICS, errorCode, loadPlatformUsage, runUsageSnapshot, USAGE_METRICS, USAGE_PERIODS,
} from '../../data/platformService';
import { codeLabel, formatBytes, formatDate, formatDateTime, formatNumber } from '../../utils/localize';

// The columns the plan asks for, in its order.
const TABLE_METRICS = [
  'ACTIVE_USERS', 'LOGINS_30D', 'STORAGE_BYTES', 'FORMS_SUBMITTED',
  'CHAT_MESSAGES', 'NOTIFICATIONS_SENT', 'API_CALLS',
];

const HEADLINE_METRICS = [
  { code: 'ACTIVE_USERS_30D', Icon: Users },
  { code: 'LOGINS_30D', Icon: Activity },
  { code: 'STORAGE_BYTES', Icon: HardDrive },
  { code: 'FORMS_SUBMITTED', Icon: ChartColumn },
  { code: 'CHAT_MESSAGES', Icon: MessageSquare },
  { code: 'NOTIFICATIONS_SENT', Icon: Mail },
  { code: 'API_CALLS', Icon: Activity },
];

const metricLabel = (t, code) => codeLabel(t, 'pc_m', code, code);

const UsageStatistics = () => {
  const { t, locale } = useLanguage();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState('ACTIVE_USERS_30D');
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState({ tone: 'ok', text: '' });

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadPlatformUsage(days).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
        setUsage(null);
      } else {
        setUsage(data);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [days, reloadToken, t]);

  const byTenant = useMemo(() => usage?.by_tenant || [], [usage]);

  /** Platform totals are the sum of the latest rollup of every company. */
  const totals = useMemo(() => {
    const sum = {};
    byTenant.forEach((row) => {
      Object.entries(row.metrics || {}).forEach(([code, value]) => {
        sum[code] = (sum[code] || 0) + Number(value || 0);
      });
    });
    return sum;
  }, [byTenant]);

  const lastLogin = useMemo(() => (
    byTenant.reduce((latest, row) => (
      row.last_login && (!latest || row.last_login > latest) ? row.last_login : latest
    ), null)
  ), [byTenant]);

  const series = useMemo(() => (
    (usage?.daily || [])
      .filter((row) => row.metric_code === metric)
      .map((row) => ({
        date: row.usage_date,
        label: formatDate(row.usage_date, locale, { month: 'short', day: 'numeric' }),
        value: Number(row.metric_value || 0),
      }))
  ), [usage, metric, locale]);

  const formatMetric = (code, value) => (
    BYTE_METRICS.has(code) ? formatBytes(value, locale) : formatNumber(Number(value || 0), locale)
  );

  return (
    <div className="pc-console">
      <div className="pc-head">
        <p className="field-note">{t('pc_usage_intro')}</p>
        <div className="pc-head-actions">
          <label className="sr-only" htmlFor="pc-usage-period">{t('pc_period')}</label>
          <select
            id="pc-usage-period"
            className="pc-select"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {USAGE_PERIODS.map((period) => (
              <option key={period} value={period}>{t(`pc_period_${period}`)}</option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || loading}
            onClick={async () => {
              setBusy(true);
              const { data, error } = await runUsageSnapshot();
              if (error) {
                setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
              } else {
                setFeedback({ tone: 'ok', text: t('pc_snapshot_done', { count: formatNumber(data?.tenants || 0, locale) }) });
                setLoading(true);
                setReloadToken((token) => token + 1);
              }
              setBusy(false);
            }}
          >
            <RefreshCcw aria-hidden="true" /> {t('pc_run_snapshot')}
          </button>
        </div>
      </div>

      <div aria-live="polite" className={`pc-status-line ${feedback.tone === 'error' ? 'pc-error' : ''}`}>
        {loading ? t('label_loading') : feedback.text}
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <Clock aria-hidden="true" />
          <div>
            <span>{t('pc_col_last_login')}</span>
            <b>{lastLogin ? formatDateTime(lastLogin, locale) : t('pc_never')}</b>
          </div>
        </div>
        {HEADLINE_METRICS.map(({ code, Icon }) => (
          <div className="kpi-card" key={code}>
            <Icon aria-hidden="true" />
            <div>
              <span>{metricLabel(t, code)}</span>
              <b>{formatMetric(code, totals[code] || 0)}</b>
            </div>
          </div>
        ))}
      </div>

      <section className="pc-panel">
        <header>
          <div>
            <h2>{t('pc_usage_total')}</h2>
            <p>
              {usage?.from ? formatDate(usage.from, locale) : ''}
              {usage?.from && usage?.to ? ' — ' : ''}
              {usage?.to ? formatDate(usage.to, locale) : ''}
            </p>
          </div>
          <div>
            <label className="sr-only" htmlFor="pc-usage-metric">{t('pc_metric')}</label>
            <select
              id="pc-usage-metric"
              className="pc-select"
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
            >
              {USAGE_METRICS.map((code) => (
                <option key={code} value={code}>{metricLabel(t, code)}</option>
              ))}
            </select>
          </div>
        </header>

        {series.length === 0 ? (
          <p className="field-note">{t('pc_no_usage')}</p>
        ) : (
          <div className="pc-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pcUsage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis
                  width={54}
                  tick={{ fontSize: 11, fill: 'var(--muted)' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => formatMetric(metric, value)}
                />
                <Tooltip
                  formatter={(value) => [formatMetric(metric, value), metricLabel(t, metric)]}
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}
                />
                <Area type="monotone" dataKey="value" name={metricLabel(t, metric)} stroke="var(--brand)" strokeWidth={2} fill="url(#pcUsage)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="pc-panel">
        <header><div><h2>{t('pc_usage_by_company')}</h2></div></header>
        <div className="data-table-wrap">
          <table className="enterprise-table">
            <thead>
              <tr>
                <th>{t('pc_col_company')}</th>
                <th>{t('pc_col_last_login')}</th>
                {TABLE_METRICS.map((code) => <th key={code}>{metricLabel(t, code)}</th>)}
              </tr>
            </thead>
            <tbody>
              {byTenant.map((row) => (
                <tr key={row.tenant_id}>
                  <td><span className="pc-slug">/{row.slug}</span></td>
                  <td>{row.last_login ? formatDate(row.last_login, locale) : t('pc_never')}</td>
                  {TABLE_METRICS.map((code) => (
                    <td key={code}>{formatMetric(code, row.metrics?.[code] || 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {byTenant.length === 0 ? (
            <div className="empty-table compact"><ChartColumn aria-hidden="true" /><b>{t('pc_no_usage')}</b></div>
          ) : null}
        </div>
      </section>
    </div>
  );
};

export default UsageStatistics;
