import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Plus, Edit2, Trash2, Download, Upload, RotateCcw, 
  Search, X, Save, AlertTriangle, CheckCircle2, ChevronDown 
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { 
  validateOrgItems, normalizeOrgItem, deleteBranch, wouldCreateCycle 
} from '../utils/orgTree';

const OrgAdminManager = () => {
  const { lang, t } = useLanguage();
  const [items, setItems] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const saved = localStorage.getItem('shalfa_org_chart');
    if (saved) {
      setItems(JSON.parse(saved).items);
    } else {
      const res = await fetch('data/org-chart.json');
      const json = await res.json();
      setItems(json.items);
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const newItem = normalizeOrgItem(Object.fromEntries(formData));

    // Validation
    if (items.some(i => i.id === newItem.id && (!editingItem || editingItem.id !== newItem.id))) {
      alert("ID must be unique!");
      return;
    }

    if (wouldCreateCycle(items, newItem.id, newItem.parentId)) {
      alert("Cannot set a child or itself as parent (Cycle detected)!");
      return;
    }

    let updatedItems;
    if (editingItem) {
      updatedItems = items.map(i => i.id === editingItem.id ? newItem : i);
    } else {
      updatedItems = [...items, newItem];
    }

    const { isValid, errors } = validateOrgItems(updatedItems);
    if (!isValid) {
      alert("Validation failed: " + errors.join('\n'));
      return;
    }

    saveToStorage(updatedItems);
    setIsModalOpen(false);
    setEditingItem(null);
    showStatus("Saved successfully to local storage!", "success");
  };

  const saveToStorage = (newItems) => {
    setItems(newItems);
    localStorage.setItem('shalfa_org_chart', JSON.stringify({
      version: "1.0.0",
      lastUpdated: new Date().toISOString().split('T')[0],
      items: newItems
    }));
  };

  const handleDelete = (id) => {
    const hasChildren = items.some(i => i.parentId === id);
    if (hasChildren) {
      if (!confirm("This position has subordinates. Deleting it will delete the entire branch. Continue?")) return;
    } else {
      if (!confirm("Are you sure you want to delete this position?")) return;
    }

    const updated = deleteBranch(items, id);
    saveToStorage(updated);
    showStatus("Position deleted.", "warning");
  };

  const handleExport = () => {
    const dataStr = JSON.stringify({
      version: "1.0.0",
      lastUpdated: new Date().toISOString().split('T')[0],
      items: items
    }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `org-chart.json`;
    link.click();
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const json = JSON.parse(evt.target.result);
        const { isValid, errors } = validateOrgItems(json.items);
        if (isValid) {
          saveToStorage(json.items);
          showStatus("Imported successfully!", "success");
        } else {
          alert("Invalid JSON structure:\n" + errors.join('\n'));
        }
      } catch (err) {
        alert("Failed to parse JSON file.");
      }
    };
    reader.readAsText(file);
  };

  const showStatus = (msg, type) => {
    setStatusMsg({ msg, type });
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const filteredItems = items.filter(i => 
    i.positionAr.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.positionEn.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.employeeNameAr.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.employeeNameEn.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="p-6 md:p-10">
      {/* Admin Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2">Organization Manager</h2>
          <p className="text-slate-400 text-sm">Manage company hierarchy, positions, and holders.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => { setEditingItem(null); setIsModalOpen(true); }} className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white font-bold rounded-xl shadow-lg shadow-blue-500/20 hover:bg-blue-600 transition-all">
            <Plus size={18}/> {t('add_position')}
          </button>
          <button onClick={handleExport} className="flex items-center gap-2 px-5 py-2.5 bg-white/5 text-white font-bold rounded-xl border border-white/10 hover:bg-white/10 transition-all">
            <Download size={18}/> {t('export_json')}
          </button>
          <label className="flex items-center gap-2 px-5 py-2.5 bg-white/5 text-white font-bold rounded-xl border border-white/10 hover:bg-white/10 transition-all cursor-pointer">
            <Upload size={18}/> {t('import_json')}
            <input type="file" className="hidden" accept=".json" onChange={handleImport} />
          </label>
          <button onClick={() => { if(confirm("Reset to original JSON?")) { localStorage.removeItem('shalfa_org_chart'); loadData(); } }} className="flex items-center gap-2 px-5 py-2.5 bg-red-500/10 text-red-400 font-bold rounded-xl border border-red-500/20 hover:bg-red-500/20 transition-all">
            <RotateCcw size={18}/> {t('reset')}
          </button>
        </div>
      </div>

      {/* Info Alert */}
      <div className="mb-8 p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center gap-4 text-blue-400 text-sm">
        <AlertTriangle size={20} />
        <p>Changes are saved to <strong>Local Storage</strong>. To update the production site, click <strong>Export JSON</strong> and replace <code>public/data/org-chart.json</code> on GitHub.</p>
      </div>

      {/* Table Section */}
      <div className="glass rounded-3xl overflow-hidden border border-white/10">
        <div className="p-6 border-b border-white/5 flex items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4" />
            <input 
              type="text" 
              placeholder={t('search')} 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary/50 text-sm"
            />
          </div>
          <div className="text-xs text-slate-500 font-medium">Showing {filteredItems.length} of {items.length} positions</div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-white/5 text-slate-400 text-[10px] uppercase tracking-widest font-bold">
              <tr>
                <th className="px-6 py-4">ID / Parent</th>
                <th className="px-6 py-4">Position (AR/EN)</th>
                <th className="px-6 py-4">Holder</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredItems.map(item => (
                <tr key={item.id} className="hover:bg-white/[0.02] transition-colors group">
                  <td className="px-6 py-4">
                    <div className="text-sm font-bold text-white">{item.id}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">Parent: {item.parentId || 'ROOT'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-slate-200">{item.positionAr}</div>
                    <div className="text-xs text-slate-500">{item.positionEn}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-slate-300">{item.employeeNameAr || '-'}</div>
                    <div className="text-xs text-slate-500">{item.email || '-'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase ${item.status === 'occupied' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => { setEditingItem(item); setIsModalOpen(true); }} className="p-2 hover:bg-primary/20 hover:text-primary rounded-lg transition-all text-slate-500"><Edit2 size={16}/></button>
                      <button onClick={() => handleDelete(item.id)} className="p-2 hover:bg-red-500/20 hover:text-red-500 rounded-lg transition-all text-slate-500"><Trash2 size={16}/></button>
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
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsModalOpen(false)} className="absolute inset-0 bg-black/80 backdrop-blur-md" />
            <motion.form 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              onSubmit={handleSave}
              className="relative w-full max-w-4xl bg-[#030712] border border-white/10 rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/5">
                <h3 className="text-xl font-bold text-white">{editingItem ? t('edit_position') : t('add_position')}</h3>
                <button type="button" onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-white/10 rounded-full text-slate-400"><X size={24}/></button>
              </div>
              
              <div className="p-8 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormGroup label="Position ID (Unique)" name="id" defaultValue={editingItem?.id} required />
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold text-slate-500 uppercase">Parent Position</label>
                  <select name="parentId" defaultValue={editingItem?.parentId || ""} className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-primary">
                    <option value="">None (Top Level)</option>
                    {items.filter(i => i.id !== editingItem?.id).map(i => (
                      <option key={i.id} value={i.id}>{i.id} - {i.positionEn}</option>
                    ))}
                  </select>
                </div>

                <FormGroup label="Position Name (AR)" name="positionAr" defaultValue={editingItem?.positionAr} required />
                <FormGroup label="Position Name (EN)" name="positionEn" defaultValue={editingItem?.positionEn} required />
                <FormGroup label="Employee Name (AR)" name="employeeNameAr" defaultValue={editingItem?.employeeNameAr} />
                <FormGroup label="Employee Name (EN)" name="employeeNameEn" defaultValue={editingItem?.employeeNameEn} />
                <FormGroup label="Email" name="email" type="email" defaultValue={editingItem?.email} />
                <FormGroup label="Phone" name="phone" defaultValue={editingItem?.phone} />
                <FormGroup label="Avatar URL" name="avatarUrl" defaultValue={editingItem?.avatarUrl} />
                <FormGroup label="Location" name="location" defaultValue={editingItem?.location} />
                <FormGroup label="Dept Code" name="departmentCode" defaultValue={editingItem?.departmentCode} />
                <FormGroup label="Sort Order" name="sortOrder" type="number" defaultValue={editingItem?.sortOrder || 999} />
                
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold text-slate-500 uppercase">Status</label>
                  <select name="status" defaultValue={editingItem?.status || "occupied"} className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-primary">
                    <option value="occupied">Occupied</option>
                    <option value="vacant">Vacant</option>
                  </select>
                </div>

                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-xs font-bold text-slate-500 uppercase">Notes (AR)</label>
                    <textarea name="notesAr" defaultValue={editingItem?.notesAr} className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm h-24 focus:outline-none focus:border-primary"></textarea>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xs font-bold text-slate-500 uppercase">Notes (EN)</label>
                    <textarea name="notesEn" defaultValue={editingItem?.notesEn} className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm h-24 focus:outline-none focus:border-primary"></textarea>
                  </div>
                </div>
              </div>

              <div className="p-6 border-t border-white/10 bg-white/5 flex justify-end gap-4">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-8 py-3 text-slate-400 font-bold hover:text-white transition-all">{t('cancel')}</button>
                <button type="submit" className="flex items-center gap-2 px-10 py-3 bg-primary text-white font-bold rounded-xl shadow-xl shadow-blue-500/20 hover:bg-blue-600 transition-all">
                  <Save size={20}/> {t('save')}
                </button>
              </div>
            </motion.form>
          </div>
        )}
      </AnimatePresence>

      {/* Toast Notification */}
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

const FormGroup = ({ label, name, defaultValue, type = "text", required = false }) => (
  <div className="flex flex-col gap-2">
    <label className="text-xs font-bold text-slate-500 uppercase">{label} {required && "*"}</label>
    <input 
      type={type} 
      name={name} 
      defaultValue={defaultValue} 
      required={required}
      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-primary transition-all"
    />
  </div>
);

export default OrgAdminManager;
