import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Mail, Phone, MapPin, Briefcase, Calendar, Copy, Check, ChevronRight } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const OrgDetailsDrawer = ({ open, item, parent, breadcrumb, onClose }) => {
  const { lang, t } = useLanguage();
  const [copied, setCopied] = React.useState(null);

  const handleCopy = (text, type) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  if (!item) return null;

  const isOccupied = item.status === 'occupied';
  const posName = lang === 'ar' ? item.positionAr : item.positionEn;
  const empName = lang === 'ar' ? item.employeeNameAr : item.employeeNameEn;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: lang === 'ar' ? '-100%' : '100%' }}
            animate={{ x: 0 }}
            exit={{ x: lang === 'ar' ? '-100%' : '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={`fixed top-0 ${lang === 'ar' ? 'left-0' : 'right-0'} h-full w-full max-w-md bg-[#030712] border-x border-white/10 z-[101] shadow-2xl overflow-y-auto`}
          >
            <div className="p-8">
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-xl font-bold text-white">{t('pos_details')}</h2>
                <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full text-slate-400">
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Header Info */}
              <div className="flex flex-col items-center text-center mb-10">
                <div className="w-24 h-24 rounded-3xl bg-primary/10 border-2 border-primary/20 flex items-center justify-center mb-6 overflow-hidden shadow-2xl">
                  {item.avatarUrl ? (
                    <img src={item.avatarUrl} alt={empName} className="w-full h-full object-cover" />
                  ) : (
                    <Briefcase className="w-10 h-10 text-primary" />
                  )}
                </div>
                <h3 className="text-2xl font-bold text-white mb-2">{posName}</h3>
                <div className={`px-4 py-1 rounded-full text-xs font-bold ${isOccupied ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                  {isOccupied ? t('occupied') : t('vacant')}
                </div>
              </div>

              {/* Breadcrumb Path */}
              <div className="mb-10">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-4 font-bold">Career Path</p>
                <div className="flex flex-wrap items-center gap-2">
                  {breadcrumb.map((step, idx) => (
                    <React.Fragment key={step.id}>
                      <span className={`text-xs ${idx === breadcrumb.length - 1 ? 'text-primary font-bold' : 'text-slate-400'}`}>
                        {lang === 'ar' ? step.positionAr : step.positionEn}
                      </span>
                      {idx < breadcrumb.length - 1 && <ChevronRight className="w-3 h-3 text-slate-600" />}
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* Details List */}
              <div className="space-y-6">
                <DetailItem icon={<Briefcase />} label={t('holder')} value={empName || (lang === 'ar' ? 'شاغر' : 'Vacant')} />
                <DetailItem 
                  icon={<Mail />} 
                  label={t('email')} 
                  value={item.email} 
                  copyable 
                  onCopy={() => handleCopy(item.email, 'email')}
                  isCopied={copied === 'email'}
                />
                <DetailItem 
                  icon={<Phone />} 
                  label={t('phone')} 
                  value={item.phone} 
                  copyable 
                  onCopy={() => handleCopy(item.phone, 'phone')}
                  isCopied={copied === 'phone'}
                />
                <DetailItem icon={<MapPin />} label="Location" value={item.location} />
                <DetailItem icon={<Calendar />} label="Last Updated" value={new Date().toLocaleDateString()} />
              </div>

              {/* Notes */}
              {(item.notesAr || item.notesEn) && (
                <div className="mt-10 p-6 bg-white/5 rounded-2xl border border-white/5">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 font-bold">Notes</p>
                  <p className="text-sm text-slate-300 leading-relaxed italic">
                    "{lang === 'ar' ? item.notesAr : item.notesEn}"
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

const DetailItem = ({ icon, label, value, copyable, onCopy, isCopied }) => (
  <div className="flex items-start gap-4">
    <div className="p-2.5 bg-white/5 rounded-xl text-primary border border-white/5">
      {React.cloneElement(icon, { size: 18 })}
    </div>
    <div className="flex-1 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <p className={`text-sm font-medium truncate ${value ? 'text-white' : 'text-slate-600 italic'}`}>
          {value || 'Not provided'}
        </p>
        {copyable && value && (
          <button onClick={onCopy} className="p-1 hover:bg-white/10 rounded transition-colors">
            {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-500 hover:text-white" />}
          </button>
        )}
      </div>
    </div>
  </div>
);

export default OrgDetailsDrawer;
