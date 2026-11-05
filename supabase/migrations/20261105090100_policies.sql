-- BARS — RLS, helper functions and grants
-- Principle: authenticated users may only SELECT what they are allowed to see.
-- All mutations go through the RPC layer in the next migration.

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

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
     where p.id = (select auth.uid())
       and p.status = 'active'
  );
$$;

create or replace function public.shares_conversation(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_user()
     and exists (
       select 1
         from public.conversation_members mine
         join public.conversation_members theirs
           on theirs.conversation_id = mine.conversation_id
        where mine.user_id = (select auth.uid())
          and theirs.user_id = p_user_id
     );
$$;

create or replace function public.is_conversation_member(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_user()
     and exists (
       select 1
         from public.conversation_members m
        where m.conversation_id = p_conversation_id
          and m.user_id = (select auth.uid())
     );
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.access_invites enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.devices enable row level security;
alter table public.messages enable row level security;
alter table public.message_keys enable row level security;
alter table public.key_backups enable row level security;

-- profiles ---------------------------------------------------------------

create policy "profiles_select_self_or_peers"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or (public.is_active_user() and public.shares_conversation(id))
  );

-- access_invites: no client policies at all. Invites are managed through the
-- dashboard / service role only.

-- conversations ----------------------------------------------------------

create policy "conversations_select_members"
  on public.conversations
  for select
  to authenticated
  using (public.is_conversation_member(id));

-- conversation_members ---------------------------------------------------

create policy "conversation_members_select_members"
  on public.conversation_members
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_conversation_member(conversation_id)
  );

-- devices ----------------------------------------------------------------

create policy "devices_select_self_or_peers"
  on public.devices
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (public.is_active_user() and public.shares_conversation(user_id))
  );

-- messages ---------------------------------------------------------------

create policy "messages_select_members"
  on public.messages
  for select
  to authenticated
  using (public.is_conversation_member(conversation_id));

-- message_keys -----------------------------------------------------------

create policy "message_keys_select_own"
  on public.message_keys
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.is_active_user()
  );

-- key_backups ------------------------------------------------------------

create policy "key_backups_select_own"
  on public.key_backups
  for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user());

create policy "key_backups_insert_own"
  on public.key_backups
  for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "key_backups_update_own"
  on public.key_backups
  for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user())
  with check (user_id = (select auth.uid()) and public.is_active_user());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.access_invites from anon, authenticated;
revoke all on table public.conversations from anon, authenticated;
revoke all on table public.conversation_members from anon, authenticated;
revoke all on table public.devices from anon, authenticated;
revoke all on table public.messages from anon, authenticated;
revoke all on table public.message_keys from anon, authenticated;
revoke all on table public.key_backups from anon, authenticated;

grant usage on schema public to anon, authenticated;

grant select on table public.profiles to authenticated;
grant select on table public.conversations to authenticated;
grant select on table public.conversation_members to authenticated;
grant select on table public.devices to authenticated;
grant select on table public.messages to authenticated;
grant select on table public.message_keys to authenticated;
grant select, insert, update on table public.key_backups to authenticated;

revoke all on function public.is_active_user() from public, anon;
revoke all on function public.shares_conversation(uuid) from public, anon;
revoke all on function public.is_conversation_member(uuid) from public, anon;

grant execute on function public.is_active_user() to authenticated;
grant execute on function public.shares_conversation(uuid) to authenticated;
grant execute on function public.is_conversation_member(uuid) to authenticated;
