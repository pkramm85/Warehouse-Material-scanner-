-- Manage people from the Team tab: pre-approve (invite) someone, edit their name, remove them.
-- Safe to run on its own. schema.sql and 002_locations.sql include this too.

create table if not exists public.invites (
  email text primary key,
  name text not null,
  role text not null default 'warehouse' check (role in ('warehouse','manager','admin')),
  location_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.invites enable row level security;
revoke all on public.invites from anon;
revoke insert, update, delete on public.invites from authenticated;
grant select on public.invites to authenticated;
drop policy if exists invites_read on public.invites;
create policy invites_read on public.invites for select to authenticated using (public.is_admin());

-- New sign-ups: an invite for that email (made by an admin) gives them their role and locations right away.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.invites;
begin
  if lower(new.email) not like '%@carrduff.com' then
    raise exception 'Only @carrduff.com email addresses can sign up.';
  end if;
  select * into inv from public.invites where email = lower(new.email);
  insert into public.profiles (id, email, name, role)
  values (
    new.id, lower(new.email),
    coalesce(nullif(inv.name, ''), nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)),
    case when lower(new.email) = 'pkramm@carrduff.com' then 'admin' else coalesce(inv.role, 'pending') end
  );
  if inv.email is not null then
    insert into public.user_locations (user_id, location_id)
    select new.id, l.id from public.locations l where l.id = any(inv.location_ids);
    delete from public.invites where email = inv.email;
  end if;
  return new;
end $$;

-- Admin: approve someone ahead of time. They still sign up themselves with this email.
-- If they already have an account, their role and locations are updated instead.
create or replace function public.invite_person(p_email text, p_name text, p_role text, p_locations uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email, ''))); pid uuid;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if e not like '%@carrduff.com' then raise exception 'Use a @carrduff.com email address.'; end if;
  if p_role not in ('warehouse','manager','admin') then raise exception 'Pick a role.'; end if;
  select id into pid from public.profiles where email = e;
  if pid is not null then
    if pid = auth.uid() then raise exception 'You can''t change your own role.'; end if;
    update public.profiles set role = p_role, active = true,
      name = coalesce(nullif(trim(p_name), ''), name) where id = pid;
    delete from public.user_locations where user_id = pid;
    insert into public.user_locations (user_id, location_id)
    select pid, l.id from public.locations l where l.id = any(coalesce(p_locations, '{}'));
  else
    insert into public.invites (email, name, role, location_ids)
    values (e, coalesce(nullif(trim(p_name), ''), split_part(e, '@', 1)), p_role,
            coalesce(array(select l.id from public.locations l where l.id = any(coalesce(p_locations, '{}'))), '{}'))
    on conflict (email) do update set name = excluded.name, role = excluded.role, location_ids = excluded.location_ids;
  end if;
end $$;

create or replace function public.cancel_invite(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  delete from public.invites where email = lower(trim(p_email));
end $$;

-- Admin: change someone's display name.
create or replace function public.rename_person(p_user uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Enter a name.'; end if;
  update public.profiles set name = trim(p_name) where id = p_user;
end $$;

-- Admin: delete a person's account. Their past scans stay in History under their name.
create or replace function public.remove_person(p_user uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_user = auth.uid() then raise exception 'You can''t remove yourself.'; end if;
  delete from auth.users where id = p_user;
end $$;

revoke all on function public.invite_person(text, text, text, uuid[]), public.cancel_invite(text),
  public.rename_person(uuid, text), public.remove_person(uuid) from public, anon, authenticated;
grant execute on function public.invite_person(text, text, text, uuid[]), public.cancel_invite(text),
  public.rename_person(uuid, text), public.remove_person(uuid) to authenticated;
