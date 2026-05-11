import React from 'react';
import Header from './components/Header';
import Hero from './components/Hero';
import Features from './components/Features';
import Footer from './components/Footer';

function App() {
  return (
    <div className="min-h-screen selection:bg-primary/30 selection:text-white">
      <Header />
      <main>
        <Hero />
        <Features />
      </main>
      <Footer />
    </div>
  );
}

export default App;
