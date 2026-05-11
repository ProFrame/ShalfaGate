import React from 'react';
import { motion } from 'framer-motion';
import { UserRound, MoreVertical, ShieldCheck, ShieldAlert } from 'lucide-react';

const OrgNodeCard = ({ item, lang, isHighlighted, onClick, onOpenDetails }) => {
  const isOccupied = item.status === 'occupied' && (item.employeeNameAr || item.employeeNameEn);
  const positionName = lang === 'ar' ? item.positionAr : item.positionEn;
  const employeeName = lang === 'ar' ? item.employeeNameAr : item.employeeNameEn;
  
  const getInitials = (name) => {
    if (!name) return '';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ y: -5 }}
      onClick={onClick}
      className={`relative p-5 glass rounded-2xl min-w-[240px] cursor-pointer border transition-all ${isHighlighted ? 'border-primary shadow-[0_0_20px_rgba(59,130,246,0.3)]' : 'border-white/10 hover:border-white/20'}`}
    >
      {/* Status Indicator */}
      <div className={`absolute -top-2 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-lg flex items-center gap-1 ${isOccupied ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
        <div className={`w-1.5 h-1.5 rounded-full ${isOccupied ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
        {isOccupied ? (lang === 'ar' ? 'مشغول' : 'Occupied') : (lang === 'ar' ? 'شاغر' : 'Vacant')}
      </div>

      <div className="flex flex-col items-center text-center gap-4">
        {/* Avatar Area */}
        <div className="relative">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center overflow-hidden border-2 shadow-inner ${isOccupied ? 'bg-primary/10 border-primary/20' : 'bg-white/5 border-white/10'}`}>
            {item.avatarUrl ? (
              <img src={item.avatarUrl} alt={employeeName} className="w-full h-full object-cover" />
            ) : isOccupied ? (
              <span className="text-xl font-bold text-primary">{getInitials(employeeName)}</span>
            ) : (
              <UserRound className="w-8 h-8 text-slate-600" />
            )}
          </div>
          {isOccupied && (
            <div className="absolute -bottom-1 -right-1 bg-primary text-white p-1 rounded-lg shadow-lg">
              <ShieldCheck className="w-3 h-3" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-white mb-1 leading-tight line-clamp-2">{positionName}</h3>
          <p className={`text-xs font-medium ${isOccupied ? 'text-slate-300' : 'text-red-400/80'}`}>
            {isOccupied ? employeeName : (lang === 'ar' ? 'بانتظار التعيين' : 'Vacant Position')}
          </p>
        </div>

        <div className="w-full pt-3 border-t border-white/5 flex items-center justify-between">
          <span className="text-[10px] font-mono text-slate-500 bg-white/5 px-2 py-0.5 rounded-md">
            {item.departmentCode || 'SHALFA'}
          </span>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetails(item);
            }}
            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-slate-400 hover:text-white"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </div>
      </div>
    </motion.div>
  );
};

export default OrgNodeCard;
