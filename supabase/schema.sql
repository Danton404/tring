-- TRING multi-user schema. Run once in Supabase > SQL Editor.

-- Who may use the app. Add people here (Table Editor > allowed_emails > Insert row).
create table if not exists public.allowed_emails (
  email text primary key check (email = lower(email)),
  note text,
  added_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security; -- no policies: dashboard and server only

create or replace function public.is_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_emails where email = lower(auth.jwt() ->> 'email'));
$$;
revoke execute on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;

-- One row per user: their assets, transactions, plans and snapshots.
create table if not exists public.user_state (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.user_state enable row level security;
drop policy if exists "own state" on public.user_state;
create policy "own state" on public.user_state for all to authenticated
  using (user_id = auth.uid() and public.is_allowed())
  with check (user_id = auth.uid() and public.is_allowed());

-- Shared Twelve Data cache, so all users together stay inside the free rate limit.
create table if not exists public.market_cache (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.market_cache enable row level security; -- server only

-- AI requests per user per day (UTC).
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null default current_date,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage for select to authenticated using (user_id = auth.uid());

-- Returns the new count, or -1 when the limit is already reached.
create or replace function public.bump_ai_usage(p_user uuid, p_limit int)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into ai_usage (user_id, day, count) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set count = ai_usage.count + 1
  returning count into n;
  if n > p_limit then
    update ai_usage set count = count - 1 where user_id = p_user and day = current_date;
    return -1;
  end if;
  return n;
end $$;

create or replace function public.refund_ai_usage(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update ai_usage set count = greatest(count - 1, 0) where user_id = p_user and day = current_date;
$$;

revoke execute on function public.bump_ai_usage(uuid, int) from public, anon, authenticated;
revoke execute on function public.refund_ai_usage(uuid) from public, anon, authenticated;

-- The owner: put your own Google email here before running.
insert into public.allowed_emails (email, note) values ('owner@example.com', 'owner') on conflict do nothing;
