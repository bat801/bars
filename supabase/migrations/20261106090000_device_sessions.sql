-- BARS — M1.5: bind Supabase sessions to devices
--
-- A session minted by Supabase Auth is not tied to a device by default: a
-- stolen JWT stays valid until it expires, even after its device is revoked.
-- This migration introduces an explicit server-side binding between the JWT
-- `session_id` claim and a device row.
--
-- Only security-definer functions touch device_sessions. Clients have no
-- grants and no policies; a session is created by register_device and revoked
-- by revoke_device / revoke_session.

-- ---------------------------------------------------------------------------
-- Session -> device bindings
-- ---------------------------------------------------------------------------

create table public.device_sessions (
  session_id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index device_sessions_user_idx
  on public.device_sessions (user_id);

create index device_sessions_device_idx
  on public.device_sessions (device_id);

alter table public.device_sessions enable row level security;
revoke all on table public.device_sessions from anon, authenticated;

comment on table public.device_sessions is
  'Binds an auth session_id to one device. Written only by security-definer RPCs; clients have no direct access.';

-- ---------------------------------------------------------------------------
-- Session helpers
-- ---------------------------------------------------------------------------

create or replace function public.current_session_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw text := nullif((select auth.jwt() ->> 'session_id'), '');
begin
  if v_raw is null then
    return null;
  end if;

  begin
    return v_raw::uuid;
  exception when invalid_text_representation then
    return null;
  end;
end;
$$;

revoke all on function public.current_session_id() from public, anon, authenticated;

-- Registration happens before a session is bound, so this helper checks only
-- the profile. Every other RPC/RLS path uses is_active_user(), which also
-- requires an active session binding.
create or replace function public.is_active_profile()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = (select auth.uid())
       and p.status = 'active'
  );
$$;

revoke all on function public.is_active_profile() from public, anon, authenticated;

-- Replaces the M1 helper. Existing policies call it by name, so they all gain
-- the session check without being recreated.
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
      join public.device_sessions s
        on s.user_id = p.id
       and s.session_id = public.current_session_id()
      join public.devices d
        on d.id = s.device_id
       and d.user_id = p.id
       and d.status = 'active'
     where p.id = (select auth.uid())
       and p.status = 'active'
       and s.revoked_at is null
  );
$$;

revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;

-- ---------------------------------------------------------------------------
-- Register / refresh a device and bind the current session to it
-- ---------------------------------------------------------------------------

create or replace function public.register_device(
  p_device_id uuid,
  p_name text,
  p_public_key_jwk jsonb
)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := public.current_session_id();
  v_name text := trim(coalesce(p_name, ''));
  v_count integer := 0;
  v_device public.devices%rowtype;
  v_binding public.device_sessions%rowtype;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if v_session is null then
    raise exception 'session_required' using errcode = '28000';
  end if;

  if not public.is_active_profile() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if p_device_id is null then
    raise exception 'invalid_device_id';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'invalid_device_name';
  end if;

  if p_public_key_jwk is null
     or p_public_key_jwk->>'kty' <> 'EC'
     or p_public_key_jwk->>'crv' <> 'P-256'
     or coalesce(p_public_key_jwk->>'x', '') !~ '^[A-Za-z0-9_-]{40,100}$'
     or coalesce(p_public_key_jwk->>'y', '') !~ '^[A-Za-z0-9_-]{40,100}$' then
    raise exception 'invalid_public_key';
  end if;

  -- A session may only ever be bound to one device. Reusing a JWT from a
  -- different browser is rejected instead of silently moving the binding.
  select * into v_binding
    from public.device_sessions
   where session_id = v_session;

  if v_binding.session_id is not null then
    if v_binding.user_id <> v_user then
      raise exception 'session_conflict' using errcode = '42501';
    end if;

    if v_binding.revoked_at is not null then
      raise exception 'session_revoked' using errcode = '42501';
    end if;

    if v_binding.device_id <> p_device_id then
      raise exception 'session_device_mismatch' using errcode = '42501';
    end if;
  end if;

  select * into v_device
    from public.devices
   where id = p_device_id;

  if v_device.id is not null then
    if v_device.user_id <> v_user then
      raise exception 'device_conflict';
    end if;

    if v_device.status = 'revoked' then
      raise exception 'device_revoked' using errcode = '42501';
    end if;
  else
    select count(*) into v_count
      from public.devices
     where user_id = v_user
       and status = 'active';

    if v_count >= 20 then
      raise exception 'device_limit';
    end if;
  end if;

  insert into public.devices as d (
    id, user_id, name, public_key_jwk, algorithm, status, last_seen_at
  )
  values (
    p_device_id,
    v_user,
    v_name,
    jsonb_build_object(
      'kty', 'EC',
      'crv', 'P-256',
      'x', p_public_key_jwk->>'x',
      'y', p_public_key_jwk->>'y'
    ),
    'P-256',
    'active',
    now()
  )
  on conflict (id) do update
    set name = excluded.name,
        public_key_jwk = excluded.public_key_jwk,
        last_seen_at = now()
    where d.user_id = v_user
      and d.status = 'active'
  returning * into v_device;

  if v_device.id is null then
    raise exception 'device_conflict';
  end if;

  if v_binding.session_id is null then
    insert into public.device_sessions (session_id, user_id, device_id)
    values (v_session, v_user, p_device_id)
    on conflict (session_id) do nothing;

    select * into v_binding
      from public.device_sessions
     where session_id = v_session;

    if v_binding.session_id is null
       or v_binding.user_id <> v_user
       or v_binding.device_id <> p_device_id
       or v_binding.revoked_at is not null then
      raise exception 'session_conflict' using errcode = '42501';
    end if;
  else
    update public.device_sessions
       set last_seen_at = now()
     where session_id = v_session;
  end if;

  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke a device and every session bound to it
-- ---------------------------------------------------------------------------

create or replace function public.revoke_device(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_device public.devices%rowtype;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if p_device_id is null then
    raise exception 'device_not_found';
  end if;

  update public.devices
     set status = 'revoked',
         revoked_at = now()
   where id = p_device_id
     and user_id = v_user
     and status = 'active'
  returning * into v_device;

  if v_device.id is null then
    raise exception 'device_not_found';
  end if;

  update public.device_sessions
     set revoked_at = now()
   where device_id = p_device_id
     and user_id = v_user
     and revoked_at is null;

  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke the current session (used on local sign-out)
-- ---------------------------------------------------------------------------

create or replace function public.revoke_session()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := public.current_session_id();
begin
  if v_user is null or v_session is null then
    return;
  end if;

  update public.device_sessions
     set revoked_at = now()
   where session_id = v_session
     and user_id = v_user
     and revoked_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.register_device(uuid, text, jsonb) from public, anon;
revoke all on function public.revoke_device(uuid) from public, anon;
revoke all on function public.revoke_session() from public, anon;

grant execute on function public.register_device(uuid, text, jsonb) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.revoke_session() to authenticated;
