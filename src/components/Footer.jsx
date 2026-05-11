import React from 'react';
import { Mail, Phone, MapPin } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import logo from '../assets/logo.png';

const Footer = () => {
  const { t } = useLanguage();
  
  return (
    <footer id="contact" className="py-16 border-t border-white/5 bg-[#020617]">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-2 mb-6">
              <img src={logo} alt="Shalfa Logo" className="h-10" />
            </div>
            <p className="text-slate-400 max-w-sm mb-6 leading-relaxed">
              {t('about')}
            </p>
          </div>

          <div>
            <h4 className="text-white font-bold mb-6">{t('contact_info')}</h4>
            <ul className="space-y-4">
              <li className="flex items-center gap-3 text-slate-400">
                <Mail className="w-5 h-5 text-primary" />
                <span className="text-sm">a.alemary@shalfaintl.com.sa</span>
              </li>
              <li className="flex items-center gap-3 text-slate-400">
                <Phone className="w-5 h-5 text-primary" />
                <span className="text-sm">0594420232</span>
              </li>
              <li className="flex items-center gap-3 text-slate-400">
                <MapPin className="w-5 h-5 text-primary" />
                <span className="text-sm">Riyadh, Saudi Arabia</span>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-white font-bold mb-6">{t('docs')}</h4>
            <ul className="space-y-4">
              <li><a href="/org" className="text-slate-400 hover:text-white transition-colors text-sm">{t('org_chart')}</a></li>
              <li><a href="/circulars" className="text-slate-400 hover:text-white transition-colors text-sm">{t('circulars')}</a></li>
              <li><a href="/forms" className="text-slate-400 hover:text-white transition-colors text-sm">{t('forms')}</a></li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-white/5 flex flex-col md:row items-center justify-between gap-4 text-slate-500 text-xs">
          <p>{t('copyright')}</p>
          <div className="flex items-center gap-6">
            <a href="https://www.linkedin.com/company/shalfa" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">LinkedIn</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
