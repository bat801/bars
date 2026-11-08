/**
 * Short human-verifiable fingerprint of a device public key.
 *
 * The same key material is shown on the pending device and in the approval
 * request on an active device. Comparing the two codes proves that the
 * approved request belongs to the device the user is holding; the code is not
 * a secret and is derived only from the public JWK.
 */

// Crockford-style alphabet without 0/O and 1/I to avoid reading mistakes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

export async function deviceApprovalCode(publicJwk) {
  const x = publicJwk?.x;
  const y = publicJwk?.y;

  if (!x || !y) return '';

  const material = `P-256:${x}:${y}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(material),
    ),
  );

  let buffer = 0;
  let bits = 0;
  let code = '';

  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5 && code.length < CODE_LENGTH) {
      bits -= 5;
      code += ALPHABET[(buffer >>> bits) & 31];
    }

    if (code.length === CODE_LENGTH) break;

    // Drop consumed bits so the buffer never exceeds 12 bits between bytes.
    buffer &= (1 << bits) - 1;
  }

  return code.match(/.{4}/g)?.join('-') ?? code;
}
