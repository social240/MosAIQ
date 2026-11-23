# Signup emails are not arriving — diagnosis and fix

**Status: confirmed, not yet fixed. Needs an account on an email provider,
which is a decision for Mike.**

Mike signed up on 24 November 2026 and never received the 6-digit code. The
page did its job — it created the account and moved to the verify screen — but
no mail arrived, so the account can never be confirmed.

---

## What is actually wrong

The project has **no SMTP provider configured**, so Supabase is falling back
to its own built-in email service:

```
smtp_host   : (none)
smtp_user   : (none)
smtp_sender : (none)
```

Supabase's built-in service is explicitly **for development only**. Two limits
make it unusable in production:

1. **Roughly 2–4 emails per hour, per project.** Not per user — per project.
   A handful of signups exhausts it for everyone.
2. **It only delivers to members of the Supabase organization.** Mail to any
   other address is accepted by the API and then dropped.

That second limit is the one that bit here. `kushevsky@gmail.com` is not a
member of the Supabase org, so the mail was never delivered.

### Why nothing looked broken

The signup API returns success either way:

```
POST /auth/v1/signup  ->  HTTP 200
{ "confirmation_sent_at": "2026-11-23T19:20:48Z", ... }
```

`confirmation_sent_at` means *Supabase handed the message to its mailer*. It
does not mean the message was delivered. There is no error for the front end
to catch and nothing to show the user, which is why this looked like a working
signup right up until the inbox stayed empty.

---

## The fix

Configure a real SMTP provider in **Supabase → Project Settings →
Authentication → SMTP Settings**. Any of these work; all have a free tier that
covers early traffic:

| Provider | Free tier | Notes |
|---|---|---|
| **Resend** | 3,000/month, 100/day | Simplest setup; good choice for a new project |
| **SendGrid** | 100/day | Long-established |
| **Postmark** | 100/month | Best deliverability; paid beyond that |
| **Amazon SES** | 62,000/month from EC2 | Cheapest at volume, fiddliest setup |

Whichever is chosen, the sending domain must be verified with **SPF, DKIM and
DMARC** DNS records, or Gmail will route the mail to spam. The provider
generates these records; they go in the DNS for `ravmizai.com`.

Settings to enter in Supabase:

```
Sender email : no-reply@ravmizai.com   (must be on the verified domain)
Sender name  : RavMizAI
Host         : smtp.resend.com         (or the chosen provider's host)
Port         : 465
Username     : resend                  (provider-specific)
Password     : <the provider's API key>
```

Then raise the rate limit under **Authentication → Rate Limits** — the default
of 30/hour is low once real traffic starts.

### Verifying it worked

After saving, sign up with a Gmail address that is **not** a Supabase org
member. The code should arrive within about a minute. Check the spam folder
too: if it lands there, the DNS records are incomplete.

---

## Decision needed from Mike

Mike asked: *"Should we use our email platform?"*

Yes — if there is already a transactional email account (Resend, SendGrid,
Mailgun, SES), use it. It is the same SMTP configuration either way, and
reusing an already-warmed sending domain gives better deliverability than a
fresh one.

What is needed to proceed:

1. Which provider, and access to create or use an API key.
2. Access to the `ravmizai.com` DNS to add the SPF, DKIM and DMARC records.

---

## Interim option, if email must wait

Email confirmation can be turned off — **Authentication → Providers → Email →
Confirm email: off**. Signup then completes immediately with no code.

This is a real tradeoff, not a neutral switch:

* Anyone can sign up with an address they do not own.
* Typo'd addresses create accounts nobody can recover.
* **Password reset still needs working email.** Turning confirmation off does
  not fix the reset flow — those messages fail the same way.

So it unblocks signup and nothing else. Worth it only to let Mike test the
rest of the flow while a provider is being set up.

---

## Related

The project is in **ap-northeast-1 (Tokyo)**. Not a cause of the email
problem, but it does add latency for US users on every request. Worth
revisiting separately — moving a project means a migration, not a setting.
