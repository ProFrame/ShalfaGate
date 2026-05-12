import React from 'react';
import { motion } from 'framer-motion';
import { Network, FileText, Files, ScrollText, Palette } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useNavigate } from 'react-router-dom';

const DashboardGrid = () => {
  const { t } = useLanguage();
  const navigate = useNavigate();

  const menuItems = [
    /* {
      id: 'org',
      title: t('org_chart'),
      icon: <Network className="w-12 h-12" />,
      color: "from-blue-500 to-blue-600",
      path: "org"
    }, */
    {
      id: 'forms',
      title: t('forms'),
      icon: <FileText className="w-12 h-12" />,
      color: "from-emerald-500 to-emerald-600",
      path: "forms"
    },
    {
      id: 'docs',
      title: t('docs'),
      icon: <Files className="w-12 h-12" />,
      color: "from-purple-500 to-purple-600",
      path: "documents"
    },
    {
      id: 'circulars',
      title: t('circulars'),
      icon: <ScrollText className="w-12 h-12" />,
      color: "from-amber-500 to-amber-600",
      path: "circulars"
    },
    {
      id: 'designs',
      title: t('designs'),
      icon: <Palette className="w-12 h-12" />,
      color: "from-pink-500 to-pink-600",
      path: "designs"
    }
  ];

  return (
    <section className="py-24 bg-[#030712]">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {menuItems.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              onClick={() => navigate(item.path)}
              className="relative group cursor-pointer"
            >
              <div className="absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-10 transition-opacity rounded-3xl" />
              <div className="p-8 h-full rounded-3xl glass flex flex-col items-center justify-center text-center gap-6 group-hover:-translate-y-2 transition-all border border-white/5 group-hover:border-white/20">
                <div className={`p-4 rounded-2xl bg-gradient-to-br ${item.color} shadow-lg shadow-black/20 group-hover:scale-110 transition-transform`}>
                  {item.icon}
                </div>
                <h3 className="text-xl font-bold text-white tracking-tight">{item.title}</h3>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default DashboardGrid;
