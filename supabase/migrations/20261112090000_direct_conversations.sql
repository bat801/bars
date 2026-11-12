-- BARS — personal 1:1 conversations
-- A direct conversation is uniquely identified by an order-independent key
-- derived from its two member ids. Creation is idempotent and only allowed
-- between active users who already share a conversation.

-- ---------------------------------------------------------------------------
-- Direct key
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists direct_key text;

comment on column public.conversations.direct_key is
  'Order-independent "smaller-uuid:larger-uuid" key for direct conversations.';

-- Backfill any pre-existing direct rows so the shape constraint can be added.
-- A direct conversation must have exactly two members to have a stable key.
do $$
declare
  v_conversation record;
begin
  for v_conversation in
    select c.id,
           count(cm.user_id)::integer as member_count,
           min(cm.user_id::text) as first_id,
           max(cm.user_id::text) as second_id
      from public.conversations c
      join public.conversation_members cm
        on cm.conversation_id = c.id
     where c.kind = 'direct'
       and c.direct_key is null
     group by c.id
  loop
    if v_conversation.member_count <> 2 then
      raise exception
        'direct conversation % has % members; expected exactly 2',
        v_conversation.id,
        v_conversation.member_count;
    end if;

    update public.conversations
       set direct_key =
         least(v_conversation.first_id, v_conversation.second_id)
         || ':'
         || greatest(v_conversation.first_id, v_conversation.second_id)
     where id = v_conversation.id;
  end loop;
end;
$$;

alter table public.conversations
  add constraint conversations_direct_key_shape
  check (
    (kind = 'direct' and direct_key is not null)
    or (kind = 'group' and direct_key is null)
  );

-- A plain unique index still allows any number of NULLs for group dialogs.
create unique index conversations_direct_key_uidx
  on public.conversations (direct_key);

-- ---------------------------------------------------------------------------
-- Contacts: active users who share at least one conversation with the caller
-- ---------------------------------------------------------------------------

create or replace function public.list_contacts()
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  direct_conversation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  return query
    select p.id,
           p.username,
           p.display_name,
           p.avatar_url,
           (
             select c.id
               from public.conversations c
              where c.kind = 'direct'
                and c.direct_key =
                  least(v_user::text, p.id::text)
                  || ':'
                  || greatest(v_user::text, p.id::text)
              limit 1
           ) as direct_conversation_id
      from public.profiles p
     where p.status = 'active'
       and p.id <> v_user
       and exists (
         select 1
           from public.conversation_members mine
           join public.conversation_members theirs
             on theirs.conversation_id = mine.conversation_id
          where mine.user_id = v_user
            and theirs.user_id = p.id
       )
     order by lower(p.display_name), lower(p.username);
end;
$$;

-- ---------------------------------------------------------------------------
-- Create (or return) the direct conversation for the caller and a peer
-- ---------------------------------------------------------------------------

create or replace function public.create_direct_conversation(p_peer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_key text;
  v_conversation_id uuid;
  v_peer public.profiles%rowtype;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if p_peer_id is null or p_peer_id = v_user then
    raise exception 'invalid_direct_peer';
  end if;

  select *
    into v_peer
    from public.profiles p
   where p.id = p_peer_id
     and p.status = 'active';

  if v_peer.id is null then
    raise exception 'contact_not_found' using errcode = '42501';
  end if;

  -- Keep the closed circle closed: a direct dialog can only be started with
  -- someone the caller already knows through an existing conversation.
  if not exists (
    select 1
      from public.conversation_members mine
      join public.conversation_members theirs
        on theirs.conversation_id = mine.conversation_id
     where mine.user_id = v_user
       and theirs.user_id = p_peer_id
  ) then
    raise exception 'contact_not_found' using errcode = '42501';
  end if;

  v_key :=
    least(v_user::text, p_peer_id::text)
    || ':'
    || greatest(v_user::text, p_peer_id::text);

  insert into public.conversations (kind, title, direct_key, created_by)
  values ('direct', 'Личный диалог', v_key, v_user)
  on conflict (direct_key) do nothing
  returning id into v_conversation_id;

  if v_conversation_id is null then
    select c.id
      into v_conversation_id
      from public.conversations c
     where c.direct_key = v_key;
  end if;

  if v_conversation_id is null then
    raise exception 'direct_conversation_conflict';
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conversation_id, v_user),
         (v_conversation_id, p_peer_id)
  on conflict do nothing;

  return v_conversation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.list_contacts() from public, anon;
revoke all on function public.create_direct_conversation(uuid) from public, anon;

grant execute on function public.list_contacts() to authenticated;
grant execute on function public.create_direct_conversation(uuid) to authenticated;
