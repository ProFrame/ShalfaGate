// Wording owned by the Favorites + Recent Items screens
// (src/components/favorites/FavoritesScreen.jsx / RecentItemsScreen.jsx) and
// their shared data layer (src/data/navigationAidsService.js).
//
// Every key is prefixed `navaids_*` so this file can never overwrite a key
// that belongs to another module. Shared vocabulary (action_*, label_*,
// error_generic, the generic `add`) is reused from
// src/context/LanguageContext.jsx/src/i18n/modules/platform.js instead of
// being repeated here; `shell_area_*` (src/i18n/modules/notifications.js) is
// reused for the group label on a favorited/recent row rather than a second
// set of group names.
//
// navaids_err_<code> keys mirror every SCREAMING_SNAKE_CASE error
// favorite_screen_add()/favorite_screen_remove()/recent_screen_touch() can
// raise (navigationAidsErrorMessage() maps one to the other, same convention
// operationsErrorMessage()/safetyErrorMessage() use). favorite_screen_remove()
// and recent_screen_touch() are both documented as never raising beyond
// NO_ACTIVE_TENANT (idempotent/silent-no-op by design), so SCREEN_NOT_FOUND
// only ever surfaces from favorite_screen_add().

const en = {
  // ---- Favorites -----------------------------------------------------------
  navaids_fav_module_kicker: 'Workspace',
  navaids_fav_portal_title: 'Favorites',
  navaids_fav_intro: 'The screens you have starred for quick access, and a picker to add more.',
  navaids_fav_list_title: 'My favorites',
  navaids_fav_empty: 'You have not favorited any screen yet.',
  navaids_fav_remove: 'Remove {{name}} from favorites',
  navaids_fav_added: '{{name}} was added to your favorites.',
  navaids_fav_removed: '{{name}} was removed from your favorites.',
  navaids_fav_add_title: 'Add a favorite',
  navaids_fav_add_search_placeholder: 'Search your screens...',
  navaids_fav_add_button: 'Add {{name}} to favorites',
  navaids_fav_add_empty: 'Every screen you can open is already in your favorites.',

  // ---- Recent items ----------------------------------------------------------
  navaids_recent_module_kicker: 'Workspace',
  navaids_recent_portal_title: 'Recent Items',
  navaids_recent_intro: 'The screens you opened most recently, in order.',
  navaids_recent_list_title: 'Recently visited',
  navaids_recent_empty: 'Nothing here yet — screens you open will start appearing in this list.',

  // ---- errors (RPC codes mapped to wording) ----------------------------------
  navaids_err_no_active_tenant: 'No active company session was found. Please sign in again.',
  navaids_err_screen_code_required: 'Choose a screen to favorite.',
  navaids_err_screen_not_found: 'This screen no longer exists.',
};

const ar = {
  navaids_fav_module_kicker: 'مساحة العمل',
  navaids_fav_portal_title: 'المفضلة',
  navaids_fav_intro: 'الشاشات التي ثبّتها للوصول السريع، مع قائمة لإضافة المزيد.',
  navaids_fav_list_title: 'مفضلتي',
  navaids_fav_empty: 'لم تُضِف أي شاشة إلى المفضلة بعد.',
  navaids_fav_remove: 'إزالة {{name}} من المفضلة',
  navaids_fav_added: 'تمت إضافة {{name}} إلى المفضلة.',
  navaids_fav_removed: 'تمت إزالة {{name}} من المفضلة.',
  navaids_fav_add_title: 'إضافة إلى المفضلة',
  navaids_fav_add_search_placeholder: 'ابحث في شاشاتك...',
  navaids_fav_add_button: 'إضافة {{name}} إلى المفضلة',
  navaids_fav_add_empty: 'كل شاشة يمكنك فتحها موجودة بالفعل في مفضلتك.',

  navaids_recent_module_kicker: 'مساحة العمل',
  navaids_recent_portal_title: 'الأخيرة',
  navaids_recent_intro: 'الشاشات التي فتحتها مؤخراً، مرتبة حسب الأحدث.',
  navaids_recent_list_title: 'زرتها مؤخراً',
  navaids_recent_empty: 'لا شيء هنا بعد — ستظهر الشاشات التي تفتحها في هذه القائمة.',

  navaids_err_no_active_tenant: 'تعذّر العثور على جلسة شركة نشطة. يرجى تسجيل الدخول مرة أخرى.',
  navaids_err_screen_code_required: 'اختر شاشة لإضافتها إلى المفضلة.',
  navaids_err_screen_not_found: 'لم تعد هذه الشاشة موجودة.',
};

const hi = {
  navaids_fav_module_kicker: 'कार्यक्षेत्र',
  navaids_fav_portal_title: 'पसंदीदा',
  navaids_fav_intro: 'वे स्क्रीन जिन्हें आपने त्वरित पहुँच के लिए पसंदीदा बनाया है, और अधिक जोड़ने के लिए एक सूची।',
  navaids_fav_list_title: 'मेरे पसंदीदा',
  navaids_fav_empty: 'आपने अभी तक कोई स्क्रीन पसंदीदा में नहीं जोड़ी है।',
  navaids_fav_remove: '{{name}} को पसंदीदा से हटाएँ',
  navaids_fav_added: '{{name}} आपके पसंदीदा में जोड़ा गया।',
  navaids_fav_removed: '{{name}} आपके पसंदीदा से हटाया गया।',
  navaids_fav_add_title: 'पसंदीदा जोड़ें',
  navaids_fav_add_search_placeholder: 'अपनी स्क्रीन खोजें...',
  navaids_fav_add_button: '{{name}} को पसंदीदा में जोड़ें',
  navaids_fav_add_empty: 'आप जो भी स्क्रीन खोल सकते हैं वे सभी पहले से ही आपके पसंदीदा में हैं।',

  navaids_recent_module_kicker: 'कार्यक्षेत्र',
  navaids_recent_portal_title: 'हाल की वस्तुएँ',
  navaids_recent_intro: 'आपके द्वारा हाल ही में खोली गई स्क्रीन, क्रम में।',
  navaids_recent_list_title: 'हाल ही में देखी गई',
  navaids_recent_empty: 'अभी यहाँ कुछ नहीं है — आपके द्वारा खोली गई स्क्रीन इस सूची में दिखने लगेंगी।',

  navaids_err_no_active_tenant: 'कोई सक्रिय कंपनी सत्र नहीं मिला। कृपया फिर से साइन इन करें।',
  navaids_err_screen_code_required: 'पसंदीदा बनाने के लिए एक स्क्रीन चुनें।',
  navaids_err_screen_not_found: 'यह स्क्रीन अब मौजूद नहीं है।',
};

const ur = {
  navaids_fav_module_kicker: 'ورک اسپیس',
  navaids_fav_portal_title: 'پسندیدہ',
  navaids_fav_intro: 'وہ اسکرینیں جنہیں آپ نے فوری رسائی کے لیے پسندیدہ بنایا ہے، اور مزید شامل کرنے کے لیے فہرست۔',
  navaids_fav_list_title: 'میری پسندیدہ',
  navaids_fav_empty: 'آپ نے ابھی تک کوئی اسکرین پسندیدہ میں شامل نہیں کی۔',
  navaids_fav_remove: '{{name}} کو پسندیدہ سے ہٹائیں',
  navaids_fav_added: '{{name}} آپ کی پسندیدہ میں شامل کر دی گئی۔',
  navaids_fav_removed: '{{name}} آپ کی پسندیدہ سے ہٹا دی گئی۔',
  navaids_fav_add_title: 'پسندیدہ میں شامل کریں',
  navaids_fav_add_search_placeholder: 'اپنی اسکرینیں تلاش کریں...',
  navaids_fav_add_button: '{{name}} کو پسندیدہ میں شامل کریں',
  navaids_fav_add_empty: 'جو بھی اسکرین آپ کھول سکتے ہیں وہ پہلے ہی آپ کی پسندیدہ میں شامل ہے۔',

  navaids_recent_module_kicker: 'ورک اسپیس',
  navaids_recent_portal_title: 'حالیہ اشیاء',
  navaids_recent_intro: 'وہ اسکرینیں جو آپ نے حال ہی میں کھولی ہیں، ترتیب کے ساتھ۔',
  navaids_recent_list_title: 'حال ہی میں دیکھی گئی',
  navaids_recent_empty: 'ابھی یہاں کچھ نہیں ہے — آپ کی کھولی ہوئی اسکرینیں اس فہرست میں دکھائی دینے لگیں گی۔',

  navaids_err_no_active_tenant: 'کوئی فعال کمپنی سیشن نہیں ملا۔ براہِ کرم دوبارہ سائن ان کریں۔',
  navaids_err_screen_code_required: 'پسندیدہ بنانے کے لیے ایک اسکرین منتخب کریں۔',
  navaids_err_screen_not_found: 'یہ اسکرین اب موجود نہیں ہے۔',
};

const tl = {
  navaids_fav_module_kicker: 'Workspace',
  navaids_fav_portal_title: 'Mga Paborito',
  navaids_fav_intro: 'Ang mga screen na na-favorite mo para sa mabilis na access, at isang listahan para magdagdag pa.',
  navaids_fav_list_title: 'Mga paborito ko',
  navaids_fav_empty: 'Wala ka pang na-favorite na screen.',
  navaids_fav_remove: 'Alisin ang {{name}} sa mga paborito',
  navaids_fav_added: 'Naidagdag ang {{name}} sa iyong mga paborito.',
  navaids_fav_removed: 'Naalis ang {{name}} sa iyong mga paborito.',
  navaids_fav_add_title: 'Magdagdag ng paborito',
  navaids_fav_add_search_placeholder: 'Hanapin ang iyong mga screen...',
  navaids_fav_add_button: 'Idagdag ang {{name}} sa mga paborito',
  navaids_fav_add_empty: 'Nasa mga paborito mo na ang bawat screen na puwede mong buksan.',

  navaids_recent_module_kicker: 'Workspace',
  navaids_recent_portal_title: 'Mga Kamakailang Binuksan',
  navaids_recent_intro: 'Ang mga screen na kamakailan mong binuksan, ayon sa pagkakasunod.',
  navaids_recent_list_title: 'Kamakailang binisita',
  navaids_recent_empty: 'Wala pang laman dito — lalabas dito ang mga screen na iyong bubuksan.',

  navaids_err_no_active_tenant: 'Walang aktibong company session na nahanap. Mangyaring mag-sign in muli.',
  navaids_err_screen_code_required: 'Pumili ng screen na ida-favorite.',
  navaids_err_screen_not_found: 'Wala na ang screen na ito.',
};

export default { en, ar, hi, ur, tl };
