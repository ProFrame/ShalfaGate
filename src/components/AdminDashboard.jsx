import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Edit2, Trash2, Lock, Files, Network } from 'lucide-react';
import OrgAdminManager from './OrgAdminManager';

const AdminDashboard = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [activeTab, setActiveTab] = useState('docs'); // docs, org
  
  // Mock data for management
  const [docs, setDocs] = useState([
    { id: 1, name: 'Employee Handbook 2026', type: 'PDF', date: '2026-01-15' },
    { id: 2, name: 'Security Protocol v2', type: 'PDF', date: '2026-03-10' },
  ]);

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
          <p className="text-slate-400 mb-8 text-sm">Restricted access for Ahmed Al-Emary only.</p>
          
          <input 
            type="password" 
            placeholder="Enter Admin Password"
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl mb-6 text-center focus:outline-none focus:border-primary transition-all"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
        
        {/* Tab Switcher */}
        <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10 shadow-xl mb-12 w-fit mx-auto md:mx-0">
          <button
            onClick={() => setActiveTab('docs')}
            className={`flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'docs' ? 'bg-primary text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
          >
            <Files size={18} />
            Documents
          </button>
          <button
            onClick={() => setActiveTab('org')}
            className={`flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'org' ? 'bg-primary text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
          >
            <Network size={18} />
            Organization Chart
          </button>
        </div>

        {activeTab === 'docs' ? (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-center justify-between mb-12">
              <div>
                <h1 className="text-3xl font-bold text-white">Document Management</h1>
                <p className="text-slate-400 mt-2">Manage ShalfaGate repository and documents.</p>
              </div>
              <button className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-white font-bold rounded-xl hover:bg-emerald-600 transition-all">
                <Plus className="w-5 h-5" />
                Add New Document
              </button>
            </div>

            <div className="grid gap-4">
              {docs.map((doc) => (
                <div key={doc.id} className="p-6 glass rounded-2xl flex items-center justify-between border border-white/5 hover:border-white/20 transition-all">
                  <div className="flex items-center gap-6">
                    <div className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center text-primary font-bold">
                      {doc.type}
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">{doc.name}</h3>
                      <p className="text-sm text-slate-500 mt-1">Modified: {doc.date}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <button className="p-2 text-slate-400 hover:text-white transition-colors">
                      <Edit2 size={16}/>
                    </button>
                    <button className="p-2 text-slate-400 hover:text-red-500 transition-colors">
                      <Trash2 size={16}/>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <OrgAdminManager />
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default AdminDashboard;
