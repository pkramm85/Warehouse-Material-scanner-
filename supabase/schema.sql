-- Carr & Duff Material Scanner: tables, roles and security rules.
-- Run once in Supabase: SQL Editor > New query > paste this file > Run.
--
-- How the security works (this is what makes roles real):
--   * Row Level Security (RLS) means the DATABASE decides who can read or write each table.
--   * Stock changes only happen through the functions below (record_scan, correct_count, ...).
--     Each function checks the caller's role first, so a hacked or edited app still can't cheat.
--   * Roles: pending (no access) < warehouse < manager < admin.

create extension if not exists pgcrypto;

-- ============ tables ============
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  role text not null default 'pending' check (role in ('pending','warehouse','manager','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.materials (
  code text primary key,
  name text not null,
  unit text not null default 'pcs',
  min_qty integer not null default 0 check (min_qty >= 0),
  qty integer not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  user_name text not null,
  code text not null,
  name text not null,
  unit text not null,
  type text not null check (type in ('in','out','fix')),
  delta integer not null,
  after_qty integer not null,
  job text,
  note text
);
create index if not exists scans_ts_idx on public.scans (ts desc);

create table if not exists public.counts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  by_name text not null,
  status text not null default 'open' check (status in ('open','review','done'))
);

create table if not exists public.count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.counts(id) on delete cascade,
  code text not null,
  expected integer not null,
  counted integer check (counted >= 0),
  res text not null default 'pending' check (res in ('pending','approved','rejected'))
);

-- ============ who is the caller? ============
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case when p.active and p.role <> 'pending' then p.role end
  from public.profiles p where p.id = auth.uid()
$$;
create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('manager','admin'), false)
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- ============ sign-up rules ============
-- Only @carrduff.com addresses can create an account. Everyone starts as "pending"
-- (no access) until an admin approves them. The first admin is set by email below.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) not like '%@carrduff.com' then
    raise exception 'Only @carrduff.com email addresses can sign up.';
  end if;
  insert into public.profiles (id, email, name, role)
  values (
    new.id, lower(new.email),
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)),
    case when lower(new.email) = 'pkramm@carrduff.com' then 'admin' else 'pending' end
  );
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Quantities may only change through the functions below, never by editing a row directly.
create or replace function public.guard_qty() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.rpc', true), '') <> '1' then
    if tg_op = 'INSERT' and new.qty <> 0 then
      raise exception 'Add the material first, then record a count.';
    elsif tg_op = 'UPDATE' and new.qty <> old.qty then
      raise exception 'Stock can only change by scanning or correcting a count.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists materials_guard_qty on public.materials;
create trigger materials_guard_qty before insert or update on public.materials
  for each row execute function public.guard_qty();

-- ============ row level security ============
alter table public.profiles    enable row level security;
alter table public.materials   enable row level security;
alter table public.scans       enable row level security;
alter table public.counts      enable row level security;
alter table public.count_lines enable row level security;

revoke all on public.profiles, public.materials, public.scans, public.counts, public.count_lines from anon;
revoke insert, update, delete on public.profiles, public.scans, public.counts, public.count_lines from authenticated;
-- Explicit grants, so this works even when "Automatically expose new tables" is switched off.
-- RLS policies below still decide which rows each signed-in person can see or change.
grant usage on schema public to authenticated;
grant select on public.profiles, public.materials, public.scans, public.counts, public.count_lines to authenticated;
grant insert, update, delete on public.materials to authenticated;

drop policy if exists profiles_read   on public.profiles;
drop policy if exists materials_read  on public.materials;
drop policy if exists materials_ins   on public.materials;
drop policy if exists materials_upd   on public.materials;
drop policy if exists materials_del   on public.materials;
drop policy if exists scans_read      on public.scans;
drop policy if exists counts_read     on public.counts;
drop policy if exists lines_read      on public.count_lines;

create policy profiles_read  on public.profiles    for select to authenticated using (id = auth.uid() or public.is_admin());
create policy materials_read on public.materials   for select to authenticated using (public.my_role() is not null);
create policy materials_ins  on public.materials   for insert to authenticated with check (public.is_manager());
create policy materials_upd  on public.materials   for update to authenticated using (public.is_manager()) with check (public.is_manager());
create policy materials_del  on public.materials   for delete to authenticated using (public.is_manager());
create policy scans_read     on public.scans       for select to authenticated using (public.my_role() is not null);
create policy counts_read    on public.counts      for select to authenticated using (public.my_role() is not null);
-- Only managers see expected quantities, so counters stay blind.
create policy lines_read     on public.count_lines for select to authenticated using (public.is_manager());

-- ============ internal helpers (not callable from the app) ============
create or replace function public.apply_fix(p_code text, p_delta integer, p_note text)
returns public.scans language plpgsql security definer set search_path = public as $$
declare m public.materials; s public.scans; nq integer; uname text;
begin
  select * into m from public.materials where code = p_code for update;
  if not found then raise exception 'Material % not found.', p_code; end if;
  nq := greatest(0, m.qty + p_delta);
  perform set_config('app.rpc', '1', true);
  update public.materials set qty = nq, updated_at = now() where code = p_code;
  select name into uname from public.profiles where id = auth.uid();
  insert into public.scans (user_id, user_name, code, name, unit, type, delta, after_qty, note)
  values (auth.uid(), coalesce(uname, 'system'), m.code, m.name, m.unit, 'fix', nq - m.qty, nq, p_note)
  returning * into s;
  return s;
end $$;

create or replace function public.settle_count(p_count uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.counts c set status = 'done'
  where c.id = p_count and c.status = 'review'
    and not exists (select 1 from public.count_lines l
                    where l.count_id = c.id and l.counted is not null and l.res = 'pending');
end $$;

-- ============ actions the app calls ============
-- Warehouse+: check material in or out.
create or replace function public.record_scan(p_code text, p_type text, p_qty integer, p_job text default null, p_note text default null)
returns public.scans language plpgsql security definer set search_path = public as $$
declare m public.materials; s public.scans; d integer; uname text;
begin
  if public.my_role() is null then raise exception 'Your account is not approved yet.'; end if;
  if p_type not in ('in','out') then raise exception 'Bad scan type.'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1.'; end if;
  select * into m from public.materials where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Material % not found.', p_code; end if;
  d := case when p_type = 'in' then p_qty else -p_qty end;
  if m.qty + d < 0 then raise exception 'Only % % on hand.', m.qty, m.unit; end if;
  perform set_config('app.rpc', '1', true);
  update public.materials set qty = qty + d, updated_at = now() where code = m.code;
  select name into uname from public.profiles where id = auth.uid();
  insert into public.scans (user_id, user_name, code, name, unit, type, delta, after_qty, job, note)
  values (auth.uid(), uname, m.code, m.name, m.unit, p_type, d, m.qty + d, nullif(trim(p_job), ''), nullif(trim(p_note), ''))
  returning * into s;
  return s;
end $$;

-- Manager+: set a material's count to what is really on the shelf.
create or replace function public.correct_count(p_code text, p_new integer, p_note text default null)
returns public.scans language plpgsql security definer set search_path = public as $$
declare m public.materials;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  if p_new is null or p_new < 0 then raise exception 'Enter 0 or higher.'; end if;
  select * into m from public.materials where code = p_code;
  if not found then raise exception 'Material % not found.', p_code; end if;
  return public.apply_fix(p_code, p_new - m.qty, coalesce(p_note, format('Count corrected %s to %s', m.qty, p_new)));
end $$;

-- Own scan within 15 minutes, or any scan for managers and admins.
create or replace function public.undo_scan(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.scans;
begin
  select * into s from public.scans where id = p_id for update;
  if not found then raise exception 'Scan not found.'; end if;
  if not (public.is_manager()
          or (public.my_role() is not null and s.user_id = auth.uid() and s.ts > now() - interval '15 minutes')) then
    raise exception 'Only a manager can undo that scan.';
  end if;
  perform set_config('app.rpc', '1', true);
  update public.materials set qty = greatest(0, qty - s.delta), updated_at = now() where code = s.code;
  delete from public.scans where id = p_id;
end $$;

-- Manager+: start a cycle count for the chosen materials.
create or replace function public.create_count(p_codes text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; uname text;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  if p_codes is null or array_length(p_codes, 1) is null then raise exception 'Pick at least one material.'; end if;
  select name into uname from public.profiles where id = auth.uid();
  insert into public.counts (created_by, by_name) values (auth.uid(), uname) returning id into cid;
  insert into public.count_lines (count_id, code, expected)
  select cid, m.code, m.qty from public.materials m where m.code = any(p_codes);
  return cid;
end $$;

-- Warehouse+: counter's view of a count. Expected numbers are NOT included.
create or replace function public.count_lines_for_counter(p_count uuid)
returns table (id uuid, code text, name text, counted integer)
language sql stable security definer set search_path = public as $$
  select l.id, l.code, m.name, l.counted
  from public.count_lines l left join public.materials m on m.code = l.code
  where l.count_id = p_count and public.my_role() is not null
  order by m.name
$$;

-- Warehouse+: send counted numbers. p_lines looks like [{"id":"...","counted":12}, ...]
create or replace function public.submit_count(p_count uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is null then raise exception 'Your account is not approved yet.'; end if;
  if not exists (select 1 from public.counts where id = p_count and status = 'open') then
    raise exception 'That count is not open.';
  end if;
  update public.count_lines l
  set counted = greatest(0, (e.v->>'counted')::integer)
  from jsonb_array_elements(p_lines) as e(v)
  where l.id = (e.v->>'id')::uuid and l.count_id = p_count and nullif(e.v->>'counted', '') is not null;
  update public.count_lines set res = 'approved' where count_id = p_count and counted is not null and counted = expected;
  update public.counts set status = 'review' where id = p_count;
  perform public.settle_count(p_count);
end $$;

-- Manager+: approve or reject one counted line.
create or replace function public.resolve_line(p_line uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare l public.count_lines;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  select * into l from public.count_lines where id = p_line for update;
  if not found or l.res <> 'pending' or l.counted is null then raise exception 'Nothing to approve on that line.'; end if;
  if p_approve then
    perform public.apply_fix(l.code, l.counted - l.expected, format('Cycle count: expected %s, counted %s', l.expected, l.counted));
  end if;
  update public.count_lines set res = case when p_approve then 'approved' else 'rejected' end where id = p_line;
  perform public.settle_count(l.count_id);
end $$;

-- Manager+: approve every pending line in a count.
create or replace function public.approve_all(p_count uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.count_lines;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  for l in select * from public.count_lines
           where count_id = p_count and counted is not null and res = 'pending' for update loop
    perform public.apply_fix(l.code, l.counted - l.expected, format('Cycle count: expected %s, counted %s', l.expected, l.counted));
    update public.count_lines set res = 'approved' where id = l.id;
  end loop;
  perform public.settle_count(p_count);
end $$;

-- Admin only: approve a new person, change a role, or switch someone off.
create or replace function public.set_role(p_user uuid, p_role text, p_active boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own role.'; end if;
  if p_role not in ('pending','warehouse','manager','admin') then raise exception 'Bad role.'; end if;
  update public.profiles set role = p_role, active = p_active where id = p_user;
end $$;

-- ============ permissions on functions ============
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.my_role(), public.is_manager(), public.is_admin(),
  public.record_scan(text, text, integer, text, text),
  public.correct_count(text, integer, text),
  public.undo_scan(uuid),
  public.create_count(text[]),
  public.count_lines_for_counter(uuid),
  public.submit_count(uuid, jsonb),
  public.resolve_line(uuid, boolean),
  public.approve_all(uuid),
  public.set_role(uuid, text, boolean)
to authenticated;

-- Live updates: every phone sees stock change as it happens.
do $$ begin
  begin alter publication supabase_realtime add table public.materials; exception when others then null; end;
  begin alter publication supabase_realtime add table public.scans;     exception when others then null; end;
end $$;
