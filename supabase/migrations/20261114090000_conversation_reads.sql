-- BARS — conversation read state
-- Unread counts are per user, not per device. The server stores only the
-- highest message sequence the user has acknowledged; message text never
-- participates in this model.

-- ---------------------------------------------------------------------------
-- Read state
-- ---------------------------------------------------------------------------

create table public.conversation_reads (
  conversation_id uuid not null
    references public.conversations (id) on delete cascade,
  user_id uuid not null
    references public.profiles (id) on delete cascade,
  last_read_seq bigint not null default 0
    check (last_read_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

comment on table public.conversation_reads is
  'Per-user high-water mark of read messages. Read positions are private to the user.';

create index conversation_reads_user_idx
  on public.conversation_reads (user_id);

-- Existing conversations should not become unread after the migration: every
-- current member starts at the latest sequence already present.
insert into public.conversation_reads (
  conversation_id,
  user_id,
  last_read_seq
)
select cm.conversation_id,
       cm.user_id,
       coalesce(max(m.seq), 0)
  from public.conversation_members cm
  left join public.messages m
    on m.conversation_id = cm.conversation_id
 group by cm.conversation_id, cm.user_id
on conflict (conversation_id, user_id) do nothing;

-- A member who joins later starts with the current history marked as read.
-- This keeps the closed-circle bootstrap and direct-dialog creation working
-- without every RPC having to remember read state.
create or replace function public.initialize_conversation_read()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.conversation_reads (
    conversation_id,
    user_id,
    last_read_seq
  )
  values (
    new.conversation_id,
    new.user_id,
    coalesce(
      (
        select max(m.seq)
          from public.messages m
         where m.conversation_id = new.conversation_id
      ),
      0
    )
  )
  on conflict (conversation_id, user_id) do nothing;

  return new;
end;
$$;

create trigger conversation_members_initialize_read
  after insert on public.conversation_members
  for each row
  execute function public.initialize_conversation_read();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

alter table public.conversation_reads enable row level security;

create policy "conversation_reads_select_own"
  on public.conversation_reads
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.is_active_user()
  );

revoke all on table public.conversation_reads from public, anon, authenticated;
grant select on table public.conversation_reads to authenticated;

revoke all on function public.initialize_conversation_read()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC: mark a conversation read up to a sequence
-- ---------------------------------------------------------------------------

create or replace function public.mark_conversation_read(
  p_conversation_id uuid,
  p_seq bigint
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_max_seq bigint;
  v_target bigint;
  v_result bigint;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not public.is_active_user() then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if not public.is_conversation_member(p_conversation_id) then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  select coalesce(max(m.seq), 0)
    into v_max_seq
    from public.messages m
   where m.conversation_id = p_conversation_id;

  -- Never let a stale or malicious client mark future messages as read.
  v_target := least(greatest(coalesce(p_seq, 0), 0), v_max_seq);

  insert into public.conversation_reads (
    conversation_id,
    user_id,
    last_read_seq
  )
  values (p_conversation_id, v_user, v_target)
  on conflict (conversation_id, user_id) do nothing;

  update public.conversation_reads
     set last_read_seq = greatest(last_read_seq, v_target),
         updated_at = now()
   where conversation_id = p_conversation_id
     and user_id = v_user
  returning last_read_seq into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: unread counts for the caller
-- ---------------------------------------------------------------------------

create or replace function public.list_unread_counts()
returns table (
  conversation_id uuid,
  unread_count bigint
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
    select m.conversation_id,
           count(*)::bigint as unread_count
      from public.messages m
      join public.conversation_members cm
        on cm.conversation_id = m.conversation_id
       and cm.user_id = v_user
      left join public.conversation_reads r
        on r.conversation_id = m.conversation_id
       and r.user_id = v_user
     where m.sender_id <> v_user
       and m.seq > coalesce(r.last_read_seq, 0)
     group by m.conversation_id;
end;
$$;

revoke all on function public.mark_conversation_read(uuid, bigint)
  from public, anon;
revoke all on function public.list_unread_counts()
  from public, anon;

grant execute on function public.mark_conversation_read(uuid, bigint)
  to authenticated;
grant execute on function public.list_unread_counts()
  to authenticated;
