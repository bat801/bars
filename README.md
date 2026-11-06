# BARS

**Private space. Trusted people.**

BARS — закрытый end-to-end зашифрованный мессенджер для небольшого круга близких людей (3–5 человек). Без публичной регистрации, без рекламы и без чтения переписки на сервере. Интерфейс на русском, тёмная фиолетовая glassmorphism-тема, поддержка телефона, планшета и десктопа.

## Статус

Текущая версия — **M1.5 в работе**: рабочий групповой чат M1 плюс привязка сессий Supabase к устройствам.

- [x] Вход по приглашению, публичная регистрация отключена
- [x] Групповой чат по умолчанию
- [x] E2EE: HPKE Auth (RFC 9180) + AES-256-GCM
- [x] Отдельный ключ на каждое устройство, приватный ключ неэкстрагируемый
- [x] Доставка в реальном времени через Supabase Realtime
- [x] Атомарная отправка сообщения и ключевых конвертов в одной RPC-транзакции
- [x] Список устройств и отзыв устройства
- [x] Привязка `session_id` к устройству: отозванная сессия теряет доступ к RLS и RPC сразу
- [x] Адаптивный интерфейс, мобильный экран чата, safe-area и VisualViewport

Осталось в **M1.5**: recovery kit, подтверждение нового устройства, QR-сопряжение, тесты Auth/Realtime на hosted Supabase. Дальше: личные диалоги, вложения, стикеры, MLS/Signal-подобный ratchet.

## Стек

- **Vite 8** + vanilla JavaScript (ES-модули), без UI-фреймворка
- **Supabase**: Auth, Postgres, Realtime, RLS
- **@hpke/core 1.10** — HPKE Auth, P-256 / HKDF-SHA256 / AES-256-GCM
- **WebCrypto** — AES-256-GCM для полезной нагрузки
- **IndexedDB** (`idb`) — хранение неэкстрагируемого `CryptoKey`
- **GitHub Pages** — статический хостинг

## Безопасность в двух словах

1. У каждого браузера/устройства своя пара P-256. Приватный ключ создаётся как `extractable: false` и хранится в IndexedDB; его нельзя экспортировать даже кодом приложения.
2. Для каждого сообщения генерируется случайный AES-256 ключ. Им шифруется текст.
3. Этот ключ заворачивается отдельно для каждого активного устройства каждого участника через **HPKE Auth**. Отправитель подтверждает владение своим приватным ключом, получатель проверяет отправителя.
4. На сервер уходят только шифротекст и конверты ключей. AAD привязывает сообщение к диалогу, id сообщения, отправителю, устройству отправителя и типу.
5. Клиенты имеют только `SELECT` под RLS. Все записи идут через `security definer` RPC. Прямого доступа к таблицам на запись нет.
6. Каждая сессия Supabase привязана к устройству через `device_sessions`. Отзыв устройства или выход закрывают JWT на сервере сразу, а не после истечения токена.

Подробности: [docs/SECURITY.md](docs/SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) и [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Быстрый старт

Требования: Node.js 22+ (проверено на 24), npm.

```bash
npm ci
npm run dev
```

Приложение откроется на `http://localhost:5173/`.

По умолчанию используются URL и publishable-ключ проекта Supabase, указанные в `src/core/config.js`. Они безопасны для браузера: publishable-ключ работает только с ролью `anon`, доступ ограничен RLS. **Service-role key и пароль базы нельзя класть в клиент или репозиторий.**

Если нужен другой проект:

```bash
cp .env.example .env.local
# заполните VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY
```

## Настройка Supabase

### 1. Применить миграции

Миграции лежат в `supabase/migrations` и применяются по порядку:

| Файл | Назначение |
| --- | --- |
| `20261105090000_schema.sql` | таблицы, триггер профиля, общий чат |
| `20261105090100_policies.sql` | helper-функции, RLS, гранты |
| `20261105090200_rpc.sql` | атомарные RPC для устройств, профиля и сообщений |
| `20261105090300_realtime.sql` | публикация `messages` для Realtime |
| `20261105090400_bootstrap.sql` | профили для аккаунтов, созданных до миграций |
| `20261106090000_device_sessions.sql` | привязка сессий Supabase к устройствам и отзыв сессий |

Вариант A — Supabase CLI. `supabase/config.toml` уже в репозитории, `supabase init` выполнять не нужно:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

Для `db push` понадобится пароль базы данных. Настройки в `config.toml` относятся к локальному стеку; hosted-проект они не меняют — Auth настраивается в Dashboard.

Вариант B — Dashboard → SQL Editor: выполните файлы по одному в указанном порядке.

После применения проверьте:

```sql
select count(*) from public.profiles;
select * from public.conversations;
```

Первый существовавший аккаунт становится `owner` и автоматически попадает в «Общий чат». Остальные существовавшие аккаунты остаются `pending` до активации.

### 2. Настроить Auth

Dashboard → Authentication:

- **Email** provider включён.
- **Allow new users to sign up** выключен.
- Email confirmation можно включить; при ручной выдаче аккаунтов удобнее создавать пользователей с подтверждённой почтой.
- Redirect URLs для GitHub Pages не обязательны: BARS не использует magic link.

### 3. Выдать приглашение и создать аккаунт

Сначала создайте приглашение в SQL Editor:

```sql
insert into public.access_invites (email, note)
values ('friend@example.com', 'Для Саши')
on conflict (email) do update set note = excluded.note, used_at = null, used_by = null;
```

Затем Dashboard → Authentication → Users → **Add user**:

- email — тот же, что в приглашении;
- пароль — временный, передайте его лично;
- **Auto Confirm User** — включить.

Триггер `handle_new_user` создаст профиль, активирует его, свяжет приглашение и добавит пользователя в «Общий чат».

Если аккаунт уже существует, но остался `pending`:

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

Пароль пользователь может сменить в настройках BARS. E2EE-ключи от пароля не зависят.

### 4. Realtime

Миграция добавляет `public.messages` в публикацию `supabase_realtime`. RLS применяется и к Realtime: клиент получает только строки диалогов, где он участник.

Если live-обновления не приходят, проверьте:

```sql
select * from pg_publication_tables
 where pubname = 'supabase_realtime' and tablename = 'messages';
```

## GitHub Pages

В репозитории есть workflow `.github/workflows/deploy.yml`. Он собирает проект, прогоняет тесты и линт, затем публикует `dist`.

1. Settings → Pages → Source: **GitHub Actions**.
2. Push в `main` или запуск workflow вручную (Actions → Deploy to GitHub Pages → Run workflow).
3. Сайт будет доступен по адресу `https://<username>.github.io/bars/`.

Vite использует `base: '/bars/'` для production. CSP встраивается в `index.html` на этапе сборки и разрешает только self, Supabase HTTPS/WSS и локальные шрифты.

## Скрипты

| Команда | Что делает |
| --- | --- |
| `npm run dev` | dev-сервер Vite |
| `npm run build` | production-сборка в `dist` |
| `npm run preview` | локальный просмотр `dist` |
| `npm test` | 24 теста: 12 криптографических и 12 backend-тестов на PostgreSQL |
| `npm run lint` | ESLint |

## Структура

```text
src/
  app/            жизненный цикл приложения и маршрутизация
  components/     иконки, аватары, toast
  core/           конфиг, DOM, форматирование, ошибки
  crypto/         ключи, HPKE, конверты, IndexedDB, кодирование
  features/       login, access, chat, settings
  services/       Supabase Auth, профили, устройства, сообщения, realtime
  styles/         токены, glassmorphism, layout, адаптивность
supabase/
  migrations/     схема, RLS, RPC, Realtime, bootstrap, привязка сессий
tests/            криптографические и backend-тесты (PGlite)
docs/             архитектура, безопасность, эксплуатация
```

## Ограничения M1.5

- Нет recovery kit: при потере всех устройств аккаунта старая переписка не восстановится.
- Нет forward secrecy: компрометация устройства и его ключа раскрывает сообщения, для которых этому устройству был выдан конверт.
- Привязка сессии закрывает доступ для уже отозванной сессии, но украденный пароль всё ещё позволяет создать новую сессию и зарегистрировать новое устройство. Подтверждение нового устройства — следующий шаг.
- Новая сессия привязывается к устройству по принципу «первый связал»: кто первым вызовет `register_device` с этим JWT, тот и получит привязку.
- Нет вложений и стикеров в интерфейсе, хотя схема сообщений к ним готова.
- Нет тестов против hosted Supabase и Realtime: миграции, RLS и RPC проверяются на PGlite, но живой Realtime и Dashboard-настройки нужно проверять вручную.
- Публичная регистрация должна быть выключена в Supabase Dashboard, иначе аккаунт без приглашения всё равно сможет войти в состояние «Доступ закрыт», но не получит данные.

## Лицензия

MIT, см. [LICENSE](LICENSE).
