# خطة التحديث الثالثة — ما تم تنفيذه

هذا المستند يربط كل بند في `thirdupdate.md` بما تم بناؤه فعلاً، وبالملفات التي
تحتويه، ويوضح صراحةً ما لم يُنفَّذ بعد ولماذا.

> This document maps every item of the third update plan to what was actually
> built, names the files, and states plainly what is not done yet.

---

## 1. المعمارية متعددة الشركات — Multi-tenant architecture

| البند | الحالة | التنفيذ |
|---|---|---|
| تطبيق React واحد، مشروع Supabase واحد، جداول مشتركة | ✅ | كما هو |
| عمود `tenant_id` في جميع الجداول | ✅ | `202608040012` — أُضيف إلى 35 جدولاً قائماً وإلى كل جدول جديد |
| عزل كامل بواسطة RLS | ✅ | سياسة `"tenant isolation"` من نوع **RESTRICTIVE** على كل جدول، تُدمج بعملية AND مع سياسات الصلاحيات القائمة |
| `tenants` / `tenant_branding` / `tenant_settings` / `tenant_domains` / `tenant_memberships` | ✅ | `202608040012` |
| اسم الشركة بعدة لغات | ✅ | `tenant_names(tenant_id, language_code, name)` |
| قيود فريدة مركبة `(tenant_id, code)` | ✅ | أُعيد بناء كل قيد فريد عام |
| منع الربط بين شركتين بمفاتيح مركبة | ✅ | `202608040012` + `202608040020` — 18 مفتاحاً أجنبياً مركباً `(tenant_id, x_id)` |
| `created_by / updated_by / created_at / updated_at / deleted_at / is_deleted / row_version` | ✅ | العمود الزمني في هذا المشروع اسمه `created_on / updated_on / deleted_date`؛ أُكملت المجموعة على كل جدول عبر `apply_row_defaults` |
| فصل Platform Operator عن Tenant Administrator | ✅ | دور `PLATFORM_OPERATOR` موجود حصراً في شركة `platform`؛ `PLATFORM_ADMIN` صار «مدير المؤسسة» داخل شركته |
| الصلاحية تُفحص بـ User + Tenant + Role + Permission | ✅ | `has_permission()` أُعيدت كتابتها لتشترط `roles.tenant_id = current_tenant_id()` |
| ملفات Storage بمسار `tenants/{tenant_id}/...` | ✅ | `src/lib/storage/index.js` + سياسات `storage.objects` |
| البيانات الحالية تُحفظ لشركة `shalfa` | ✅ | `202608040012` ينشئ `platform` و `shalfa` وينقل كل صف قائم إلى `shalfa` |

**نقطتان أمنيتان عولجتا أثناء التنفيذ:**

1. الدوال القديمة من نوع `SECURITY DEFINER` كانت تتجاوز RLS وتقرأ بيانات كل
   الشركات — دالة تعمل بصلاحية مالكها لا تخضع لسياسات الصفوف. عولجت في
   `202608040020`: `list_form_recipients`، `approval_dashboard_data`،
   `approval_verify`. ونفس الفئة من الخطأ وجدت وأُصلحت في
   `audience_matches` و `notification_enabled` و `support_ticket_status`
   و `tenant_usage_snapshot` و `reject_signup_request`.
2. جدول `public.users` يحمل رقم الهوية والجنس والجوال، فلا يجوز فتحه لكل زميل
   لمجرد أن الشاشات تحتاج قائمة أسماء. بقي مغلقاً، وأُضيفت
   `public.employee_directory(query, limit)` التي ترجع أعمدة العرض فقط داخل
   شركة المستخدم، وتستخدمها كل قوائم اختيار الموظفين.

---

## 2. العناوين والمسارات — Addresses

| البند | الحالة | التنفيذ |
|---|---|---|
| `bbnovix.com/shalfa/` لكل شركة | ✅ | `src/lib/routing.js` + `src/App.jsx` (توجيه بالمسار بدل `#`) |
| `bbnovix.com/platform/` | ✅ | شركة المنصة سلاگ `platform` |
| `bbnovix.com/portal` | ✅ | `src/components/public/PortalSite.jsx` |
| `/verify` و `/support` و `/signup` عامة | ✅ | مسارات عامة خارج أي شركة |
| الروابط القديمة `#/...` | ✅ | تُعاد كتابتها تلقائياً إلى `/shalfa/...` |
| النشر على النطاق | ✅ | `public/CNAME`، `dist/404.html`، `vite.config.js` |

---

## 3. الصفحة الافتتاحية للشركات وصفحة الدخول

| البند | الحالة |
|---|---|
| 1. شعار ديناميكي، وفارغ عند عدم وجوده | ✅ `TenantLogo` لا يعرض شيئاً إطلاقاً بدون شعار |
| 2. حذف الاسم التجاري القديم وجعل اسم الشركة ديناميكياً حسب اللغة | ✅ `landing_title_company` + `tenant_names` |
| 3. استخدام «بوابة الموظفين» في النص العام | ✅ `landing_about_generic` |
| 4. المقر الرئيسي ديناميكي، وإخفاء المستطيل كاملاً بدون رابط | ✅ |
| 5. لوجو واسم الشركة أسفل الصفحة | ✅ `Footer` |
| 6. معلومات التواصل ديناميكية | ✅ `tenant_contacts` + `ContactChannels` |
| 7. حذف جملة حقوق النشر | ✅ |
| 8. رابط LinkedIn ديناميكي | ✅ |
| 9. صورة الغلاف الديناميكية مع الافتراضية | ✅ `hero_image_url` وإلا `src/assets/portal-hero.png` |
| صفحة الدخول: نفس المعالجة | ✅ `AuthPage` + `ResetPasswordPage` |

---

## 4. صفحة الاشتراك والتفعيل التلقائي

| البند | الحالة | التنفيذ |
|---|---|---|
| نموذج اشتراك عام | ✅ | `src/components/public/SignupPage.jsx` |
| امتداد الشركة: إنجليزي وأرقام فقط، فريد، غير محجوز، لا يتغير أبداً | ✅ | `slug_is_available()` + `platform_reserved_slugs` + `guard_tenant_slug` (يرفض التعديل على مستوى قاعدة البيانات) |
| اسم الشركة بكل اللغات المتاحة مع لغة افتراضية إجبارية | ✅ | `tenant_names` + التحقق في `provision_tenant` |
| مالك أو مسؤول، الاسم، رقم التواصل، الايميل | ✅ | |
| اللوجو + صورة الغلاف مع تحديد النوع والمقاس | ✅ | ترفع عبر دالة الحافة ثم إلى `tenant-branding` |
| عنوان جوجل ماب | ✅ | `tenant_branding.map_url` |
| قنوات التواصل الاختيارية بأيقوناتها | ✅ | `tenant_contacts` |
| المنطقة الزمنية والثيمات | ✅ | `tenants.timezone`، `tenant_branding.theme_preset` والألوان |
| الرقم الضريبي ومعلومات أساسية أخرى | ✅ | `tax_number`, `commercial_register`, `industry`, `employee_range`, `legal_name` |
| بعد الحفظ: إنشاء الشركة + موظف رقم 1 + مستخدم مفعّل + بريد ترحيبي فيه رابط تعيين كلمة المرور ورابط الشركة | ✅ | `provision_tenant()` + `bootstrap_tenant_defaults()` + دالة الحافة `tenant-signup` + قالب `TENANT_WELCOME` |
| استخدام `bbnovix@gmail.com` بدل البريد القديم | ✅ | `supabase/functions/_shared/mailer.ts` — عبر متغيرات بيئة، وليس في الكود |

---

## 5. اللغات

| البند | الحالة |
|---|---|
| نظام موحد، لا كلمة ثابتة | ✅ جزئياً — كل الشاشات الجديدة والصفحات العامة والدخول عبر المترجم؛ `AdminCenter` القديمة نُقلت نصوصها |
| الأدوار والحالات تُخزن رموزاً وتُعرض مترجمة | ✅ `status_*` و `role_*` و `codeLabel()` |
| «الاسم الأول / الاسم الثاني» بدل «عربي / إنجليزي» | ✅ `label_name_1` / `label_name_2` |
| كل رسائل الخطأ مترجمة | ✅ `error_*` وأكواد الأخطاء من قاعدة البيانات تُترجم عند العرض |
| إضافة لغة جديدة | ✅ إدخال واحد في `src/i18n/languages.js` |

---

## 6. الوحدات الجديدة

| الوحدة | الحالة | الملفات |
|---|---|---|
| الدردشة | ✅ | `202608040016` + `src/components/chat/*` |
| التقويم | ✅ | `202608040014` + `src/components/calendar/*` |
| المفكرة | ✅ | `202608040014` + `src/components/notes/*` |
| لوحة الإعلانات (بطاقات + Carousel + تثبيت) | ✅ | `src/components/announcements/*` |
| الاستطلاع (واحد منشور فقط + تغيير التصويت) | ✅ | `src/components/surveys/*` |
| مركز الإشعارات + تفضيلات لكل نوع | ✅ | `202608040015` + `src/components/notifications/*` |
| تخصيص الصفحة الرئيسية + السحب والإفلات | ✅ | `202608040015` + `src/components/workspace/*` |
| محرك الاستهداف الموحد (AND/OR/NOT) | ✅ | `202608040013` + `src/components/audience/*` |
| تذاكر الدعم (عام + داخلي + لوحة الرد) | ✅ | `202608040018` + `src/components/public/PublicSupportPage.jsx` + لوحة المنصة |
| التحقق من الوثائق + الشهادات + مصمم القوالب | ✅ | `202608040017` + `src/components/verification/*` |
| لوحة إدارة المنصة | ✅ | `202608040018` + `src/components/platform/*` |
| طبقة التخزين المجردة | ✅ | `src/lib/storage/index.js` + `supabase/functions/storage-proxy` |
| الحصص والحدود | ✅ | `tenant_quotas` + `tenant_quota_check/consume` |
| الأمن (كلمة المرور، الجلسة، المحاولات، الأجهزة، IP) | ⚠️ جزئي | `202608040018` + `202608050023`: التسجيل وسياسة الواجهة ومهلة الجلسة منفذة؛ فرض MFA وIP وقفل Auth الحقيقي ما زال يحتاج Auth Hook/إعداد Supabase. |
| Feature Flags / Modules / License | ✅ | `platform_modules` → `platform_licenses` → `tenant_modules` |

---

## 7. ما لم يُنفَّذ بعد — Not delivered

هذه بنود من الخطة تُركت عن قصد، مع سبب واضح لكل واحد:

1. **مزودات التخزين Google Drive و OneDrive و Azure Blob** — البنية جاهزة
   (`storage_providers`, `tenant_storage_config`, `storage-proxy`) والمسار
   المتوافق مع S3 (S3 / R2 / B2) منفّذ فعلاً؛ أما الثلاثة الباقية فتحتاج تدفق
   OAuth لكل مزود وتخزين رموز التحديث، وهو مشروع مستقل. الدالة ترجع
   `NOT_IMPLEMENTED` بوضوح بدل التظاهر بالعمل.
2. **Backup & Restore لكل شركة** — موجود في لوحة المنصة كقسم ظاهر بأزرار معطّلة
   وشرح، كما طلبت الخطة («ضعها في الخطة حتى لو لم تنفذها الآن»).
3. **Template Marketplace** — الوحدة مسجّلة في `platform_modules` وقابلة
   للتفعيل، لكن لا توجد شاشة لها بعد.
4. **AI و Webhooks و Teams / Google / Power Automate** — مسجّلة كوحدات
   مستقبلية فقط.
5. **Voice Messages و Video Calls في الدردشة** — أعلام موجودة في الإعدادات
   ومعطّلة، كما وصفتها الخطة بأنها مستقبلية.
6. **CPU و Memory في شاشة صحة النظام** — لا يمكن قياسهما من داخل Postgres،
   فالبطاقة تعرض «غير متاح من هنا» بدل رقم مخترع.
7. **شاشة كاملة للإعلانات والاستطلاعات داخل البرنامج** — تظهران كبطاقتين في
   الصفحة الرئيسية وتُداران من تاب الإدارة، ولا توجد لهما صفحة مستقلة بعد.
   مسجّلتان في `app_screens` ومعطّلتان حتى تُبنى الصفحة.

---

## 9. اللغات — الحالة النهائية

| الملف | المفاتيح | ar | en | hi | ur | tl |
|---|---|---|---|---|---|---|
| 12 ملف قاموس | **1,796** | ✅ | ✅ | ✅ | ✅ | ✅ |

إجمالي 8,980 نصاً مترجماً. لا يوجد مفتاح `t()` واحد في البرنامج بلا ترجمة
(تحقّق آلي)، ولا نص ظاهر للمستخدم مكتوب داخل الشاشات.

الأردية مكتوبة بالأردية لا بالعربية، والهندية بالديفاناغري، والفلبينية كما
تُكتب فعلاً في بيئة العمل.

---

## 8. ملاحظة أمنية مهمة

ملف الخطة `thirdupdate.md` يحتوي كلمة مرور بريد `bbnovix@gmail.com` مكتوبة
صراحة. **لم تُوضع في الكود ولا في أي ملف يُرفع.** المطلوب:

1. توليد **App Password** من حساب Google (جوجل يرفض كلمة مرور الحساب في SMTP).
2. وضعها في أسرار Supabase: `supabase secrets set SMTP_PASS=...`.
3. تغيير كلمة مرور الحساب الحالية لأنها ظهرت في ملف نصي.
