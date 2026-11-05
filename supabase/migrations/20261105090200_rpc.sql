-- BARS — atomic RPC layer
-- All client writes go through these security-definer functions.

-- ---------------------------------------------------------------------------
-- Register / refresh a device public key
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
  v_name text := trim(coalesce(p_name, ''));
  v_count integer := 0;
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

  if not exists (
    select 1 from public.devices
     where id = p_device_id and user_id = v_user
  ) then
    select count(*) into v_count
      from public.devices
     where user_id = v_user and status = 'active';

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

  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke a device (it stops receiving new key envelopes immediately)
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

  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Update own profile
-- ---------------------------------------------------------------------------

create or replace function public.update_profile(p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_name text := trim(coalesce(p_display_name, ''));
  v_profile public.profiles%rowtype;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 60 then
    raise exception 'invalid_display_name';
  end if;

  update public.profiles
     set display_name = v_name,
         updated_at = now()
   where id = v_user
     and status = 'active'
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- Default group membership (self-healing)
-- ---------------------------------------------------------------------------

create or replace function public.ensure_default_conversation()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_conversation_id uuid := '00000000-0000-4000-8000-000000000001';
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  insert into public.conversations (id, kind, title)
  values (v_conversation_id, 'group', 'Общий чат')
  on conflict (id) do nothing;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conversation_id, v_user)
  on conflict do nothing;

  return v_conversation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Devices of every member of a conversation (including revoked ones, so old
-- history can still verify sender keys). Only public keys are returned.
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
     order by d.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Send message + envelopes atomically
-- ---------------------------------------------------------------------------

create or replace function public.send_message(
  p_conversation_id uuid,
  p_message_id uuid,
  p_client_message_id uuid,
  p_device_id uuid,
  p_type text,
  p_crypto_version smallint,
  p_ciphertext text,
  p_iv text,
  p_keys jsonb
)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_message public.messages%rowtype;
  v_recent integer := 0;
  v_keys_count integer := 0;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if p_conversation_id is null
     or p_message_id is null
     or p_client_message_id is null
     or p_device_id is null then
    raise exception 'invalid_message';
  end if;

  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'conversation_not_found' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.devices d
     where d.id = p_device_id
       and d.user_id = v_user
       and d.status = 'active'
  ) then
    raise exception 'invalid_sender_device' using errcode = '42501';
  end if;

  if p_type is null or p_type not in ('text') then
    raise exception 'invalid_message_type';
  end if;

  if p_crypto_version is null or p_crypto_version <> 1 then
    raise exception 'unsupported_crypto_version';
  end if;

  if p_ciphertext is null
     or p_iv is null
     or char_length(p_ciphertext) = 0
     or char_length(p_iv) = 0 then
    raise exception 'empty_message';
  end if;

  if octet_length(p_ciphertext) > 100000 or octet_length(p_iv) > 64 then
    raise exception 'message_too_large';
  end if;

  if p_keys is null
     or jsonb_typeof(p_keys) <> 'array'
     or jsonb_array_length(p_keys) = 0
     or jsonb_array_length(p_keys) > 128 then
    raise exception 'invalid_keys';
  end if;

  select count(*) into v_recent
    from public.messages
   where sender_id = v_user
     and created_at > now() - interval '10 seconds';

  if v_recent >= 20 then
    raise exception 'rate_limited';
  end if;

  -- Idempotency: a retried request must return the original message.
  insert into public.messages (
    id, conversation_id, sender_id, sender_device_id, client_message_id,
    type, crypto_version, ciphertext, iv
  )
  values (
    p_message_id, p_conversation_id, v_user, p_device_id, p_client_message_id,
    p_type, p_crypto_version, p_ciphertext, p_iv
  )
  on conflict do nothing
  returning * into v_message;

  if v_message.id is null then
    select * into v_message
      from public.messages m
     where m.sender_id = v_user
       and m.client_message_id = p_client_message_id
     limit 1;

    if v_message.id is null then
      select * into v_message
        from public.messages m
       where m.id = p_message_id
         and m.sender_id = v_user
       limit 1;
    end if;

    if v_message.id is null then
      raise exception 'message_conflict';
    end if;

    return v_message;
  end if;

  insert into public.message_keys (
    message_id, user_id, device_id, recipient_kind, enc, wrapped_key
  )
  select v_message.id,
         d.user_id,
         d.id,
         'device',
         k.enc,
         k.wrapped_key
    from jsonb_to_recordset(p_keys)
           as k(device_id uuid, enc text, wrapped_key text)
    join public.devices d
      on d.id = k.device_id
     and d.status = 'active'
    join public.conversation_members cm
      on cm.user_id = d.user_id
     and cm.conversation_id = p_conversation_id
    join public.profiles p
      on p.id = d.user_id
     and p.status = 'active'
   where k.enc is not null
     and k.wrapped_key is not null
     and char_length(k.enc) between 1 and 500
     and char_length(k.wrapped_key) between 1 and 500
  on conflict (message_id, device_id) do nothing;

  get diagnostics v_keys_count = row_count;

  if v_keys_count = 0 then
    raise exception 'invalid_keys';
  end if;

  update public.conversations
     set last_message_at = now()
   where id = p_conversation_id;

  return v_message;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.register_device(uuid, text, jsonb) from public, anon;
revoke all on function public.revoke_device(uuid) from public, anon;
revoke all on function public.update_profile(text) from public, anon;
revoke all on function public.ensure_default_conversation() from public, anon;
revoke all on function public.get_conversation_devices(uuid) from public, anon;
revoke all on function public.send_message(uuid, uuid, uuid, uuid, text, smallint, text, text, jsonb) from public, anon;

grant execute on function public.register_device(uuid, text, jsonb) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.update_profile(text) to authenticated;
grant execute on function public.ensure_default_conversation() to authenticated;
grant execute on function public.get_conversation_devices(uuid) to authenticated;
grant execute on function public.send_message(uuid, uuid, uuid, uuid, text, smallint, text, text, jsonb) to authenticated;
