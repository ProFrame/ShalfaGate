import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Inbox, ScanSearch, Search, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { useLanguage } from '../context/LanguageContext';
import { searchMyRequests } from '../data/approvalService';

// Portal-wide search: jumps to a screen, finds one of your own requests by
// reference/verification code, or hands a code straight to the public
// verification page.
const GlobalSearch = ({ isAdmin }) => {
  const { t, lang } = useLanguage();
  const [, navigate] = useLocation();
  const wrapRef = useRef(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState([]);
  const [highlight, setHighlight] = useState(0);

  const destinations = useMemo(() => ([
    { id: 'home', label: t('home'), to: '/app' },
    { id: 'forms', label: t('forms'), to: '/app/forms' },
    { id: 'approvals', label: t('approval_center'), to: '/app/approvals' },
    { id: 'docs', label: t('docs'), to: '/app/documents' },
    { id: 'circulars', label: t('circulars'), to: '/app/circulars' },
    { id: 'designs', label: t('designs'), to: '/app/designs' },
    { id: 'org', label: t('organization_chart'), to: '/app/org' },
    ...(isAdmin ? [{ id: 'admin', label: t('administration'), to: '/app/admin' }] : []),
  ]), [t, isAdmin]);

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
  const looksLikeCode = /^\d{6,}$/.test(needle);
  const requestName = (row) => (
    lang === 'ar' || lang === 'ur'
      ? row.template_name_ar || row.template_name
      : row.template_name_en || row.template_name
  );

  const results = [
    ...(looksLikeCode ? [{
      key: `verify:${needle}`, icon: ScanSearch, title: t('verify_this_code', { code: needle }), hint: t('verify_title'),
      run: () => { window.open(`${import.meta.env.BASE_URL || '/'}#/verify?code=${needle}`, '_blank', 'noopener'); },
    }] : []),
    ...matchedRequests.map((row) => ({
      key: `form:${row.id}`, icon: FileText, title: requestName(row) || row.reference_no,
      hint: [row.reference_no, t(`status_${String(row.status).toLowerCase()}`) !== `status_${String(row.status).toLowerCase()}` ? t(`status_${String(row.status).toLowerCase()}`) : row.status].filter(Boolean).join(' · '),
      run: () => navigate('/app/approvals'),
    })),
    ...matchedDestinations.map((item) => ({
      key: `nav:${item.id}`, icon: item.id === 'approvals' ? Inbox : Search, title: item.label, hint: t('go_to_page'),
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
