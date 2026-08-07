import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Inbox, ScanSearch, Search, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import { searchMyRequests } from '../data/approvalService';
import { FALLBACK_SCREENS, loadMyScreens } from '../data/notificationCenterService';
import { pickLocalized } from '../utils/localize';
import { verifyUrl } from '../lib/routing';

// Portal-wide search: jumps to a screen, finds one of your own requests by
// reference/verification code, or hands a code straight to the public
// verification page.
//
// The "jump to a screen" destinations used to be a small, hand-maintained
// array naming only 7-8 screens, which drifted the moment a new module
// shipped. They are now built from the same public.my_screens() rows
// AppShell.jsx's own useNavigationGroups() and AdminNav.jsx's own
// useAdminNavigation() already load — portal AND admin screens alike,
// already filtered by module/role on the server — so a screen becomes
// searchable the day it is registered, with nothing to hand-edit here.
const GlobalSearch = () => {
  const { t, lang } = useLanguage();
  const { isModuleAllowed } = useTenant();
  const [, navigate] = useLocation();
  const wrapRef = useRef(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [screens, setScreens] = useState(FALLBACK_SCREENS);

  // Loaded once per mount and cached in state, exactly like AppShell.jsx's own
  // useNavigationGroups(). `data: null` means the RPC could not answer (an
  // unmigrated database, a network blip, or local preview): FALLBACK_SCREENS
  // — the very same list AppShell.jsx falls back to — keeps the box useful
  // rather than going empty, instead of inventing a second fallback here.
  useEffect(() => {
    let cancelled = false;
    loadMyScreens().then(({ data }) => {
      if (!cancelled && data?.length) setScreens(data);
    });
    return () => { cancelled = true; };
  }, []);

  // A company whose profile carries no module map at all (local preview, or a
  // profile that predates licensing) is treated as "everything on" — the same
  // rule AppShell.jsx's own useNavigationGroups() applies, via the shared
  // TenantContext.isModuleAllowed() helper. Real rows already arrive
  // pre-filtered by public.my_screens() itself; this only matters for the
  // FALLBACK_SCREENS case, so a company without e.g. the Notes module does
  // not see "Notes" offered while the RPC is unreachable.
  const destinations = useMemo(() => {
    return screens
      .filter((screen) => screen.path && isModuleAllowed(screen.module_code))
      .map((screen) => ({
        id: screen.code,
        label: pickLocalized(screen, 'name', lang, screen.labelKey ? t(screen.labelKey) : screen.code),
        to: screen.path,
      }));
  }, [screens, lang, t, isModuleAllowed]);

  useEffect(() => {
    const close = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    const term = query.trim();
    let cancelled = false;
    const timer = setTimeout(() => {
      if (term.length < 2) {
        setRequests([]);
        return;
      }
      searchMyRequests(term)
        .then((rows) => { if (!cancelled) setRequests(rows); })
        .catch(() => { if (!cancelled) setRequests([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const needle = query.trim();
  // Never show results that belong to a previous query.
  const matchedRequests = needle.length >= 2 ? requests : [];
  const normalized = needle.toLocaleLowerCase();
  const matchedDestinations = normalized
    ? destinations.filter((item) => item.label.toLocaleLowerCase().includes(normalized))
    : destinations.slice(0, 4);
  // Document codes are either legacy digits or the tenant-prefixed form
  // SHALFA-123456789012 introduced with the multi-tenant platform.
  const looksLikeCode = /^(\d{6,}|[A-Za-z0-9]{2,32}-\d{6,})$/.test(needle);
  const requestName = (row) => pickLocalized(row, 'template_name', lang, row.template_name);

  const results = [
    ...(looksLikeCode ? [{
      key: `verify:${needle}`, icon: ScanSearch, title: t('verify_this_code', { code: needle }), hint: t('verify_title'),
      run: () => { window.open(verifyUrl(needle), '_blank', 'noopener'); },
    }] : []),
    ...matchedRequests.map((row) => ({
      key: `form:${row.id}`, icon: FileText, title: requestName(row) || row.reference_no,
      hint: [row.reference_no, t(`status_${String(row.status).toLowerCase()}`) !== `status_${String(row.status).toLowerCase()}` ? t(`status_${String(row.status).toLowerCase()}`) : row.status].filter(Boolean).join(' · '),
      run: () => navigate('/app/approvals'),
    })),
    ...matchedDestinations.map((item) => ({
      key: `nav:${item.id}`, icon: item.to === '/app/approvals' ? Inbox : Search, title: item.label, hint: t('go_to_page'),
      run: () => navigate(item.to),
    })),
  ];

  const runResult = (result) => {
    setOpen(false);
    setQuery('');
    result.run();
  };

  return (
    <div className="global-search-wrap" ref={wrapRef}>
      <div className="global-search">
        <Search size={18} />
        <input
          value={query}
          placeholder={t('search_portal')}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); setHighlight(0); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((value) => Math.min(value + 1, results.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((value) => Math.max(value - 1, 0)); }
            if (event.key === 'Enter' && results[highlight]) { event.preventDefault(); runResult(results[highlight]); }
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        {query && <button type="button" className="search-clear" onClick={() => { setQuery(''); setRequests([]); }} aria-label={t('clear')}><X size={15} /></button>}
      </div>
      {open && (
        <div className="popover global-search-results">
          {results.length ? results.map((result, index) => (
            <button
              key={result.key}
              className={index === highlight ? 'active' : ''}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => runResult(result)}
            >
              <result.icon size={16} />
              <span><b>{result.title}</b><small>{result.hint}</small></span>
            </button>
          )) : <div className="notification-empty">{t('no_search_results')}</div>}
        </div>
      )}
    </div>
  );
};

export default GlobalSearch;
