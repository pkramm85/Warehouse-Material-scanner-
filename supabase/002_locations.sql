-- Version 1 -> 2: replaces the materials/scans/counts tables with location-aware ones.
-- This DELETES test materials, scans and counts. It KEEPS people (profiles) and their roles.
-- Safe to run before the real bulk upload. Do not run it after real data is loaded.
drop table if exists public.count_lines cascade;
drop table if exists public.counts cascade;
drop table if exists public.scans cascade;
drop table if exists public.materials cascade;
drop function if exists public.guard_qty() cascade;
drop function if exists public.record_scan(text, text, integer, text, text);
drop function if exists public.correct_count(text, integer, text);
drop function if exists public.apply_fix(text, integer, text);
drop function if exists public.create_count(text[]);

-- ============ tables ============
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.user_locations (
  user_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  primary key (user_id, location_id)
);

-- The material list (SKUs) is shared by every location.
create table if not exists public.materials (
  code text primary key,
  name text not null,
  unit text not null default 'pcs',
  updated_at timestamptz not null default now()
);

-- Quantity and low-stock minimum are kept per material per location.
create table if not exists public.stock (
  material_code text not null references public.materials(code) on delete cascade on update cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  qty integer not null default 0 check (qty >= 0),
  min_qty integer not null default 0 check (min_qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (material_code, location_id)
);

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  user_name text not null,
  location_id uuid references public.locations(id) on delete set null,
  location_name text,
  code text not null,
  name text not null,
  unit text not null,
  type text not null check (type in ('in','out','fix','transfer')),
  delta integer not null,
  after_qty integer not null,
  job text,
  note text,
  transfer_id uuid,
  other_location text
);
create index if not exists scans_ts_idx on public.scans (ts desc);
create index if not exists scans_loc_idx on public.scans (location_id, ts desc);

create table if not exists public.counts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  by_name text not null,
  location_id uuid not null references public.locations(id) on delete cascade,
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

-- ============ location access ============
-- Admins reach every location. Everyone else only the ones an admin assigned to them.
create or replace function public.can_access(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    public.my_role() is not null and p_loc is not null
    and (public.is_admin() or exists (select 1 from public.user_locations ul
                                      where ul.user_id = auth.uid() and ul.location_id = p_loc)),
    false)
$$;

create or replace function public.assert_loc(p_loc uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_access(p_loc) then raise exception 'You don''t have access to that location.'; end if;
  if not exists (select 1 from public.locations where id = p_loc and active) then
    raise exception 'That location is switched off.';
  end if;
end $$;

-- The locations this person can work in (admins get all, including switched-off ones).
create or replace function public.my_locations()
returns table (id uuid, name text, active boolean)
language sql stable security definer set search_path = public as $$
  select l.id, l.name, l.active from public.locations l
  where public.my_role() is not null
    and (public.is_admin() or (l.active and exists (select 1 from public.user_locations ul
                                                    where ul.user_id = auth.uid() and ul.location_id = l.id)))
  order by l.name
$$;

-- ============ row level security ============
alter table public.profiles       enable row level security;
alter table public.locations      enable row level security;
alter table public.user_locations enable row level security;
alter table public.materials      enable row level security;
alter table public.stock          enable row level security;
alter table public.scans          enable row level security;
alter table public.counts         enable row level security;
alter table public.count_lines    enable row level security;

revoke all on public.profiles, public.locations, public.user_locations, public.materials,
              public.stock, public.scans, public.counts, public.count_lines from anon;
revoke insert, update, delete on public.profiles, public.locations, public.user_locations,
              public.stock, public.scans, public.counts, public.count_lines from authenticated;
-- Explicit grants, so this works even when "Automatically expose new tables" is switched off.
-- RLS policies below still decide which rows each signed-in person can see or change.
grant usage on schema public to authenticated;
grant select on public.profiles, public.locations, public.user_locations, public.materials,
                public.stock, public.scans, public.counts, public.count_lines to authenticated;
grant insert, update, delete on public.materials to authenticated;

drop policy if exists profiles_read        on public.profiles;
drop policy if exists locations_read       on public.locations;
drop policy if exists user_locations_read  on public.user_locations;
drop policy if exists materials_read       on public.materials;
drop policy if exists materials_ins        on public.materials;
drop policy if exists materials_upd        on public.materials;
drop policy if exists materials_del        on public.materials;
drop policy if exists stock_read           on public.stock;
drop policy if exists scans_read           on public.scans;
drop policy if exists counts_read          on public.counts;
drop policy if exists lines_read           on public.count_lines;

create policy profiles_read       on public.profiles       for select to authenticated using (id = auth.uid() or public.is_admin());
-- Location names are visible to every approved person so they can pick a transfer destination.
create policy locations_read      on public.locations      for select to authenticated using (public.my_role() is not null);
create policy user_locations_read on public.user_locations for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy materials_read      on public.materials      for select to authenticated using (public.my_role() is not null);
create policy materials_ins       on public.materials      for insert to authenticated with check (public.is_manager());
create policy materials_upd       on public.materials      for update to authenticated using (public.is_manager()) with check (public.is_manager());
create policy materials_del       on public.materials      for delete to authenticated using (public.is_manager());
create policy stock_read          on public.stock          for select to authenticated using (public.can_access(location_id));
create policy scans_read          on public.scans          for select to authenticated using (public.can_access(location_id));
create policy counts_read         on public.counts         for select to authenticated using (public.can_access(location_id));
-- Only managers see expected quantities, so counters stay blind.
create policy lines_read          on public.count_lines    for select to authenticated using (
  public.is_manager() and exists (select 1 from public.counts c where c.id = count_id and public.can_access(c.location_id)));

-- ============ internal helpers (not callable from the app) ============
create or replace function public.apply_fix(p_code text, p_loc uuid, p_delta integer, p_note text)
returns public.scans language plpgsql security definer set search_path = public as $$
declare m public.materials; st public.stock; s public.scans; nq integer; uname text; lname text;
begin
  select * into m from public.materials where code = p_code;
  if not found then raise exception 'Material % not found.', p_code; end if;
  insert into public.stock (material_code, location_id) values (p_code, p_loc) on conflict do nothing;
  select * into st from public.stock where material_code = p_code and location_id = p_loc for update;
  nq := greatest(0, st.qty + p_delta);
  update public.stock set qty = nq, updated_at = now() where material_code = p_code and location_id = p_loc;
  select name into uname from public.profiles where id = auth.uid();
  select name into lname from public.locations where id = p_loc;
  insert into public.scans (user_id, user_name, location_id, location_name, code, name, unit, type, delta, after_qty, note)
  values (auth.uid(), coalesce(uname, 'system'), p_loc, lname, m.code, m.name, m.unit, 'fix', nq - st.qty, nq, p_note)
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
-- Warehouse+: check material in or out at a location they can access.
create or replace function public.record_scan(p_code text, p_type text, p_qty integer, p_job text default null, p_note text default null, p_location uuid default null)
returns public.scans language plpgsql security definer set search_path = public as $$
declare m public.materials; st public.stock; s public.scans; d integer; uname text; lname text;
begin
  if public.my_role() is null then raise exception 'Your account is not approved yet.'; end if;
  perform public.assert_loc(p_location);
  if p_type not in ('in','out') then raise exception 'Bad scan type.'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1.'; end if;
  select * into m from public.materials where code = upper(trim(p_code));
  if not found then raise exception 'Material % not found.', p_code; end if;
  insert into public.stock (material_code, location_id) values (m.code, p_location) on conflict do nothing;
  select * into st from public.stock where material_code = m.code and location_id = p_location for update;
  d := case when p_type = 'in' then p_qty else -p_qty end;
  if st.qty + d < 0 then raise exception 'Only % % on hand here.', st.qty, m.unit; end if;
  update public.stock set qty = qty + d, updated_at = now() where material_code = m.code and location_id = p_location;
  select name into uname from public.profiles where id = auth.uid();
  select name into lname from public.locations where id = p_location;
  insert into public.scans (user_id, user_name, location_id, location_name, code, name, unit, type, delta, after_qty, job, note)
  values (auth.uid(), uname, p_location, lname, m.code, m.name, m.unit, p_type, d, st.qty + d, nullif(trim(p_job), ''), nullif(trim(p_note), ''))
  returning * into s;
  return s;
end $$;

-- Warehouse+: move material from one of their locations to any other active location. Instant, one history entry.
create or replace function public.transfer_stock(p_code text, p_from uuid, p_to uuid, p_qty integer, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare m public.materials; fq integer; tid uuid := gen_random_uuid(); uname text; fname text; tname text;
begin
  if public.my_role() is null then raise exception 'Your account is not approved yet.'; end if;
  perform public.assert_loc(p_from);
  if p_to is null or p_to = p_from then raise exception 'Pick a different location to send it to.'; end if;
  if not exists (select 1 from public.locations where id = p_to and active) then raise exception 'That destination is switched off.'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1.'; end if;
  select * into m from public.materials where code = upper(trim(p_code));
  if not found then raise exception 'Material % not found.', p_code; end if;
  insert into public.stock (material_code, location_id) values (m.code, p_from), (m.code, p_to) on conflict do nothing;
  perform 1 from public.stock where material_code = m.code and location_id in (p_from, p_to) order by location_id for update;
  select qty into fq from public.stock where material_code = m.code and location_id = p_from;
  select name into fname from public.locations where id = p_from;
  select name into tname from public.locations where id = p_to;
  if fq < p_qty then raise exception 'Only % % on hand at %.', fq, m.unit, fname; end if;
  update public.stock set qty = qty - p_qty, updated_at = now() where material_code = m.code and location_id = p_from;
  update public.stock set qty = qty + p_qty, updated_at = now() where material_code = m.code and location_id = p_to;
  select name into uname from public.profiles where id = auth.uid();
  insert into public.scans (user_id, user_name, location_id, location_name, code, name, unit, type, delta, after_qty, note, transfer_id, other_location)
  values (auth.uid(), uname, p_from, fname, m.code, m.name, m.unit, 'transfer', -p_qty, fq - p_qty, nullif(trim(p_note), ''), tid, tname);
  insert into public.scans (user_id, user_name, location_id, location_name, code, name, unit, type, delta, after_qty, note, transfer_id, other_location)
  values (auth.uid(), uname, p_to, tname, m.code, m.name, m.unit, 'transfer', p_qty,
          (select qty from public.stock where material_code = m.code and location_id = p_to), nullif(trim(p_note), ''), tid, fname);
  return tid;
end $$;

-- Manager+: set a material's count at a location to what is really on the shelf.
create or replace function public.correct_count(p_code text, p_location uuid, p_new integer, p_note text default null)
returns public.scans language plpgsql security definer set search_path = public as $$
declare cur integer;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  perform public.assert_loc(p_location);
  if p_new is null or p_new < 0 then raise exception 'Enter 0 or higher.'; end if;
  if not exists (select 1 from public.materials where code = p_code) then raise exception 'Material % not found.', p_code; end if;
  select coalesce((select qty from public.stock where material_code = p_code and location_id = p_location), 0) into cur;
  return public.apply_fix(p_code, p_location, p_new - cur, coalesce(p_note, format('Count corrected %s to %s', cur, p_new)));
end $$;

-- Manager+: set the low-stock minimum for a material at a location.
create or replace function public.set_min(p_code text, p_location uuid, p_min integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  perform public.assert_loc(p_location);
  insert into public.stock (material_code, location_id, min_qty) values (p_code, p_location, greatest(0, coalesce(p_min, 0)))
  on conflict (material_code, location_id) do update set min_qty = excluded.min_qty, updated_at = now();
end $$;

-- Own scan within 15 minutes, or any scan for managers and admins (at locations they can access).
-- Undoing a transfer reverses both sides, and is refused if the stock has already moved on.
create or replace function public.undo_scan(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.scans; r public.scans; cur integer;
begin
  select * into s from public.scans where id = p_id for update;
  if not found then raise exception 'Scan not found.'; end if;
  if not (public.is_manager()
          or (public.my_role() is not null and s.user_id = auth.uid() and s.ts > now() - interval '15 minutes')) then
    raise exception 'Only a manager can undo that scan.';
  end if;
  if not public.can_access(s.location_id) then raise exception 'You don''t have access to that location.'; end if;
  if s.type = 'transfer' and s.transfer_id is not null then
    for r in select * from public.scans where transfer_id = s.transfer_id order by location_id for update loop
      select qty into cur from public.stock where material_code = r.code and location_id = r.location_id for update;
      if r.delta > 0 and coalesce(cur, 0) < r.delta then
        raise exception 'Can''t undo: that stock has already moved on from %.', r.location_name;
      end if;
    end loop;
    for r in select * from public.scans where transfer_id = s.transfer_id loop
      update public.stock set qty = qty - r.delta, updated_at = now() where material_code = r.code and location_id = r.location_id;
    end loop;
    delete from public.scans where transfer_id = s.transfer_id;
  else
    update public.stock set qty = greatest(0, qty - s.delta), updated_at = now()
    where material_code = s.code and location_id = s.location_id;
    delete from public.scans where id = p_id;
  end if;
end $$;

-- Manager+: start a cycle count at a location for the chosen materials.
create or replace function public.create_count(p_location uuid, p_codes text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; uname text;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  perform public.assert_loc(p_location);
  if p_codes is null or array_length(p_codes, 1) is null then raise exception 'Pick at least one material.'; end if;
  select name into uname from public.profiles where id = auth.uid();
  insert into public.counts (created_by, by_name, location_id) values (auth.uid(), uname, p_location) returning id into cid;
  insert into public.count_lines (count_id, code, expected)
  select cid, m.code, coalesce(s.qty, 0)
  from public.materials m left join public.stock s on s.material_code = m.code and s.location_id = p_location
  where m.code = any(p_codes);
  return cid;
end $$;

-- Warehouse+: counter's view of a count. Expected numbers are NOT included.
create or replace function public.count_lines_for_counter(p_count uuid)
returns table (id uuid, code text, name text, counted integer)
language sql stable security definer set search_path = public as $$
  select l.id, l.code, m.name, l.counted
  from public.count_lines l
  join public.counts c on c.id = l.count_id
  left join public.materials m on m.code = l.code
  where l.count_id = p_count and public.can_access(c.location_id)
  order by m.name
$$;

-- Warehouse+: send counted numbers. p_lines looks like [{"id":"...","counted":12}, ...]
create or replace function public.submit_count(p_count uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare loc uuid;
begin
  select location_id into loc from public.counts where id = p_count and status = 'open';
  if loc is null then raise exception 'That count is not open.'; end if;
  perform public.assert_loc(loc);
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
declare l public.count_lines; loc uuid;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  select * into l from public.count_lines where id = p_line for update;
  if not found or l.res <> 'pending' or l.counted is null then raise exception 'Nothing to approve on that line.'; end if;
  select location_id into loc from public.counts where id = l.count_id;
  perform public.assert_loc(loc);
  if p_approve then
    perform public.apply_fix(l.code, loc, l.counted - l.expected, format('Cycle count: expected %s, counted %s', l.expected, l.counted));
  end if;
  update public.count_lines set res = case when p_approve then 'approved' else 'rejected' end where id = p_line;
  perform public.settle_count(l.count_id);
end $$;

-- Manager+: approve every pending line in a count.
create or replace function public.approve_all(p_count uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.count_lines; loc uuid;
begin
  if not public.is_manager() then raise exception 'Managers and admins only.'; end if;
  select location_id into loc from public.counts where id = p_count;
  perform public.assert_loc(loc);
  for l in select * from public.count_lines
           where count_id = p_count and counted is not null and res = 'pending' for update loop
    perform public.apply_fix(l.code, loc, l.counted - l.expected, format('Cycle count: expected %s, counted %s', l.expected, l.counted));
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

-- Admin only: add, rename or switch off a location.
create or replace function public.create_location(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Enter a location name.'; end if;
  insert into public.locations (name) values (trim(p_name)) returning id into lid;
  return lid;
exception when unique_violation then raise exception 'A location with that name already exists.';
end $$;

create or replace function public.update_location(p_id uuid, p_name text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Enter a location name.'; end if;
  update public.locations set name = trim(p_name), active = coalesce(p_active, true) where id = p_id;
exception when unique_violation then raise exception 'A location with that name already exists.';
end $$;

-- Admin only: choose which locations a person can work in.
create or replace function public.set_user_locations(p_user uuid, p_locations uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  delete from public.user_locations where user_id = p_user;
  insert into public.user_locations (user_id, location_id)
  select p_user, l.id from public.locations l where l.id = any(coalesce(p_locations, '{}'));
end $$;

-- ============ permissions on functions ============
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.my_role(), public.is_manager(), public.is_admin(), public.can_access(uuid),
  public.my_locations(),
  public.record_scan(text, text, integer, text, text, uuid),
  public.transfer_stock(text, uuid, uuid, integer, text),
  public.correct_count(text, uuid, integer, text),
  public.set_min(text, uuid, integer),
  public.undo_scan(uuid),
  public.create_count(uuid, text[]),
  public.count_lines_for_counter(uuid),
  public.submit_count(uuid, jsonb),
  public.resolve_line(uuid, boolean),
  public.approve_all(uuid),
  public.set_role(uuid, text, boolean),
  public.create_location(text),
  public.update_location(uuid, text, boolean),
  public.set_user_locations(uuid, uuid[])
to authenticated;

-- First location. Add more from the Team tab.
insert into public.locations (name) values ('2100 Byberry') on conflict (name) do nothing;

-- Live updates: every phone sees stock change as it happens.
do $$ begin
  begin alter publication supabase_realtime add table public.stock;     exception when others then null; end;
  begin alter publication supabase_realtime add table public.scans;     exception when others then null; end;
  begin alter publication supabase_realtime add table public.counts;    exception when others then null; end;
  begin alter publication supabase_realtime add table public.materials; exception when others then null; end;
end $$;

-- ============ job requisitions ============
alter table public.scans add column if not exists req_id uuid;
create index if not exists scans_req_idx on public.scans (req_id);

-- What is currently out on a job at a location (issued minus returned).
create or replace function public.job_net(p_job text, p_location uuid)
returns table (code text, name text, unit text, net integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_loc(p_location);
  return query
    select s.code, max(s.name), max(s.unit), (-sum(s.delta))::integer
    from public.scans s
    where s.location_id = p_location and s.req_id is not null and upper(s.job) = upper(trim(p_job))
    group by s.code
    having -sum(s.delta) > 0
    order by max(s.name);
end $$;

-- Warehouse+: p_kind 'issue' takes stock out to the job, 'return' puts it back.
-- p_lines looks like [{"code":"EMT-050","qty":20}, ...]. All lines succeed or none do.
-- A return can't be more than what was issued to that job at that location.
create or replace function public.requisition(p_location uuid, p_job text, p_kind text, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid := gen_random_uuid(); j text := upper(trim(coalesce(p_job, '')));
  l record; m public.materials; st public.stock; d integer; net integer; n integer := 0; uname text; lname text;
begin
  if public.my_role() is null then raise exception 'Your account is not approved yet.'; end if;
  perform public.assert_loc(p_location);
  if j = '' then raise exception 'Enter a job number.'; end if;
  if p_kind not in ('issue', 'return') then raise exception 'Bad request type.'; end if;
  select name into uname from public.profiles where id = auth.uid();
  select name into lname from public.locations where id = p_location;
  for l in select upper(trim(e.v->>'code')) as code, sum((e.v->>'qty')::integer) as qty
           from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as e(v) group by 1 order by 1 loop
    if l.qty is null or l.qty < 1 then raise exception 'Quantity must be at least 1 for %.', l.code; end if;
    select * into m from public.materials where code = l.code;
    if not found then raise exception 'Material % not found.', l.code; end if;
    insert into public.stock (material_code, location_id) values (m.code, p_location) on conflict do nothing;
    select * into st from public.stock where material_code = m.code and location_id = p_location for update;
    if p_kind = 'issue' then
      d := -l.qty;
      if st.qty + d < 0 then raise exception 'Only % % of % on hand here.', st.qty, m.unit, m.name; end if;
    else
      select coalesce(-sum(delta), 0) into net from public.scans
      where location_id = p_location and req_id is not null and upper(job) = j and code = m.code;
      if l.qty > net then raise exception 'Only % % of % is out on job % at this location.', net, m.unit, m.name, j; end if;
      d := l.qty;
    end if;
    update public.stock set qty = qty + d, updated_at = now() where material_code = m.code and location_id = p_location;
    insert into public.scans (user_id, user_name, location_id, location_name, code, name, unit, type, delta, after_qty, job, note, req_id)
    values (auth.uid(), uname, p_location, lname, m.code, m.name, m.unit, case when p_kind = 'issue' then 'out' else 'in' end,
            d, st.qty + d, j, nullif(trim(p_note), ''), rid);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one material.'; end if;
  return rid;
end $$;

revoke all on function public.job_net(text, uuid), public.requisition(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.job_net(text, uuid), public.requisition(uuid, text, text, jsonb, text) to authenticated;
