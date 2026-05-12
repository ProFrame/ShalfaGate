import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { LanguageProvider } from './context/LanguageContext';
import Header from './components/Header';
import Hero from './components/Hero';
import DashboardGrid from './components/DashboardGrid';
import Footer from './components/Footer';
import PDFViewer from './components/PDFViewer';
import FileExplorer from './components/FileExplorer';
import AdminDashboard from './components/AdminDashboard';
import OrgChartPage from './components/OrgChartPage';

function App() {
  const [siteData, setSiteData] = useState({ orgChart: [], documents: [], circulars: [], designs: [] });

  useEffect(() => {
    const loadInitialData = async () => {
      const saved = localStorage.getItem('shalfa_site_data');
      if (saved) {
        setSiteData(JSON.parse(saved));
      } else {
        try {
          const res = await fetch('data/site-data.json?t=' + new Date().getTime());
          const json = await res.json();
          setSiteData(json);
        } catch (e) {
          console.error("Data fetch failed", e);
        }
      }
    };

    loadInitialData();

    // Listen for local changes (Preview Mode)
    const handleStorage = () => {
      const saved = localStorage.getItem('shalfa_site_data');
      if (saved) setSiteData(JSON.parse(saved));
    };

    window.addEventListener('storage', handleStorage);
    // Interval check for same-window updates
    const interval = setInterval(handleStorage, 1000);

    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(interval);
    };
  }, []);

  return (
    <LanguageProvider>
      <Router>
        <div className="min-h-screen selection:bg-primary/30 selection:text-white bg-[#030712] transition-colors duration-500">
          <Header />
          <Routes>
            <Route path="/" element={
              <>
                <Hero />
                <DashboardGrid />
                <Footer />
              </>
            } />
            
            <Route path="/forms" element={
              <PDFViewer 
                titleKey="forms" 
                url="https://drive.google.com/file/d/1ubPnCUmD1StRTT5_nkLmCgyP4a3IElpN/view?pli=1" 
              />
            } />

            <Route path="/documents" element={
              <FileExplorer titleKey="docs" items={siteData.documents} />
            } />

            <Route path="/circulars" element={
              <FileExplorer titleKey="circulars" items={siteData.circulars} />
            } />

            <Route path="/designs" element={
              <FileExplorer titleKey="designs" items={siteData.designs} />
            } />

            <Route path="/org" element={<OrgChartPage data={siteData.orgChart} />} />

            <Route path="/admin-shalfa-2026" element={<AdminDashboard />} />
          </Routes>
        </div>
      </Router>
    </LanguageProvider>
  );
}

export default App;
