# Admin dashboard

Mike asked for a dashboard covering:

> a) all the users that signed up — who succeeded, who failed
> b) all the trial offers and when they will be paid clients
> c) all the financial reports in live realtime

**(a) and (b) are built**, at `app/admin.html`. **(c) deliberately is not** —
see below.

**Not live yet:** `sql/011_admin.sql` has to be run first, and someone has to
be made an admin. Until then the page shows the staff-only notice.

---

## Why (c) is a link, not a rebuild

Stripe already holds every charge, refund, failed payment, dispute and payout,
with reconciliation, invoices and tax reporting on top. Rebuilding those
figures in Supabase would mean:

* a second set of numbers that can disagree with the money;
* every edge case to re-handle — proration, partial refunds, disputes,
  currency, failed retries;
* an ongoing obligation to keep it right as Stripe changes.

A revenue figure that is *nearly* right is worse than no figure, because
someone will act on it. So the page links to Stripe's own reports rather than
restating them.

What Stripe cannot see is anyone who never reached Checkout — the largest
group by far. That is what this dashboard adds.

---

## What it shows

### Headline figures

| | |
|---|---|
| Total signups | every account ever created |
| Paying | trial converted, money arriving |
| On trial | in a free trial, not yet charged |
| Never started | confirmed, signed in, never opened Checkout |
| Stuck unconfirmed | account created, email never confirmed |
| Lapsed | was a member, no longer is |
| Signed up this week | last 7 days |

### Trials in progress

Each live trial with the date it is due to be charged and the card on file
(brand and last four only — the full number never leaves Stripe).

A trial with **no card** is flagged *"will not convert"*. Checkout is set to
cancel rather than charge when the payment method is missing, so that trial
ends in nothing unless the person adds a card.

### Everyone who signed up

One row per account, newest first, filterable by stage, with a plain-English
reason where someone is stuck:

* *Never confirmed their email — check SMTP is configured*
* *Confirmed but never signed in*
* *Signed in but never started a trial*
* *Payment failed — card declined or expired*
* *Cancelled or lapsed*
* *Period ended without renewing*

As of 24 November 2026 the first of those applies to the newest signup, and
the cause is known: no SMTP provider is configured. See `EMAIL-SETUP.md`.

---

## Setting it up

**1. Run the migration.** Supabase SQL Editor → paste `sql/011_admin.sql` → Run.

It adds `profiles.is_admin`, three views over `auth.users`, and three
`SECURITY DEFINER` functions that check `is_admin()` before returning
anything.

**2. Make yourself an admin.** In the same editor, which runs as the service
role:

```sql
update public.profiles
   set is_admin = true
 where id = (select id from auth.users where email = 'mike@mymosaiq.com');
```

**3. Check who has access:**

```sql
select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.is_admin;
```

The **Admin** link then appears in the user menu, and `app/admin.html` opens.

---

## How it is kept shut

Four layers, each independent of the others:

1. **The page requires a session.** `appBody` sends a signed-out visitor to
   `/login` before anything renders.
2. **The nav link ships `hidden`** and is revealed only after `is_admin()`
   returns true. This is cosmetic — it keeps the menu honest, nothing more.
3. **The views are not granted to anyone.** `admin_signups`, `admin_trials`
   and `admin_summary` read `auth.users`, so `anon` and `authenticated` have
   no access to them at all. A browser cannot select from them.
4. **The functions check `is_admin()` first** and raise `42501` otherwise.
   They are the only way the data can be reached, and `EXECUTE` was revoked
   from `public` before being granted to `authenticated` — Postgres grants
   `EXECUTE` to `PUBLIC` by default, so revoking from `anon, authenticated`
   alone would have left the functions open to everyone.

`is_admin` is also frozen in the RLS policy on `profiles`, alongside the
billing columns. Without that, a member could grant themselves staff access
from the browser console — exactly the hole that `009` closed for membership.

**A browser check is never the control.** Someone who calls the RPCs directly
with their own token is refused by Postgres, not by the page.

---

## What it does not do

* **No financial figures.** By design — see above.
* **No editing.** Read-only. Changing a subscription means Stripe; changing a
  profile means SQL. A dashboard that can cancel subscriptions is a much
  larger surface to get right.
* **No usage data.** Voice minutes are not tracked yet; that is blocked on
  Delphi exposing session events. See `USAGE-TRACKING.md`.
* **No realtime push.** Figures are read when the page loads. "Live realtime"
  in the sense of a ticker would need subscriptions and a reason to justify
  them; refreshing is enough for a funnel that moves a few times a day.

---

## If the figures look wrong

The page distinguishes three states, and they should not be confused:

| On screen | Means |
|---|---|
| A number, including `0` | read successfully; that is the real count |
| *"unavailable right now"* | the read failed — RPC missing, offline, or denied |
| *"Nobody at this stage"* | read successfully, genuinely empty |

If everything says *unavailable*, the migration has probably not been run.
Check in the SQL editor:

```sql
select proname from pg_proc
 where proname in ('is_admin','admin_get_summary','admin_get_signups','admin_get_trials');
```

Four rows expected. Fewer means `sql/011_admin.sql` has not been applied.
