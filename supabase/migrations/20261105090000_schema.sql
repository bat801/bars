-- BARS — initial schema
-- Security model: clients can only read data through RLS; writes go through
-- security-definer RPCs or are performed by the service role / dashboard.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique
    check (username ~ '^[a-z0-9_]{3,32}$'),
  display_name text not null
    check (char_length(display_name) between 1 and 60),
  avatar_url text,
  role text not null default 'member'
    check (role in ('owner', 'member')),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile. Created by trigger from auth.users; only active profiles may read data.';

-- ---------------------------------------------------------------------------
-- Closed registration
-- ---------------------------------------------------------------------------

create table public.access_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique
    check (email = lower(email)),
  note text,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by uuid references public.profiles (id) on delete set null
);

comment on table public.access_invites is
  'Second line of defence: an account without an unused invite is created with status=pending.';

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'group'
    check (kind in ('group', 'direct')),
  title text not null
    check (char_length(title) between 1 and 80),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx
  on public.conversation_members (user_id);

-- ---------------------------------------------------------------------------
-- Devices (one P-256 key pair per browser/installation)
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 80),
  public_key_jwk jsonb not null,
  algorithm text not null default 'P-256'
    check (algorithm = 'P-256'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index devices_user_idx on public.devices (user_id);

comment on table public.devices is
  'Public device keys. Private keys never leave the browser and are non-extractable.';

-- ---------------------------------------------------------------------------
-- Messages and HPKE key envelopes
-- ---------------------------------------------------------------------------

create table public.messages (
  id uuid primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  sender_device_id uuid not null references public.devices (id) on delete restrict,
  client_message_id uuid not null,
  type text not null default 'text'
    check (type in ('text', 'sticker', 'system')),
  crypto_version smallint not null default 1
    check (crypto_version >= 1),
  ciphertext text not null,
  iv text not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique (sender_id, client_message_id)
);

create index messages_conversation_seq_idx
  on public.messages (conversation_id, seq desc);

create index messages_sender_created_idx
  on public.messages (sender_id, created_at desc);

comment on table public.messages is
  'Ciphertext only. Plaintext and content keys never reach the server.';

create table public.message_keys (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  recipient_kind text not null default 'device'
    check (recipient_kind in ('device', 'recovery')),
  enc text not null,
  wrapped_key text not null,
  created_at timestamptz not null default now(),
  unique (message_id, device_id)
);

create index message_keys_user_message_idx
  on public.message_keys (user_id, message_id);

comment on table public.message_keys is
  'One HPKE envelope per recipient device. The server cannot unwrap content keys.';

-- ---------------------------------------------------------------------------
-- Encrypted recovery kit (reserved for M1.5, schema is ready from day one)
-- ---------------------------------------------------------------------------

create table public.key_backups (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  version smallint not null default 1,
  kdf text not null default 'PBKDF2-SHA256',
  kdf_iterations integer not null default 600000
    check (kdf_iterations between 100000 and 5000000),
  salt text not null,
  iv text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Default group conversation
-- ---------------------------------------------------------------------------

insert into public.conversations (id, kind, title, created_by)
values ('00000000-0000-4000-8000-000000000001', 'group', 'Общий чат', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Auto-create profile on auth signup
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(coalesce(new.email, ''));
  v_invite public.access_invites%rowtype;
  v_base text;
  v_username text;
  v_display text;
  v_role text := 'member';
  v_status text := 'pending';
  v_first boolean := false;
begin
  select *
    into v_invite
    from public.access_invites
   where email = v_email
     and used_at is null
   limit 1;

  if v_invite.id is not null then
    v_status := 'active';
  end if;

  select not exists (select 1 from public.profiles) into v_first;
  if v_first then
    v_role := 'owner';
  end if;

  v_display := nullif(trim(split_part(v_email, '@', 1)), '');
  if v_display is null then
    v_display := 'Новый участник';
  end if;
  v_display := left(v_display, 60);

  v_base := regexp_replace(lower(split_part(v_email, '@', 1)), '[^a-z0-9_]+', '_', 'g');
  v_base := trim(both '_' from v_base);
  if char_length(v_base) < 3 then
    v_base := 'bars';
  end if;
  v_base := left(v_base, 20);

  v_username := v_base || '_' || substr(replace(new.id::text, '-', ''), 1, 4);

  while exists (select 1 from public.profiles where username = v_username) loop
    v_username := v_base || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  end loop;

  insert into public.profiles (id, username, display_name, role, status)
  values (new.id, v_username, v_display, v_role, v_status);

  if v_invite.id is not null then
    update public.access_invites
       set used_at = now(),
           used_by = new.id
     where id = v_invite.id;

    insert into public.conversation_members (conversation_id, user_id)
    values ('00000000-0000-4000-8000-000000000001', new.id)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
