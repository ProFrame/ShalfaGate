import { useCallback, useEffect, useState } from 'react';
import {
  Activity, Cpu, Database, HardDrive, LifeBuoy, Mail, MemoryStick, RefreshCcw, Server, ShieldAlert,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { errorCode, isPreviewMode, loadPlatformHealth } from '../../data/platformService';
import { codeLabel, formatBytes, formatDateTime, formatNumber } from '../../utils/localize';

const Card = ({ Icon, title, badge, children, className = '' }) => (
  <section className={`pc-health-card ${className}`}>
    <header>
      <Icon aria-hidden="true" />
      <h3>{title}</h3>
      {badge}
    </header>
    {children}
  </section>
);

const Line = ({ label, value }) => (
  <div className="pc-health-line">
    <span>{label}</span>
    <b>{value}</b>
  </div>
);

/**
 * Postgres cannot report the host CPU or memory. Rather than invent a number
 * the card says so and explains where the figure actually lives.
 */
const UnmeasuredCard = ({ Icon, title }) => {
  const { t } = useLanguage();
  return (
    <Card
      Icon={Icon}
      title={title}
      className="pc-unmeasured"
      badge={<span className="pc-chip">{t('pc_health_not_measured')}</span>}
    >
      <p>{t('pc_health_not_measured_body')}</p>
    </Card>
  );
};

const SystemHealth = () => {
  const { t, locale } = useLanguage();
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadPlatformHealth().then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) { setError(loadError); setHealth(null); } else { setError(null); setHealth(data); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const database = health?.database || {};
  const storage = health?.storage || {};
  const emails = health?.emails || {};
  const jobs = health?.jobs || {};
  const support = health?.support || {};
  const security = health?.security || {};
  const byStatus = emails.by_status || {};
  const number = (value) => formatNumber(Number(value || 0), locale);

  return (
    <div className="pc-console">
      <div className="pc-head">
        <p className="field-note">{t('pc_health_intro')}</p>
        <div className="pc-head-actions">
          {health?.measured_on ? (
            <span className="pc-stamp">{t('pc_read_at', { time: formatDateTime(health.measured_on, locale) })}</span>
          ) : null}
          <button type="button" className="secondary-button" onClick={reload} disabled={loading}>
            <RefreshCcw aria-hidden="true" /> {t('action_refresh')}
          </button>
        </div>
      </div>

      <div aria-live="polite" className={`pc-status-line ${error ? 'pc-error' : ''}`}>
        {loading ? t('label_loading') : ''}
        {error ? codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) : ''}
      </div>

      <div className="pc-health-grid">
        <UnmeasuredCard Icon={Cpu} title={t('pc_health_cpu')} />
        <UnmeasuredCard Icon={MemoryStick} title={t('pc_health_memory')} />

        <Card Icon={Database} title={t('pc_health_database')}>
          <div className="pc-health-lines">
            <Line label={t('label_code')} value={database.name || '—'} />
            <Line label={t('pc_health_db_size')} value={formatBytes(database.size_bytes, locale)} />
            <Line label={t('pc_health_tables')} value={number(database.tables)} />
            <Line label={t('pc_health_rows')} value={number(database.live_rows)} />
            <Line label={t('pc_health_connections')} value={number(database.connections)} />
          </div>
        </Card>

        <Card
          Icon={Server}
          title={t('pc_health_supabase')}
          badge={(
            <span className={`pc-chip ${isPreviewMode() ? 'pc-chip-pending' : 'pc-chip-active'}`}>
              {t(isPreviewMode() ? 'pc_health_local_preview' : 'pc_health_reachable')}
            </span>
          )}
        >
          <div className="pc-health-lines">
            <Line label={t('pc_health_storage')} value={formatBytes(storage.bytes, locale)} />
            <Line label={t('pc_health_providers_connected')} value={number(storage.tenants_with_provider)} />
            <Line label={t('pc_health_providers_failing')} value={number(storage.providers_failing)} />
          </div>
        </Card>

        <Card Icon={HardDrive} title={t('pc_health_storage')}>
          <div className="pc-health-lines">
            <Line label={t('pc_health_files')} value={number(storage.files)} />
            <Line label={t('pc_storage_totals')} value={formatBytes(storage.bytes, locale)} />
          </div>
        </Card>

        <Card Icon={Mail} title={t('pc_health_emails')}>
          <div className="pc-health-lines">
            <Line label={t('pc_health_queue')} value={number(emails.queue_depth)} />
            <Line label={t('pc_health_failed')} value={number(emails.failed)} />
            <Line
              label={t('pc_health_oldest_pending')}
              value={emails.oldest_pending_on ? formatDateTime(emails.oldest_pending_on, locale) : t('label_none')}
            />
            <Line label={t('pc_health_stuck')} value={number(emails.stuck_processing)} />
            {Object.entries(byStatus).map(([statusCode, count]) => (
              <Line key={statusCode} label={codeLabel(t, 'status', statusCode, statusCode)} value={number(count)} />
            ))}
          </div>
        </Card>

        <Card Icon={Activity} title={t('pc_health_jobs')}>
          <div className="pc-health-lines">
            <Line label={t('pc_health_imports_failed')} value={number(jobs.imports_failed)} />
            <Line label={t('pc_health_imports_running')} value={number(jobs.imports_running)} />
            <Line
              label={t('pc_health_last_snapshot')}
              value={jobs.last_usage_snapshot ? formatDateTime(jobs.last_usage_snapshot, locale) : t('label_none')}
            />
          </div>
        </Card>

        <Card Icon={LifeBuoy} title={t('pc_health_support')}>
          <div className="pc-health-lines">
            <Line label={t('pc_health_open_tickets')} value={number(support.open)} />
            <Line label={t('pc_health_unanswered_24h')} value={number(support.unanswered_24h)} />
          </div>
        </Card>

        <Card Icon={ShieldAlert} title={t('pc_health_security')}>
          <div className="pc-health-lines">
            <Line label={t('pc_health_failed_logins')} value={number(security.failed_logins_24h)} />
            <Line label={t('pc_health_critical_events')} value={number(security.critical_events_7d)} />
          </div>
        </Card>
      </div>

      <section className="pc-panel">
        <header><div><h2>{t('pc_health_largest_tables')}</h2></div></header>
        <div className="data-table-wrap">
          <table className="enterprise-table">
            <thead>
              <tr>
                <th>{t('pc_col_table')}</th>
                <th>{t('pc_col_rows')}</th>
                <th>{t('pc_col_size')}</th>
              </tr>
            </thead>
            <tbody>
              {(database.largest_tables || []).map((row) => (
                <tr key={row.table}>
                  <td><span className="pc-slug">{row.table}</span></td>
                  <td>{number(row.rows)}</td>
                  <td>{formatBytes(row.size_bytes, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(database.largest_tables || []).length === 0 ? (
            <div className="empty-table compact"><Database aria-hidden="true" /><b>{t('label_no_results')}</b></div>
          ) : null}
        </div>
      </section>
    </div>
  );
};

export default SystemHealth;
