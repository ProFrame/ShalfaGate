# Update 4 — Phase 0: Platform Core + INumberGenerator — 2026-08-05

يوثّق هذا الملف الموديول الأول من التحديث الرابع وفق قاعدة "تحديث الوثائق أولاً بأول"
المذكورة في `FourthUpdate.md`. النطاق: خدمة ترقيم موحدة واحدة (`INumberGenerator`) تحل
محل ثلاثة مولّدات مخصصة، مع تثبيت `src/lib/platformCore/` كموطن الواجهة الأمامية
لخدمات Platform Core.

---

## 1. Architecture

- **المالك**: Platform Core (حسب جدول Shared Platform Services في `FourthUpdate.md`).
- **الترتيب**: هذا هو الموديول الأول في تسلسل التنفيذ الإلزامي
  (`Platform Core → INumberGenerator → Storage → ...`).
- **القرار المعماري الحاسم في هذه المرحلة**: تم إبقاء `generate_verify_code()` /
  `generate_document_code()` (رمز التحقق العام) **منفصلين تماماً** عن `generate_number()`
  (الرقم المرجعي التسلسلي)، رغم أن كليهما "رقم" منطقياً. السبب: `verify_document(p_code)`
  دالة عامة غير مصادق عليها بدون أي طبقة حماية ثانية — أي شخص يعرف الكود يرى بيانات
  الوثيقة كاملة. لو أصبح هذا الكود تسلسلياً (`NO-SHLF-TA-00000125` بدل عشوائي) لأصبح كل
  مستند لأي شركة قابلاً للاكتشاف بمجرد تجربة أرقام متتالية. هذا قرار صريح من صاحب المنتج
  بعد طرح الخيارات الثلاثة (رقم واحد تسلسلي / رقم تسلسلي + لاحقة عشوائية / رقمان
  منفصلان) — تم اختيار **رقمان منفصلان**. أي عمل مستقبلي على TA/CT في موديول Workflow
  يجب أن يعرض الاثنين: `reference_no` (من `generate_number`) للعرض، و`verify_code`/
  `document_code` (كما هو) كسر التحقق العام فقط.
- **ما لم يُبنَ عمداً في هذه المرحلة**: Tags، Activity Timeline، Barcode Generator، QR
  service — جميعها مذكورة في جدول Shared Platform Services لكن بلا أي مستهلك (Consumer)
  اليوم. ستُبنى عند أول موديول يحتاجها فعلياً (الأصول على الأرجح، حسب `FourthUpdate.md`
  الذي ينص صراحة أن الباركود/QR للأصل يجب أن يعتمدا على `INumberGenerator`) بدلاً من بناء
  خدمة بلا مستخدم مسبقاً.

## 2. ERD

```
public.number_sources (catalogue, no tenant_id — global)
  code (PK)  label_ar  label_en  owner_module  is_active

public.number_sequences (per-tenant counter)
  tenant_id (FK → tenants.id)  ─┐
  source_code (FK → number_sources.code) ├─ PK (tenant_id, source_code)
  next_value  updated_on       ─┘
```

لا توجد علاقة مباشرة بعد بين `number_sequences` وأي كيان عمل (Asset، Work Order...) —
الأرقام المولدة تُخزَّن كنص (`text`) داخل عمود الكيان المستهلك، تماماً كما تُخزَّن أرقام
`verify_code` اليوم. هذا الربط يحدث عند بناء كل موديول مستهلك (Assets، إلخ)، وليس هنا.

## 3. Database

ملف الترحيل: `supabase/migrations/202608050039_platform_core_number_generator.sql`.

- `number_sources`: جدول كتالوج عام (بدون `tenant_id`)، مصدر واحد للإجابة عن "ما هو AS /
  WO / RF"، مزروع بالفعل بكتالوج `FourthUpdate.md` الكامل (TA, AS, WO, TR, CT, ID, IN, MS,
  PO, IV, CO, RF, AU, EV) + `ST` (تذاكر الدعم).
- `number_sequences`: عدّاد بنية تحتية، معاملته كـ `TENANT_INFRASTRUCTURE` في
  `tests/tenancy-invariants.test.mjs` (مثل `tenant_quotas`) وليس كجدول عمل عادي، لأنه
  يُكتب حصراً من داخل `generate_number()` بمعامل `p_tenant_id` صريح (بعض المستدعين —
  إنشاء تذكرة دعم عامة، مهام بصلاحية الخادم — لا تملك جلسة تحدد الشركة أصلاً)، فتثبيت
  `tenant_id` من الجلسة عبر `apply_row_defaults` سيكون خاطئاً هنا تحديداً.
- الزيادة ذرّية (`insert ... on conflict (tenant_id, source_code) do update set
  next_value = next_value + 1 ... returning next_value - 1`) — نفس نمط
  `tenant_quota_consume()` الموجود مسبقاً. **تم التحقق فعلياً**: تطبيق كامل سلسلة الـ39
  ترحيلاً على نسخة PostgreSQL 17 معزولة محلياً نجح 39/39 بلا أي خطأ، ثم اختبار وظيفي حي:
  20 استدعاء متزامن حقيقي (20 اتصال psql منفصل بالتوازي) لنفس (tenant, source) أنتجوا 20
  قيمة فريدة متتالية بلا تكرار وبلا فجوة (00000001 → 00000020).

## 4. API

```
generate_number(p_source_code text, p_tenant_id uuid default null) returns text
```

- المستدعي المفترض: `select public.generate_number('AS');` من داخل RPC أخرى بصلاحية
  Security Definer، أو من الواجهة عبر `generateNumber('AS')` في
  `src/lib/platformCore/numberGenerator.js`.
- الناتج: `NO-{TENANT_SLUG}-{SOURCE}-{00000125}` (سلاج الشركة بأحرف كبيرة، رقم بـ8 خانات).
- الأخطاء: `NUMBER_GENERATOR_TENANT_REQUIRED` (لا جلسة ولا `p_tenant_id`)،
  `NUMBER_GENERATOR_UNKNOWN_SOURCE` (كود غير مسجل أو معطّل في `number_sources`)،
  `NUMBER_GENERATOR_TENANT_NOT_FOUND`، `NUMBER_GENERATOR_TENANT_NOT_AUTHORIZED`
  (انظر نموذج التفويض أدناه).
- **نموذج التفويض لـ `p_tenant_id`** (أُضيف بعد المراجعة المعمارية، انظر القسم 8): بما أن
  الدالة ممنوحة لـ `authenticated` (كل شاشة مستقبلية تناديها مباشرة لشركتها الخاصة)، فإن
  تمرير `p_tenant_id` مختلف عن شركة الجلسة الحالية **لا يُقبل تلقائياً**. يُسمح به فقط في
  حالتين: (1) المستخدم عضو في دور `PLATFORM_OPERATOR` (`is_platform_operator()`)، أو (2)
  الطلب هو تحديداً `source_code = 'ST'` تجاه المستأجر الثابت `platform_tenant_id()` —
  الحالة الوحيدة التي يحتاجها `support_next_ticket_no()` فعلياً، بغض النظر عن كون
  المستدعي مجهولاً أو موظف شركة عادية. أي موديول مستقبلي يحتاج نمطاً مشابهاً (مستأجر ثابت
  يُستهدف بغض النظر عن هوية المستدعي) يجب أن يُضاف صراحة إلى هذه القائمة المحدودة، ولا
  يجوز توسيعها إلى "المستأجر الثابت مسموح دائماً لأي مصدر".
- `support_next_ticket_no()` أصبحت الآن غلافاً رقيقاً حول
  `generate_number('ST', platform_tenant_id())` بدل تسلسل عام غير مقيّد بالشركة —
  السلوك الظاهري لمستدعييها (`support_ticket_create`, `support_ticket_create_internal`)
  لم يتغيّر، فقط شكل الرقم الجديد يتحول من `BBX-YYYY-######` إلى
  `NO-PLATFORM-ST-00000412`؛ الأرقام القديمة المصدرة سابقاً تبقى بشكلها القديم.

## 5. Permissions

- `generate_number(text, uuid)`: `grant execute ... to authenticated, service_role` فقط
  (لا منح لـ `anon` — لا حاجة له اليوم، الاستدعاءات من سياقات مجهولة تمر عبر دوال أخرى
  بصلاحية Security Definer مثل `support_ticket_create`، والتي تُنفَّذ بصلاحية مالكها لا
  المستدعي الأصلي).
- `number_sources`: قراءة فقط لـ `authenticated` (RLS، بلا `tenant_id` لأنه كتالوج عام).
- `number_sequences`: قراءة فقط لصاحب الـ`tenant_id` نفسه (RLS)؛ لا صلاحية إدراج/تعديل
  مباشرة لأي دور — الكتابة الوحيدة عبر `generate_number()` بصلاحية Security Definer.
- الدفعة تنتهي بـ `revoke execute on all functions in schema public from public;` (آخر
  سطر في الترحيل) — وفق القاعدة المعروفة أن أي `grant`/`revoke` صريح على دالة يعيد فتح
  صلاحية `PUBLIC` تلقائياً.

## 6. Workflow

لا يوجد تكامل بعد. `TA` (Approved Form Transaction) مسجّل في الكتالوج لكن موديول
Workflow Engine (المرحلة التالية بعد Storage) هو من سيربط `generate_number('TA')`
بالفعل بمسار تقديم/اعتماد النماذج.

## 7. Storage

لا تغيير على نظام التخزين في هذه المرحلة. تخزين هذه المرحلة نصي بحت (أرقام كنصوص داخل
أعمدة قواعد بيانات)، ولا رفع ملفات متضمَّناً.

## 8. المراجعة المعمارية المستقلة (قاعدة رقم 3)

نُفّذت مراجعة معمارية مستقلة (4 محاور: Module Ownership، Tenant Security، Concurrency
Correctness، Convention & Completeness)، وكل ملاحظة خضعت لتحقق عدائي (Adversarial
Verification) منفصل قبل قبولها. 8 ملاحظات أُكِّدت، أُصلحت جميعها قبل إغلاق المرحلة:

1. **حرجة (Blocker)** — `generate_number()` كانت تثق بأي `p_tenant_id` يُمرَّر من أي
   مستخدم `authenticated`، مما يسمح لموظف أي شركة بإنفاق/قراءة عدّاد أي شركة أخرى ومعرفة
   الـ`slug` الخاص بها — نفس ثغرة `tenant_quota_consume()` التي أُصلحت سابقاً في الترحيل
   `202608050031`. **الإصلاح**: نموذج التفويض الموضح في القسم 4 أعلاه (تم التحقق فعلياً
   بمحاكاة هجوم حقيقية على قاعدة بيانات معزولة: موظف Tenant A محظور من مهاجمة Tenant
   Platform أو أي معرّف مُختلق، بينما التسجيل الشرعي لتذكرة الدعم والمشغّل الحقيقي
   `PLATFORM_OPERATOR` ما زالا يعملان).
2. **رئيسية** — `generateNumber()` في الواجهة كانت تستخدم `throw` بدل نمط `{data, error}`
   الموثّق في `docs/bbnovix_contract.md` §9 والمطابق لأسلوب `src/lib/storage/index.js`.
   **أُصلحت**: الآن تُعيد `{data, error}` دائماً بدون `throw`.
3. **بسيطة** — الوضع التجريبي (`useLocalData`) كان يخزّن العدّادات في `Map` بالذاكرة فقط
   (تُصفَّر عند أي تحديث للصفحة)، خلافاً لكل ملف Demo آخر في المشروع الذي يحفظ في
   `localStorage`. **أُصلحت**: تُحفَظ الآن في `localStorage` بنفس نمط
   `verificationService.js`/`approvalService.js`.
4. **طفيفة** — رسالة الخطأ `NUMBER_GENERATOR_UNKNOWN_SOURCE: %` كانت الاستثناء الوحيد في
   كامل سلسلة الترحيلات الذي يُلحق قيمة ديناميكية بعد رمز الخطأ. **أُصلحت**: أصبحت رمزاً
   ثابتاً (`SCREAMING_SNAKE_CODE`) بدون إلحاق، مطابقة للعُرف الموثّق في §2 من
   `bbnovix_contract.md`.

ملاحظتان لم تُقبلا (Refuted) عن حق:
- ادّعاء بعدم تحديث الوثائق — كان قبل كتابة هذا الملف وتحديث `bbnovix_contract.md`، وليس
  خللاً حقيقياً.
- ملاحظة بأن `src/components/FormsPortal.jsx` ما زال يولّد أرقام EV-/MEM- محلياً عبر
  `Date.now()` خارج `generate_number()` — صحيحة تقنياً لكنها **خارج نطاق هذه المرحلة**:
  الملف موجود قبل هذا الترحيل بكثير، وليس من الثلاثة مولّدات التي استهدفتها هذه الخطة.
  **ملاحظة استباقية للمستقبل**: عند بناء موديول Workflow Engine أو Operations
  (`EV` مُسجَّل بالفعل في `number_sources` لموديول Operations)، يجب ترحيل
  `FormsPortal.jsx`/`formsService.js` (`blankForm()`/`blankMemo()`، الأسطر ~87 و110) لاستخدام
  `generateNumber('EV')`/`generateNumber('TA')` بدل التوليد العشوائي المحلي الحالي، والذي
  يحمل احتمال تصادم حقيقي (نافذة 10 ثوانٍ فقط) ضد `uq_forms_reference_no_tenant`.

## الحالة

**مغلقة (Closed)** بتاريخ 2026-08-05 بعد المراجعة المعمارية المستقلة وإصلاح كل الملاحظات
المؤكدة أعلاه، وإعادة التحقق الكامل (39/39 ترحيلاً + محاكاة الهجوم + 31/31 اختبار).
**الموديول التالي وفق الترتيب الإلزامي: Storage.**
