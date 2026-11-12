-- RavMizAI — fund wallets from Stripe, charge usage once, keep the ledger whole
--
-- Run AFTER 001-009. Idempotent: safe to run again.
--
-- 1. Funding. Nothing credited a member's wallet, so the "3 hours of voice a
--    month" on app/subscribe.html never arrived. The Stripe webhook now calls
--    apply_stripe_allowance() on every subscription event:
--      trial started     +60 minutes of voice and +120 chats, once
--      each paid period  voice reset to 3 hours; unused time does not roll
--                        over, and its expiry gets its own ledger row
-- 2. Once only. A ledger row can carry a reference (Stripe period, call id)
--    that is unique, so a retried webhook or a repeated usage report cannot
--    credit or charge twice.
-- 3. Whole ledger. record_usage() charges at most what is in the wallet and
--    reports the rest as overage, so the history always adds up to the
--    balance. It used to log the full amount while the balance stopped at 0.

-- ---------------------------------------------------------------------------
-- ledger: references, and 'expire' for allowance that lapsed
-- ---------------------------------------------------------------------------
alter table public.wallet_ledger add column if not exists ref text;

create unique index if not exists wallet_ledger_ref_idx
  on public.wallet_ledger(ref) where ref is not null;

comment on column public.wallet_ledger.ref is
  'Unique key of the event behind this row (Stripe period, call id), so it applies once.';

alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in ('grant','debit','refund','adjustment','expire'));

-- ---------------------------------------------------------------------------
-- apply_allowance() — add, or reset to, an allowance, once per reference
-- ---------------------------------------------------------------------------
create or replace function public.apply_allowance(
  p_user_id     uuid,
  p_ref         text,
  p_seconds     integer,
  p_chats       integer,
  p_reset       boolean,
  p_description text
)
returns table (out_applied boolean, out_seconds integer, out_chats integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cur_s integer;
  secs  integer := greatest(coalesce(p_seconds, 0), 0);
  msgs  integer := greatest(coalesce(p_chats, 0), 0);
begin
  if p_user_id is null or coalesce(p_ref, '') = '' then
    raise exception 'apply_allowance: user and reference are required';
  end if;

  -- Lock the member's wallet before checking the reference, so two deliveries
  -- of the same Stripe event queue here instead of both passing the check.
  insert into public.wallets (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select w.seconds_balance into cur_s
    from public.wallets w where w.user_id = p_user_id for update;

  if exists (select 1 from public.wallet_ledger l where l.ref = p_ref) then
    return query select false, w.seconds_balance, w.chats_balance
                   from public.wallets w where w.user_id = p_user_id;
    return;
  end if;

  if p_reset and cur_s > 0 then
    insert into public.wallet_ledger (user_id, kind, seconds, minutes, chats, description, ref)
    values (p_user_id, 'expire', cur_s, cur_s / 60, 0,
            'Unused voice time from the last period (does not roll over)', p_ref || ':expired');
  end if;

  insert into public.wallet_ledger (user_id, kind, seconds, minutes, chats, description, ref)
  values (p_user_id, 'grant', secs, secs / 60, msgs, p_description, p_ref);

  update public.wallets w
     set seconds_balance = case when p_reset then secs else w.seconds_balance + secs end,
         minutes_balance = (case when p_reset then secs else w.seconds_balance + secs end) / 60,
         chats_balance   = w.chats_balance + msgs,
         updated_at      = now()
   where w.user_id = p_user_id;

  return query select true, w.seconds_balance, w.chats_balance
                 from public.wallets w where w.user_id = p_user_id;
end;
$fn$;

comment on function public.apply_allowance(uuid,text,integer,integer,boolean,text) is
  'Adds (or with p_reset, resets voice to) an allowance once per reference. Service-role only.';

-- ---------------------------------------------------------------------------
-- apply_stripe_allowance() — the webhook's single call for funding
-- ---------------------------------------------------------------------------
-- The plan lives here, in one place. app/subscribe.html states it to members.
create or replace function public.apply_stripe_allowance(
  p_customer_id     text,
  p_subscription_id text,
  p_status          text,
  p_period_start    timestamptz,
  p_user_id         uuid default null
)
returns table (out_applied boolean, out_what text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  uid uuid := p_user_id;
  r   record;
  trial_seconds   constant integer := 60 * 60;       -- 60 minutes, once
  trial_chats     constant integer := 120;
  monthly_seconds constant integer := 3 * 60 * 60;   -- 3 hours, reset each period
begin
  if uid is null then
    select p.id into uid from public.profiles p where p.stripe_customer_id = p_customer_id;
  end if;
  if uid is null then
    raise exception 'No profile for Stripe customer %', p_customer_id;
  end if;
  if coalesce(p_subscription_id, '') = '' then
    return query select false, 'no subscription'::text;
    return;
  end if;

  if p_status = 'trialing' then
    select * into r from public.apply_allowance(
      uid, 'stripe:' || p_subscription_id || ':trial',
      trial_seconds, trial_chats, false, 'Free trial: 60 minutes of voice and 120 chats');
    return query select r.out_applied, 'trial'::text;
  elsif p_status = 'active' and p_period_start is not null then
    select * into r from public.apply_allowance(
      uid, 'stripe:' || p_subscription_id || ':'
           || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      monthly_seconds, 0, true, 'Monthly allowance: 3 hours of voice');
    return query select r.out_applied, 'period'::text;
  else
    return query select false, coalesce(p_status, 'unknown');
  end if;
end;
$fn$;

comment on function public.apply_stripe_allowance(text,text,text,timestamptz,uuid) is
  'Trial: +60 min voice, +120 chats once. Each paid period: voice reset to 3 hours. Service-role only.';

-- ---------------------------------------------------------------------------
-- record_usage() — charge once per call, never past zero, ledger stays whole
-- ---------------------------------------------------------------------------
-- The return shape changes, so the old version has to go first.
drop function if exists public.record_usage(uuid,integer,integer,text);

create or replace function public.record_usage(
  p_user_id     uuid,
  p_seconds     integer default 0,
  p_chats       integer default 0,
  p_description text    default 'Usage',
  p_ref         text    default null
)
returns table (seconds_left integer, chats_left integer,
               charged_seconds integer, overage_seconds integer, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  secs  integer := greatest(coalesce(p_seconds, 0), 0);
  msgs  integer := greatest(coalesce(p_chats, 0), 0);
  cur_s integer;
  cur_c integer;
  pay_s integer;
  pay_c integer;
  note  text := '';
begin
  if p_user_id is null then
    raise exception 'record_usage: no user';
  end if;

  -- Lock first: concurrent reports for one member are charged one at a time.
  select w.seconds_balance, w.chats_balance into cur_s, cur_c
    from public.wallets w where w.user_id = p_user_id for update;
  if not found then
    raise exception 'record_usage: no wallet for %', p_user_id;
  end if;

  if p_ref is not null and exists (select 1 from public.wallet_ledger l where l.ref = p_ref) then
    return query select cur_s, cur_c, 0, 0, true;     -- already charged
    return;
  end if;
  if secs = 0 and msgs = 0 then
    return query select cur_s, cur_c, 0, 0, false;
    return;
  end if;

  pay_s := least(secs, cur_s);
  pay_c := least(msgs, cur_c);
  if secs > pay_s or msgs > pay_c then
    note := ' (over the balance by ' || concat_ws(' and ',
              case when secs > pay_s then (secs - pay_s) || 's of voice' end,
              case when msgs > pay_c then (msgs - pay_c) || ' chats' end)
            || '; not charged)';
  end if;

  insert into public.wallet_ledger (user_id, kind, seconds, minutes, chats, description, ref)
  values (p_user_id, 'debit', pay_s, pay_s / 60, pay_c,
          left(coalesce(nullif(p_description, ''), 'Usage'), 80) || note, p_ref);

  update public.wallets w
     set seconds_balance = w.seconds_balance - pay_s,
         minutes_balance = (w.seconds_balance - pay_s) / 60,
         chats_balance   = w.chats_balance - pay_c,
         updated_at      = now()
   where w.user_id = p_user_id;

  return query select cur_s - pay_s, cur_c - pay_c, pay_s, secs - pay_s, false;
end;
$fn$;

comment on function public.record_usage(uuid,integer,integer,text,text) is
  'Charges usage once per p_ref, never past zero; excess is returned as overage. Service-role only.';

-- ---------------------------------------------------------------------------
-- Service role only. Postgres grants EXECUTE to PUBLIC on new functions.
-- ---------------------------------------------------------------------------
revoke execute on function public.apply_allowance(uuid,text,integer,integer,boolean,text) from public;
revoke execute on function public.apply_allowance(uuid,text,integer,integer,boolean,text) from anon, authenticated;
grant  execute on function public.apply_allowance(uuid,text,integer,integer,boolean,text) to service_role;

revoke execute on function public.apply_stripe_allowance(text,text,text,timestamptz,uuid) from public;
revoke execute on function public.apply_stripe_allowance(text,text,text,timestamptz,uuid) from anon, authenticated;
grant  execute on function public.apply_stripe_allowance(text,text,text,timestamptz,uuid) to service_role;

revoke execute on function public.record_usage(uuid,integer,integer,text,text) from public;
revoke execute on function public.record_usage(uuid,integer,integer,text,text) from anon, authenticated;
grant  execute on function public.record_usage(uuid,integer,integer,text,text) to service_role;
