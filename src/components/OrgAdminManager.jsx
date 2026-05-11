import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Plus, Edit2, Trash2, Download, Upload, RotateCcw, 
  Search, X, Save, AlertTriangle, CheckCircle2, 
  Files, Network, ScrollText, Palette
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { 
  validateOrgItems, normalizeOrgItem, deleteBranch, wouldCreateCycle 
} from '../utils/orgTree';

const OrgAdminManager = () => {
  const { lang, t } = useLanguage();
  const [siteData, setSiteData] = useState({ orgChart: [], documents: [], circulars: [], designs: [] });
  const [activeSubTab, setActiveSubTab] = useState('org'); // org, docs, circulars, designs
  const [searchTerm, setSearchTerm] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const saved = localStorage.getItem('shalfa_site_data');
    if (saved) {
      setSiteData(JSON.parse(saved));
    } else {
      try {
        const res = await fetch('data/site-data.json');
        const json = await res.json();
        setSiteData(json);
      } catch (e) {
        console.error("Failed to load initial data", e);
      }
    }
  };

  const saveToStorage = (newData) => {
    setSiteData(newData);
    const updated = {
      ...newData,
      version: "1.1.0",
      lastUpdated: new Date().toISOString().split('T')[0]
    };
    localStorage.setItem('shalfa_site_data', JSON.stringify(updated));
  };

  const handleSave = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const rawData = Object.fromEntries(formData);
    
    let updatedData = { ...siteData };

    if (activeSubTab === 'org') {
      const newItem = normalizeOrgItem(rawData);
      if (siteData.orgChart.some(i => i.id === newItem.id && (!editingItem || editingItem.id !== newItem.id))) {
        alert("ID must be unique!"); return;
      }
      if (wouldCreateCycle(siteData.orgChart, newItem.id, newItem.parentId)) {
        alert("Cycle detected!"); return;
      }
      if (editingItem) {
        updatedData.orgChart = siteData.orgChart.map(i => i.id === editingItem.id ? newItem : i);
      } else {
        updatedData.orgChart = [...siteData.orgChart, newItem];
      }
    } else {
      // Logic for docs, circulars, designs
      const newItem = { 
        id: editingItem ? editingItem.id : Date.now().toString(),
        ...rawData,
        date: new Date().toISOString().split('T')[0]
      };
      const key = activeSubTab === 'docs' ? 'documents' : activeSubTab;
      if (editingItem) {
        updatedData[key] = siteData[key].map(i => i.id === editingItem.id ? newItem : i);
      } else {
        updatedData[key] = [...siteData[key], newItem];
      }
    }

    saveToStorage(updatedData);
    setIsModalOpen(false);
    setEditingItem(null);
    showStatus("Saved successfully!", "success");
  };

  const handleDelete = (id) => {
    if (!confirm("Are you sure?")) return;
    let updatedData = { ...siteData };
    if (activeSubTab === 'org') {
      updatedData.orgChart = deleteBranch(siteData.orgChart, id);
    } else {
      const key = activeSubTab === 'docs' ? 'documents' : activeSubTab;
      updatedData[key] = siteData[key].filter(i => i.id !== id);
    }
    saveToStorage(updatedData);
    showStatus("Deleted.", "warning");
  };

  const handleExportAll = () => {
    const dataStr = JSON.stringify({
      ...siteData,
      version: "1.1.0",
      lastUpdated: new Date().toISOString().split('T')[0]
    }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `site-data.json`;
    link.click();
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const json = JSON.parse(evt.target.result);
        saveToStorage(json);
        showStatus("Imported successfully!", "success");
      } catch (err) { alert("Failed to parse JSON."); }
    };
    reader.readAsText(file);
  };

  const showStatus = (msg, type) => {
    setStatusMsg({ msg, type });
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const currentItems = activeSubTab === 'org' ? siteData.orgChart : (activeSubTab === 'docs' ? siteData.documents : siteData[activeSubTab]);
  const filteredItems = currentItems.filter(i => 
    (i.positionAr || i.name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (i.positionEn || "").toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-8">
      {/* Warning Box */}
      <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center gap-4 text-amber-400 text-sm">
        <AlertTriangle size={20} className="shrink-0" />
        <p><strong>تنبيه:</strong> التغييرات هنا مؤقتة للمعاينة فقط. لاعتمادها بشكل دائم، يرجى الضغط على <strong>Export All Site Data</strong> واستبدال ملف <code>public/data/site-data.json</code> في GitHub.</p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col lg:flex-row justify-between gap-6">
        <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10 w-fit">
          <SubTab active={activeSubTab === 'org'} onClick={() => setActiveSubTab('org')} icon={<Network size={16}/>} label="Org Chart" />
          <SubTab active={activeSubTab === 'docs'} onClick={() => setActiveSubTab('docs')} icon={<Files size={16}/>} label="Documents" />
          <SubTab active={activeSubTab === 'circulars'} onClick={() => setActiveSubTab('circulars')} icon={<ScrollText size={16}/>} label="Circulars" />
          <SubTab active={activeSubTab === 'designs'} onClick={() => setActiveSubTab('designs')} icon={<Palette size={16}/>} label="Designs" />
        </div>

        <div className="flex flex-wrap gap-3">
          <button onClick={() => { setEditingItem(null); setIsModalOpen(true); }} className="flex items-center gap-2 px-6 py-2.5 bg-primary text-white font-bold rounded-xl shadow-lg hover:bg-blue-600 transition-all">
            <Plus size={18}/> {activeSubTab === 'org' ? t('add_position') : 'Add Item'}
          </button>
          <button onClick={handleExportAll} className="flex items-center gap-2 px-6 py-2.5 bg-emerald-500 text-white font-bold rounded-xl shadow-lg hover:bg-emerald-600 transition-all">
            <Download size={18}/> Export All Site Data
          </button>
          <label className="flex items-center gap-2 px-5 py-2.5 bg-white/5 text-white font-bold rounded-xl border border-white/10 cursor-pointer">
            <Upload size={18}/> Import
            <input type="file" className="hidden" accept=".json" onChange={handleImport} />
          </label>
        </div>
      </div>

      {/* List / Table */}
      <div className="glass rounded-3xl overflow-hidden border border-white/10">
        <div className="p-6 border-b border-white/5 flex items-center justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4" />
            <input type="text" placeholder={t('search')} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-white/5 text-slate-400 text-[10px] uppercase tracking-widest font-bold">
              <tr>
                <th className="px-6 py-4">Title / ID</th>
                <th className="px-6 py-4">Details</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredItems.map(item => (
                <tr key={item.id} className="hover:bg-white/[0.02]">
                  <td className="px-6 py-4">
                    <div className="text-sm font-bold text-white">{item.positionEn || item.name}</div>
                    <div className="text-[10px] text-slate-500">{item.id}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-400">
                    {activeSubTab === 'org' ? item.employeeNameEn : item.size || item.type}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => { setEditingItem(item); setIsModalOpen(true); }} className="p-2 text-slate-500 hover:text-primary"><Edit2 size={16}/></button>
                      <button onClick={() => handleDelete(item.id)} className="p-2 text-slate-500 hover:text-red-500"><Trash2 size={16}/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-[250] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsModalOpen(false)} className="absolute inset-0 bg-black/80 backdrop-blur-md" />
            <motion.form 
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              onSubmit={handleSave}
              className="relative w-full max-w-4xl bg-[#030712] border border-white/10 rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/5">
                <h3 className="text-xl font-bold text-white">
                  {editingItem ? t('edit_position') : (activeSubTab === 'org' ? t('add_position') : 'Add New Item')}
                </h3>
                <button type="button" onClick={() => setIsModalOpen(false)} className="p-2 text-slate-400"><X size={24}/></button>
              </div>
              
              <div className="p-8 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-6">
                {activeSubTab === 'org' ? (
                  <>
                    <FormGroup label="ID" name="id" defaultValue={editingItem?.id} required />
                    <div className="flex flex-col gap-2">
                      <label className="text-xs font-bold text-slate-500 uppercase">Parent</label>
                      <select name="parentId" defaultValue={editingItem?.parentId || ""} className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm">
                        <option value="">Top Level</option>
                        {siteData.orgChart.filter(i => i.id !== editingItem?.id).map(i => <option key={i.id} value={i.id}>{i.positionEn}</option>)}
                      </select>
                    </div>
                    <FormGroup label="Name (AR)" name="positionAr" defaultValue={editingItem?.positionAr} required />
                    <FormGroup label="Name (EN)" name="positionEn" defaultValue={editingItem?.positionEn} required />
                    <FormGroup label="Employee (AR)" name="employeeNameAr" defaultValue={editingItem?.employeeNameAr} />
                    <FormGroup label="Employee (EN)" name="employeeNameEn" defaultValue={editingItem?.employeeNameEn} />
                    <FormGroup label="Email" name="email" defaultValue={editingItem?.email} />
                    <FormGroup label="Phone" name="phone" defaultValue={editingItem?.phone} />
                  </>
                ) : (
                  <>
                    <FormGroup label="Display Name" name="name" defaultValue={editingItem?.name} required />
                    <FormGroup label="URL / Link" name="url" defaultValue={editingItem?.url} required />
                    <FormGroup label="Type (PDF, IMG, etc)" name="type" defaultValue={editingItem?.type || "pdf"} />
                    <FormGroup label="Size" name="size" defaultValue={editingItem?.size || "1.0 MB"} />
                  </>
                )}
              </div>

              <div className="p-6 border-t border-white/10 bg-white/5 flex justify-end gap-4">
                <button type="submit" className="flex items-center gap-2 px-10 py-3 bg-primary text-white font-bold rounded-xl shadow-xl shadow-blue-500/20 hover:bg-blue-600 transition-all">
                  <Save size={20}/> {t('save')}
                </button>
              </div>
            </motion.form>
          </div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {statusMsg && (
          <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }} className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[300] px-6 py-3 glass rounded-2xl border border-white/10 flex items-center gap-3 shadow-2xl">
            <CheckCircle2 className={statusMsg.type === 'success' ? 'text-emerald-400' : 'text-amber-400'} />
            <span className="text-sm font-bold text-white">{statusMsg.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const SubTab = ({ active, onClick, icon, label }) => (
  <button onClick={onClick} className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold transition-all ${active ? 'bg-primary text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>
    {icon} {label}
  </button>
);

const FormGroup = ({ label, name, defaultValue, type = "text", required = false }) => (
  <div className="flex flex-col gap-2">
    <label className="text-xs font-bold text-slate-500 uppercase">{label} {required && "*"}</label>
    <input type={type} name={name} defaultValue={defaultValue} required={required} className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm focus:border-primary transition-all" />
  </div>
);

export default OrgAdminManager;
