import { describe, expect, it } from 'vitest';
import {
  generateDeviceKeys,
  importPublicJwk,
} from '../src/crypto/keys.js';
import {
  decryptMessage,
  encryptMessage,
} from '../src/crypto/envelope.js';

const CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';
const ALICE = '11111111-1111-4111-8111-111111111111';
const CAROL = '33333333-3333-4333-8333-333333333333';

async function makeDevice() {
  const keys = await generateDeviceKeys();
  return {
    deviceId: crypto.randomUUID(),
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    publicJwk: keys.publicJwk,
  };
}

async function setup() {
  const alice = await makeDevice();
  const bob = await makeDevice();
  const bobTablet = await makeDevice();
  const carol = await makeDevice();

  const messageId = crypto.randomUUID();
  const text = 'Привет, BARS. Это приватный разговор.';

  const payload = await encryptMessage({
    text,
    conversationId: CONVERSATION_ID,
    messageId,
    senderId: ALICE,
    senderDeviceId: alice.deviceId,
    senderPrivateKey: alice.privateKey,
    senderPublicKey: alice.publicKey,
    recipients: [
      { deviceId: alice.deviceId, publicKey: alice.publicKey },
      { deviceId: bob.deviceId, publicKey: bob.publicKey },
      { deviceId: bobTablet.deviceId, publicKey: bobTablet.publicKey },
    ],
  });

  const row = {
    id: messageId,
    conversation_id: CONVERSATION_ID,
    sender_id: ALICE,
    sender_device_id: alice.deviceId,
    type: 'text',
    crypto_version: 1,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
  };

  return { alice, bob, bobTablet, carol, messageId, text, payload, row };
}

function envelopeFor(payload, deviceId) {
  const key = payload.keys.find((item) => item.deviceId === deviceId);
  return { enc: key.enc, wrapped_key: key.wrappedKey };
}

describe('BARS Envelope v1', () => {
  it('generates non-extractable P-256 private keys and public JWKs', async () => {
    const device = await makeDevice();

    expect(device.privateKey.extractable).toBe(false);
    expect(device.privateKey.type).toBe('private');
    expect(device.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(device.publicJwk.x).toBeTruthy();
    expect(device.publicJwk.y).toBeTruthy();

    const imported = await importPublicJwk(device.publicJwk);
    expect(imported.type).toBe('public');
  });

  it('round-trips a message for each active device', async () => {
    const { alice, bob, bobTablet, payload, row, text } = await setup();

    const bobText = await decryptMessage({
      message: row,
      envelope: envelopeFor(payload, bob.deviceId),
      senderPublicKey: alice.publicKey,
      privateKey: bob.privateKey,
      publicKey: bob.publicKey,
      deviceId: bob.deviceId,
    });

    const tabletText = await decryptMessage({
      message: row,
      envelope: envelopeFor(payload, bobTablet.deviceId),
      senderPublicKey: alice.publicKey,
      privateKey: bobTablet.privateKey,
      publicKey: bobTablet.publicKey,
      deviceId: bobTablet.deviceId,
    });

    expect(bobText).toBe(text);
    expect(tabletText).toBe(text);
  });

  it('round-trips across many independently generated key pairs', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { alice, bob, payload, row, text } = await setup();

      await expect(
        decryptMessage({
          message: row,
          envelope: envelopeFor(payload, bob.deviceId),
          senderPublicKey: alice.publicKey,
          privateKey: bob.privateKey,
          publicKey: bob.publicKey,
          deviceId: bob.deviceId,
        }),
      ).resolves.toBe(text);
    }
  });

  it('creates one envelope per device and never leaks plaintext', async () => {
    const { payload, text } = await setup();

    expect(payload.keys).toHaveLength(3);
    expect(payload.ciphertext).not.toContain(text);
    expect(payload.ciphertext.length).toBeGreaterThan(20);
    expect(payload.iv.length).toBeGreaterThan(10);
    expect(new Set(payload.keys.map((key) => key.enc)).size).toBe(3);
  });

  it('rejects a device that has no envelope', async () => {
    const { carol, payload, row, alice } = await setup();

    const bobEnvelope = payload.keys.find((key) => key.deviceId !== carol.deviceId);

    await expect(
      decryptMessage({
        message: row,
        envelope: { enc: bobEnvelope.enc, wrapped_key: bobEnvelope.wrappedKey },
        senderPublicKey: alice.publicKey,
        privateKey: carol.privateKey,
        publicKey: carol.publicKey,
        deviceId: carol.deviceId,
      }),
    ).rejects.toBeTruthy();
  });

  it('rejects a sender whose key does not match the HPKE auth tag', async () => {
    const { bob, carol, payload, row } = await setup();

    await expect(
      decryptMessage({
        message: row,
        envelope: envelopeFor(payload, bob.deviceId),
        senderPublicKey: carol.publicKey,
        privateKey: bob.privateKey,
        publicKey: bob.publicKey,
        deviceId: bob.deviceId,
      }),
    ).rejects.toBeTruthy();
  });

  it('rejects tampered ciphertext', async () => {
    const { alice, bob, payload, row } = await setup();

    const bytes = atob(row.ciphertext).split('');
    bytes[0] = bytes[0] === 'A' ? 'B' : 'A';
    const tampered = { ...row, ciphertext: btoa(bytes.join('')) };

    await expect(
      decryptMessage({
        message: tampered,
        envelope: envelopeFor(payload, bob.deviceId),
        senderPublicKey: alice.publicKey,
        privateKey: bob.privateKey,
        publicKey: bob.publicKey,
        deviceId: bob.deviceId,
      }),
    ).rejects.toBeTruthy();
  });

  it('rejects a message whose AAD was changed', async () => {
    const { alice, bob, payload, row } = await setup();

    const altered = { ...row, sender_id: CAROL };

    await expect(
      decryptMessage({
        message: altered,
        envelope: envelopeFor(payload, bob.deviceId),
        senderPublicKey: alice.publicKey,
        privateKey: bob.privateKey,
        publicKey: bob.publicKey,
        deviceId: bob.deviceId,
      }),
    ).rejects.toBeTruthy();
  });

  it('rejects an envelope replayed under a different device id', async () => {
    const { alice, bob, bobTablet, payload, row } = await setup();

    await expect(
      decryptMessage({
        message: row,
        envelope: envelopeFor(payload, bobTablet.deviceId),
        senderPublicKey: alice.publicKey,
        privateKey: bob.privateKey,
        publicKey: bob.publicKey,
        deviceId: bob.deviceId,
      }),
    ).rejects.toBeTruthy();
  });

  it('rejects unsupported crypto versions', async () => {
    const { alice, bob, payload, row } = await setup();

    await expect(
      decryptMessage({
        message: { ...row, crypto_version: 2 },
        envelope: envelopeFor(payload, bob.deviceId),
        senderPublicKey: alice.publicKey,
        privateKey: bob.privateKey,
        publicKey: bob.publicKey,
        deviceId: bob.deviceId,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_crypto_version' });
  });

  it('uses a fresh content key for every message', async () => {
    const { alice, bob, messageId } = await setup();
    const shared = {
      conversationId: CONVERSATION_ID,
      senderId: ALICE,
      senderDeviceId: alice.deviceId,
      senderPrivateKey: alice.privateKey,
      senderPublicKey: alice.publicKey,
      recipients: [{ deviceId: bob.deviceId, publicKey: bob.publicKey }],
    };

    const first = await encryptMessage({
      ...shared,
      text: 'same text',
      messageId,
    });
    const second = await encryptMessage({
      ...shared,
      text: 'same text',
      messageId,
    });

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.keys[0].wrappedKey).not.toBe(second.keys[0].wrappedKey);
  });

  it('rejects empty messages and empty recipient lists', async () => {
    const { alice } = await setup();

    await expect(
      encryptMessage({
        text: '',
        conversationId: CONVERSATION_ID,
        messageId: crypto.randomUUID(),
        senderId: ALICE,
        senderDeviceId: alice.deviceId,
        senderPrivateKey: alice.privateKey,
        senderPublicKey: alice.publicKey,
        recipients: [],
      }),
    ).rejects.toMatchObject({ code: 'empty_text' });

    await expect(
      encryptMessage({
        text: 'hello',
        conversationId: CONVERSATION_ID,
        messageId: crypto.randomUUID(),
        senderId: ALICE,
        senderDeviceId: alice.deviceId,
        senderPrivateKey: alice.privateKey,
        senderPublicKey: alice.publicKey,
        recipients: [],
      }),
    ).rejects.toMatchObject({ code: 'no_recipients' });
  });
});
