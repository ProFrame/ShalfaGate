// Company landing page, branded sign-in and the shared branding components.
//
// Everything brand specific was removed from the wording: the company name is
// always interpolated ({{company}}) and never written into a string, so the
// same sentence serves every company on the platform in every language.
//
// The generic variants (…_generic, company_head_office) are what a visitor sees
// while the company name is still loading, or when a company registered no name
// in any language at all.

const en = {
  // ---- landing page ------------------------------------------------------
  landing_title_generic: 'Employee Portal',
  about_portal_generic: 'The official digital employee portal.',
  company_head_office: 'Head office',

  // ---- sign in / password ------------------------------------------------
  email_placeholder: 'name@company.com',
  password_setup_note:
    'Choose a secure password for the Employee Portal. This password is separate from your email password.',

  // ---- contact channels --------------------------------------------------
  contact_channel_aria: '{{label}}: {{value}}',
};

const ar = {
  landing_title_generic: 'بوابة الموظفين',
  about_portal_generic: 'البوابة الرقمية الرسمية للموظفين.',
  company_head_office: 'المقر الرئيسي',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'اختر كلمة مرور آمنة لبوابة الموظفين. كلمة المرور هذه مستقلة عن كلمة مرور بريدك الإلكتروني.',

  contact_channel_aria: '{{label}}: {{value}}',
};

const hi = {
  landing_title_generic: 'कर्मचारी पोर्टल',
  about_portal_generic: 'आधिकारिक डिजिटल कर्मचारी पोर्टल।',
  company_head_office: 'मुख्यालय',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'कर्मचारी पोर्टल के लिए एक सुरक्षित पासवर्ड चुनें। यह पासवर्ड आपके ईमेल पासवर्ड से अलग है।',

  contact_channel_aria: '{{label}}: {{value}}',
};

const ur = {
  landing_title_generic: 'ملازمین پورٹل',
  about_portal_generic: 'ملازمین کا باضابطہ ڈیجیٹل پورٹل۔',
  company_head_office: 'مرکزی دفتر',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'ملازمین پورٹل کے لیے ایک محفوظ پاس ورڈ منتخب کریں۔ یہ پاس ورڈ آپ کے ای میل کے پاس ورڈ سے الگ ہے۔',

  contact_channel_aria: '{{label}}: {{value}}',
};

const tl = {
  landing_title_generic: 'Employee Portal',
  about_portal_generic: 'Ang opisyal na digital employee portal.',
  company_head_office: 'Head office',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'Pumili ng secure na password para sa Employee Portal. Hiwalay ang password na ito sa password ng iyong email.',

  contact_channel_aria: '{{label}}: {{value}}',
};

export default { en, ar, hi, ur, tl };
