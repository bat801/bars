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
   ```

   CLI (`supabase/config.toml` уже в репозитории, `supabase init` не нужен):

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

   Для `db push` понадобится пароль базы. Настройки в `config.toml` действуют только на локальный стек: `enable_signup = false` там не выключает регистрацию в hosted-проекте, это делается в Dashboard (шаг 4).

   Либо Dashboard → SQL Editor: каждый файл целиком, по одному.

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
   ```

   Ожидается: общий чат `00000000-0000-4000-8000-000000000001`, `messages` в публикации, `rowsecurity = true` у всех таблиц, а `device_sessions` заполняется после первого входа обновлённого клиента.

4. Authentication → Providers → Email: включён. **Allow new users to sign up** — выключен. Email confirmation можно оставить включённым; при ручном создании пользователей включайте **Auto Confirm User**.

5. Authentication → URL Configuration: BARS не использует magic link и OAuth, поэтому redirect URLs не обязательны. Site URL можно указать как `https://<username>.github.io/bars/`.

После миграции `device_sessions` уже существующие сессии M1 не имеют привязки. Это нормально: при следующей загрузке обновлённый клиент вызовет `register_device` и привяжет сессию к локальному устройству. Если клиент старый и не умеет привязку, RLS перестанет отдавать ему сообщения — сначала обновите клиент, затем применяйте миграцию.

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

В M1 есть один общий чат, и `ensure_default_conversation()` самовосстанавливает членство активного пользователя при входе. Поэтому удаление строки из `conversation_members` не является надёжным способом закрыть доступ: при следующем входе пользователь вернётся в чат.

Надёжный способ в M1 — заблокировать профиль (`status = 'blocked'`). Это останавливает чтение, RPC и выдачу новых конвертов. Если нужно полностью убрать человека из круга, заблокируйте его, завершите сессии и отзовите устройства. Удаление из чата без блокировки появится вместе с управлением участниками в следующих версиях.

> **Не удаляйте пользователя из `auth.users` без необходимости.** Из-за `on delete cascade` вместе с профилем удалятся его устройства, конверты ключей и **все отправленные им сообщения** — они исчезнут из истории у всех. Для отключения доступа используйте `blocked`.

## 4. Устройства

- Каждое устройство — отдельная пара P-256 и строка в `public.devices`.
- Лимит активных устройств — 20 на пользователя.
- Каждая сессия Supabase привязана к одному устройству через `public.device_sessions`.
- Отзыв через интерфейс: настройки → «Устройства» → «Отозвать». После отзыва устройство не получает новые конверты, все его сессии помечаются `revoked_at`, а при следующей загрузке оно показывает «Устройство отозвано».
- Повторная очистка данных сайта или приватного окна создаёт новое устройство. Старое остаётся активным, пока его не отзовут; следите за списком.
- Отозванное устройство остаётся в таблице для проверки старых ключей отправителей, но не может обновить ключ через RPC.

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
     and d.status = 'active'
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
   and d.status = 'active';
```

Пользователь сможет войти снова после регистрации нового устройства: с другого устройства или после очистки данных сайта в отозванном браузере. Новые сообщения будут шифроваться уже для нового устройства. Помните, что новая сессия по украденному паролю тоже сможет зарегистрировать новое устройство — подтверждение устройств появится в следующем этапе.

## 5. Повседневные проверки

Раз в неделю или перед важными изменениями:

```sql
-- активные пользователи и устройства
select p.username, p.status, count(d.id) filter (where d.status = 'active') as active_devices
  from public.profiles p
  left join public.devices d on d.user_id = p.id
 group by p.id, p.username, p.status
 order by p.username;

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
5. Помните: устройство, которому уже выданы конверты, могло прочитать соответствующие старые сообщения. Отзыв останавливает только новые. Отозванный браузер при следующей загрузке покажет «Устройство отозвано» и не зарегистрируется автоматически; чтобы снова использовать этот браузер, нужно очистить данные сайта и войти заново. Новая сессия по украденному паролю всё ещё может создать новое устройство: до появления подтверждения устройств меняйте пароль и завершайте все сессии.

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

В M1 recovery kit нет. Старые сообщения восстановить нельзя: конверты зашифрованы на потерянные ключи, а приватные ключи не покидали устройства. Пользователь может зарегистрировать новое устройство и продолжить общение, но история до этого момента для него недоступна.

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
npm test           # 23 теста: крипто + PostgreSQL/RLS/RPC/сессии
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
| Экран «Сессия недействительна» | `session_revoked`, `session_device_mismatch` или сессия без привязки | выйти и войти снова; проверить `device_sessions` |
| `session_required` при входе | в JWT нет `session_id` или клиент старый | обновить клиент, выйти и войти снова |
| После очистки данных нет истории | удалён приватный ключ устройства | recovery kit появится в M1.5; сейчас история не восстановима |
| `relation "..." does not exist` | миграции применены не по порядку | применить недостающие по порядку |

Логи:

- Supabase Dashboard → Logs → Auth / Postgres / Realtime / API.
- Browser DevTools → Console и Network (без публикации ключей и текстов в issue).
- GitHub Actions → последний run.

## 10. Чек-лист перед раздачей друзьям

- [ ] Миграции применены все шесть, по порядку.
- [ ] `messages` в публикации `supabase_realtime`.
- [ ] RLS включён на всех таблицах; у `anon`/`authenticated` нет write-грантов на доменные таблицы.
- [ ] После входа в `device_sessions` появилась активная привязка, а отзыв устройства её закрывает.
- [ ] Signup выключен, приглашения создаются вручную.
- [ ] Первый владелец активен и видит общий чат.
- [ ] Тестовый аккаунт друга активируется, входит и получает сообщения.
- [ ] Проверены два устройства одного аккаунта: оба расшифровывают новые сообщения.
- [ ] Проверен отзыв устройства: новое сообщение ему не приходит.
- [ ] GitHub Pages открывается по HTTPS, CSP не блокирует Supabase.
- [ ] Бэкапы БД включены.
- [ ] В репозитории нет `.env.local`, service-role key, паролей и `forOpenCode/supabase.txt`.
- [ ] Друзьям объяснено: потеря всех устройств = потеря старой истории; пароль не восстанавливает E2EE-ключи.
