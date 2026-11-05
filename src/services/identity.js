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
    // The Supabase session is still valid until M1.5 adds session binding, so
    // the honest client stops here and asks the user to use another device.
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

      // Refresh last_seen_at without blocking startup.
      devices
        .registerDevice({
          deviceId: local.deviceId,
          name: local.name,
          publicJwk: local.publicJwk,
        })
        .catch(() => {});

      return identity;
    }

    await deleteIdentity(userId);
  }

  const keys = await generateDeviceKeys();
  const deviceId = crypto.randomUUID();
  const name = detectDeviceName();

  const registered = await devices.registerDevice({
    deviceId,
    name,
    publicJwk: keys.publicJwk,
  });

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
