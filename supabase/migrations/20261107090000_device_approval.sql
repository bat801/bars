-- BARS — M1.5: new-device approval
--
-- A new browser device starts as `pending` when the account already has a
-- device row. A pending device is bound to its auth session, but
-- is_active_user() stays false: it cannot read messages, call protected RPCs
-- or receive new envelopes until an active device approves it.
--
-- `profiles.device_reset_until` is a break-glass window for the owner. If all
-- devices are lost or revoked, the owner sets it via SQL; the next new device
-- becomes active and the flag is cleared. Clients have no write access to
-- profiles, so this cannot be self-granted.

-- ---------------------------------------------------------------------------
-- Profiles: break-glass reset window
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column device_reset_until timestamptz;

comment on column public.profiles.device_reset_until is
  'Break-glass window: the next new device becomes active when the user has no active devices. Set by the owner/service role only.';

-- ---------------------------------------------------------------------------
-- Devices: pending state and approval audit fields
-- ---------------------------------------------------------------------------

alter table public.devices
  drop constraint if exists devices_status_check;

alter table public.devices
  add constraint devices_status_check
  check (status in ('active', 'pending', 'revoked'));

alter table public.devices
  add column approved_at timestamptz,
  add column approved_by_device_id uuid
    references public.devices (id) on delete set null;

-- Existing rows were active or revoked before this migration. Keep their
-- approval timestamp for audit instead of leaving it empty.
update public.devices
   set approved_at = created_at
 where approved_at is null
   and status in ('active', 'revoked');

create index devices_pending_idx
  on public.devices (user_id, created_at)
  where status = 'pending' and kind = 'device';

-- ---------------------------------------------------------------------------
-- Register / refresh a browser device
-- Same as the recovery migration, plus pending-device policy and the
-- break-glass reset window.
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
  v_device_count integer := 0;
  v_active_count integer := 0;
  v_pending_count integer := 0;
  v_reset_until timestamptz;
  v_new_status text;
  v_used_reset boolean := false;
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

  -- Serialize registrations for one user so two concurrent first devices
  -- cannot both become active.
  perform 1
    from public.profiles
   where id = v_user
   for update;

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
    if v_device.user_id <> v_user or v_device.kind <> 'device' then
      raise exception 'device_conflict';
    end if;

    if v_device.status = 'revoked' then
      raise exception 'device_revoked' using errcode = '42501';
    end if;

    -- Existing active and pending rows are refreshed below. A pending key is
    -- immutable in place so the approval code cannot change under the user.
    v_new_status := v_device.status;
  else
    select count(*),
           count(*) filter (where status = 'active'),
           count(*) filter (where status = 'pending')
      into v_device_count, v_active_count, v_pending_count
      from public.devices
     where user_id = v_user
       and kind = 'device';

    -- Active-device limit is enforced on approval, not on request: a user at
    -- the limit can still queue a replacement and then revoke an old device.
    if v_pending_count >= 3 then
      raise exception 'device_pending_limit';
    end if;

    if v_device_count = 0 then
      -- First device ever: bootstrap the account.
      v_new_status := 'active';
    else
      select p.device_reset_until
        into v_reset_until
        from public.profiles p
       where p.id = v_user;

      if v_active_count = 0
         and v_reset_until is not null
         and v_reset_until > now() then
        -- Owner opened a short break-glass window after all devices were lost.
        v_new_status := 'active';
        v_used_reset := true;
      else
        v_new_status := 'pending';
      end if;
    end if;
  end if;

  insert into public.devices as d (
    id, user_id, name, public_key_jwk, algorithm, status, kind,
    approved_at, last_seen_at
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
    v_new_status,
    'device',
    case when v_new_status = 'active' then now() else null end,
    now()
  )
  on conflict (id) do update
    set name = excluded.name,
        public_key_jwk = case
          when d.status = 'active' then excluded.public_key_jwk
          else d.public_key_jwk
        end,
        last_seen_at = now()
    where d.user_id = v_user
      and d.kind = 'device'
      and d.status in ('active', 'pending')
  returning * into v_device;

  if v_device.id is null then
    raise exception 'device_conflict';
  end if;

  if v_used_reset then
    update public.profiles
       set device_reset_until = null
     where id = v_user;
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
-- Approve a pending device from an active session
-- ---------------------------------------------------------------------------

create or replace function public.approve_device(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := public.current_session_id();
  v_approver public.devices%rowtype;
  v_device public.devices%rowtype;
  v_active_count integer := 0;
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

  perform 1
    from public.profiles
   where id = v_user
   for update;

  select d.* into v_approver
    from public.device_sessions s
    join public.devices d on d.id = s.device_id
   where s.session_id = v_session
     and s.user_id = v_user
     and s.revoked_at is null
     and d.user_id = v_user
     and d.kind = 'device'
     and d.status = 'active';

  if v_approver.id is null then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  select count(*) into v_active_count
    from public.devices
   where user_id = v_user
     and kind = 'device'
     and status = 'active';

  if v_active_count >= 20 then
    raise exception 'device_limit';
  end if;

  update public.devices
     set status = 'active',
         approved_at = now(),
         approved_by_device_id = v_approver.id,
         last_seen_at = now()
   where id = p_device_id
     and user_id = v_user
     and kind = 'device'
     and status = 'pending'
  returning * into v_device;

  if v_device.id is null then
    raise exception 'device_not_found';
  end if;

  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel a pending request from the pending device itself
-- ---------------------------------------------------------------------------

create or replace function public.cancel_device_request(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := public.current_session_id();
  v_device public.devices%rowtype;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_profile() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if p_device_id is null then
    raise exception 'device_not_found';
  end if;

  if not exists (
    select 1
      from public.device_sessions s
     where s.session_id = v_session
       and s.user_id = v_user
       and s.device_id = p_device_id
       and s.revoked_at is null
  ) then
    raise exception 'session_device_mismatch' using errcode = '42501';
  end if;

  update public.devices
     set status = 'revoked',
         revoked_at = now()
   where id = p_device_id
     and user_id = v_user
     and kind = 'device'
     and status = 'pending'
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
-- Revoke an active device or deny a pending request
-- Same as the session migration, but pending rows can now be denied.
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
     and status in ('active', 'pending')
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
-- Conversation device directory
-- Pending devices are not part of the conversation yet, so peers must not see
-- them. Revoked devices remain visible so old sender names stay resolvable.
-- ---------------------------------------------------------------------------

create or replace function public.get_conversation_devices(p_conversation_id uuid)
returns table (
  device_id uuid,
  user_id uuid,
  device_name text,
  display_name text,
  username text,
  public_key_jwk jsonb,
  status text,
  profile_status text,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'conversation_not_found' using errcode = '42501';
  end if;

  return query
    select d.id,
           d.user_id,
           d.name,
           p.display_name,
           p.username,
           d.public_key_jwk,
           d.status,
           p.status,
           d.last_seen_at
      from public.devices d
      join public.profiles p on p.id = d.user_id
      join public.conversation_members cm
        on cm.user_id = d.user_id
       and cm.conversation_id = p_conversation_id
     where d.status <> 'pending'
     order by d.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.approve_device(uuid) from public, anon;
revoke all on function public.cancel_device_request(uuid) from public, anon;

grant execute on function public.approve_device(uuid) to authenticated;
grant execute on function public.cancel_device_request(uuid) to authenticated;
