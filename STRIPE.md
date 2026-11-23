# Stripe setup — RavMizAI Monthly Membership

**Plan:** 7-day free trial, then **$18/month**, cancel anytime.

Checkout is hosted by Stripe, so card details never touch this site or your
server. Membership is granted only by the webhook, never by the browser.

---

## 1. Create the product in Stripe

Dashboard → **Product catalogue** → Add product.

| Field | Value |
|---|---|
| Name | `RavMizAI Monthly Membership` |
| Description | Access to RavMizAI's AI-powered Torah voice and text experience, including personalized conversations, saved preferences, transcripts, and member features. Includes a 7-day free trial, then $18/month automatically until canceled. Cancel anytime before the trial ends to avoid being charged. |
| Price | `18.00` USD, **Recurring**, **Monthly** |

Copy the **price id** (`price_...`) — not the product id (`prod_...`).

> The 7-day trial is set by `create-checkout`, not on the price. Leave the
> price's own trial setting empty, or the trial would be applied twice.

## 2. Add the secrets to Supabase

```bash
npx supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_PRICE_ID=price_xxx \
  SITE_URL=https://your-site.netlify.app \
  --project-ref ujqrmjoklinyxbnvyswa
```

Use `sk_test_...` until the whole flow works, then repeat with `sk_live_...`.

**The secret key must never reach the browser.** It belongs only in Supabase
secrets. The site needs no Stripe key at all — Checkout is a redirect.

## 3. Run the schema

Supabase SQL Editor → paste `sql/004_stripe.sql` → Run.

Adds the Stripe columns, the `stripe_events` table (webhook idempotency), and
`apply_stripe_subscription()` — the single place membership is written.

## 4. Deploy the functions

```bash
npx supabase functions deploy create-checkout --project-ref ujqrmjoklinyxbnvyswa
npx supabase functions deploy stripe-webhook --no-verify-jwt --project-ref ujqrmjoklinyxbnvyswa
```

`--no-verify-jwt` is required on the webhook: Stripe has no Supabase token. It
is not a hole — the function verifies Stripe's own signature instead, and
rejects anything unsigned.

## 5. Register the webhook

Stripe → **Developers → Webhooks → Add endpoint**.

**URL:**
```
https://ujqrmjoklinyxbnvyswa.supabase.co/functions/v1/stripe-webhook
```

**Events to send:**
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
- `charge.refunded`

`charge.refunded` applies the refund rule: when a subscription payment is fully
refunded, the subscription stops renewing and the member keeps access until the
end of the paid period. A partial refund changes nothing. To end the membership
after a partial refund, cancel the subscription in Stripe.

Copy the **signing secret** (`whsec_...`) and add it:

```bash
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx \
  --project-ref ujqrmjoklinyxbnvyswa
```

Without this the webhook rejects every event and nobody becomes a member.

## 6. Test with a test card

1. Sign in, press **Call** → subscribe page.
2. **Start 7-day free trial** → redirects to Stripe.
3. Card `4242 4242 4242 4242`, any future expiry, any CVC.
4. Should return to `/app/home.html?checkout=success` with Call and Text open.

Check `Authentication → Users` and:

```sql
select u.email, p.subscription_status, p.is_member, p.subscribed_until
  from public.profiles p join auth.users u on u.id = p.id;
```

Expected: `trialing`, `is_member = true`, `subscribed_until` ≈ 7 days out.

Other useful test cards:

| Card | Behaviour |
|---|---|
| `4242 4242 4242 4242` | succeeds |
| `4000 0000 0000 9995` | declined — trial should not start |
| `4000 0025 0000 3155` | requires 3D Secure |

## 7. Going live

**This is the step Mike hit on 24 November 2026.** The Checkout page showed a
`Sandbox` badge and his real card was declined with *"Your request was in test
mode, but used a non test card."* Nothing is broken — the deployed functions
are still carrying **test** keys, so Stripe correctly refuses real cards.

### Two accounts, not one

The configured key belongs to a **sandbox**, not to the business account:

| | |
|---|---|
| Business account | `acct_1Pae2oDdO89zKJmA` — **Digital Social** (the LLC named in the Terms) |
| What the site uses | `acct_1UNzLvD1Kkwkc6Pk` — **Ravmizai**, a sandbox inside Digital Social |

Checked on 24 November 2026, against the sandbox:

| | |
|---|---|
| Key prefix | `sk_test_` |
| `charges_enabled` | true — **within the sandbox only** |
| `payouts_enabled` | true — **within the sandbox only** |
| Configured price | `price_1UNzcsD1Kkwkc6Pk3oDIATG4` — $18.00/month, `livemode: false` |

Those flags say the sandbox is fully set up. They say nothing about whether
**Digital Social** can take real money, because a test key cannot see the live
account at all.

**So before anything below: check that Digital Social itself is activated.**
In the dashboard, switch out of the sandbox, turn **Test mode** off, and look
for a banner asking for business details or a bank account. If one is there,
activation has to be completed first — no key swap will work until it is.

### What has to be recreated, not reused

A sandbox and the live account are separate worlds in Stripe, and nothing
crosses between them. A sandbox object cannot be used with a live key —
`create-checkout` would fail with *"No such price"*. These each need making
again in **Digital Social, live mode**:

* the **product and price** (new `price_...` id)
* the **webhook endpoint** (new `whsec_...` signing secret)
* any **coupon** that should still exist

Customers, subscriptions and payment methods do not carry over either. Every
test subscriber starts again — fine, since they are all test accounts.

### Step by step

**1. Get into the right account, in live mode.** The account switcher
currently sits in the **Ravmizai** sandbox. Switch back to **Digital Social**,
then turn **Test mode** off. Everything below must be done there — do it in
the sandbox and you will simply create a second set of sandbox objects that
live keys cannot see.

Confirm before continuing: the dashboard header should read **Digital
Social**, with no *Sandbox* badge and no *Test mode* banner.

**2. Recreate the product.** Product catalogue → Add product.

| Field | Value |
|---|---|
| Name | `RavMizAI Monthly Membership` |
| Description | Access to RavMizAI's AI-powered Torah voice and text experience, including personalized conversations, saved preferences, transcripts, and member features. Includes a 7-day free trial, then $18/month automatically until canceled. Cancel anytime before the trial ends to avoid being charged. |
| Price | `18.00` USD, Recurring, Monthly |

Copy the new **price id**. Leave the price's own trial setting empty — the
7-day trial is applied by `create-checkout`, and setting it in both places
gives the member 14 days.

**3. Recreate the webhook.** Developers → Webhooks → Add endpoint, with the
same URL and the same six events as §5. Copy the new signing secret.

**4. Swap the secrets.**

```bash
npx supabase secrets set \
  STRIPE_SECRET_KEY=sk_live_xxx \
  STRIPE_PRICE_ID=price_xxx_live \
  STRIPE_WEBHOOK_SECRET=whsec_xxx_live \
  SITE_URL=https://ravmizai.com \
  --project-ref ujqrmjoklinyxbnvyswa
```

`SITE_URL` is what Stripe returns the customer to. It was wrong once before —
pointing at a developer machine — and sent everyone to an error page after
paying. Check it matches the domain people actually use.

**5. Redeploy.** Secrets are read at boot, so a function keeps using the old
key until it is redeployed:

```bash
npx supabase functions deploy create-checkout  --project-ref ujqrmjoklinyxbnvyswa
npx supabase functions deploy billing-portal   --project-ref ujqrmjoklinyxbnvyswa
npx supabase functions deploy sync-membership  --project-ref ujqrmjoklinyxbnvyswa
npx supabase functions deploy delete-account   --project-ref ujqrmjoklinyxbnvyswa
npx supabase functions deploy stripe-webhook --no-verify-jwt --project-ref ujqrmjoklinyxbnvyswa
```

All five read `STRIPE_SECRET_KEY`. Miss one and it keeps talking to test mode
against live data — `delete-account` in particular would fail to cancel a real
subscription, leaving someone billed after they deleted their account.

**6. Verify with one real card.** There is no test card in live mode; the only
way to prove it works is a real charge.

1. Sign up as a new user and start the trial.
2. The Checkout page must show **no Sandbox badge**.
3. Complete it with a real card. **£0 / $0 is taken** — it is a 7-day trial,
   so the card is only authorised.
4. You should land on `/app/home.html?checkout=success` with Call and Text
   open.
5. In Stripe → Customers, the subscription reads **trialing**, renewing 7 days
   out.
6. In Supabase:

   ```sql
   select u.email, p.subscription_status, p.is_member, p.subscribed_until
     from public.profiles p join auth.users u on u.id = p.id
    order by p.subscribed_at desc nulls last limit 5;
   ```

   Expected: `trialing`, `is_member = true`, `subscribed_until` ≈ 7 days out.
   If Stripe says trialing but Supabase does not, the **webhook** is wrong —
   check Developers → Webhooks → your endpoint for failed deliveries.

7. Then cancel that subscription in Stripe and confirm access ends at the
   period end, not immediately.

### Before flipping the switch

- [ ] **Confirm Digital Social is activated for live payments.** This has not
      been verified — a test key cannot see the live account, so the only way
      to check is in the dashboard with Test mode off. Business details and a
      bank account must be on file before any real charge can settle.
- [x] ~~Delete the `activate-trial` function~~ — **already gone.** It granted a
      trial with no payment method, bypassing Checkout entirely. Confirmed
      absent from the deployed function list on 24 November 2026.
- [ ] **Do not recreate coupon `VqytA1n6`** — 100% off **forever**, not once.
      Created for testing. It exists only in the sandbox so it cannot leak
      into live, but anyone holding the code would never pay. If a promo code
      is wanted in live mode, give it a duration.
- [ ] **Configure SMTP** (see `EMAIL-SETUP.md`). Without it nobody can confirm
      their account or reset a password, so they cannot reach Checkout at all.
- [ ] Turn email confirmation back on in Supabase once SMTP works.
- [ ] **The Terms do not name the trial length.** Section 6 states $18.00/month
      correctly, but Section 7 only says "we may offer free trial periods…
      disclosed at the time of enrollment". Checkout does disclose "7 days
      free", so this is defensible — but if the 7 days are meant to be a fixed
      promise rather than a current offer, say so in Section 7.

### If you need to go back to test mode

Set the test secrets again and redeploy the same five functions. Live
subscriptions are untouched; they are simply invisible to a test key.
