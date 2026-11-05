-- BARS — bootstrap profiles for accounts that existed before the schema
-- The auth.users -> profiles trigger only applies to future signups. This
-- migration keeps the first existing account usable as owner and leaves any
-- other pre-existing accounts pending until an administrator activates them.
-- It is intentionally idempotent and a no-op on a fresh project.

do $$
declare
  v_user record;
  v_invite public.access_invites%rowtype;
  v_default constant uuid := '00000000-0000-4000-8000-000000000001';
  v_has_profile boolean;
  v_first boolean;
  v_base text;
  v_username text;
  v_display text;
  v_role text;
  v_status text;
begin
  for v_user in
    select u.id, u.email
      from auth.users u
     order by u.created_at, u.id
  loop
    select exists (
      select 1 from public.profiles p where p.id = v_user.id
    ) into v_has_profile;

    if v_has_profile then
      continue;
    end if;

    select *
      into v_invite
      from public.access_invites
     where email = lower(coalesce(v_user.email, ''))
       and used_at is null
     limit 1;

    select not exists (select 1 from public.profiles) into v_first;

    v_role := case when v_first then 'owner' else 'member' end;
    v_status := case
      when v_first or v_invite.id is not null then 'active'
      else 'pending'
    end;

    v_display := nullif(trim(split_part(v_user.email, '@', 1)), '');
    if v_display is null then
      v_display := 'Новый участник';
    end if;
    v_display := left(v_display, 60);

    v_base := regexp_replace(
      lower(split_part(coalesce(v_user.email, ''), '@', 1)),
      '[^a-z0-9_]+',
      '_',
      'g'
    );
    v_base := trim(both '_' from v_base);
    if char_length(v_base) < 3 then
      v_base := 'bars';
    end if;
    v_base := left(v_base, 20);

    v_username := v_base || '_' || substr(replace(v_user.id::text, '-', ''), 1, 4);

    while exists (select 1 from public.profiles where username = v_username) loop
      v_username := v_base || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    end loop;

    insert into public.profiles (
      id, username, display_name, role, status, created_at, updated_at
    )
    values (
      v_user.id, v_username, v_display, v_role, v_status, now(), now()
    );

    if v_invite.id is not null then
      update public.access_invites
         set used_at = now(),
             used_by = v_user.id
       where id = v_invite.id;
    end if;

    if v_status = 'active' then
      insert into public.conversation_members (conversation_id, user_id)
      values (v_default, v_user.id)
      on conflict do nothing;
    end if;
  end loop;
end
$$;
