-- BARS — enable Realtime for messages
-- Postgres Changes honours RLS: a client only receives rows from conversations
-- it is allowed to SELECT. The publication may already contain the table on a
-- project created from the dashboard, so the guard keeps this idempotent.

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;
