import { AppError } from '../core/errors.js';

export const EC_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };

export function hasWebCrypto() {
  return Boolean(globalThis.crypto?.subtle);
}

export function assertWebCrypto() {
  if (!hasWebCrypto()) {
    throw new AppError(
      'secure_context_required',
      'Web Crypto is unavailable. HTTPS or localhost is required.',
    );
  }
}

/**
 * Generates a device identity key pair.
 * The private key is non-extractable: it can be used for ECDH, but its bytes
 * can never be read by JavaScript again, even by this application.
 */
export async function generateDeviceKeys() {
  assertWebCrypto();

  const pair = await crypto.subtle.generateKey(EC_ALGORITHM, false, ['deriveBits']);
  const publicJwk = await exportPublicJwk(pair.publicKey);

  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
  };
}

export async function exportPublicJwk(publicKey) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  return {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
  };
}

export async function importPublicJwk(jwk) {
  if (
    !jwk ||
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    throw new AppError('invalid_public_key', 'Invalid P-256 public key');
  }

  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    EC_ALGORITHM,
    true,
    [],
  );
}

export function publicJwkMatches(a, b) {
  return Boolean(
    a &&
      b &&
      a.kty === b.kty &&
      a.crv === b.crv &&
      a.x === b.x &&
      a.y === b.y,
  );
}
