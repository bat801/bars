import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from '@hpke/core';

/**
 * RFC 9180 HPKE, ciphersuite P-256 / HKDF-SHA256 / AES-256-GCM.
 * Auth mode is used for message envelopes: only the holder of the sender
 * device's private key can create a key envelope accepted as that sender.
 */
export const hpke = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export const HPKE_INFO_PREFIX = 'bars/v1/key';
