# RavMizAI automated tests

Checks sign-in, access control and the wallet against the **live** site and
Supabase project, the way a visitor and a member would. Each run creates two
throwaway accounts (`autotest+<run>.a@example.com` and `.b@`) and deletes them
at the end, even when a test fails.

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
| `SITE_URL` | `https://ravmizaii.netlify.app` |
| `SUPABASE_REF` | `ujqrmjoklinyxbnvyswa` |
| `BROWSER_CHANNEL` | `msedge` (or `chrome`) |
| `TEST_EMAIL_DOMAIN` | `example.com` |

Results print as the run goes and are saved to `reports/run-<date>-<run>.json`
(not committed). The exit code is 1 if anything failed. A full run takes
10–12 minutes; step 10 (repeated wrong passwords) and the browser steps take
most of it.

## What each step checks

| Step | Check | How |
|---|---|---|
| 1 | Duplicate registration | Signs up twice with one email: still one account, and the first password still works. |
| 2 | Email verification | Whether "Confirm email" is on, and what a new sign-up gets. |
| 3a–3d | Password reset | Supabase sends the email; repeated requests are limited; a reset link works once, then is refused; the reset page changes the password end to end. |
| 4 | Google sign-in duplicates | Database: no email has two accounts; Google joins the existing account. |
| 5 | Staying signed in | Refresh, close and reopen the browser, sign out and reopen. |
| 6 | Signed-out access | The 7 member pages, the data tables, and the admin and server functions refuse a signed-out visitor, and no member page shows for even one frame. |
| 7a, 7b | Member limits | A signed-in member tries to make itself a paid member, write its wallet, history or trial, call admin functions, and call the old activate-trial function. |
| 8a, 8b | Account deletion | Members can ask for deletion; deleting an account removes its profile, wallet, history and trials. |
| 9a–9c | Email enumeration | Sign-up, log-in and reset messages for a known versus an unknown email. |
| 10 | Rate limiting | Wrong passwords until Supabase blocks; whether CAPTCHA is on. |
| A1–A10 | Wallet | Starting balance, funding, deductions, who decides the charge, history, duplicate and concurrent charges, insufficient balance, Stripe events, and the balance shown after a refresh. |

## Limits

- Stripe is not called. Failed payments, refunds and cancellations (A9) are
  read from the webhook code; exercise them with the Stripe CLI in test mode.
- A real Google sign-in needs a real Google account, so step 4 checks the
  database for duplicates instead.
- Email delivery is judged from Supabase's answer, not from an inbox.
- Reset links expire after 60 minutes per the settings; the run does not wait
  that out.
