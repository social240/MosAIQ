-- RavMizAI — admin role and reporting views
--
-- Run AFTER 001-010. Idempotent.
--
-- Mike asked for a dashboard showing (a) who signed up and who succeeded or
-- failed, (b) trials and when each converts to a paid client, (c) financial
-- figures.
--
-- (c) belongs to Stripe. Stripe already holds every charge, refund, failed
-- payment and payout, with reconciliation and tax reporting that would take
-- months to rebuild and would always be a copy that can drift. Nothing here
-- tries to restate revenue. What this adds is (a) and (b), which live in
-- Supabase and which Stripe cannot see: a signup that never reached Checkout
-- leaves no trace in Stripe at all.
--
-- Security shape:
--   * admins are flagged on profiles.is_admin, writable only by the service
--     role (the RLS policy from 009 freezes it against the browser);
--   * the views read auth.users, so they are owned by postgres and exposed
--     only through SECURITY DEFINER functions that check is_admin();
--   * nothing here is reachable with an anon key.

-- ---------------------------------------------------------------------------
-- 1. the admin flag
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

comment on column public.profiles.is_admin is
  'Staff access to the admin dashboard. Service-role writes only.';

-- 009 created a single UPDATE policy that freezes the billing columns against
-- the browser. is_admin must be frozen the same way, or a member could grant
-- themselves staff access from the console exactly as they once could grant
-- themselves membership.
drop policy if exists "profiles: update own (non-billing fields)" on public.profiles;

create policy "profiles: update own (non-billing fields)"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and is_member           is not distinct from (select p.is_member           from public.profiles p where p.id = auth.uid())
    and is_admin            is not distinct from (select p.is_admin            from public.profiles p where p.id = auth.uid())
    and subscribed_at       is not distinct from (select p.subscribed_at       from public.profiles p where p.id = auth.uid())
    and subscribed_until    is not distinct from (select p.subscribed_until    from public.profiles p where p.id = auth.uid())
    and subscription_status is not distinct from (select p.subscription_status from public.profiles p where p.id = auth.uid())
    and stripe_customer_id  is not distinct from (select p.stripe_customer_id  from public.profiles p where p.id = auth.uid())
    and stripe_subscription_id is not distinct from (select p.stripe_subscription_id from public.profiles p where p.id = auth.uid())
    and card_brand          is not distinct from (select p.card_brand          from public.profiles p where p.id = auth.uid())
    and card_last4          is not distinct from (select p.card_last4          from public.profiles p where p.id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 2. is_admin() — the single gate
-- ---------------------------------------------------------------------------

create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = uid), false);
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so revoke from public first.
revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. (a) the signup funnel
-- ---------------------------------------------------------------------------
-- One row per person who ever created an account, with where they stopped.
--
-- "Succeeded" and "failed" need defining, because a signup can stall at four
-- different points and they mean different things:
--
--   signed_up      account created, email never confirmed  -> cannot sign in
--   confirmed      confirmed, but never started a trial    -> never saw Checkout
--   trialing       in a free trial, not yet charged
--   paying         trial converted, money is arriving
--   lapsed         was a member, no longer is

create or replace view public.admin_signups as
select
  u.id,
  u.email,
  coalesce(nullif(trim(p.first_name || ' ' || p.last_name), ''), '(no name)') as name,
  u.created_at                                          as signed_up_at,
  u.email_confirmed_at,
  u.last_sign_in_at,
  coalesce(u.raw_app_meta_data->>'provider', 'email')   as signup_via,
  p.subscription_status,
  p.is_member,
  p.subscribed_until,
  p.stripe_customer_id,
  p.card_brand,
  p.card_last4,
  case
    when u.email_confirmed_at is null                                then 'signed_up'
    when p.subscription_status is null                               then 'confirmed'
    when p.subscription_status = 'trialing'
     and (p.subscribed_until is null or p.subscribed_until > now())  then 'trialing'
    when p.subscription_status = 'active'
     and (p.subscribed_until is null or p.subscribed_until > now())  then 'paying'
    else                                                                  'lapsed'
  end as stage,
  -- Why they are stuck, where that is knowable. Null once they are paying.
  case
    when u.email_confirmed_at is null
      then 'Never confirmed their email — check SMTP is configured'
    when p.subscription_status is null and u.last_sign_in_at is null
      then 'Confirmed but never signed in'
    when p.subscription_status is null
      then 'Signed in but never started a trial'
    when p.subscription_status = 'past_due'
      then 'Payment failed — card declined or expired'
    when p.subscription_status in ('canceled','expired')
      then 'Cancelled or lapsed'
    when p.subscribed_until is not null and p.subscribed_until <= now()
      then 'Period ended without renewing'
  end as stalled_because
from auth.users u
left join public.profiles p on p.id = u.id;

comment on view public.admin_signups is
  'Signup funnel: one row per account, with the stage it reached. Admin only.';

-- ---------------------------------------------------------------------------
-- 4. (b) trials and when each becomes a paying client
-- ---------------------------------------------------------------------------
-- Checkout applies a 7-day trial, so subscribed_until during a trial is the
-- date the first charge is attempted. That is the figure Mike asked for.

create or replace view public.admin_trials as
select
  u.id,
  u.email,
  p.subscription_status,
  p.subscribed_at       as trial_started_at,
  p.subscribed_until    as converts_at,
  (p.card_brand is not null) as has_card,
  p.card_brand,
  p.card_last4,
  case
    when p.subscribed_until is null then null
    else greatest(0, ceil(extract(epoch from (p.subscribed_until - now())) / 86400))::int
  end as days_remaining,
  -- A trial with no card on file will not convert: Checkout is configured to
  -- cancel rather than charge when the payment method is missing.
  (p.card_brand is null) as will_not_convert
from auth.users u
join public.profiles p on p.id = u.id
where p.subscription_status = 'trialing'
  and (p.subscribed_until is null or p.subscribed_until > now());

comment on view public.admin_trials is
  'Live trials and the date each is due to be charged. Admin only.';

-- ---------------------------------------------------------------------------
-- 5. headline counts
-- ---------------------------------------------------------------------------

create or replace view public.admin_summary as
select
  count(*)                                              as total_signups,
  count(*) filter (where stage = 'signed_up')           as stuck_unconfirmed,
  count(*) filter (where stage = 'confirmed')           as never_started_trial,
  count(*) filter (where stage = 'trialing')            as on_trial,
  count(*) filter (where stage = 'paying')              as paying,
  count(*) filter (where stage = 'lapsed')              as lapsed,
  count(*) filter (where signed_up_at > now() - interval '7 days')  as signups_7d,
  count(*) filter (where signed_up_at > now() - interval '30 days') as signups_30d
from public.admin_signups;

comment on view public.admin_summary is
  'Headline funnel counts. Admin only.';

-- ---------------------------------------------------------------------------
-- 6. expose the views through admin-gated functions
-- ---------------------------------------------------------------------------
-- The views read auth.users, so they are not granted to anyone directly.
-- These functions are the only way in, and each checks is_admin() first.

create or replace function public.admin_get_summary()
returns setof public.admin_summary
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query select * from public.admin_summary;
end;
$$;

create or replace function public.admin_get_signups(
  p_stage text default null,
  p_limit int  default 100,
  p_offset int default 0
)
returns setof public.admin_signups
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
    select * from public.admin_signups s
     where p_stage is null or s.stage = p_stage
     order by s.signed_up_at desc
     limit  least(greatest(coalesce(p_limit, 100), 1), 500)
     offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.admin_get_trials()
returns setof public.admin_trials
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query select * from public.admin_trials t order by t.converts_at asc nulls last;
end;
$$;

revoke all on function public.admin_get_summary()                from public;
revoke all on function public.admin_get_signups(text, int, int)  from public;
revoke all on function public.admin_get_trials()                 from public;

grant execute on function public.admin_get_summary()               to authenticated;
grant execute on function public.admin_get_signups(text, int, int) to authenticated;
grant execute on function public.admin_get_trials()                to authenticated;

-- The views themselves stay unreachable: no grant to anon or authenticated.
revoke all on public.admin_signups from anon, authenticated;
revoke all on public.admin_trials  from anon, authenticated;
revoke all on public.admin_summary from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. make yourself an admin
-- ---------------------------------------------------------------------------
-- Run this once in the SQL editor, which runs as the service role and so is
-- not blocked by the RLS policy above. Change the address first.
--
--   update public.profiles
--      set is_admin = true
--    where id = (select id from auth.users where email = 'mike@mymosaiq.com');
--
-- To check who has access:
--
--   select u.email from public.profiles p
--     join auth.users u on u.id = p.id
--    where p.is_admin;
