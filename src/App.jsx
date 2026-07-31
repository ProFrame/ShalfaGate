import { Component, lazy, Suspense, useEffect, useState } from 'react';
import { Redirect, Route, Router, Switch } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { LanguageProvider } from './context/LanguageContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PreferencesProvider } from './context/PreferencesContext';
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
const LazyPage = ({ children }) => <Suspense fallback={<div className="page-loader inline-loader"><span /></div>}>{children}</Suspense>;

class PageErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-main empty-state">
          <h1>تعذر فتح الصفحة · Page unavailable</h1>
          <p>أعد المحاولة، وإذا استمرت المشكلة فتواصل مع مسؤول النظام.</p>
          <button className="primary-button" onClick={() => window.location.reload()}>إعادة المحاولة · Retry</button>
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

function App() {
  const [siteData, setSiteData] = useState({ orgChart: [], documents: [], circulars: [], designs: [] });

  useEffect(() => {
    let cancelled = false;

    const loadOrgChart = async () => {
      try {
        const saved = localStorage.getItem('shalfa_site_data');
        if (saved) {
          const parsed = JSON.parse(saved);
          return Array.isArray(parsed.orgChart) ? parsed.orgChart : [];
        }
        const response = await fetch(`${import.meta.env.BASE_URL}data/site-data.json?t=${Date.now()}`);
        if (!response.ok) throw new Error(`Organization request failed: ${response.status}`);
        const parsed = await response.json();
        return Array.isArray(parsed.orgChart) ? parsed.orgChart : [];
      } catch (error) {
        console.error('Organization data fetch failed', error);
        return [];
      }
    };

    const refreshData = async () => {
      try {
        const [orgChart, content] = await Promise.all([loadOrgChart(), loadPublishedContent()]);
        if (!cancelled) setSiteData({ orgChart, ...content });
      } catch (error) {
        console.error('Portal data fetch failed', error);
      }
    };

    refreshData();
    window.addEventListener('storage', refreshData);
    window.addEventListener('shalfa-content-updated', refreshData);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', refreshData);
      window.removeEventListener('shalfa-content-updated', refreshData);
    };
  }, []);

  return (
    <LanguageProvider>
      <PreferencesProvider>
        <AuthProvider>
          <Router hook={useHashLocation}>
            <div className="app-root">
              <Switch>
                <Route path="/" component={LandingPage} />
                <Route path="/login" component={AuthPage} />
                <Route path="/reset-password" component={ResetPasswordPage} />
                <Route path="/app"><ProtectedPage><EmployeeDashboard siteData={siteData} /></ProtectedPage></Route>
                <Route path="/app/forms"><ProtectedPage><PageErrorBoundary><LazyPage><FormsPortal /></LazyPage></PageErrorBoundary></ProtectedPage></Route>
                <Route path="/app/approvals"><ProtectedPage><PageErrorBoundary><LazyPage><ApprovalCenter /></LazyPage></PageErrorBoundary></ProtectedPage></Route>
                <Route path="/verify"><PageErrorBoundary><LazyPage><VerifyRequestPage /></LazyPage></PageErrorBoundary></Route>
                <Route path="/app/documents"><ProtectedPage><FileExplorer titleKey="docs" items={siteData.documents} /></ProtectedPage></Route>
                <Route path="/app/circulars"><ProtectedPage><FileExplorer titleKey="circulars" items={siteData.circulars} /></ProtectedPage></Route>
                <Route path="/app/designs"><ProtectedPage><FileExplorer titleKey="designs" items={siteData.designs} /></ProtectedPage></Route>
                <Route path="/app/org"><ProtectedPage><OrgChartPage data={siteData.orgChart} /></ProtectedPage></Route>
                <Route path="/app/admin"><ProtectedPage><PageErrorBoundary><LazyPage><AdminCenter /></LazyPage></PageErrorBoundary></ProtectedPage></Route>
                <Route path="/forms"><Redirect to="/app/forms" replace /></Route>
                <Route path="/documents"><Redirect to="/app/documents" replace /></Route>
                <Route path="/circulars"><Redirect to="/app/circulars" replace /></Route>
                <Route path="/designs"><Redirect to="/app/designs" replace /></Route>
                <Route>{passwordSetupRequested ? <div className="page-loader"><span /></div> : <Redirect to="/" replace />}</Route>
              </Switch>
            </div>
          </Router>
        </AuthProvider>
      </PreferencesProvider>
    </LanguageProvider>
  );
}

export default App;
