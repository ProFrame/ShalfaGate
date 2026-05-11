import React, { useState, useEffect } from 'react';
import { Tree, TreeNode } from 'react-organizational-chart';
import { motion } from 'framer-motion';
import { Search, ZoomIn, ZoomOut, RotateCcw, Printer, Users, UserCheck, UserPlus, Info } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { buildOrgTree, getBreadcrumb } from '../utils/orgTree';
import OrgNodeCard from './OrgNodeCard';
import OrgDetailsDrawer from './OrgDetailsDrawer';

const OrgChartPage = () => {
  const { lang, t, isRtl } = useLanguage();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState('all'); // all, occupied, vacant
  const [selectedNode, setSelectedNode] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      try {
        // Priority: localStorage -> public JSON
        const savedData = localStorage.getItem('shalfa_org_chart');
        if (savedData) {
          setData(JSON.parse(savedData).items);
        } else {
          const response = await fetch('data/org-chart.json');
          const json = await response.json();
          setData(json.items);
        }
      } catch (err) {
        setError("Failed to load organization chart data.");
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const filteredData = data.filter(item => {
    const matchesSearch = 
      item.positionAr.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.positionEn.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.employeeNameAr.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.employeeNameEn.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesFilter = 
      filter === 'all' || 
      (filter === 'occupied' && item.status === 'occupied') ||
      (filter === 'vacant' && item.status === 'vacant');

    return matchesSearch && matchesFilter;
  });

  const treeData = buildOrgTree(searchTerm ? filteredData : data);

  const stats = {
    total: data.length,
    occupied: data.filter(i => i.status === 'occupied').length,
    vacant: data.filter(i => i.status === 'vacant').length
  };

  const handleNodeClick = (node) => {
    setSelectedNode(node);
    setIsDrawerOpen(true);
  };

  const renderTree = (nodes) => {
    return nodes.map((node) => (
      <TreeNode
        key={node.id}
        label={
          <div className="inline-block p-4">
            <OrgNodeCard 
              item={node} 
              lang={lang} 
              isHighlighted={searchTerm && (
                node.positionAr.toLowerCase().includes(searchTerm.toLowerCase()) ||
                node.positionEn.toLowerCase().includes(searchTerm.toLowerCase())
              )}
              onClick={() => handleNodeClick(node)}
              onOpenDetails={handleNodeClick}
            />
          </div>
        }
      >
        {node.children && node.children.length > 0 && renderTree(node.children)}
      </TreeNode>
    ));
  };

  if (loading) return (
    <div className="min-h-screen bg-[#030712] flex items-center justify-center">
      <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#030712] bg-mesh pt-28 pb-12 overflow-hidden">
      <div className="container mx-auto px-6 mb-12">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="text-4xl font-extrabold text-white mb-3">{t('org_chart')}</h1>
            <div className="flex items-center gap-6">
              <StatBadge icon={<Users size={14}/>} label={t('total_pos')} value={stats.total} color="blue" />
              <StatBadge icon={<UserCheck size={14}/>} label={t('occupied_pos')} value={stats.occupied} color="emerald" />
              <StatBadge icon={<UserPlus size={14}/>} label={t('vacant_pos')} value={stats.vacant} color="red" />
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => setZoom(prev => Math.min(prev + 0.1, 2))} className="p-2.5 glass rounded-xl hover:text-primary transition-all"><ZoomIn size={20}/></button>
            <button onClick={() => setZoom(prev => Math.max(prev - 0.1, 0.5))} className="p-2.5 glass rounded-xl hover:text-primary transition-all"><ZoomOut size={20}/></button>
            <button onClick={() => setZoom(1)} className="p-2.5 glass rounded-xl hover:text-primary transition-all"><RotateCcw size={20}/></button>
            <div className="w-px h-8 bg-white/10 mx-2" />
            <button onClick={() => window.print()} className="p-2.5 glass rounded-xl hover:text-primary transition-all"><Printer size={20}/></button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col md:flex-row gap-4 mb-8">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
            <input 
              type="text" 
              placeholder={t('search')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-6 py-4 bg-white/5 border border-white/10 rounded-2xl focus:outline-none focus:border-primary/50 text-white transition-all shadow-xl"
            />
          </div>
          <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10 shadow-xl">
            {['all', 'occupied', 'vacant'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-6 py-3 rounded-xl text-sm font-bold transition-all ${filter === f ? 'bg-primary text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
              >
                {t(f)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart Viewport */}
      <div className="relative w-full h-[70vh] overflow-auto custom-scrollbar cursor-grab active:cursor-grabbing p-12">
        <div 
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)' }}
          className="flex justify-center"
        >
          {data.length > 0 ? (
            <Tree
              lineWidth={'2px'}
              lineColor={'rgba(255,255,255,0.1)'}
              lineBorderRadius={'12px'}
              label={
                <div className="inline-block p-4">
                  <OrgNodeCard 
                    item={treeData[0]} 
                    lang={lang} 
                    isHighlighted={searchTerm && (
                      treeData[0].positionAr.toLowerCase().includes(searchTerm.toLowerCase()) ||
                      treeData[0].positionEn.toLowerCase().includes(searchTerm.toLowerCase())
                    )}
                    onClick={() => handleNodeClick(treeData[0])}
                    onOpenDetails={handleNodeClick}
                  />
                </div>
              }
            >
              {treeData[0]?.children && renderTree(treeData[0].children)}
            </Tree>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-slate-500">
              <Info size={48} className="mb-4 opacity-20" />
              <p>No organizational data found.</p>
            </div>
          )}
        </div>
      </div>

      {/* Details Drawer */}
      <OrgDetailsDrawer 
        open={isDrawerOpen}
        item={selectedNode}
        breadcrumb={selectedNode ? getBreadcrumb(data, selectedNode.id) : []}
        onClose={() => setIsDrawerOpen(false)}
      />
    </div>
  );
};

const StatBadge = ({ icon, label, value, color }) => {
  const colors = {
    blue: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    emerald: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    red: "bg-red-500/10 text-red-400 border-red-500/20"
  };
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${colors[color]} shadow-sm`}>
      <span className="opacity-70">{icon}</span>
      <span className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}:</span>
      <span className="text-sm font-black">{value}</span>
    </div>
  );
};

export default OrgChartPage;
