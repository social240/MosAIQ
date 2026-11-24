# RavMizAI automated tests

Checks sign-in, access control and the wallet against the **live** site and
Supabase project, the way a visitor and a member would. Each run creates
throwaway accounts (`autotest+<run>.a@ravmizai.com`, `.b@` and `.c@`) and
deletes them at the end, even when a test fails. The n8n workflow that sends
RavMizAI's login emails skips `autotest+` addresses, so a run sends no real
email.

## Run

```sh
cd tests
npm install                          # once; drives your installed Edge (or Chrome)
SUPABASE_ACCESS_TOKEN=sbp_... npm test
npm test -- 5 A3                     # only some steps
```

PowerShell: `$env:SUPABASE_ACCESS_TOKEN="sbp_..."; npm test`

The access token (supabase.com/dashboard/account/tokens) can also come from the
project's `.env`. The suite uses it to read the auth settings, check results in
the database, credit the test wallets, create one-time reset links and delete
the test accounts. It is never printed. Never commit it.

| Setting (environment) | Default |
|---|---|
| `SITE_URL` | `https://ravmizai.com` |
| `SUPABASE_REF` | `ujqrmjoklinyxbnvyswa` |
| `BROWSER_CHANNEL` | `msedge` (or `chrome`) |
| `TEST_EMAIL_DOMAIN` | `ravmizai.com` (Supabase will not email `example.com`) |

Results print as the run goes and are saved to `reports/run-<date>-<run>.json`
(not committed). The exit code is 1 if anything failed. A full run takes
10–12 minutes; step 10 (repeated wrong passwords) and the browser steps take
most of it.

## What each step checks

| Step | Check | How |
|---|---|---|
| 1 | Duplicate registration | Signs up again with an existing email: still one account, the first password still works, and the answer does not say the address is taken. |
| 2 | Email verification | A new sign-up on /signup goes to the code page and cannot sign in yet; a wrong code is refused; the right code (made by Supabase, as in the email) confirms the account and moves on to checkout, which the test answers itself so nothing is created in Stripe. |
| 3a–3d | Password reset | Supabase hands the email to the mail service and it answers OK; repeated requests are limited; a reset link works once, then is refused; the reset page changes the password end to end. |
| 4 | Google sign-in duplicates | Database: no email has two accounts; Google joins the existing account. |
| 5 | Staying signed in | Refresh, close and reopen the browser, sign out and reopen. |
| 6 | Signed-out access | The 7 member pages, the data tables, and the admin and server functions refuse a signed-out visitor, and no member page shows for even one frame. |
| 7a, 7b | Member limits | A signed-in member tries to make itself a paid member, write its wallet, history or trial, call admin functions, and call the old activate-trial function. |
| 8a, 8b | Account deletion | Members can ask for deletion; deleting an account removes its profile, wallet, history and trials. |
| 9a | Sign-up with a taken email | Since 2026-11-25 the sign-up form says the email already has an account and asks the visitor to sign in, instead of going to a code page where no code arrives. |
| 9b–9c | Email enumeration | Log-in and password reset answer the same for a known and an unknown email. |
| 10 | Rate limiting | Wrong passwords until Supabase blocks; whether CAPTCHA is on. |
| A1–A10 | Wallet | Starting balance, funding, deductions, who decides the charge, history, duplicate and concurrent charges, insufficient balance, Stripe events, and the balance shown after a refresh. |

## Limits

- Stripe is not called. Failed payments, refunds and cancellations (A9) are
  read from the webhook code; exercise them with the Stripe CLI in test mode.
- A real Google sign-in needs a real Google account, so step 4 checks the
  database for duplicates instead.
- Email delivery: the run proves Supabase handed each email to the n8n
  workflow and that it answered OK. Test addresses are skipped there, so
  arrival in a real inbox (and not in Spam) is checked by hand with a real
  address.
- Reset links expire after 60 minutes per the settings; the run does not wait
  that out.
