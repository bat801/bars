import { AppError } from '../core/errors.js';
import { CRYPTO_VERSION } from '../core/config.js';
import {
  base64ToBytes,
  bytesToBase64,
  toBytes,
  utf8,
  utf8Decode,
} from './encoding.js';
import { hpke, HPKE_INFO_PREFIX } from './hpke.js';

/**
 * BARS Envelope v1.
 *
 * Payload: AES-256-GCM with a random one-time content key.
 * Content key: wrapped for every recipient device with HPKE Auth (RFC 9180).
 * AAD: binds ciphertext and envelopes to conversation, message, sender and type.
 */

export function buildMessageAad({
  conversationId,
  messageId,
  senderId,
  senderDeviceId,
  type,
}) {
  const values = [conversationId, messageId, senderId, senderDeviceId, type];
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new AppError('invalid_message', 'Incomplete message header');
  }

  return utf8(`bars:v1:message:${values.join(':')}`);
}

export function keyInfo(messageId, deviceId) {
  return utf8(`${HPKE_INFO_PREFIX}:${messageId}:${deviceId}`);
}

export async function encryptMessage({
  text,
  conversationId,
  messageId,
  senderId,
  senderDeviceId,
  senderPrivateKey,
  senderPublicKey,
  recipients,
}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new AppError('empty_text', 'Message text is empty');
  }

  if (!senderPrivateKey || !senderPublicKey) {
    throw new AppError(
      'invalid_sender_device',
      'Sender device key pair is missing',
    );
  }

  const uniqueRecipients = new Map();
  for (const recipient of recipients ?? []) {
    if (!recipient?.deviceId || !recipient?.publicKey) continue;
    uniqueRecipients.set(recipient.deviceId, recipient);
  }

  if (uniqueRecipients.size === 0) {
    throw new AppError('no_recipients', 'No recipient devices');
  }

  const aad = buildMessageAad({
    conversationId,
    messageId,
    senderId,
    senderDeviceId,
    type: 'text',
  });

  const contentKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  );
  const rawContentKey = toBytes(
    await crypto.subtle.exportKey('raw', contentKey),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = utf8(JSON.stringify({ v: CRYPTO_VERSION, kind: 'text', text }));

  let ciphertext;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      contentKey,
      payload,
    );
  } finally {
    payload.fill(0);
  }

  const keys = [];

  try {
    for (const recipient of uniqueRecipients.values()) {
      const info = keyInfo(messageId, recipient.deviceId);
      const sender = await hpke.createSenderContext({
        recipientPublicKey: recipient.publicKey,
        // @hpke derives the sender public key from the private key when only a
        // CryptoKey is provided. That derivation cannot recover the y-coordinate
        // sign of a non-extractable P-256 key, so always pass the key pair.
        senderKey: {
          privateKey: senderPrivateKey,
          publicKey: senderPublicKey,
        },
        info,
      });
      const wrapped = await sender.seal(rawContentKey, aad);

      keys.push({
        deviceId: recipient.deviceId,
        enc: bytesToBase64(sender.enc),
        wrappedKey: bytesToBase64(wrapped),
      });
    }
  } finally {
    rawContentKey.fill(0);
  }

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    keys,
  };
}

export async function decryptMessage({
  message,
  envelope,
  senderPublicKey,
  privateKey,
  publicKey,
  deviceId,
}) {
  if (Number(message.crypto_version) !== CRYPTO_VERSION) {
    throw new AppError(
      'unsupported_crypto_version',
      `Unsupported crypto version: ${message.crypto_version}`,
    );
  }

  if (!envelope?.enc || !envelope?.wrapped_key) {
    throw new AppError('invalid_keys', 'Key envelope is missing');
  }

  if (!senderPublicKey) {
    throw new AppError('invalid_sender_device', 'Sender public key is missing');
  }

  if (!privateKey || !publicKey) {
    throw new AppError(
      'invalid_sender_device',
      'Recipient device key pair is missing',
    );
  }

  const aad = buildMessageAad({
    conversationId: message.conversation_id,
    messageId: message.id,
    senderId: message.sender_id,
    senderDeviceId: message.sender_device_id,
    type: message.type,
  });

  const info = keyInfo(message.id, deviceId);
  const recipient = await hpke.createRecipientContext({
    recipientKey: { privateKey, publicKey },
    enc: base64ToBytes(envelope.enc),
    senderPublicKey,
    info,
  });

  const rawContentKey = toBytes(
    await recipient.open(base64ToBytes(envelope.wrapped_key), aad),
  );

  let contentKey;
  try {
    contentKey = await crypto.subtle.importKey(
      'raw',
      rawContentKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
  } finally {
    rawContentKey.fill(0);
  }

  const plaintext = toBytes(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(message.iv),
        additionalData: aad,
        tagLength: 128,
      },
      contentKey,
      base64ToBytes(message.ciphertext),
    ),
  );

  let payload;
  try {
    payload = JSON.parse(utf8Decode(plaintext));
  } finally {
    plaintext.fill(0);
  }

  if (
    !payload ||
    payload.v !== CRYPTO_VERSION ||
    payload.kind !== 'text' ||
    typeof payload.text !== 'string'
  ) {
    throw new AppError('invalid_payload', 'Unexpected message payload');
  }

  return payload.text;
}
