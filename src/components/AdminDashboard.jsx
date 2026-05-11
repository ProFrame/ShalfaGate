import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, LayoutDashboard } from 'lucide-react';
import OrgAdminManager from './OrgAdminManager';

const AdminDashboard = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030712] px-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md glass p-10 rounded-3xl text-center"
        >
          <div className="w-16 h-16 bg-primary/20 rounded-2xl flex items-center justify-center mx-auto mb-8">
            <Lock className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Admin Portal</h1>
          <p className="text-slate-400 mb-8 text-sm">Restricted access for authorized personnel only.</p>
          
          <input 
            type="password" 
            placeholder="Enter Admin Password"
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl mb-6 text-center focus:outline-none focus:border-primary transition-all text-white"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (password === 'shalfa2026' ? setIsAuthenticated(true) : alert('Incorrect password'))}
          />
          
          <button 
            onClick={() => {
              if(password === 'shalfa2026') setIsAuthenticated(true);
              else alert('Incorrect password');
            }}
            className="w-full py-4 bg-primary text-white font-bold rounded-xl shadow-xl shadow-blue-500/20 hover:bg-blue-600 transition-all"
          >
            Authenticate
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#030712] pt-28 pb-12 px-6">
      <div className="container mx-auto max-w-6xl">
        <div className="flex items-center gap-4 mb-10">
          <div className="p-3 bg-primary/10 rounded-2xl border border-primary/20 text-primary">
            <LayoutDashboard size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white">Site Management</h1>
            <p className="text-slate-400">Control all aspects of Shalfa Corporate Portal.</p>
          </div>
        </div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }} 
          animate={{ opacity: 1, y: 0 }}
        >
          <OrgAdminManager />
        </motion.div>
      </div>
    </div>
  );
};

export default AdminDashboard;
