-- ============================================================================
-- 052 — TENANT_WELCOME email: match FourthUpdate.md's reassuring, detailed
-- subscription-success template (found missing during the whole-plan
-- discovery pass preceding Assets Management).
--
-- The template already had both links the plan asks for (company_url and
-- password_link, shown as two separate rows) — only the wording was short/
-- generic. This migration keeps the same structure and both links, and adds:
-- a "thank you for choosing bbnovix" opening, an explicit "your subscription
-- was received, we're preparing it" framing, and a troubleshooting/closing
-- paragraph (check Spam/Junk, search for "bbnovix", sign in right after
-- setting your password, welcome to bbnovix) before the final disclaimer.
-- ============================================================================
update public.email_templates
set
  body_html_ar = $html_ar$<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">مرحباً {{owner_name}}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155">
      شكراً لاختيارك bbnovix. تم استلام طلب اشتراكك بنجاح، وأصبح لشركتك <strong>{{company_name}}</strong> رابط خاص بها الآن.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">رابط الشركة:</p>
    <p style="margin:0 0 20px;font-size:16px"><a href="{{company_url}}" style="color:#0f766e">{{company_url}}</a></p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">اسم المستخدم الخاص بك:</p>
    <p style="margin:0 0 24px;font-size:16px;color:#0b3b60"><strong>{{user_name}}</strong></p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155">
      لتفعيل حسابك يرجى تعيين كلمة المرور من الزر التالي، ثم تسجيل الدخول وإضافة بقية المستخدمين.
    </p>
    <p style="margin:0 0 24px">
      <a href="{{password_link}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">تعيين كلمة المرور</a>
    </p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.9;color:#475569">
      إذا لم تجد هذه الرسالة خلال بضع دقائق: تحقق من مجلد الرسائل غير المرغوبة (Spam أو Junk Mail)، أو ابحث في بريدك الإلكتروني عن كلمة bbnovix، وتأكد من أن عنوان بريدك الإلكتروني صحيح. بعد تعيين كلمة المرور يمكنك تسجيل الدخول مباشرة والبدء باستخدام النظام. مرحباً بك في bbnovix.
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">إذا لم تطلب هذا الحساب، تجاهل هذه الرسالة.</p>
  </div>
</div>$html_ar$,
  body_html_en = $html_en$<div dir="ltr" style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">Welcome {{owner_name}}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">
      Thank you for choosing bbnovix. Your subscription request was received successfully, and <strong>{{company_name}}</strong> now has its own address.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">Your company link:</p>
    <p style="margin:0 0 20px;font-size:16px"><a href="{{company_url}}" style="color:#0f766e">{{company_url}}</a></p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">Your user name:</p>
    <p style="margin:0 0 24px;font-size:16px;color:#0b3b60"><strong>{{user_name}}</strong></p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">
      Set your password with the button below, then sign in and create the rest of your users.
    </p>
    <p style="margin:0 0 24px">
      <a href="{{password_link}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">Set your password</a>
    </p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#475569">
      If this message does not arrive within a few minutes: check your Spam or Junk folder, search your inbox for the word bbnovix, and make sure your email address is correct. Once you set your password you can sign in right away and start using the system. Welcome to bbnovix.
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">If you did not request this account, ignore this message.</p>
  </div>
</div>$html_en$,
  updated_on = now()
where tenant_id = public.platform_tenant_id()
  and code = 'TENANT_WELCOME'
  and not is_deleted;

revoke execute on all functions in schema public from public;
