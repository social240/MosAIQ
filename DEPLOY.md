# Deploying to Netlify

The site is static, so Netlify is a good fit. One thing makes it not a pure
drag-and-drop job: `assets/supabase-config.js` holds the project credentials and
is gitignored, so it is not in the repo. Netlify regenerates it at build time
from environment variables — that is what `netlify.toml` and `build-config.js`
are for.

## 1. Push to Git

There is no git repository yet. Create one:

```bash
git init
git add .
git commit -m "RavMizAI v4.1"
git remote add origin https://github.com/YOU/ravmizai.git
git push -u origin main
```

`.gitignore` already keeps `.env` and `assets/supabase-config.js` out. **Verify
before pushing:**

```bash
git status --short | grep -E '\.env$|supabase-config'
```

That must print nothing. If `.env` appears, stop — it holds your database
password and Supabase access token.

> **Avoid the drag-and-drop deploy.** Dropping the folder on Netlify ignores
> `.gitignore` and would upload `.env`. Use Git, or `netlify deploy` from a
> clean checkout.

## 2. Create the Netlify site

New site → Import from Git → pick the repo. `netlify.toml` already sets:

- **Build command:** `node build-config.js`
- **Publish directory:** `.`

## 3. Environment variables

Site configuration → Environment variables. Add exactly two:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://ujqrmjoklinyxbnvyswa.supabase.co` |
| `SUPABASE_ANON_KEY` | the **anon public** key from Supabase → Settings → API |

**Do not add** `SUPABASE_DB_PASSWORD` or `SUPABASE_ACCESS_TOKEN`. The site does
not use them, and they grant full control of the project. `build-config.js`
refuses to build if a `service_role` key is passed as the anon key.

The build fails with a clear message if either variable is missing, so a
misconfigured deploy never ships a broken site.

## 4. Point Supabase at the new domain — required

Auth breaks without this. Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://your-site.netlify.app`
- **Redirect URLs:** add both
  - `https://your-site.netlify.app/**`
  - `https://your-deploy-preview--your-site.netlify.app/**` (for previews)

Keep `http://localhost:5173/**` if you still develop locally.

## 5. Check after deploying

1. Open the site — the header should show **Log in**, not a blank page.
2. Sign up with a real address → should land in `/app/home`.
3. Press **Call** → should go to the subscribe page.
4. Activate the trial → Call and Text should both open.
5. Sign out → should return to login and stay out.

If the auth pages fall back to the prototype (the `111111` hint appears), the
environment variables did not reach the build. Check the deploy log for
`build-config: wrote assets/supabase-config.js`.

## 6. Google sign-in

"Continue with Google" on the login and signup pages calls Supabase OAuth, but
Supabase only allows it once the Google provider is switched on. Until then
the button tells visitors Google sign-in is not available yet. To turn it on:

Two Google clients are involved:

- **Google's own button** (login and signup on ravmizai.com) uses the client
  in RavMizAI's own Google Cloud project, `ravmizai` (mymosaiq.com). It is the
  only app in that project, so Google's screen can show RavMizAI's verified
  name and logo.
- **The redirect fallback** (where Google's script cannot load, and on local
  or preview addresses) goes through Supabase, using an older web client in
  another Google Cloud project. That client's redirect URI is
  `https://ujqrmjoklinyxbnvyswa.supabase.co/auth/v1/callback`.

1. **Google Cloud Console**, project `ravmizai` → Google Auth Platform
   - Branding: app name *RavMizAI*, logo `assets/logo-square.png`, home page,
     privacy and terms on `https://ravmizai.com`. Authorized domains:
     `ravmizai.com` only. Google will not verify a domain we cannot prove we
     own, such as supabase.co or netlify.app.
   - Audience: *External*, *In production*. Scopes: `openid`, `email` and
     `profile` only, so no extra review is needed.
   - Clients → *RavMizAI website* (Web application):
     - Authorized JavaScript origins: `https://ravmizai.com` and
       `https://www.ravmizai.com`. No redirect URIs.
     - Its Client ID is `GOOGLE_CLIENT_ID` in assets/auth.js. Every origin
       here must also be in `GOOGLE_BUTTON_ORIGINS`, and the other way round.
   - Verification Center: brand verification. It needs ravmizai.com verified
     in Google Search Console by an owner of this project.
2. **Supabase** → Authentication → Sign In / Providers → **Google**: enabled.
   - **Client IDs:** `<older client ID>,<RavMizAI client ID>`, comma-separated.
     The **first** ID is the one used for the redirect flow, and it must match
     the saved **Client secret**, which is the older client's secret. Supabase
     accepts every ID in the list from Google's button.
   - Through the Management API, set `external_google_client_id` to that
     comma-separated list. Setting `external_google_additional_client_ids`
     replaced the client ID instead (2026-11-14).
3. **Supabase** → Authentication → URL Configuration (step 4 above) must list
   the live site, or Supabase sends people back to the Site URL instead:
   - Site URL: `https://ravmizai.com` (the custom domain since 2026-11-13)
   - Redirect URLs: `https://ravmizai.com/**`, `https://www.ravmizai.com/**`
     and `https://ravmizaii.netlify.app/**`
4. **Supabase** → SQL Editor: run `sql/006_oauth_profile_names.sql`, so a
   Google member's profile gets their name instead of "Member".

No redeploy is needed: the button checks the provider setting on each click.

How it behaves: a first Google sign-in creates the account. From the signup
page it then continues to Stripe Checkout, the same as an email signup; from
the login page it lands on the app home. A cancelled or failed Google sign-in
returns to the login page with the reason.

## 7. "Powered by Netlify" badge

Netlify injects this badge itself; it is not in the code. Projects created on
a Free plan on or after Aug 19, 2026 have it on by default. Turn it off per
project, no upgrade or redeploy needed:

**Netlify → the project → Project configuration → General → Powered by
Netlify badge → off → Save.**

## Before taking real users

These are still open and are **not** fixed by deploying:

1. **Email confirmation is OFF.** Anyone can sign up with someone else's address.
   Turn it back on in Authentication → Providers → Email, and add a real SMTP
   provider (the built-in mailer sends ~3 emails/hour).
2. **No payment processor.** The card form sends nothing anywhere — any number
   is accepted and every visitor can claim a free trial. Connect Stripe before
   charging anyone.
3. **`/app/*` pages are gated client-side.** Static hosting serves the HTML to
   anyone who asks; member *data* is protected by RLS, which is the part that
   matters, but the pages themselves are not private.
4. **The Delphi channel id is public** in `app/chat.html`. Confirm with Delphi
   whether that is acceptable for a production embed.
