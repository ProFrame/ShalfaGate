import React, { createContext, useContext, useState } from 'react';

const translations = {
  ar: {
    about: "منصة شلفا الرقمية هي المرجع المعتمد لجميع مستندات شركة شلفا لادارة المرافق، تهدف لتنظيم الوصول للهيكل التنظيمي، التعاميم، النماذج، والوثائق الرسمية لضمان أعلى معايير الكفاءة الإدارية.",
    login: "دخول النظام",
    about_link: "من نحن",
    services_link: "الخدمات",
    contact_link: "اتصل بنا",
    hero_title: "بوابة شلفا للمستندات",
    hero_desc: "المرجع الرقمي الموحد لإدارة المرافق والوثائق الرسمية.",
    org_chart: "الهيكل التنظيمي",
    forms: "نماذج الشركة",
    docs: "الوثائق",
    circulars: "التعاميم",
    designs: "التصاميم",
    contact_info: "معلومات التواصل",
    copyright: "© 2026 شركة شلفا لإدارة المرافق. جميع الحقوق محفوظة."
  },
  en: {
    about: "Shalfa Digital Platform is the approved reference for all Shalfa Facility Management documents, aiming to organize access to the organizational structure, circulars, forms, and official documents to ensure the highest standards of administrative efficiency.",
    login: "Login",
    about_link: "About",
    services_link: "Services",
    contact_link: "Contact",
    hero_title: "Shalfa Document Portal",
    hero_desc: "The unified digital reference for facility management and official documents.",
    org_chart: "Organization Chart",
    forms: "Company Forms",
    docs: "Documents",
    circulars: "Circulars",
    designs: "Designs",
    contact_info: "Contact Information",
    copyright: "© 2026 Shalfa Facility Management. All rights reserved."
  },
  hi: {
    hero_title: "शल्फा दस्तावेज़ पोर्टल",
    // placeholders for other languages
    forms: "कंपनी प्रपत्र",
    org_chart: "संगठनात्मक चार्ट"
  },
  ur: {
    hero_title: "شلفا دستاویزاتی پورٹل",
    forms: "کمپنی فارمز",
    org_chart: "تنظیمی ڈھانچہ"
  },
  tl: {
    hero_title: "Portal ng Dokumento ng Shalfa",
    forms: "Mga Form ng Kumpanya",
    org_chart: "Chart ng Organisasyon"
  }
};

const LanguageContext = createContext();

export const LanguageProvider = ({ children }) => {
  const [lang, setLang] = useState('ar');

  const t = (key) => {
    return translations[lang][key] || translations['en'][key] || key;
  };

  const isRtl = lang === 'ar' || lang === 'ur';

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, isRtl }}>
      <div dir={isRtl ? 'rtl' : 'ltr'} className={lang === 'ar' ? 'font-arabic' : ''}>
        {children}
      </div>
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
