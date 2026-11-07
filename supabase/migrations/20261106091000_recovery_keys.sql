-- BARS — M1.5: user-level recovery key
--
-- The recovery key is represented as a special row in public.devices with
-- kind = 'recovery'. This lets the existing, tested send path wrap a content
-- key for it exactly like for a browser device, without changing send_message
-- or get_conversation_devices.
--
-- The private key never reaches the server. The client exports it once,
-- encrypts it with a passphrase-derived key and stores only the ciphertext in
-- public.key_backups (RLS: owner only). The public key is visible to peers so
-- they can address envelopes to it.

alter table public.devices
  add column kind text not null default 'device'
  check (kind in ('device', 'recovery'));

-- One active recovery key per user. Revoked recovery rows stay for history.
create unique index devices_one_recovery_idx
  on public.devices (user_id)
  where kind = 'recovery' and status = 'active';

comment on column public.devices.kind is
  'device: browser identity; recovery: user-level key that receives recovery envelopes.';

-- ---------------------------------------------------------------------------
-- Envelope recipient kind
-- send_message historically wrote recipient_kind = 'device' for every row.
-- Derive it from devices.kind so recovery envelopes are labelled truthfully
-- without duplicating the whole send_message function.
-- ---------------------------------------------------------------------------

create or replace function public.message_keys_set_recipient_kind()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select d.kind into new.recipient_kind
    from public.devices d
   where d.id = new.device_id;

  if new.recipient_kind is null then
    new.recipient_kind := 'device';
  end if;

  return new;
end;
$$;

drop trigger if exists message_keys_recipient_kind on public.message_keys;

create trigger message_keys_recipient_kind
before insert or update of device_id on public.message_keys
for each row execute function public.message_keys_set_recipient_kind();

-- ---------------------------------------------------------------------------
-- Messages must be sent by a browser device, never by the recovery key.
-- ---------------------------------------------------------------------------

create or replace function public.messages_require_device_sender()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.devices d
     where d.id = new.sender_device_id
       and d.kind = 'device'
  ) then
    raise exception 'invalid_sender_device' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_require_device_sender on public.messages;

create trigger messages_require_device_sender
before insert on public.messages
for each row execute function public.messages_require_device_sender();

-- ---------------------------------------------------------------------------
-- Register / refresh a browser device
-- Same as the session-binding migration, plus a guard that prevents the
-- normal device RPC from rotating the recovery public key.
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

    if v_device.kind <> 'device' then
      raise exception 'device_conflict';
    end if;

    if v_device.status = 'revoked' then
      raise exception 'device_revoked' using errcode = '42501';
    end if;
  else
    select count(*) into v_count
      from public.devices
     where user_id = v_user
       and status = 'active'
       and kind = 'device';

    if v_count >= 20 then
      raise exception 'device_limit';
    end if;
  end if;

  insert into public.devices as d (
    id, user_id, name, public_key_jwk, algorithm, status, kind, last_seen_at
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
    'device',
    now()
  )
  on conflict (id) do update
    set name = excluded.name,
        public_key_jwk = excluded.public_key_jwk,
        last_seen_at = now()
    where d.user_id = v_user
      and d.kind = 'device'
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
-- Register the user's recovery public key
-- Does not touch device_sessions: the recovery key is not a login device.
-- The public key is immutable in place: replacing a recovery key requires
-- revoking it and creating a new one, so a stolen session cannot silently
-- redirect future recovery envelopes.
-- ---------------------------------------------------------------------------

create or replace function public.register_recovery_key(
  p_device_id uuid,
  p_public_key_jwk jsonb
)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_existing public.devices%rowtype;
  v_device public.devices%rowtype;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if p_device_id is null then
    raise exception 'invalid_device_id';
  end if;

  if p_public_key_jwk is null
     or p_public_key_jwk->>'kty' <> 'EC'
     or p_public_key_jwk->>'crv' <> 'P-256'
     or coalesce(p_public_key_jwk->>'x', '') !~ '^[A-Za-z0-9_-]{40,100}$'
     or coalesce(p_public_key_jwk->>'y', '') !~ '^[A-Za-z0-9_-]{40,100}$' then
    raise exception 'invalid_public_key';
  end if;

  select * into v_existing
    from public.devices
   where user_id = v_user
     and kind = 'recovery'
     and status = 'active';

  if v_existing.id is not null then
    if v_existing.id <> p_device_id then
      raise exception 'recovery_exists' using errcode = '42501';
    end if;

    if v_existing.public_key_jwk->>'x' <> p_public_key_jwk->>'x'
       or v_existing.public_key_jwk->>'y' <> p_public_key_jwk->>'y' then
      raise exception 'recovery_mismatch' using errcode = '42501';
    end if;

    update public.devices
       set last_seen_at = now()
     where id = p_device_id
       and user_id = v_user
       and kind = 'recovery'
       and status = 'active'
    returning * into v_device;

    return v_device;
  end if;

  -- The recovery key keeps its id in the kit. Refuse to reuse a normal
  -- device row or a revoked recovery row with that id.
  select * into v_device
    from public.devices
   where id = p_device_id;

  if v_device.id is not null then
    if v_device.user_id = v_user and v_device.kind = 'recovery' then
      raise exception 'recovery_revoked' using errcode = '42501';
    end if;

    raise exception 'device_conflict';
  end if;

  insert into public.devices (
    id, user_id, name, public_key_jwk, algorithm, status, kind, last_seen_at
  )
  values (
    p_device_id,
    v_user,
    'Ключ восстановления',
    jsonb_build_object(
      'kty', 'EC',
      'crv', 'P-256',
      'x', p_public_key_jwk->>'x',
      'y', p_public_key_jwk->>'y'
    ),
    'P-256',
    'active',
    'recovery',
    now()
  )
  returning * into v_device;

  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.register_device(uuid, text, jsonb) from public, anon;
revoke all on function public.register_recovery_key(uuid, jsonb) from public, anon;

grant execute on function public.register_device(uuid, text, jsonb) to authenticated;
grant execute on function public.register_recovery_key(uuid, jsonb) to authenticated;
