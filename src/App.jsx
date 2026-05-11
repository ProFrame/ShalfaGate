import React from 'react';
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

// To change the documents, edit these mock arrays or use the Admin Dashboard
const mockDocs = [
  { id: 1, name: 'Employee Handbook 2026.pdf', type: 'pdf', size: '2.4 MB', date: '2026-05-01' },
  { id: 2, name: 'Safety Procedures.pdf', type: 'pdf', size: '1.1 MB', date: '2026-04-12' },
];

const mockDesigns = [
  { id: 1, name: 'Main Lobby Concept.jpg', type: 'image', size: '4.5 MB', date: '2026-05-05', url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=1000' },
  { id: 2, name: 'Office Layout B.png', type: 'image', size: '2.1 MB', date: '2026-03-20', url: 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&q=80&w=1000' },
];

function App() {
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
              <FileExplorer titleKey="docs" items={mockDocs} />
            } />

            <Route path="/circulars" element={
              <FileExplorer titleKey="circulars" items={mockDocs} />
            } />

            <Route path="/designs" element={
              <FileExplorer titleKey="designs" items={mockDesigns} />
            } />

            <Route path="/org" element={<OrgChartPage />} />

            <Route path="/admin-shalfa-2026" element={<AdminDashboard />} />
          </Routes>
        </div>
      </Router>
    </LanguageProvider>
  );
}

export default App;
