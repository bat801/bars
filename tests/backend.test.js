import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Backend integration tests against a real PostgreSQL engine (PGlite).
 *
 * They apply the production migrations, stub the tiny part of Supabase Auth
 * that the schema depends on, and then talk to the database as the
 * `authenticated` role. This catches SQL syntax errors, broken RLS policies,
 * and RPC regressions without a hosted Supabase project.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../supabase/migrations/', import.meta.url),
);

const MIGRATIONS = [
  '20261105090000_schema.sql',
  '20261105090100_policies.sql',
  '20261105090200_rpc.sql',
  '20261105090300_realtime.sql',
  '20261105090400_bootstrap.sql',
];

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

const ALICE_DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB_DEVICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOB_OLD_DEVICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CAROL_DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const DEFAULT_CONVERSATION = '00000000-0000-4000-8000-000000000001';

const publicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'A'.repeat(43),
  y: 'B'.repeat(43),
};

let db = null;

async function createDatabase({ migrations = MIGRATIONS } = {}) {
  const instance = new PGlite({ extensions: { pgcrypto } });
  await instance.waitReady;

  await instance.exec(`
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;

    create schema auth;

    create table auth.users (
      id uuid primary key,
      email text,
      created_at timestamptz not null default now()
    );

    create or replace function auth.uid()
    returns uuid
    language sql
    stable
    as $$
      select nullif(
        current_setting('request.jwt.claim.sub', true),
        ''
      )::uuid;
    $$;

    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);

  for (const file of migrations) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await instance.exec(sql);
  }

  return instance;
}

async function seedUsers(instance = db) {
  await instance.exec(`
    insert into public.access_invites (email, note) values
      ('alice@example.com', 'Alice'),
      ('bob@example.com', 'Bob');

    insert into auth.users (id, email, created_at) values
      ('${ALICE}', 'alice@example.com', '2026-01-01T10:00:00Z'),
      ('${BOB}', 'bob@example.com', '2026-01-02T10:00:00Z'),
      ('${CAROL}', 'carol@example.com', '2026-01-03T10:00:00Z');
  `);
}

async function asUser(instance, userId) {
  await instance.exec(`
    reset role;
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${userId}', false);
  `);
}

async function asAdmin(instance) {
  await instance.exec(`
    reset role;
    select set_config('request.jwt.claim.sub', '', false);
  `);
}

async function registerDevice(instance, deviceId, name) {
  const result = await instance.query(
    `select * from public.register_device($1, $2, $3::jsonb)`,
    [deviceId, name, JSON.stringify(publicJwk)],
  );
  return result.rows[0];
}

async function sendTestMessage(instance, {
  messageId,
  clientMessageId = messageId,
  deviceId,
  recipientDeviceIds,
  text = 'secret',
}) {
  const keys = recipientDeviceIds.map((id) => ({
    device_id: id,
    enc: Buffer.from(`enc:${messageId}:${id}`).toString('base64'),
    wrapped_key: Buffer.from(`key:${messageId}:${id}`).toString('base64'),
  }));

  return instance.query(
    `select * from public.send_message(
       $1, $2, $3, $4, 'text', 1::smallint, $5, $6, $7::jsonb
     )`,
    [
      DEFAULT_CONVERSATION,
      messageId,
      clientMessageId,
      deviceId,
      Buffer.from(`ciphertext:${text}`).toString('base64'),
      Buffer.from('iv-12-bytes').toString('base64'),
      JSON.stringify(keys),
    ],
  );
}

afterEach(async () => {
  await db?.close();
  db = null;
});

describe('BARS backend migrations', () => {
  it('creates profiles from invites and makes the first user the owner', async () => {
    db = await createDatabase();
    await seedUsers();

    const { rows } = await db.query(
      `select id, username, role, status
         from public.profiles
        order by id`,
    );

    expect(rows).toHaveLength(3);

    const alice = rows.find((row) => row.id === ALICE);
    const bob = rows.find((row) => row.id === BOB);
    const carol = rows.find((row) => row.id === CAROL);

    expect(alice).toMatchObject({ role: 'owner', status: 'active' });
    expect(bob).toMatchObject({ role: 'member', status: 'active' });
    expect(carol).toMatchObject({ role: 'member', status: 'pending' });
    expect(alice.username).toMatch(/^alice_/);
    expect(bob.username).toMatch(/^bob_/);

    const members = await db.query(
      `select user_id
         from public.conversation_members
        where conversation_id = $1
        order by user_id`,
      [DEFAULT_CONVERSATION],
    );

    expect(members.rows.map((row) => row.user_id)).toEqual([ALICE, BOB]);
  });

  it('registers devices through the RPC and denies direct writes', async () => {
    db = await createDatabase();
    await seedUsers();

    await asUser(db, ALICE);
    const device = await registerDevice(db, ALICE_DEVICE, 'Alice laptop');
    expect(device).toMatchObject({ id: ALICE_DEVICE, status: 'active' });

    await expect(
      db.exec(`
        insert into public.messages (
          id, conversation_id, sender_id, sender_device_id,
          client_message_id, ciphertext, iv
        ) values (
          gen_random_uuid(), '${DEFAULT_CONVERSATION}', '${ALICE}',
          '${ALICE_DEVICE}', gen_random_uuid(), 'x', 'y'
        );
      `),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.exec(`
        insert into public.access_invites (email) values ('intruder@example.com');
      `),
    ).rejects.toThrow(/permission denied/i);

    await asUser(db, CAROL);
    await expect(registerDevice(db, CAROL_DEVICE, 'Carol phone')).rejects.toThrow(
      /access_denied/,
    );
  });

  it('stores only envelopes for active devices of active members', async () => {
    db = await createDatabase();
    await seedUsers();

    await asUser(db, ALICE);
    await registerDevice(db, ALICE_DEVICE, 'Alice laptop');
    await asUser(db, BOB);
    await registerDevice(db, BOB_DEVICE, 'Bob phone');

    await asAdmin(db);
    await db.exec(`
      insert into public.devices (id, user_id, name, public_key_jwk, status)
      values
        ('${BOB_OLD_DEVICE}', '${BOB}', 'Bob old phone', '${JSON.stringify(publicJwk)}', 'revoked'),
        ('${CAROL_DEVICE}', '${CAROL}', 'Carol pending phone', '${JSON.stringify(publicJwk)}', 'active');
    `);

    await asUser(db, ALICE);
    const messageId = crypto.randomUUID();
    const sent = await sendTestMessage(db, {
      messageId,
      deviceId: ALICE_DEVICE,
      recipientDeviceIds: [
        ALICE_DEVICE,
        BOB_DEVICE,
        BOB_OLD_DEVICE,
        CAROL_DEVICE,
      ],
    });

    expect(sent.rows[0].id).toBe(messageId);

    // Envelopes are written for every eligible device, but RLS only exposes
    // the caller's own rows. Inspect the full result as the administrator.
    await asAdmin(db);
    const keys = await db.query(
      `select device_id
         from public.message_keys
        where message_id = $1
        order by device_id`,
      [messageId],
    );

    expect(keys.rows.map((row) => row.device_id)).toEqual([
      ALICE_DEVICE,
      BOB_DEVICE,
    ]);

    // A retried send returns the original row instead of inserting a duplicate.
    await asUser(db, ALICE);
    const retried = await sendTestMessage(db, {
      messageId,
      deviceId: ALICE_DEVICE,
      recipientDeviceIds: [ALICE_DEVICE],
    });
    expect(retried.rows[0].id).toBe(messageId);

    const count = await db.query(
      `select count(*)::int as total from public.messages`,
    );
    expect(count.rows[0].total).toBe(1);

    await asUser(db, BOB);
    const bobKeys = await db.query(
      `select device_id from public.message_keys where message_id = $1`,
      [messageId],
    );
    expect(bobKeys.rows.map((row) => row.device_id)).toEqual([BOB_DEVICE]);

    await asUser(db, CAROL);
    const carolMessages = await db.query(`select id from public.messages`);
    expect(carolMessages.rows).toHaveLength(0);

    const carolKeys = await db.query(`select id from public.message_keys`);
    expect(carolKeys.rows).toHaveLength(0);
  });

  it('rejects a message with no eligible envelope', async () => {
    db = await createDatabase();
    await seedUsers();

    await asUser(db, ALICE);
    await registerDevice(db, ALICE_DEVICE, 'Alice laptop');

    await asAdmin(db);
    await db.exec(`
      insert into public.devices (id, user_id, name, public_key_jwk, status)
      values ('${CAROL_DEVICE}', '${CAROL}', 'Carol pending phone', '${JSON.stringify(publicJwk)}', 'active');
    `);

    await asUser(db, ALICE);
    await expect(
      sendTestMessage(db, {
        messageId: crypto.randomUUID(),
        deviceId: ALICE_DEVICE,
        recipientDeviceIds: [CAROL_DEVICE],
      }),
    ).rejects.toThrow(/invalid_keys/);

    const count = await db.query(
      `select count(*)::int as total from public.messages`,
    );
    expect(count.rows[0].total).toBe(0);
  });

  it('stops new keys and reads for a blocked profile', async () => {
    db = await createDatabase();
    await seedUsers();

    await asUser(db, ALICE);
    await registerDevice(db, ALICE_DEVICE, 'Alice laptop');
    await asUser(db, BOB);
    await registerDevice(db, BOB_DEVICE, 'Bob phone');

    await asAdmin(db);
    await db.exec(`
      update public.profiles
         set status = 'blocked'
       where id = '${BOB}';
    `);

    await asUser(db, ALICE);
    const messageId = crypto.randomUUID();
    await sendTestMessage(db, {
      messageId,
      deviceId: ALICE_DEVICE,
      recipientDeviceIds: [ALICE_DEVICE, BOB_DEVICE],
    });

    await asAdmin(db);
    const keys = await db.query(
      `select device_id from public.message_keys where message_id = $1`,
      [messageId],
    );
    expect(keys.rows.map((row) => row.device_id)).toEqual([ALICE_DEVICE]);

    await asUser(db, ALICE);
    const devices = await db.query(
      `select device_id, profile_status
         from public.get_conversation_devices($1)`,
      [DEFAULT_CONVERSATION],
    );
    expect(devices.rows).toEqual(
      expect.arrayContaining([
        { device_id: ALICE_DEVICE, profile_status: 'active' },
        { device_id: BOB_DEVICE, profile_status: 'blocked' },
      ]),
    );

    await asUser(db, BOB);
    const messages = await db.query(`select id from public.messages`);
    expect(messages.rows).toHaveLength(0);

    await expect(
      sendTestMessage(db, {
        messageId: crypto.randomUUID(),
        deviceId: BOB_DEVICE,
        recipientDeviceIds: [BOB_DEVICE],
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it('restricts profile visibility to the user and conversation peers', async () => {
    db = await createDatabase();
    await seedUsers();

    await asUser(db, ALICE);
    const aliceView = await db.query(`select id from public.profiles order by id`);
    expect(aliceView.rows.map((row) => row.id)).toEqual([ALICE, BOB]);

    await asUser(db, CAROL);
    const carolView = await db.query(`select id from public.profiles`);
    expect(carolView.rows.map((row) => row.id)).toEqual([CAROL]);
  });

  it('bootstraps pre-existing auth users and stays idempotent', async () => {
    db = await createDatabase({ migrations: MIGRATIONS.slice(0, 4) });

    await db.exec(`
      drop trigger on_auth_user_created on auth.users;

      insert into public.access_invites (email, note)
      values ('alice@example.com', 'Alice');

      insert into auth.users (id, email, created_at) values
        ('${BOB}', 'bob@example.com', '2026-01-01T10:00:00Z'),
        ('${ALICE}', 'alice@example.com', '2026-01-02T10:00:00Z'),
        ('${CAROL}', 'carol@example.com', '2026-01-03T10:00:00Z');
    `);

    const bootstrap = await readFile(
      join(MIGRATIONS_DIR, '20261105090400_bootstrap.sql'),
      'utf8',
    );
    await db.exec(bootstrap);
    await db.exec(bootstrap);

    const profiles = await db.query(
      `select id, role, status from public.profiles order by id`,
    );
    expect(profiles.rows).toHaveLength(3);
    expect(profiles.rows.find((row) => row.id === BOB)).toMatchObject({
      role: 'owner',
      status: 'active',
    });
    expect(profiles.rows.find((row) => row.id === ALICE)).toMatchObject({
      role: 'member',
      status: 'active',
    });
    expect(profiles.rows.find((row) => row.id === CAROL)).toMatchObject({
      role: 'member',
      status: 'pending',
    });

    const members = await db.query(
      `select user_id
         from public.conversation_members
        where conversation_id = $1
        order by user_id`,
      [DEFAULT_CONVERSATION],
    );
    expect(members.rows.map((row) => row.user_id)).toEqual([ALICE, BOB]);

    const invite = await db.query(
      `select used_at, used_by from public.access_invites
        where email = 'alice@example.com'`,
    );
    expect(invite.rows[0].used_by).toBe(ALICE);
    expect(invite.rows[0].used_at).not.toBeNull();
  });
});
