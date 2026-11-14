# Эксплуатация BARS

Практическое руководство для владельца проекта: развёртывание, выдача доступов, обслуживание и действия при инцидентах. Технические детали — в [ARCHITECTURE.md](ARCHITECTURE.md), модель угроз — в [SECURITY.md](SECURITY.md).

## 1. Что чем управляется

| Компонент | Где живёт | Кто меняет |
| --- | --- | --- |
| Клиент | GitHub Pages, статические файлы | push в `main` |
| Auth, Postgres, Realtime | Supabase project | миграции и Dashboard |
| Публичные ключи устройств | `public.devices` | клиент через RPC |
| Приватные ключи | IndexedDB на устройстве | только браузер |
| Приглашения | `public.access_invites` | владелец через SQL Editor |
| Секреты Supabase | вне репозитория | владелец |

Публикуемый (publishable/anon) ключ находится в клиенте и не является секретом. Секреты: **service-role key**, **пароль базы**, **access token Supabase CLI**, **пароли пользователей**. Они не должны попадать в git, `.env.local`, скриншоты и чаты.

## 2. Первичное развёртывание

### 2.1. Supabase

1. Создайте проект или используйте существующий.
2. Примените миграции строго по порядку:

   ```text
   20261105090000_schema.sql
   20261105090100_policies.sql
   20261105090200_rpc.sql
   20261105090300_realtime.sql
   20261105090400_bootstrap.sql
   20261106090000_device_sessions.sql
   20261106091000_recovery_keys.sql
   20261107090000_device_approval.sql
   20261112090000_direct_conversations.sql
   20261114090000_conversation_reads.sql
   ```

   CLI (`supabase/config.toml` уже в репозитории, `supabase init` не нужен):

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

   Для `db push` понадобится пароль базы. Настройки в `config.toml` действуют только на локальный стек: `enable_signup = false` там не выключает регистрацию в hosted-проекте, это делается в Dashboard (шаг 4).

   Либо Dashboard → SQL Editor: каждый файл целиком, по одному. После успешного выполнения добавьте запись в историю, иначе `npx supabase db push` попытается применить файл повторно:

   ```sql
   insert into supabase_migrations.schema_migrations (version, name)
   values ('20261112090000', 'direct_conversations')
   on conflict (version) do nothing;
   ```

   Для каждой миграции используйте её timestamp и имя без `.sql`.

3. Проверьте схему:

   ```sql
   select count(*) as profiles from public.profiles;
   select id, title from public.conversations;
   select tablename
     from pg_publication_tables
    where pubname = 'supabase_realtime';
   select tablename, rowsecurity
     from pg_tables
    where schemaname = 'public'
    order by tablename;
   select session_id, device_id, revoked_at
     from public.device_sessions
    order by created_at desc
    limit 5;
   select id, user_id, kind, status, approved_at
     from public.devices
    where kind = 'recovery';
   select user_id, version, kdf, kdf_iterations, updated_at
     from public.key_backups;
   select id, username, device_reset_until
     from public.profiles
    where device_reset_until is not null;
   select kind, count(*) from public.conversations group by kind;
   select id, kind, direct_key from public.conversations where kind = 'direct';
   select count(*) as read_rows from public.conversation_reads;
   ```

   Ожидается: общий чат `00000000-0000-4000-8000-000000000001`, `messages` в публикации, `rowsecurity = true` у всех таблиц, `device_sessions` заполняется после первого входа обновлённого клиента, а recovery-строки и `key_backups` появляются после создания kit в настройках. `device_reset_until` должен быть `null`, кроме момента ручного reset. Личные диалоги появляются после первого создания в интерфейсе; у каждого `kind = 'direct'` непустой `direct_key` и ровно два участника. После миграции прочтения `conversation_reads` содержит по строке на каждого существующего участника каждого диалога.

4. Authentication → Providers → Email: включён. **Allow new users to sign up** — выключен. Email confirmation можно оставить включённым; при ручном создании пользователей включайте **Auto Confirm User**.

5. Authentication → URL Configuration: BARS не использует magic link и OAuth, поэтому redirect URLs не обязательны. Site URL можно указать как `https://<username>.github.io/bars/`.

После миграции `device_sessions` уже существующие сессии M1 не имеют привязки. Это нормально: при следующей загрузке обновлённый клиент вызовет `register_device` и привяжет сессию к локальному устройству. Если клиент старый и не умеет привязку, RLS перестанет отдавать ему сообщения — сначала обновите клиент, затем применяйте миграцию.

Миграция `recovery_keys` добавляет `devices.kind` (существующие строки становятся `device`) и RPC `register_recovery_key`. Recovery-ключ создаётся пользователем в настройках; до этого он не существует. Старые сообщения не получают recovery-конверт задним числом — восстановить можно только переписку после создания kit.

Миграция `device_approval` добавляет статус `pending`, поля `approved_at`/`approved_by_device_id`, RPC `approve_device`/`cancel_device_request` и `profiles.device_reset_until`. После неё первое устройство аккаунта остаётся активным, а каждое новое требует одобрения с уже активного устройства. Существующие активные и отозванные устройства не меняют статус.

Миграция `direct_conversations` добавляет `conversations.direct_key`, уникальный индекс и RPC `list_contacts`/`create_direct_conversation`. Она не меняет существующий общий чат. Личный диалог можно создать только с активным участником, с которым уже есть общий разговор; повторное создание возвращает тот же диалог.

Миграция `conversation_reads` добавляет приватную таблицу позиций прочтения, backfill для существующих участников и триггер `initialize_conversation_read()` для новых. Она также создаёт RPC `mark_conversation_read` и `list_unread_counts`. Backfill помечает существующую историю прочитанной, поэтому после обновления старые сообщения не превращаются в стену бейджей. Миграция не меняет `messages`, `message_keys` и криптографию.

### 2.2. Первый владелец

Если в проекте уже были пользователи до миграций, `20261105090400_bootstrap.sql` создаст им профили. Самый первый по `created_at` станет `owner` и активным участником общего чата; остальные останутся `pending`.

Если пользователей не было, создайте первого:

1. SQL Editor:

   ```sql
   insert into public.access_invites (email, note)
   values ('owner@example.com', 'Владелец')
   on conflict (email) do update
     set note = excluded.note, used_at = null, used_by = null;
   ```

2. Authentication → Users → **Add user**: email, пароль, **Auto Confirm User**.
3. Триггер создаст профиль, активирует его и добавит в общий чат.

Проверка:

```sql
select p.id, p.username, p.role, p.status, u.email
  from public.profiles p
  join auth.users u on u.id = p.id;
```

### 2.3. GitHub Pages

1. Settings → Pages → Source: **GitHub Actions**.
2. Push в `main` (или Actions → Deploy to GitHub Pages → Run workflow).
3. Дождитесь зелёного workflow и откройте `https://<username>.github.io/bars/`.

Workflow `.github/workflows/deploy.yml` выполняет `npm ci`, `npm test`, `npm run lint`, `npm run build` и публикует `dist`. Если тест или линт падает, деплой не происходит.

## 3. Добавление и удаление участников

### Добавить друга

1. Создайте приглашение:

   ```sql
   insert into public.access_invites (email, note)
   values ('friend@example.com', 'Для Саши')
   on conflict (email) do update
     set note = excluded.note, used_at = null, used_by = null;
   ```

2. Authentication → Users → **Add user**, тот же email, временный пароль, **Auto Confirm User**.
3. Передайте email и пароль лично. Попросите сменить пароль в настройках BARS.
4. При первом входе устройство само зарегистрирует публичный ключ и получит конверты для новых сообщений. Старые сообщения, отправленные до регистрации устройства, ему недоступны — это ожидаемо.

### Активировать зависший аккаунт

```sql
update public.profiles
   set status = 'active', updated_at = now()
 where id = (select id from auth.users where email = 'friend@example.com');

insert into public.conversation_members (conversation_id, user_id)
select '00000000-0000-4000-8000-000000000001', id
  from public.profiles
 where id = (select id from auth.users where email = 'friend@example.com')
on conflict do nothing;
```

### Заблокировать участника

```sql
update public.profiles
   set status = 'blocked', updated_at = now()
 where id = (select id from auth.users where email = 'friend@example.com');
```

Заблокированный профиль не проходит `is_active_user()`, поэтому не может читать данные и вызывать RPC. Его устройства также исключаются из новых ключевых конвертов: после блокировки он не получит доступ к сообщениям, отправленным во время блокировки, даже если позже блокировку снимут. Сессия Supabase при этом не обязательно завершается — см. раздел 6.

### Исключить участника из чата

В 0.4.0 есть общий чат и личные диалоги, а `ensure_default_conversation()` самовосстанавливает членство активного пользователя в общем чате при входе. Поэтому удаление строки из `conversation_members` не является надёжным способом закрыть доступ: при следующем входе пользователь вернётся в общий чат.

Надёжный способ — заблокировать профиль (`status = 'blocked'`). Это останавливает чтение, RPC и выдачу новых конвертов, включая личные диалоги. Если нужно полностью убрать человека из круга, заблокируйте его, завершите сессии и отзовите устройства. Удаление из чата без блокировки появится вместе с управлением участниками в следующих версиях.

> **Не удаляйте пользователя из `auth.users` без необходимости.** Из-за `on delete cascade` вместе с профилем удалятся его устройства, конверты ключей и **все отправленные им сообщения** — они исчезнут из истории у всех. Для отключения доступа используйте `blocked`.

## 4. Устройства

- Каждое устройство — отдельная пара P-256 и строка в `public.devices`.
- Лимит активных устройств — 20 на пользователя, одновременных pending-запросов — 3.
- Каждая сессия Supabase привязана к одному устройству через `public.device_sessions`.
- Первое устройство аккаунта создаётся `active`; каждое следующее — `pending`. Pending-устройство привязано к сессии, но не читает сообщения, не получает конверты и не может отправлять.
- Новое устройство одобряется в настройках активного устройства: «Запросы на подключение» → «Одобрить». Перед этим сверьте код-отпечаток на новом устройстве и в запросе. «Отклонить» отзывает pending-строку.
- Pending-устройство может само отменить запрос кнопкой «Отменить запрос» на экране ожидания.
- Отзыв через интерфейс: настройки → «Устройства» → «Отозвать». После отзыва устройство не получает новые конверты, все его сессии помечаются `revoked_at`, а при следующей загрузке оно показывает «Устройство отозвано».
- Повторная очистка данных сайта или приватного окна создаёт новое устройство. Старое остаётся активным, пока его не отзовут; следите за списком.
- Отозванные устройства скрыты в сворачиваемом блоке «Отозванные (N)». Они остаются в таблице для проверки старых ключей отправителей и не могут обновить ключ через RPC. Не удаляйте строки отозванных устройств: на них ссылаются старые сообщения.

Посмотреть устройства и привязки:

```sql
select d.id, d.name, d.status, d.created_at, d.last_seen_at, u.email,
       count(s.session_id) filter (where s.revoked_at is null) as active_sessions
  from public.devices d
  join auth.users u on u.id = d.user_id
  left join public.device_sessions s on s.device_id = d.id
 group by d.id, u.email
 order by u.email, d.created_at;
```

Отозвать все устройства пользователя (например, при компрометации). Прямой SQL по `devices` не вызывает RPC, поэтому сессии нужно отозвать отдельно:

```sql
with target_devices as (
  select d.id
    from public.devices d
    join auth.users u on u.id = d.user_id
   where u.email = 'friend@example.com'
     and d.status in ('active', 'pending')
)
update public.device_sessions s
   set revoked_at = now()
  from target_devices t
 where s.device_id = t.id
   and s.revoked_at is null;

update public.devices d
   set status = 'revoked',
       revoked_at = now()
  from auth.users u
 where u.id = d.user_id
   and u.email = 'friend@example.com'
   and d.status in ('active', 'pending');
```

После этого пользователь входит на новом устройстве. Если у него осталось хотя бы одно активное устройство, новый запрос нужно одобрить в настройках. Если активных устройств не осталось, используйте процедуру из раздела 4.2.

### 4.1. Подтвердить новое устройство

1. Пользователь входит на новом устройстве и видит экран «Ожидает подтверждения» с кодом вида `ABCD-EFGH-IJKL`, QR-кодом и ссылкой.
2. На активном устройстве откройте ссылку `#/approve/<deviceId>` (на телефоне QR можно отсканировать штатной камерой) либо зайдите в настройки → «Запросы на подключение».
3. Сверьте имя и код. Код должен совпадать с кодом на новом устройстве.
4. Поставьте отметку «Код на новом устройстве совпадает» и нажмите «Одобрить». Новое устройство автоматически перейдёт в чат в течение нескольких секунд.
5. Если запрос создан по ошибке или код не совпадает — «Отклонить».

Ссылка и QR содержат только `deviceId` и не являются секретом. Они не дают права на одобрение: модалка на активном устройстве перечитывает запрос и всё равно требует активную сессию, совпадение кода и явное подтверждение. Не одобряйте запрос, если код отличается: это может быть попытка подключить чужое устройство по украденному паролю.

### 4.2. Все устройства потеряны (ручной reset)

Если у пользователя не осталось активных устройств, одобрять новый запрос некому. Владелец открывает короткое окно через SQL Editor:

```sql
-- 1. Отозвать все сессии и устройства пользователя.
update public.device_sessions
   set revoked_at = now()
 where user_id = (select id from auth.users where email = 'friend@example.com')
   and revoked_at is null;

update public.devices
   set status = 'revoked', revoked_at = now()
 where user_id = (select id from auth.users where email = 'friend@example.com')
   and status in ('active', 'pending');

-- 2. Открыть окно на 15 минут.
update public.profiles
   set device_reset_until = now() + interval '15 minutes'
 where id = (select id from auth.users where email = 'friend@example.com');
```

После этого пользователь входит заново на новом устройстве (или на старом после очистки данных сайта): его следующее новое устройство станет `active`, а `device_reset_until` очистится. Все последующие устройства снова требуют одобрения. Окно одноразовое: если не успеть, повторите шаг 2.

Если на старом браузере показан экран «Устройство отозвано», кнопка «Начать заново на этом браузере» удаляет локальный ключ и сессию и сразу возвращает на вход. Следующий вход создаст новый pending-запрос; вручную чистить данные сайта не нужно.

Recovery kit не участвует в одобрении устройства. Он позволяет читать сообщения после создания kit, но не даёт права подключить новое устройство без активного устройства или ручного reset.

### 4.3. Личные диалоги

Личный диалог создаётся из интерфейса кнопкой «Новый диалог» и только с активным участником, с которым уже есть общий разговор. Сервер хранит `conversations.kind = 'direct'` и `direct_key`; повторное создание возвращает существующий диалог.

Посмотреть личные диалоги и участников:

```sql
select c.id, c.direct_key, c.created_at,
       array_agg(p.username order by p.username) as members
  from public.conversations c
  join public.conversation_members cm on cm.conversation_id = c.id
  join public.profiles p on p.id = cm.user_id
 where c.kind = 'direct'
 group by c.id
 order by c.created_at;
```

Не удаляйте `conversations` и `conversation_members` вручную: на них ссылаются сообщения и конверты. Если у личного диалога пропала строка участника, повторный вызов `create_direct_conversation(peer_id)` из клиента вернёт диалог и восстановит обе строки `conversation_members`. Заблокированный профиль не читает личный диалог, даже если остался его участником.

### 4.4. Непрочитанные и уведомления

Позиция прочтения хранится в `public.conversation_reads` отдельно для каждого пользователя и диалога. Собеседники её не видят: RLS отдаёт только собственную строку. Клиент обновляет позицию через `mark_conversation_read` при открытии диалога, загрузке истории, отправке сообщения и событиях внимания. Счётчики считает `list_unread_counts`; собственные сообщения не учитываются.

Посмотреть состояние прочтения:

```sql
select c.kind, c.title, p.username,
       r.last_read_seq, r.updated_at,
       (select max(m.seq) from public.messages m
         where m.conversation_id = c.id) as latest_seq
  from public.conversation_reads r
  join public.conversations c on c.id = r.conversation_id
  join public.profiles p on p.id = r.user_id
 order by c.kind, p.username;
```

Если у участника нет строки `conversation_reads` (например, после ручного вмешательства), её создаст триггер при следующем добавлении в диалог. Для уже существующего участника можно создать строку вручную; `last_read_seq = 0` означает «всё непрочитано»:

```sql
insert into public.conversation_reads (conversation_id, user_id, last_read_seq)
select cm.conversation_id, cm.user_id, 0
  from public.conversation_members cm
 where not exists (
   select 1 from public.conversation_reads r
    where r.conversation_id = cm.conversation_id
      and r.user_id = cm.user_id
 );
```

Настройка браузерных уведомлений хранится только в `localStorage` устройства (`bars:notifications:<userId>`), на сервере её нет. Пользователь включает уведомления в настройках BARS и выдаёт разрешение браузеру. Уведомления работают только пока вкладка открыта: service worker и push в 0.4.0 отсутствуют. Уведомление не содержит текст сообщения — только отправителя/диалог и «Новое сообщение».

Чтобы проверить счётчики и уведомления:

1. Откройте BARS в двух вкладках под разными пользователями (или на двух устройствах).
2. Оставьте вкладку получателя в фоне и отправьте сообщение.
3. У получателя должен появиться бейдж, счётчик в заголовке вкладки и toast/уведомление без текста.
4. Откройте диалог: бейдж и счётчик исчезают, `last_read_seq` в `conversation_reads` растёт.
5. Перезагрузите страницу: непрочитанных нет, история на месте.

Если браузер не поддерживает уведомления из контекста страницы (например, iOS Safari), остаются бейджи, заголовок и toast — это ожидаемое поведение.

## 5. Повседневные проверки

Раз в неделю или перед важными изменениями:

```sql
-- активные пользователи и устройства
select p.username, p.status,
       count(d.id) filter (where d.status = 'active') as active_devices,
       count(d.id) filter (where d.status = 'pending') as pending_devices
  from public.profiles p
  left join public.devices d on d.user_id = p.id and d.kind = 'device'
 group by p.id, p.username, p.status
 order by p.username;

-- pending-запросы, которые ждут одобрения
select u.email, d.name, d.created_at
  from public.devices d
  join auth.users u on u.id = d.user_id
 where d.status = 'pending'
 order by d.created_at;

-- сессии: сколько активных привязок у каждого устройства
select d.name, u.email, count(*) filter (where s.revoked_at is null) as active_sessions
  from public.device_sessions s
  join public.devices d on d.id = s.device_id
  join auth.users u on u.id = s.user_id
 group by d.id, d.name, u.email
 order by u.email, d.name;

-- неиспользованные приглашения
select email, note, created_at
  from public.access_invites
 where used_at is null
 order by created_at;

-- последние сообщения (только метаданные)
select conversation_id, sender_id, type, seq, created_at
  from public.messages
 order by seq desc
 limit 20;

-- публикация Realtime
select * from pg_publication_tables
 where pubname = 'supabase_realtime' and tablename = 'messages';
```

Также проверяйте:

- Dashboard → Database → Backups: включены ли бэкапы и когда последний.
- Dashboard → Reports / Logs: ошибки Auth, Postgres, Realtime, Edge.
- GitHub Actions: последний деплой успешен.
- Список устройств: нет ли незнакомых.

## 6. Инциденты

### Потерян или украден телефон/ноутбук

1. Отзовите конкретное устройство через настройки BARS с другого устройства. UI вызывает `revoke_device`, который сам помечает все сессии устройства отозванными. Если действуете через SQL, сделайте оба шага:

   ```sql
   update public.device_sessions
      set revoked_at = now()
    where device_id = '<device-uuid>'
      and revoked_at is null;

   update public.devices
      set status = 'revoked', revoked_at = now()
    where id = '<device-uuid>';
   ```

2. Завершите сессии Supabase этого пользователя, если подозреваете кражу пароля или других устройств: Dashboard → Authentication → Users → пользователь → завершить сессии. Если кнопки нет, удалите сессии через SQL Editor:

   ```sql
   delete from auth.sessions
    where user_id = (select id from auth.users where email = 'friend@example.com');
   ```

   Отозванная привязка в `device_sessions` блокирует access token немедленно, не дожидаясь истечения. Session deletion дополнительно не даёт выпустить новый токен.

3. Смените пароль пользователя и передайте новый лично.
4. Проверьте `public.devices` и `public.device_sessions` на незнакомые устройства и привязки, отзовите их.
5. Помните: устройство, которому уже выданы конверты, могло прочитать соответствующие старые сообщения. Отзыв останавливает только новые. Отозванный браузер при следующей загрузке покажет «Устройство отозвано» и не зарегистрируется автоматически; чтобы снова использовать этот браузер, нажмите «Начать заново на этом браузере» и войдите заново. Новая сессия по украденному паролю создаст только pending-устройство и не получит доступ без одобрения. Всё равно смените пароль и завершите все сессии.

### Скомпрометирован аккаунт

1. `status = 'blocked'` для профиля.
2. Удалите все сессии.
3. Отзовите все устройства.
4. Смените пароль.
5. Разберитесь, как получен доступ: повторное использование пароля, фишинг, заражённое устройство.
6. Верните `active` только после смены пароля и чистки устройств.

### Утёк service-role key или пароль базы

1. Dashboard → Project Settings → API → **Rotate** / сброс ключей.
2. Смените пароль базы.
3. Проверьте логи и `auth.users` на новые аккаунты, `public.messages` на подозрительные строки.
4. Обновите секреты в местах, где они используются (в клиенте их быть не должно).
5. Publishable-ключ ротировать не обязательно: он публичен, но после ротации обновите `src/core/config.js` и CSP.

### Подозрение на подмену клиентского кода

E2EE не защищает от вредоносного JS: он выполняется до шифрования и после расшифровки. При подозрении:

1. Остановите деплой: Actions → отключите workflow или удалите артефакт Pages.
2. Проверьте историю `main`, артефакты workflow, зависимости и `package-lock.json`.
3. Пересоберите из проверенного коммита.
4. Считайте переписку потенциально скомпрометированной; предупредите участников.

### Потеря всех устройств пользователя

Если recovery kit был создан и у пользователя есть файл kit + парольная фраза, он может войти на новом устройстве, открыть настройки → «Восстановление» и восстановить ключ из файла или серверной копии. После этого новые сообщения, отправленные после создания kit, снова доступны.

Но сначала новое устройство должно получить доступ: если активных устройств не осталось, выполните ручной reset из раздела 4.2. Recovery kit сам по себе не одобряет устройство.

Если kit не создавался или файл и парольная фраза потеряны, сообщения восстановить нельзя: конверты зашифрованы на потерянные ключи, а приватные ключи не покидали устройства. Пользователь может зарегистрировать новое устройство после reset и продолжить общение, но история до этого момента для него недоступна.

Если нужно сбросить потерянный recovery-ключ (например, пользователь потерял и файл, и парольную фразу), отзовите его строку и создайте новый kit:

```sql
update public.devices
   set status = 'revoked', revoked_at = now()
 where user_id = (select id from auth.users where email = 'friend@example.com')
   and kind = 'recovery'
   and status = 'active';

delete from public.key_backups
 where user_id = (select id from auth.users where email = 'friend@example.com');
```

После этого пользователь создаёт новый kit в настройках. Старые recovery-конверты останутся в `message_keys`, но соответствующий приватный ключ уже отозван.

## 7. Обновления и откат

### Обновить клиент

```bash
git pull
npm ci
npm test
npm run lint
npm run build
git push origin main
```

GitHub Actions пересоберёт и опубликует `dist`. Vite использует base `/bars/`; при смене имени репозитория поменяйте `base` в `vite.config.js`.

### Обновить схему

1. Сделайте резервную копию.
2. Добавьте новую миграцию с timestamp больше предыдущих.
3. Примените через `npx supabase db push` или SQL Editor.
4. Проверьте RLS, RPC и Realtime.
5. Не редактируйте уже применённые миграции: Supabase хранит их хэши.

Отката «вниз» в проекте нет. Откат схемы — восстановление из бэкапа или новая компенсирующая миграция. Поэтому изменения, удаляющие данные, требуют отдельного плана.

### Откатить фронтенд

Pages хранит предыдущие деплои. Быстрый путь — перезапустить workflow на предыдущем хорошем коммите:

```bash
git revert <bad-commit>
git push origin main
```

Или Actions → Deploy to GitHub Pages → Run workflow после checkout нужного коммита в отдельной ветке (не делайте force-push в `main` без необходимости).

## 8. Локальная разработка и проверка production

```bash
npm ci
npm run dev        # http://localhost:5173/
npm test           # 59 тестов: крипто + PostgreSQL/RLS/RPC/сессии/recovery/approval/личные диалоги/прочтение + unread + уведомления + ссылки/QR
npm run lint
npm run build
npm run preview    # проверка dist с base /bars/
```

`npm run preview` открывает `http://localhost:4173/bars/`. CSP в preview соответствует production.

Если используете другой Supabase project:

```bash
cp .env.example .env.local
# раскомментируйте и заполните VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY
```

CSP собирается из `VITE_SUPABASE_URL`, поэтому после смены проекта нужна пересборка. `VITE_SUPABASE_PUBLISHABLE_KEY` в CSP не участвует, но попадает в бандл — это нормально для publishable-ключа.

## 9. Диагностика

| Симптом | Вероятная причина | Что делать |
| --- | --- | --- |
| Белый экран, 404 на `/assets/...` | неверный base path | проверить `base` в `vite.config.js` и URL Pages |
| `Access token not provided` в CLI | нет `supabase login` | `npx supabase login` или `SUPABASE_ACCESS_TOKEN` |
| `db push` просит пароль | нет database password | указать пароль проекта или применить SQL в Dashboard |
| Вход проходит, но «Доступ закрыт» | профиль `pending` или нет приглашения | активировать профиль и добавить в чат (раздел 3) |
| Вход не проходит | неверный пароль, email не подтверждён, signup выключен | проверить пользователя в Authentication → Users |
| Сообщения не приходят в реальном времени | `messages` не в публикации или RLS | проверить `pg_publication_tables`, переподключиться |
| «Зашифровано для другого устройства» | у устройства нет конверта для этого сообщения | это ожидаемо для старых сообщений; отправить новое |
| Ошибка расшифровки у всех | повреждён AAD/конверт или несовпадение ключей | проверить версию клиента, `crypto_version`, не менялись ли поля сообщения |
| CSP блокирует Supabase | в сборке другой URL, чем в `.env.local` | пересобрать с правильным `VITE_SUPABASE_URL` |
| Устройство не регистрируется, `device_limit` | 20 активных устройств | отозвать лишние |
| Устройство не регистрируется, `device_pending_limit` | 3 одновременных pending-запроса | отклонить лишние в настройках активного устройства или отменить запрос на новом |
| Экран «Ожидает подтверждения» | новое устройство в статусе `pending` | одобрить в настройках активного устройства; если активных нет — reset из раздела 4.2 |
| Код на новом устройстве не совпадает с кодом в запросе | возможен чужой pending-запрос | не одобрять; отклонить запрос и сменить пароль |
| Ссылка одобрения открывается, но запрос «не найден» | устройство уже одобрено/отозвано, ссылка устарела или относится к другому аккаунту | обновить список устройств; проверить `deviceId` и аккаунт |
| Ссылка открыта на самом новом устройстве | pending-экран не имеет доступа к чату, одобрять нужно с активного | открыть ссылку на активном устройстве |
| Бейдж запросов не появляется | активных устройств нет либо запрос уже обработан | проверить `public.devices.status = 'pending'` и активную сессию |
| `device_not_found` при одобрении | запрос уже отменён, отклонён или одобрен | обновить список устройств |
| `device_reset_until` не сработал | окно истекло или у пользователя ещё есть активное устройство | повторить reset и проверить `profiles.device_reset_until` |
| Экран «Сессия недействительна» | `session_revoked`, `session_device_mismatch` или сессия без привязки | выйти и войти снова; проверить `device_sessions` |
| `session_required` при входе | в JWT нет `session_id` или клиент старый | обновить клиент, выйти и войти снова |
| После очистки данных нет истории | удалён приватный ключ устройства; recovery kit не создан | восстановить kit в настройках, если он был создан; иначе история не восстановима |
| `recovery_bad_passphrase` | неверная парольная фраза kit | проверить раскладку и регистр; парольную фразу нельзя восстановить |
| `recovery_mismatch` | файл kit не совпадает с активным recovery-ключом | использовать актуальный файл или сбросить recovery-ключ через SQL (раздел 6) |
| `recovery_exists` | активный recovery-ключ уже создан | скачать актуальный kit; для замены сначала отозвать старый |
| `recovery_not_found` | на сервере нет `key_backups` | создать kit заново; старые сообщения не восстановятся |
| `contact_not_found` | нет общего разговора, профиль не активен или заблокирован | проверить `profiles.status` и членство в общем чате |
| `invalid_direct_peer` | попытка создать личный диалог с самим собой | выбрать другого участника |
| `direct_conversation_conflict` | гонка создания или не применена миграция | повторить; проверить `20261112090000_direct_conversations.sql` |
| `function public.create_direct_conversation(...) does not exist` | миграция личных диалогов не применена | применить `20261112090000_direct_conversations.sql` |
| `function public.list_unread_counts(...) does not exist` | миграция прочтения не применена | применить `20261114090000_conversation_reads.sql` |
| Бейдж не исчезает после открытия диалога | `mark_conversation_read` не выполнилась или миграция не применена | проверить консоль и `conversation_reads.last_read_seq`; перезагрузить вкладку |
| Счётчик не появляется у получателя | Realtime не доставил строку или счётчики не обновились | проверить `messages` в публикации, переподключиться; счётчики обновляются при фокусе/видимости |
| Нет браузерных уведомлений | настройка выключена, разрешение не выдано, вкладка закрыта или браузер не поддерживает page-context Notification | включить в настройках BARS, разрешить уведомления для сайта; на iOS Safari остаются бейджи и toast |
| Уведомление приходит с текстом сообщения | устаревший клиент или сторонняя модификация | обновить клиент; уведомление должно содержать только отправителя/диалог и «Новое сообщение» |
| `relation "..." does not exist` | миграции применены не по порядку | применить недостающие по порядку |

Логи:

- Supabase Dashboard → Logs → Auth / Postgres / Realtime / API.
- Browser DevTools → Console и Network (без публикации ключей и текстов в issue).
- GitHub Actions → последний run.

## 10. Чек-лист перед раздачей друзьям

- [ ] Миграции применены все десять, по порядку.
- [ ] `messages` в публикации `supabase_realtime`; `conversation_reads` в публикацию не добавлена.
- [ ] RLS включён на всех таблицах; у `anon`/`authenticated` нет write-грантов на доменные таблицы.
- [ ] `conversation_reads` содержит строку на каждого участника; прямой `update` из клиента запрещён.
- [ ] Бейдж непрочитанных появляется для фонового диалога, счётчик в заголовке вкладки суммирует диалоги.
- [ ] Открытие диалога очищает бейдж, а `mark_conversation_read` увеличивает `last_read_seq`; свои сообщения не считаются.
- [ ] Уведомление не содержит текст сообщения; настройка хранится локально и не появляется у другого пользователя.
- [ ] После входа в `device_sessions` появилась активная привязка, а отзыв устройства её закрывает.
- [ ] «Новый диалог» показывает только активных участников общего круга, поиск по имени и `@username` работает.
- [ ] Личный диалог создаётся, повторное создание открывает тот же диалог; третий участник не видит его сообщения.
- [ ] Второе устройство создаётся `pending`, не видит сообщения и не получает конверты до одобрения.
- [ ] Код-отпечаток совпадает на новом устройстве и в настройках активного; после одобрения чат открывается.
- [ ] Ссылка/QR открывает на активном устройстве модалку с тем же кодом; без отметки о совпадении кнопка «Одобрить» неактивна.
- [ ] Бейдж на иконке настроек появляется при новом pending-запросе и исчезает после одобрения или отказа.
- [ ] Отклонение и отмена pending-запроса работают; отозванные устройства скрыты в сворачиваемом блоке.
- [ ] Кнопка «Начать заново на этом браузере» после отзыва удаляет локальный ключ и позволяет создать новый pending-запрос.
- [ ] Ручной reset из раздела 4.2 активирует следующее устройство и очищает `device_reset_until`.
- [ ] Signup выключен, приглашения создаются вручную.
- [ ] Первый владелец активен и видит общий чат.
- [ ] Тестовый аккаунт друга активируется, входит и получает сообщения.
- [ ] Проверены два устройства одного аккаунта: оба расшифровывают новые сообщения.
- [ ] Проверен отзыв устройства: новое сообщение ему не приходит.
- [ ] Создан recovery kit, файл скачан, парольная фраза сохранена отдельно.
- [ ] Восстановление на втором устройстве/после очистки данных открывает новые сообщения, отправленные после создания kit.
- [ ] GitHub Pages открывается по HTTPS, CSP не блокирует Supabase.
- [ ] Бэкапы БД включены.
- [ ] В репозитории нет `.env.local`, service-role key, паролей и `forOpenCode/supabase.txt`.
- [ ] Друзьям объяснено: recovery kit защищает только новые сообщения; файл и парольная фраза хранятся отдельно; потеря обоих = потеря истории.
