-- Job material requisitions: issue many materials to a job in one step, or roll them back into stock.
-- Safe to run on its own if you already ran schema.sql / 002_locations.sql before this existed.
-- (schema.sql and 002_locations.sql also include this, so fresh installs don't need it separately.)

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
