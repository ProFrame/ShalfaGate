import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Redirect, Route, Router, Switch } from 'wouter';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PreferencesProvider } from './context/PreferencesContext';
import { TenantProvider, useTenant } from './context/TenantContext';
import {
  BASE_PATH,
  DEFAULT_TENANT_SLUG,
  parseLocation,
  publicPath,
  readLegacyHashRoute,
  tenantPath,
} from './lib/routing';
import FileExplorer from './components/FileExplorer';
import OrgChartPage from './components/OrgChartPage';
import AuthPage from './components/AuthPage';
import LandingPage from './components/LandingPage';
import AppShell from './components/AppShell';
import EmployeeDashboard from './components/EmployeeDashboard';
import ResetPasswordPage from './components/ResetPasswordPage';
import { passwordSetupRequested } from './lib/supabaseClient';
import { loadPublishedContent } from './data/contentService';

const FormsPortal = lazy(() => import('./components/FormsPortal'));
const AdminCenter = lazy(() => import('./components/AdminCenter'));
const ApprovalCenter = lazy(() => import('./components/ApprovalCenter'));
const VerifyRequestPage = lazy(() => import('./components/VerifyRequestPage'));
const PortalSite = lazy(() => import('./components/public/PortalSite'));
const SignupPage = lazy(() => import('./components/public/SignupPage'));
const PublicSupportPage = lazy(() => import('./components/public/PublicSupportPage'));
const PlatformConsole = lazy(() => import('./components/platform/PlatformConsole'));
const NotesBoard = lazy(() => import('./components/notes/NotesBoard'));
const CalendarPage = lazy(() => import('./components/calendar/CalendarPage'));
const VerificationCenter = lazy(() => import('./components/verification/VerificationCenter'));

const LazyPage = ({ children }) => (
  <Suspense fallback={<div className="page-loader inline-loader"><span /></div>}>{children}</Suspense>
);

// The boundary sits outside LanguageProvider on purpose: it must still render
// when the context is the thing that failed, so it cannot call t(). It keeps
// its own copy instead, read straight from the stored language preference and
// falling back to English for anything it does not know.
const BOUNDARY_COPY = {
  en: {
    title: 'Page unavailable',
    body: 'Try again, and if the problem continues contact your system administrator.',
    retry: 'Retry',
  },
  ar: {
    title: 'تعذر فتح الصفحة',
    body: 'أعد المحاولة، وإذا استمرت المشكلة فتواصل مع مسؤول النظام.',
    retry: 'إعادة المحاولة',
  },
  hi: {
    title: 'पेज उपलब्ध नहीं है',
    body: 'फिर से प्रयास करें; समस्या बनी रहे तो अपने सिस्टम प्रशासक से संपर्क करें।',
    retry: 'पुनः प्रयास करें',
  },
  ur: {
    title: 'صفحہ دستیاب نہیں',
    body: 'دوبارہ کوشش کریں، اور مسئلہ برقرار رہے تو اپنے سسٹم ایڈمنسٹریٹر سے رابطہ کریں۔',
    retry: 'دوبارہ کوشش کریں',
  },
  tl: {
    title: 'Hindi available ang page',
    body: 'Subukan ulit, at kung magpapatuloy ang problema ay makipag-ugnayan sa iyong system administrator.',
    retry: 'Subukan ulit',
  },
};

// Reading storage can itself throw (private mode, blocked cookies), and the
// boundary is the last line of defence — never let it be the thing that fails.
const boundaryCopy = () => {
  try {
    return BOUNDARY_COPY[localStorage.getItem('bbnovix_lang')] || BOUNDARY_COPY.en;
  } catch {
    return BOUNDARY_COPY.en;
  }
};

class PageErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      const copy = boundaryCopy();
      return (
        <main className="app-main empty-state">
          <h1>{copy.title}</h1>
          <p>{copy.body}</p>
          <button className="primary-button" onClick={() => window.location.reload()}>
            {copy.retry}
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

const ProtectedPage = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <div className="page-loader"><span /></div>;
  return isAuthenticated ? <AppShell>{children}</AppShell> : <Redirect to="/login" replace />;
};

/** A screen that only exists while its module is switched on for the company. */
const ModulePage = ({ module, children }) => {
  const { hasModule } = useTenant();
  const { t } = useLanguage();
  if (module && !hasModule(module)) {
    return (
      <main className="app-main empty-state">
        <h1>{t('error_module_disabled')}</h1>
      </main>
    );
  }
  return children;
};

const TenantMissing = ({ reason }) => {
  const { t } = useLanguage();
  return (
    <main className="app-main empty-state">
      <h1>{reason === 'SUSPENDED' ? t('company_suspended') : t('company_not_found')}</h1>
      <p>{reason === 'SUSPENDED' ? t('company_suspended_help') : t('company_not_found_help')}</p>
      <a className="primary-button" href={publicPath('portal')}>{t('go_to_platform')}</a>
    </main>
  );
};

// Auth consumes the public security settings resolved by TenantProvider. This
// keeps session policy company-specific without issuing a second profile RPC.
const TenantAuthProvider = ({ tenantSlug, children }) => {
  const { settings } = useTenant();
  return (
    <AuthProvider tenantSlug={tenantSlug} securitySettings={settings}>
      {children}
    </AuthProvider>
  );
};

// ---------------------------------------------------------------------------
// The company workspace: /{slug}/...
// ---------------------------------------------------------------------------

const TenantRoutes = () => {
  const { loading, error, isSuspended } = useTenant();
  const [siteData, setSiteData] = useState({ orgChart: [], documents: [], circulars: [], designs: [] });

  useEffect(() => {
    let cancelled = false;

    const loadOrgChart = async () => {
      try {
        const saved = localStorage.getItem('bbnovix_site_data');
        if (saved) {
          const parsed = JSON.parse(saved);
          return Array.isArray(parsed.orgChart) ? parsed.orgChart : [];
        }
        const response = await fetch(`${import.meta.env.BASE_URL}data/site-data.json?t=${Date.now()}`);
        if (!response.ok) throw new Error(`Organization request failed: ${response.status}`);
        const parsed = await response.json();
        return Array.isArray(parsed.orgChart) ? parsed.orgChart : [];
      } catch (fetchError) {
        console.error('Organization data fetch failed', fetchError);
        return [];
      }
    };

    const refreshData = async () => {
      try {
        const [orgChart, content] = await Promise.all([loadOrgChart(), loadPublishedContent()]);
        if (!cancelled) setSiteData({ orgChart, ...content });
      } catch (refreshError) {
        console.error('Portal data fetch failed', refreshError);
      }
    };

    refreshData();
    window.addEventListener('storage', refreshData);
    window.addEventListener('bbnovix-content-updated', refreshData);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', refreshData);
      window.removeEventListener('bbnovix-content-updated', refreshData);
    };
  }, []);

  if (loading) return <div className="page-loader"><span /></div>;
  if (error) return <TenantMissing reason={error} />;
  if (isSuspended) return <TenantMissing reason="SUSPENDED" />;

  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={AuthPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />

      <Route path="/app"><ProtectedPage><EmployeeDashboard siteData={siteData} /></ProtectedPage></Route>
      <Route path="/app/forms">
        <ProtectedPage><ModulePage module="FORMS"><PageErrorBoundary><LazyPage><FormsPortal /></LazyPage></PageErrorBoundary></ModulePage></ProtectedPage>
      </Route>
      <Route path="/app/approvals">
        <ProtectedPage><ModulePage module="APPROVALS"><PageErrorBoundary><LazyPage><ApprovalCenter /></LazyPage></PageErrorBoundary></ModulePage></ProtectedPage>
      </Route>
      <Route path="/app/documents"><ProtectedPage><FileExplorer titleKey="docs" items={siteData.documents} /></ProtectedPage></Route>
      <Route path="/app/circulars"><ProtectedPage><FileExplorer titleKey="circulars" items={siteData.circulars} /></ProtectedPage></Route>
      <Route path="/app/designs"><ProtectedPage><FileExplorer titleKey="designs" items={siteData.designs} /></ProtectedPage></Route>
      <Route path="/app/org"><ProtectedPage><OrgChartPage data={siteData.orgChart} /></ProtectedPage></Route>
      <Route path="/app/notes">
        <ProtectedPage><ModulePage module="NOTES"><PageErrorBoundary><LazyPage><NotesBoard /></LazyPage></PageErrorBoundary></ModulePage></ProtectedPage>
      </Route>
      <Route path="/app/calendar">
        <ProtectedPage><ModulePage module="CALENDAR"><PageErrorBoundary><LazyPage><CalendarPage /></LazyPage></PageErrorBoundary></ModulePage></ProtectedPage>
      </Route>
      <Route path="/app/verification/:section?">
        <ProtectedPage><ModulePage module="VERIFICATION"><PageErrorBoundary><LazyPage><VerificationCenter /></LazyPage></PageErrorBoundary></ModulePage></ProtectedPage>
      </Route>
      <Route path="/app/admin/:section?">
        <ProtectedPage><PageErrorBoundary><LazyPage><AdminCenter /></LazyPage></PageErrorBoundary></ProtectedPage>
      </Route>
      <Route path="/app/platform/:section?">
        <ProtectedPage><PageErrorBoundary><LazyPage><PlatformConsole /></LazyPage></PageErrorBoundary></ProtectedPage>
      </Route>

      {/* A company address may still be used to verify a document. */}
      <Route path="/verify/:code?"><PageErrorBoundary><LazyPage><VerifyRequestPage /></LazyPage></PageErrorBoundary></Route>

      <Route path="/forms"><Redirect to="/app/forms" replace /></Route>
      <Route path="/documents"><Redirect to="/app/documents" replace /></Route>
      <Route path="/circulars"><Redirect to="/app/circulars" replace /></Route>
      <Route path="/designs"><Redirect to="/app/designs" replace /></Route>
      <Route>{passwordSetupRequested ? <div className="page-loader"><span /></div> : <Redirect to="/" replace />}</Route>
    </Switch>
  );
};

// ---------------------------------------------------------------------------
// Everything that is not a company: the product site and the public services.
// ---------------------------------------------------------------------------

const PublicRoutes = () => (
  <Switch>
    <Route path="/"><Redirect to="/portal" replace /></Route>
    <Route path="/portal"><PageErrorBoundary><LazyPage><PortalSite /></LazyPage></PageErrorBoundary></Route>
    <Route path="/signup"><PageErrorBoundary><LazyPage><SignupPage /></LazyPage></PageErrorBoundary></Route>
    <Route path="/support/:ticket?"><PageErrorBoundary><LazyPage><PublicSupportPage /></LazyPage></PageErrorBoundary></Route>
    <Route path="/verify/:code?"><PageErrorBoundary><LazyPage><VerifyRequestPage /></LazyPage></PageErrorBoundary></Route>
    <Route><Redirect to="/portal" replace /></Route>
  </Switch>
);

// ---------------------------------------------------------------------------

function App() {
  // Old links were `#/route` under a single company. Rewrite them once so a
  // bookmark from the previous version still lands in the right place.
  const [entry] = useState(() => {
    const legacy = readLegacyHashRoute();
    const parsed = parseLocation();
    if (legacy && parsed.scope === 'public' && !parsed.section) {
      const target = `${tenantPath(DEFAULT_TENANT_SLUG, legacy.replace(/^\//, ''))}${window.location.search}`;
      window.history.replaceState(null, '', target);
      return parseLocation(new URL(target, window.location.origin).pathname);
    }
    return parsed;
  });

  const routerBase = useMemo(
    () => (entry.scope === 'tenant' ? `${BASE_PATH}/${entry.slug}` : BASE_PATH),
    [entry],
  );

  return (
    <LanguageProvider>
      <PreferencesProvider>
        <TenantProvider slug={entry.scope === 'tenant' ? entry.slug : null}>
          <TenantAuthProvider tenantSlug={entry.scope === 'tenant' ? entry.slug : null}>
            <Router base={routerBase}>
              <div className="app-root">
                {entry.scope === 'tenant' ? <TenantRoutes /> : <PublicRoutes />}
              </div>
            </Router>
          </TenantAuthProvider>
        </TenantProvider>
      </PreferencesProvider>
    </LanguageProvider>
  );
}

export default App;
