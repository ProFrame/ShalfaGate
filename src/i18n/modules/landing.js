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
  landing_title_generic: 'Digital Workplace Platform',
  about_portal_generic: 'The official Digital Workplace Platform.',
  company_head_office: 'Head office',

  // ---- sign in / password ------------------------------------------------
  email_placeholder: 'name@company.com',
  password_setup_note:
    'Choose a secure password for the Digital Workplace Platform. This password is separate from your email password.',

  // ---- contact channels --------------------------------------------------
  contact_channel_aria: '{{label}}: {{value}}',
};

const ar = {
  landing_title_generic: 'منصة العمل الرقمية',
  about_portal_generic: 'منصة العمل الرقمية الرسمية.',
  company_head_office: 'المقر الرئيسي',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'اختر كلمة مرور آمنة لمنصة العمل الرقمية. كلمة المرور هذه مستقلة عن كلمة مرور بريدك الإلكتروني.',

  contact_channel_aria: '{{label}}: {{value}}',
};

const hi = {
  landing_title_generic: 'डिजिटल वर्कप्लेस प्लेटफ़ॉर्म',
  about_portal_generic: 'आधिकारिक डिजिटल वर्कप्लेस प्लेटफ़ॉर्म।',
  company_head_office: 'मुख्यालय',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'डिजिटल वर्कप्लेस प्लेटफ़ॉर्म के लिए एक सुरक्षित पासवर्ड चुनें। यह पासवर्ड आपके ईमेल पासवर्ड से अलग है।',

  contact_channel_aria: '{{label}}: {{value}}',
};

const ur = {
  landing_title_generic: 'ڈیجیٹل ورک پلیس پلیٹ فارم',
  about_portal_generic: 'باضابطہ ڈیجیٹل ورک پلیس پلیٹ فارم۔',
  company_head_office: 'مرکزی دفتر',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'ڈیجیٹل ورک پلیس پلیٹ فارم کے لیے ایک محفوظ پاس ورڈ منتخب کریں۔ یہ پاس ورڈ آپ کے ای میل کے پاس ورڈ سے الگ ہے۔',

  contact_channel_aria: '{{label}}: {{value}}',
};

const tl = {
  landing_title_generic: 'Digital Workplace Platform',
  about_portal_generic: 'Ang opisyal na Digital Workplace Platform.',
  company_head_office: 'Head office',

  email_placeholder: 'name@company.com',
  password_setup_note:
    'Pumili ng secure na password para sa Digital Workplace Platform. Hiwalay ang password na ito sa password ng iyong email.',

  contact_channel_aria: '{{label}}: {{value}}',
};

export default { en, ar, hi, ur, tl };
