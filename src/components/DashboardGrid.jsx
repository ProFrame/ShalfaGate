import { motion } from 'framer-motion';
import { FileText, Files, Palette, ScrollText } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useLocation } from 'wouter';

const DashboardGrid = () => {
  const { t } = useLanguage();
  const [, navigate] = useLocation();

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
      path: "/app/forms"
    },
    {
      id: 'docs',
      title: t('docs'),
      icon: <Files className="w-12 h-12" />,
      color: "from-purple-500 to-purple-600",
      path: "/app/documents"
    },
    {
      id: 'circulars',
      title: t('circulars'),
      icon: <ScrollText className="w-12 h-12" />,
      color: "from-amber-500 to-amber-600",
      path: "/app/circulars"
    },
    {
      id: 'designs',
      title: t('designs'),
      icon: <Palette className="w-12 h-12" />,
      color: "from-pink-500 to-pink-600",
      path: "/app/designs"
    }
  ];

  return (
    <section className="bg-stone-50 py-20">
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
              <div className="absolute inset-0 rounded-lg bg-emerald-700 opacity-0 transition-opacity group-hover:opacity-5" />
              <div className="flex h-full flex-col items-center justify-center gap-6 rounded-lg border border-stone-200 bg-white p-8 text-center shadow-sm transition-all group-hover:-translate-y-1 group-hover:border-emerald-200">
                <div className={`rounded-md bg-gradient-to-br p-4 text-white shadow-sm ${item.color} transition-transform group-hover:scale-105`}>
                  {item.icon}
                </div>
                <h3 className="text-xl font-bold tracking-normal text-slate-950">{item.title}</h3>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default DashboardGrid;
