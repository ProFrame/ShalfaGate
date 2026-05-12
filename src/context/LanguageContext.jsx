import React, { createContext, useContext, useState } from 'react';

const translations = {
  ar: {
    about: "منصة شلفا الرقمية هي المرجع المعتمد لجميع مستندات شركة شلفا لادارة المرافق، تهدف لتنظيم الوصول للهيكل التنظيمي، التعاميم، النماذج، والوثائق الرسمية لضمان أعلى معايير الكفاءة الإدارية.",
    login: "دخول النظام",
    hero_title: "بوابة شلفا للمستندات",
    hero_desc: "المرجع الرقمي الموحد لإدارة المرافق والوثائق الرسمية.",
    org_chart: "الهيكل التنظيمي",
    forms: "نماذج الشركة",
    docs: "الوثائق",
    circulars: "التعاميم",
    designs: "التصاميم",
    contact_info: "معلومات التواصل",
    copyright: "© 2026 شركة شلفا لإدارة المرافق. جميع الحقوق محفوظة.",
    home: "الرئيسية",
    back: "رجوع",
    search_placeholder: "بحث في المستندات...",
    files_count: "ملفات",
    download: "تحميل",
    open_new_tab: "فتح في نافذة جديدة",
    select_file: "اختر ملفاً للمعاينة",
    search: "بحث",
    all: "الكل",
    occupied: "مشغول",
    vacant: "شاغر",
    add_position: "إضافة منصب",
    edit_position: "تعديل منصب",
    delete_position: "حذف منصب",
    pos_details: "تفاصيل المنصب",
    parent_pos: "المنصب الأب",
    holder: "الشاغل",
    phone: "الهاتف",
    email: "البريد الإلكتروني",
    status: "الحالة",
    save: "حفظ",
    cancel: "إلغاء",
    import_json: "استيراد JSON",
    export_json: "تصدير JSON",
    reset: "إعادة التعيين",
    last_updated: "آخر تحديث",
    total_pos: "عدد المناصب",
    occupied_pos: "المناصب المشغولة",
    vacant_pos: "المناصب الشاغرة"
  },
  en: {
    about: "Shalfa Digital Platform is the approved reference for all Shalfa Facility Management documents, aiming to organize access to the organizational structure, circulars, forms, and official documents to ensure the highest standards of administrative efficiency.",
    login: "Login",
    hero_title: "Shalfa Document Portal",
    hero_desc: "The unified digital reference for facility management and official documents.",
    org_chart: "Organization Chart",
    forms: "Company Forms",
    docs: "Documents",
    circulars: "Circulars",
    designs: "Designs",
    contact_info: "Contact Information",
    copyright: "© 2026 Shalfa Facility Management. All rights reserved.",
    home: "Home",
    back: "Back",
    search_placeholder: "Search documents...",
    files_count: "Files",
    download: "Download",
    open_new_tab: "Open in New Tab",
    select_file: "Select a file to preview",
    search: "Search",
    all: "All",
    occupied: "Occupied",
    vacant: "Vacant",
    add_position: "Add Position",
    edit_position: "Edit Position",
    delete_position: "Delete Position",
    pos_details: "Position Details",
    parent_pos: "Parent Position",
    holder: "Holder",
    phone: "Phone",
    email: "Email",
    status: "Status",
    save: "Save",
    cancel: "Cancel",
    import_json: "Import JSON",
    export_json: "Export JSON",
    reset: "Reset",
    last_updated: "Last Updated",
    total_pos: "Total Positions",
    occupied_pos: "Occupied Positions",
    vacant_pos: "Vacant Positions"
  },
  hi: {
    hero_title: "शल्फा दस्तावेज़ पोर्टल",
    hero_desc: "सुविधा प्रबंधन और आधिकारिक दस्तावेजों के लिए एकीकृत डिजिटल संदर्भ।",
    org_chart: "संगठनात्मक चार्ट",
    forms: "कंपनी प्रपत्र",
    docs: "दस्तावेज़",
    circulars: "परिपत्र",
    designs: "डिजाइन",
    about: "शल्फा डिजिटल प्लेटफॉर्म शल्फा फैसिलिटी मैनेजमेंट के सभी दस्तावेजों के लिए स्वीकृत संदर्भ है।",
    contact_info: "संपर्क जानकारी",
    copyright: "© 2026 शल्फा फैसिलिटी मैनेजमेंट। सर्वाधिकार सुरक्षित।",
    home: "होम",
    back: "वापस",
    search_placeholder: "दस्तावेज़ खोजें...",
    files_count: "फ़ाइलें",
    download: "डाउनलोड",
    open_new_tab: "नए टैब में खोलें",
    select_file: "पूर्वावलोकन के लिए एक फ़ाइल चुनें"
  },
  ur: {
    hero_title: "شلفا دستاویزاتی پورٹل",
    hero_desc: "سہولت کے انتظام اور سرکاری دستاویزات کے لیے متحد ڈیجیٹل حوالہ۔",
    org_chart: "تنظیمی ڈھانچہ",
    forms: "کمپنی فارمز",
    docs: "دستاویزات",
    circulars: "تعامیات",
    designs: "ڈیزائن",
    about: "شلفا ڈیجیٹل پلیٹ فارم شلفا فیسیلٹی مینجمنٹ کی تمام دستاویزات کا منظور شدہ حوالہ ہے۔",
    contact_info: "رابطے کی معلومات",
    copyright: "© 2026 شلفا فیسیلٹی مینجمنٹ۔ جملہ حقوق محفوظ ہیں۔",
    home: "ہوم",
    back: "پیچھے",
    search_placeholder: "دستاویزات تلاش کریں...",
    files_count: "فائلیں",
    download: "ڈاؤن لوڈ",
    open_new_tab: "نئی ونڈو میں کھولیں",
    select_file: "معائنہ کے لیے فائل منتخب کریں"
  },
  tl: {
    hero_title: "Portal ng Dokumento ng Shalfa",
    hero_desc: "Ang pinag-isang digital reference para sa pamamahala ng pasilidad at opisyal na dokumento.",
    org_chart: "Chart ng Organisasyon",
    forms: "Mga Form ng Kumpanya",
    docs: "Mga Dokumento",
    circulars: "Mga Circular",
    designs: "Mga Disenyo",
    about: "Ang Shalfa Digital Platform ay ang inaprubahang sanggunian para sa lahat ng dokumento ng Shalfa Facility Management.",
    contact_info: "Impormasyon sa Pakikipag-ugnayan",
    copyright: "© 2026 Shalfa Facility Management. Nakalaan ang lahat ng karapatan.",
    home: "Home",
    back: "Bumalik",
    search_placeholder: "Maghanap ng mga dokumento...",
    files_count: "Mga File",
    download: "I-download",
    open_new_tab: "Buksan sa Bagong Tab",
    select_file: "Pumili ng file na i-preview"
  }
};

const LanguageContext = createContext();

export const LanguageProvider = ({ children }) => {
  const [lang, setLang] = useState(() => localStorage.getItem('shalfa_lang') || 'ar');

  const handleSetLang = (newLang) => {
    setLang(newLang);
    localStorage.setItem('shalfa_lang', newLang);
  };

  const t = (key) => {
    return translations[lang][key] || translations['en'][key] || key;
  };

  const isRtl = lang === 'ar' || lang === 'ur';

  return (
    <LanguageContext.Provider value={{ lang, setLang: handleSetLang, t, isRtl }}>
      <div dir={isRtl ? 'rtl' : 'ltr'} className={lang === 'ar' ? 'font-arabic' : ''}>
        {children}
      </div>
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
