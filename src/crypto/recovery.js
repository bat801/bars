import { AppError } from '../core/errors.js';
import {
  base64ToBytes,
  bytesToBase64,
  toBytes,
  utf8,
  utf8Decode,
} from './encoding.js';

/**
 * Recovery kit backup v1.
 *
 * The recovery private key is exported once, serialized as JSON and encrypted
 * with AES-256-GCM under a PBKDF2-SHA256 key derived from a user passphrase.
 * Only this ciphertext (plus KDF parameters) is stored in key_backups and in
 * the downloadable kit file. The server never sees the passphrase or the key.
 */

export const RECOVERY_VERSION = 1;
export const RECOVERY_KDF = 'PBKDF2-SHA256';
export const RECOVERY_ITERATIONS = 600000;
export const MIN_RECOVERY_PASSPHRASE = 12;

const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 5000000;

function recoveryAad(userId) {
  return utf8(`bars:v1:recovery:${userId}`);
}

function normalizePassphrase(passphrase) {
  return String(passphrase).normalize('NFKC');
}

async function deriveBackupKey(passphrase, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    utf8(normalizePassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function validateBackup(backup) {
  if (
    !backup ||
    Number(backup.version) !== RECOVERY_VERSION ||
    backup.kdf !== RECOVERY_KDF ||
    typeof backup.salt !== 'string' ||
    typeof backup.iv !== 'string' ||
    typeof backup.ciphertext !== 'string'
  ) {
    throw new AppError('invalid_recovery_kit', 'Invalid recovery kit');
  }

  const iterations = Number(backup.kdfIterations ?? backup.kdf_iterations);
  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    throw new AppError('invalid_recovery_kit', 'Invalid KDF parameters');
  }

  return iterations;
}

export async function encryptRecoverySecret({ passphrase, userId, secret }) {
  if (!userId) {
    throw new AppError('invalid_recovery_kit', 'Missing user id');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, RECOVERY_ITERATIONS);
  const plaintext = utf8(JSON.stringify(secret));

  let ciphertext;
  try {
    ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: recoveryAad(userId),
        tagLength: 128,
      },
      key,
      plaintext,
    );
  } finally {
    plaintext.fill(0);
  }

  return {
    version: RECOVERY_VERSION,
    kdf: RECOVERY_KDF,
    kdfIterations: RECOVERY_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptRecoverySecret({ passphrase, userId, backup }) {
  if (!userId) {
    throw new AppError('invalid_recovery_kit', 'Missing user id');
  }

  const iterations = validateBackup(backup);
  const salt = base64ToBytes(backup.salt);
  const iv = base64ToBytes(backup.iv);
  const key = await deriveBackupKey(passphrase, salt, iterations);

  let plaintext;
  try {
    plaintext = toBytes(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: recoveryAad(userId),
          tagLength: 128,
        },
        key,
        base64ToBytes(backup.ciphertext),
      ),
    );
  } catch {
    throw new AppError(
      'recovery_bad_passphrase',
      'The recovery passphrase is incorrect',
    );
  }

  let secret;
  try {
    secret = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw new AppError('invalid_recovery_kit', 'Recovery payload is damaged');
  } finally {
    plaintext.fill(0);
  }

  if (
    !secret ||
    Number(secret.v) !== RECOVERY_VERSION ||
    secret.userId !== userId ||
    typeof secret.deviceId !== 'string' ||
    !secret.privateJwk ||
    !secret.publicJwk
  ) {
    throw new AppError('invalid_recovery_kit', 'Recovery payload is invalid');
  }

  return secret;
}
