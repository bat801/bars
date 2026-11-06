import { AppError } from '../core/errors.js';
import {
  generateDeviceKeys,
  importPublicJwk,
  publicJwkMatches,
} from '../crypto/keys.js';
import {
  deleteIdentity,
  loadIdentity,
  saveIdentity,
} from '../crypto/keystore.js';
import * as devices from './devices.js';

const IDENTITY_ERRORS = [
  'session_required',
  'session_revoked',
  'session_device_mismatch',
  'session_conflict',
  'device_revoked',
  'device_conflict',
  'device_limit',
  'invalid_public_key',
  'invalid_device_name',
  'access_denied',
];

/**
 * PostgREST returns a SQLSTATE in `error.code` and the raised text in
 * `error.message`. The client needs the stable message token, so convert it
 * into an AppError before the session lifecycle inspects it.
 */
function toIdentityError(error) {
  if (error instanceof AppError) return error;

  const message = String(error?.message ?? '');
  const code = IDENTITY_ERRORS.find((token) => message.includes(token));

  return code ? new AppError(code, message) : error;
}

/**
 * Resolves the local device identity:
 * 1. reuse a stored non-extractable key if the server still knows the device;
 * 2. otherwise generate a new P-256 key pair and register its public key.
 *
 * Private keys never leave IndexedDB-backed CryptoKey objects.
 */
export async function ensureDeviceIdentity(userId) {
  const local = await loadIdentity(userId);

  if (local) {
    const server = await devices.getDevice(local.deviceId);

    // A revoked device must not silently mint a replacement identity on reload.
    // The device's Supabase sessions are revoked server-side as well, but the
    // honest client stops before making any RLS-protected request.
    if (server && server.status === 'revoked') {
      throw new AppError(
        'device_revoked',
        'This device has been revoked',
      );
    }

    if (
      server &&
      server.status === 'active' &&
      publicJwkMatches(server.public_key_jwk, local.publicJwk) &&
      local.privateKey
    ) {
      const publicKey =
        local.publicKey ?? (await importPublicJwk(local.publicJwk));
      const identity = { ...local, publicKey };

      if (!local.publicKey) await saveIdentity(identity);

      // Registering refreshes last_seen_at and, crucially, binds the current
      // Supabase session to this device. It must succeed before the app makes
      // any RLS-protected request, so this call is intentionally awaited.
      try {
        await devices.registerDevice({
          deviceId: local.deviceId,
          name: local.name,
          publicJwk: local.publicJwk,
        });
      } catch (error) {
        throw toIdentityError(error);
      }

      return identity;
    }

    await deleteIdentity(userId);
  }

  const keys = await generateDeviceKeys();
  const deviceId = crypto.randomUUID();
  const name = detectDeviceName();

  let registered;
  try {
    registered = await devices.registerDevice({
      deviceId,
      name,
      publicJwk: keys.publicJwk,
    });
  } catch (error) {
    throw toIdentityError(error);
  }

  if (!registered?.id) {
    throw new AppError(
      'device_registration_failed',
      'Device registration returned no row',
    );
  }

  const identity = {
    userId,
    deviceId,
    name,
    publicJwk: keys.publicJwk,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: new Date().toISOString(),
  };

  await saveIdentity(identity);
  return identity;
}

export function detectDeviceName() {
  if (typeof navigator === 'undefined') return 'Браузер';

  const ua = navigator.userAgent || '';
  let platform = 'Браузер';

  if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  let browser = 'Браузер';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return `${browser} · ${platform}`;
}
