-- RavMizAI — 012: call and chat sessions, and an optional daily cap
--
-- The Delphi embed is no longer in the page HTML. The delphi-embed Edge
-- Function hands it to a signed-in member and opens a session row here, and
-- the page checks in about once a minute while it stays open. Each check-in
-- adds the time since the previous one, at most 90 seconds, so time while a
-- tab was asleep or closed is not counted.
--
-- This measures time with the call or chat open, not talk time: Delphi does
-- not tell us how long a call lasted (see USAGE-TRACKING.md). It is a safety
-- cap, so a few heavy users cannot use up the Delphi plan for everyone. It is
-- not billing.
--
-- The cap is OFF: the default row has no limits. To switch it on for every
-- member (minutes per day; empty/null means no limit):
--
--   update public.daily_limits set call_minutes = 60, chat_minutes = 120
--   where user_id is null;
--
-- For one member, a row of their own replaces the default (null there means
-- no limit for them):
--
--   insert into public.daily_limits (user_id, call_minutes, note)
--   values ('<user uuid>', 30, 'heavy user')
--   on conflict (user_id) do update set call_minutes = excluded.call_minutes;
--
-- The day runs midnight to midnight, New York time (embed_day()).
--
-- Idempotent: safe to re-run.

create table if not exists public.embed_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('call', 'chat')),
  day          date not null,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seconds      integer not null default 0 check (seconds >= 0)
);

create index if not exists embed_sessions_user_day_kind
  on public.embed_sessions (user_id, day, kind);

create table if not exists public.daily_limits (
  user_id      uuid references auth.users(id) on delete cascade,  -- null = every member
  call_minutes integer check (call_minutes >= 0),                 -- null = no limit
  chat_minutes integer check (chat_minutes >= 0),                 -- null = no limit
  note         text,
  constraint daily_limits_user_key unique nulls not distinct (user_id)
);

insert into public.daily_limits (user_id, call_minutes, chat_minutes, note)
values (null, null, null, 'Default for every member: minutes per day, empty means no limit.')
on conflict (user_id) do nothing;

-- Only the server (service role) reads or writes these. RLS with no policies
-- shuts out the browser even if a grant comes back.
alter table public.embed_sessions enable row level security;
alter table public.daily_limits enable row level security;
revoke all on table public.embed_sessions, public.daily_limits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The usage day: midnight to midnight, New York time.
create or replace function public.embed_day()
returns date
language sql
stable
set search_path = public
as $fn$
  select (now() at time zone 'America/New_York')::date
$fn$;

-- The member's cap in seconds for 'call' or 'chat', or null for no limit.
-- Their own row, if any, replaces the default row entirely.
create or replace function public.embed_limit_seconds(p_user uuid, p_kind text)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select (case p_kind when 'call' then l.call_minutes when 'chat' then l.chat_minutes end) * 60
  from public.daily_limits l
  where l.user_id = p_user or l.user_id is null
  order by l.user_id nulls last
  limit 1
$fn$;

create or replace function public.embed_used_seconds(p_user uuid, p_kind text, p_day date)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(sum(s.seconds), 0)::integer
  from public.embed_sessions s
  where s.user_id = p_user and s.kind = p_kind and s.day = p_day
$fn$;

-- Opens a session, unless the member is already at today's cap, in which case
-- out_session is null. Membership is checked by the caller (delphi-embed).
create or replace function public.embed_open(p_user uuid, p_kind text)
returns table (out_session uuid, out_limit_seconds integer, out_used_seconds integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_day   date := public.embed_day();
  v_limit integer;
  v_used  integer;
  v_id    uuid;
begin
  if p_user is null or p_kind is null or p_kind not in ('call', 'chat') then
    raise exception 'embed_open: a user and a kind of call or chat are required';
  end if;
  v_limit := public.embed_limit_seconds(p_user, p_kind);
  v_used  := public.embed_used_seconds(p_user, p_kind, v_day);
  if v_limit is null or v_used < v_limit then
    insert into public.embed_sessions (user_id, kind, day)
    values (p_user, p_kind, v_day)
    returning id into v_id;
  end if;
  return query select v_id, v_limit, v_used;
end
$fn$;

-- A check-in from an open page: adds the time since the previous one (at most
-- 90 seconds) to the session, and reports the member's total for that
-- session's day. No row back means it is not this member's session.
create or replace function public.embed_ping(p_user uuid, p_session uuid)
returns table (out_kind text, out_limit_seconds integer, out_used_seconds integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_kind text;
  v_day  date;
begin
  update public.embed_sessions s
     set seconds = s.seconds
                   + least(greatest(floor(extract(epoch from now() - s.last_seen_at))::integer, 0), 90),
         last_seen_at = now()
   where s.id = p_session and s.user_id = p_user
  returning s.kind, s.day into v_kind, v_day;
  if not found then
    return;
  end if;
  return query select v_kind,
                      public.embed_limit_seconds(p_user, v_kind),
                      public.embed_used_seconds(p_user, v_kind, v_day);
end
$fn$;

revoke all on function public.embed_day() from public, anon, authenticated;
revoke all on function public.embed_limit_seconds(uuid, text) from public, anon, authenticated;
revoke all on function public.embed_used_seconds(uuid, text, date) from public, anon, authenticated;
revoke all on function public.embed_open(uuid, text) from public, anon, authenticated;
revoke all on function public.embed_ping(uuid, uuid) from public, anon, authenticated;
grant execute on function public.embed_day() to service_role;
grant execute on function public.embed_limit_seconds(uuid, text) to service_role;
grant execute on function public.embed_used_seconds(uuid, text, date) to service_role;
grant execute on function public.embed_open(uuid, text) to service_role;
grant execute on function public.embed_ping(uuid, uuid) to service_role;
