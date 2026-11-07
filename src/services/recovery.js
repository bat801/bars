import { AppError } from '../core/errors.js';
import {
  MIN_RECOVERY_PASSPHRASE,
  RECOVERY_VERSION,
  decryptRecoverySecret,
  encryptRecoverySecret,
} from '../crypto/recovery.js';
import {
  generateRecoveryKeys,
  importPrivateJwk,
  importPublicJwk,
  publicJwkMatches,
} from '../crypto/keys.js';
import {
  loadRecoveryIdentity,
  saveRecoveryIdentity,
} from '../crypto/keystore.js';
import {
  getMyRecoveryDevice,
  registerRecoveryKey,
  revokeDevice,
} from './devices.js';
import { supabase } from './supabase.js';

const RECOVERY_ERRORS = [
  'recovery_exists',
  'recovery_revoked',
  'recovery_mismatch',
  'recovery_bad_passphrase',
  'recovery_not_found',
  'recovery_backup_failed',
  'invalid_recovery_kit',
  'invalid_recovery_key',
  'invalid_public_key',
  'device_conflict',
  'access_denied',
  'not_authenticated',
  'session_required',
  'session_revoked',
  'session_device_mismatch',
  'session_conflict',
];

function toRecoveryError(error, fallbackCode = null) {
  if (error instanceof AppError) return error;

  const message = String(error?.message ?? '');
  const code = RECOVERY_ERRORS.find((token) => message.includes(token));

  if (code) return new AppError(code, message);
  if (fallbackCode) return new AppError(fallbackCode, message);
  return error;
}

function assertPassphrase(passphrase) {
  const normalized = String(passphrase ?? '').normalize('NFKC');
  if (normalized.length < MIN_RECOVERY_PASSPHRASE) {
    throw new AppError(
      'recovery_weak_passphrase',
      `Recovery passphrase must be at least ${MIN_RECOVERY_PASSPHRASE} characters`,
    );
  }
  return normalized;
}

function normalizeBackupRow(row) {
  return {
    version: Number(row.version),
    kdf: row.kdf,
    kdfIterations: Number(row.kdf_iterations),
    salt: row.salt,
    iv: row.iv,
    ciphertext: row.ciphertext,
  };
}

function normalizeKit(kit) {
  let value = kit;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AppError('invalid_recovery_kit', 'Recovery kit is not JSON');
    }
  }

  if (!value || typeof value !== 'object') {
    throw new AppError('invalid_recovery_kit', 'Recovery kit is empty');
  }

  return {
    version: Number(value.v ?? value.version),
    kdf: value.kdf,
    kdfIterations: Number(value.kdfIterations ?? value.kdf_iterations),
    salt: value.salt,
    iv: value.iv,
    ciphertext: value.ciphertext,
    userId: value.userId ?? null,
  };
}

function buildKit(userId, backup) {
  return {
    v: RECOVERY_VERSION,
    userId,
    kdf: backup.kdf,
    kdfIterations: backup.kdfIterations,
    salt: backup.salt,
    iv: backup.iv,
    ciphertext: backup.ciphertext,
  };
}

async function fetchBackupRow(userId) {
  const { data, error } = await supabase
    .from('key_backups')
    .select('version, kdf, kdf_iterations, salt, iv, ciphertext')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw toRecoveryError(error);
  return data ? normalizeBackupRow(data) : null;
}

async function storeBackup(userId, backup) {
  const { error } = await supabase.from('key_backups').upsert(
    {
      user_id: userId,
      version: backup.version,
      kdf: backup.kdf,
      kdf_iterations: backup.kdfIterations,
      salt: backup.salt,
      iv: backup.iv,
      ciphertext: backup.ciphertext,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) throw toRecoveryError(error, 'recovery_backup_failed');
}

export function getRecoveryIdentity(userId) {
  return loadRecoveryIdentity(userId);
}

export async function createRecoveryKit({ userId, passphrase }) {
  const normalizedPassphrase = assertPassphrase(passphrase);

  const existingDevice = await getMyRecoveryDevice(userId);
  const existingBackup = await fetchBackupRow(userId);

  // A previous attempt may have registered the key but failed to upload the
  // backup. That key can never be used, so replace it instead of bricking
  // recovery. A real key with a backup is never touched here.
  if (existingDevice && !existingBackup) {
    try {
      await revokeDevice(existingDevice.id);
    } catch (error) {
      throw toRecoveryError(error);
    }
  } else if (existingDevice) {
    throw new AppError(
      'recovery_exists',
      'A recovery key already exists for this account',
    );
  }

  const keys = await generateRecoveryKeys();
  const deviceId = crypto.randomUUID();
  const secret = {
    v: RECOVERY_VERSION,
    userId,
    deviceId,
    publicJwk: keys.publicJwk,
    privateJwk: keys.privateJwk,
  };

  const backup = await encryptRecoverySecret({
    passphrase: normalizedPassphrase,
    userId,
    secret,
  });

  let registered;
  try {
    registered = await registerRecoveryKey({
      deviceId,
      publicJwk: keys.publicJwk,
    });
  } catch (error) {
    throw toRecoveryError(error);
  }

  try {
    await storeBackup(userId, backup);
  } catch (error) {
    // Never leave an active recovery public key without a usable backup.
    try {
      await revokeDevice(registered.id);
    } catch {
      // The administrator can revoke the orphan row manually.
    }
    throw error;
  }

  const identity = {
    userId,
    deviceId,
    name: 'Ключ восстановления',
    publicJwk: keys.publicJwk,
    publicKey: await importPublicJwk(keys.publicJwk),
    privateKey: await importPrivateJwk(keys.privateJwk),
    createdAt: new Date().toISOString(),
  };

  await saveRecoveryIdentity(identity);

  return {
    identity,
    backup,
    kit: buildKit(userId, backup),
  };
}

export async function restoreRecoveryKit({ userId, passphrase, kit = null }) {
  const normalizedPassphrase = assertPassphrase(passphrase);
  const incoming = kit ? normalizeKit(kit) : null;

  if (incoming?.userId && incoming.userId !== userId) {
    throw new AppError(
      'invalid_recovery_kit',
      'This recovery kit belongs to another account',
    );
  }

  const backup = incoming ?? (await fetchBackupRow(userId));
  if (!backup) {
    throw new AppError(
      'recovery_not_found',
      'No recovery backup exists on the server',
    );
  }

  const secret = await decryptRecoverySecret({
    passphrase: normalizedPassphrase,
    userId,
    backup,
  });

  const serverDevice = await getMyRecoveryDevice(userId);

  if (serverDevice) {
    if (serverDevice.id !== secret.deviceId) {
      throw new AppError(
        'recovery_mismatch',
        'Another recovery key is active on the server',
      );
    }
    if (!publicJwkMatches(serverDevice.public_key_jwk, secret.publicJwk)) {
      throw new AppError(
        'recovery_mismatch',
        'Recovery public key does not match the server',
      );
    }
  } else {
    try {
      await registerRecoveryKey({
        deviceId: secret.deviceId,
        publicJwk: secret.publicJwk,
      });
    } catch (error) {
      throw toRecoveryError(error);
    }
  }

  const identity = {
    userId,
    deviceId: secret.deviceId,
    name: 'Ключ восстановления',
    publicJwk: secret.publicJwk,
    publicKey: await importPublicJwk(secret.publicJwk),
    privateKey: await importPrivateJwk(secret.privateJwk),
    createdAt: new Date().toISOString(),
  };

  await saveRecoveryIdentity(identity);
  return identity;
}

export async function downloadRecoveryKit(userId) {
  const backup = await fetchBackupRow(userId);
  if (!backup) {
    throw new AppError(
      'recovery_not_found',
      'No recovery backup exists on the server',
    );
  }
  return buildKit(userId, backup);
}

export function recoveryKitFilename(username) {
  const safe = String(username ?? 'bars').replace(/[^a-z0-9_]+/gi, '_');
  return `bars-recovery-${safe}.json`;
}
