# Usage tracking — voice and text

**Mike's question (#8):** *"how do you track voice minutes and text? Let's
ensure we track voice to a second (not minute)."*

## The honest answer today

**Nothing tracks usage yet.** Balances only ever went up, from the trial grant.
Nothing has ever debited a wallet, so the numbers on the wallet page were true
but frozen.

The backend for it now exists and is tested. What is missing is a trustworthy
source for *how long a call actually lasted* — see "What is still blocked".

## What was built

### Seconds, not minutes

`sql/008_usage_seconds.sql` — applied.

| | |
|---|---|
| `wallets.seconds_balance` | the balance, in seconds |
| `wallet_ledger.seconds` | each movement, in seconds |

The old `minutes` columns are kept and derived, so nothing that still reads
them breaks. A 40-second call now costs 40 seconds — not a rounded minute, and
not nothing.

### Two functions, one path

- `record_usage(user, seconds, chats, description)` — debits and writes the
  matching ledger row together, so a balance can never drift from its history.
  Clamps at zero: an overrunning call is still recorded, never negative.
- `grant_credit(user, seconds, chats, description)` — the credit side, for
  trial activation and renewals.

Both are **service-role only**. The browser cannot call them, and RLS gives it
no write access to `wallets` or `wallet_ledger` either.

### The entry point

`supabase/functions/record-usage/index.ts` — deployed.

**Server to server only** (since 2026-11-13). How long a call lasted must come
from the system that ran it, not from the member's browser, which could simply
report less. The caller must present the service-role key; a member's token
gets 403. Rejects negative and implausible amounts (over 4 hours, over 500
chats).

```
POST /functions/v1/record-usage
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
{ "user_id": "<uuid>", "call_id": "<id from the call system>",
  "seconds": 40, "chats": 0, "description": "Voice call" }

-> { "ok": true, "seconds_left": 3560, "chats_left": 120,
     "charged_seconds": 40, "overage_seconds": 0, "duplicate": false }
```

- `call_id` makes each call count once (`wallet_ledger.ref` is unique), so a
  retried or duplicated report is not charged twice.
- A call longer than the balance is charged down to zero; the rest comes back
  as `overage_seconds` and is noted on the ledger row, so the history always
  adds up to the balance (`sql/010`).

### Funding (since 2026-11-13)

The Stripe webhook calls `apply_stripe_allowance()` on every subscription
event (`sql/010`): **trial** +60 minutes and +120 chats, once; **each paid
period** voice is reset to 3 hours, and unused time expires as its own ledger
row (`kind = 'expire'`). Each grant is keyed on the subscription and period,
so repeated events add nothing. app/subscribe.html states these rules.

## Daily limit (safety cap), off by default

Added 2026-11-27: `sql/012_delphi_embed_sessions.sql` and
`supabase/functions/delphi-embed`.

**The embed is handed out by the server.** `app/call.html` and `app/chat.html`
no longer carry the Delphi embed. The page asks `delphi-embed`, which checks the
session and the membership on the server (`is_subscribed()`), and only then
returns the channel id. The ids live in the function secrets
`DELPHI_CALL_CHANNEL` and `DELPHI_CHAT_CHANNEL`, never in the repo. The ids
used before 2026-11-27 are in the public git history, so new embeds should
replace them; that is a secret change, not a code change.

**What is counted.** Each opened page is a row in `embed_sessions`, and the
page checks in once a minute: a call while the page is open, a chat while it is
on screen. Each check-in adds the time since the previous one, at most 90
seconds. So this is time with the call or chat open, not talk time. It is a
safety cap, so a few heavy users cannot use up the Delphi plan for everyone.
It is not billing. A member who blocks the check-ins in their browser is not
counted; only Delphi's Embed SSO could enforce a limit fully.

**Switch it on.** Minutes per day, New York midnight to midnight; null means no
limit:

```sql
update public.daily_limits set call_minutes = 60, chat_minutes = 120
where user_id is null;
```

**One member.** Their row replaces the default; null there means no limit for
them:

```sql
insert into public.daily_limits (user_id, call_minutes, note)
values ('<user uuid>', 30, 'heavy user')
on conflict (user_id) do update set call_minutes = excluded.call_minutes;
```

**Switch it off.** Set both columns of the default row (`user_id is null`) back
to null, and delete any member rows.

**Who used the most today:**

```sql
select u.email, s.kind, round(sum(s.seconds) / 60.0) as minutes
from public.embed_sessions s join auth.users u on u.id = s.user_id
where s.day = public.embed_day()
group by 1, 2 order by minutes desc limit 20;
```

Over the cap, the page says "You've reached today's voice limit. It resets at
midnight, New York time." Within 5 minutes of it, a line under the call says
how many minutes are left.

## What is still blocked

**Nothing calls `record-usage` yet, because nothing knows how long a call was.**

The conversation runs inside Delphi's embedded iframe (`delphi.ai/embed.js` in
`app/chat.html`). The iframe does not report session start, end or duration
back to the page, and a cross-origin iframe cannot be measured from outside.

Three ways forward, in order of how much we would trust the number:

1. **A Delphi webhook** — Delphi calls us when a session ends, with its own
   duration. Most trustworthy: the figure never passes through the browser.
   Needs Delphi to offer one.
2. **A Delphi JS API on the embed** — the page listens for session events and
   reports the duration. Workable, but the number comes from the browser, so a
   determined member could under-report. Mitigated by the caps already in the
   function.
3. **Time the page** — start a timer when the member opens the call and stop on
   leave. Least trustworthy and wrong in ordinary cases: a backgrounded tab, a
   dropped connection or a closed laptop all mis-measure it.

**This is the question to put to Delphi: do they expose session events or a
webhook with call duration?** Until that is answered, any number we record is a
guess, and charging a paying member against a guess is worse than not charging
at all.

Text messages have the same gap: the embed does not report how many were sent.

## Verified

Against the live database, 11/11:

- 40-second call debits exactly 40 seconds; 7 seconds debits 7
- Ledger total reconciles exactly with the balance
- Negative amounts rejected (400); implausible amounts rejected (400)
- No auth rejected (401); direct RPC from the browser rejected (403)
- Overrun clamps to zero, never negative
