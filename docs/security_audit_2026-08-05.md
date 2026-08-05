# تدقيق أمني شامل لـ bbnovix — 2026-08-05

## النتيجة التنفيذية

تم تدقيق المستودع محليًا، بما في ذلك React/Vite، GitHub Actions، ملفات Supabase
SQL، وEdge Functions. لا يوجد دليل على مفتاح service-role داخل الملفات المتتبعة
ولا في تاريخ Git الذي تم فحصه، ونجحت اختبارات البناء والتبعيات. لا يمكن إعلان
النظام آمنًا 100% قبل فحص حالة مشروع Supabase الفعلية من لوحة المشروع؛ ملفات
migrations وحدها لا تثبت أنها طُبّقت على قاعدة الإنتاج.

## الأدلة المنفذة

| الفحص | النتيجة |
|---|---|
| `npm audit --audit-level=high` | 0 ثغرات: Critical/High/Moderate/Low |
| `npm run lint` | ناجح |
| `npm test` | 25/25 ناجحًا، وتشمل عزل المستأجر وRLS الثابت وStorage paths |
| `npm run build` | ناجح، ولا توجد source maps في `dist` |
| البحث عن الأسرار في الملفات وتاريخ Git | لم يظهر `.env` أو مفتاح service-role أو private key متتبعًا |
| `console.log`/debugger | لا يوجد؛ توجد 3 `console.error` عامة لا تطبع tokens |
| 94 جدولًا في migrations | 68 لها `enable RLS` صريحًا و26 ضمن كتل `DO` الديناميكية؛ يلزم تأكيد العدد من SQL Editor في الإنتاج |

## Critical

لم يثبت فحص المستودع وجود مشكلة Critical.

## High — يلزم المعالجة قبل اعتبار البيانات الحساسة محمية

### 1. `employee-assets` حاوية عامة

في `supabase/migrations/202607280005_content_profile_and_performance_form.sql`
و`202607290008_profile_assets_and_internal_memo.sql` و
`202608040012_multitenant_foundation.sql` يتم ضبط bucket `employee-assets` إلى
`public = true`. وفي `src/context/AuthContext.jsx` يتم تحويل مسار الصورة أو
التوقيع إلى `getPublicUrl` ثم حفظه في `users.avatar_url` أو `users.signature_url`.
هذا يجعل التوقيعات، وأي ملف يوضع في الحاوية، قابلًا للتحميل برابط مباشر دون JWT؛
سياسة `select to authenticated` لا تحمي رابط CDN العام.

المعالجة الآمنة ليست تغيير `public=false` فقط، لأنه سيكسر الروابط المخزنة الحالية.
يجب تنفيذ ترحيل منظم: فصل الصور العامة عن التوقيعات، أو جعل الحاوية خاصة وإضافة
`avatar_path`/`signature_path` مع signed URLs قصيرة العمر أو Edge Function تتحقق
من العضوية. بعد الترحيل يجب حذف/إبطال الروابط العامة القديمة واختبار مستخدم من
شركة أخرى.

### 2. حالة Supabase الفعلية غير مثبتة من المستودع

الاختبارات الحالية static وتقرأ migrations. يجب تنفيذ استعلام `supabase/verification.sql`
في SQL Editor للإنتاج، ثم حفظ ناتج: كل الجداول العامة، `rowsecurity`، policies،
grants، buckets، وحقول `storage.objects`. أي جدول أو bucket ظهر خارج النتيجة
يُعامل كـ High حتى يُغلق.

## Medium

### 1. CORS افتراضي واسع

`supabase/functions/_shared/cors.ts` يعيد origin المطلوب عندما لا يكون السر
`ALLOWED_ORIGINS` مضبوطًا. هذا لا يتجاوز Authorization الحالي، لكنه يتيح لأي موقع
قراءة ردود الدوال التي يملك الزائر token لها ويجعل حماية CSRF المستقبلية أضعف.
اضبط في Supabase secrets:

`ALLOWED_ORIGINS=https://bbnovix.com,https://www.bbnovix.com`

وأضف localhost فقط أثناء التطوير. اترك endpoints العامة (signup/verify/support)
مفتوحة فقط إذا كان ذلك مقصودًا، وراقبها بمعدل طلبات على مستوى قاعدة البيانات أو
بوابة خارجية؛ limiter الموجود داخل isolate ليس عالميًا.

### 2. إعدادات Auth لا يمكن إثباتها من الكود

يجب التحقق يدويًا من Supabase Authentication:

- Site URL = `https://bbnovix.com`.
- Redirect URLs تشمل `https://bbnovix.com/**` ونسخة `www` إن كانت مستخدمة.
- Email confirmation وقيود كلمة المرور وMFA مضبوطة وفق سياسة المنتج.
- تعطيل أي redirect URL قديم أو wildcard غير مطلوب.

### 3. روابط البيانات الخارجية

تمت إضافة `src/utils/safeUrl.js` وربطه بالروابط الخارجية في الواجهة لمنع
`javascript:`/`data:` URLs القادمة من بيانات الشركة أو المحتوى. يجب أيضًا رفض هذه
البروتوكولات عند إدخال البيانات في أي API جديد، وليس في الواجهة فقط.

## Low / Informational

- GitHub Pages لا يسمح بإضافة HTTP response headers مخصصة. CSP وHSTS وReferrer-
  Policy وPermissions-Policy يجب وضعها عبر طبقة reverse proxy مثل Cloudflare؛
  لا تضف `_headers` وتتوقع أن يطبقها GitHub Pages.
- `console.error` الموجود يعرض أخطاء تشغيل عامة في console؛ لا يطبع session أو
  token، لكنه يستحسن تقليله في production أو تمريره إلى مراقبة أخطاء.
- `npm audit` يعكس حالة lockfile وقت التدقيق؛ يجب إعادة تشغيله في كل deploy.
- ملف `thirdupdate.md` محلي ومُهمل من Git ويحتوي نصًا تاريخيًا عن بيانات بريد.
  لا يجب وضع أي كلمة مرور حقيقية فيه؛ تم التأكد أن السطر الحالي لا يحتوي قيمة
  كلمة مرور، ويجب حذف النسخ القديمة من أي جهاز/نسخة احتياطية وتدوير App Password
  إذا سبق استخدامه في محادثة أو ملف.

## OWASP Top 10 — ملخص الحالة

- A01 Broken Access Control: عزل tenant وRLS وقيود Storage paths موجودة في
  migrations والاختبارات؛ يلزم إثبات الإنتاج، ومشكلة public employee-assets هي
  استثناء مهم.
- A02 Cryptographic Failures: لا توجد أسرار frontend حساسة؛ signed URLs للتوقيعات
  مطلوبة.
- A03 Injection: لا يوجد `dangerouslySetInnerHTML`/`eval` في الواجهة؛ mailer
  يهرب HTML والقوالب.
- A04 Insecure Design: دعوات البريد أصبحت تستخدم APP_URL الثابت بعد إصلاح Open
  Redirect؛ يلزم نشر التغيير.
- A05 Security Misconfiguration: CORS وAuth/headers تحتاج ضبط لوحة Supabase أو
  reverse proxy.
- A06 Vulnerable Components: `npm audit` بلا نتائج.
- A07 Identification/Auth: التدفق موجود، لكن Site URL وMFA وemail confirmation
  تحتاج تحققًا من لوحة Supabase.
- A08 Software/Data Integrity: Actions تشغل lint/test/audit قبل البناء.
- A09 Logging/Monitoring: توجد جداول security events/login attempts، لكن لم يتم
  التحقق من retention والتنبيهات في الإنتاج.
- A10 SSRF: storage-proxy يقيد providers إلى S3/R2/B2، لكن يجب التحقق من أن
  `endpoint` لا يقبل عناوين داخلية عند حفظ إعدادات provider.

## إجراءات الإغلاق المطلوبة

1. تنفيذ استعلام `supabase/verification.sql` في مشروع الإنتاج وإرفاق الناتج.
2. معالجة `employee-assets` قبل تخزين أي توقيع جديد.
3. ضبط `ALLOWED_ORIGINS` وإعدادات Auth في Supabase.
4. تفعيل Secret Scanning/Push Protection من GitHub إن كانت الخطة تدعمها، ومراجعة
   Dependabot alerts.
5. إعادة تشغيل الاختبارات بعد نشر migration الخاصة بالتخزين واختبار cross-tenant
   بحسابين من شركتين مختلفتين.

## جرد Buckets واستخدام Service Role

| Bucket | الحالة في migrations | الاستخدام | الحكم |
|---|---|---|---|
| `tenant-branding` | `public=true` | شعارات وصور واجهة عامة | مقبول بشرط عدم رفع ملفات خاصة |
| `employee-assets` | `public=true` | صور الموظفين والتوقيعات | High؛ يجب فصل التوقيعات أو جعلها خاصة |
| `form-attachments` | `public=false` | مرفقات النماذج | مناسب مبدئيًا، مع اختبار سياسات القراءة والحذف |
| `tenant-files` | لا يُنشأ في migrations | مزود Supabase الاختياري للتخزين الإضافي | يُنشأ فقط عند تفعيله وبشكل خاص |

الملف `supabase/storage_security_audit.sql` يقرأ الجرد الفعلي من مشروع الإنتاج،
ويكشف أي Bucket مفقود أو visibility خاطئة وسياسات `storage.objects` وRPC grants.

Service Role مستخدم فقط في:

- `invite-employee`: إدارة Auth users بعد التحقق من JWT و`Employees.Manage`.
- `tenant-signup`: إنشاء/حذف مستخدم Auth وتهيئة الشركة العامة.
- `send-email`: تشغيل queue وSMTP، مع مقارنة bearer أو worker secret.
- `storage-proxy`: قراءة إعدادات التخزين وتحديث health بعد التحقق من tenant.
- `verify-api`: لا يستخدم Service Role، ويستعمل anon RPC للقراءة العامة.

القيمة نفسها لا توجد في الكود أو الواجهة؛ تُقرأ من `Deno.env` فقط. يجب التأكد من
وجودها في Supabase Function Secrets دون نسخها إلى GitHub Pages أو `.env`.
