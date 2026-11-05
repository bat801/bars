const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value) {
  return encoder.encode(value);
}

export function utf8Decode(value) {
  return decoder.decode(value);
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Unsupported binary value');
}

export function bytesToBase64(value) {
  const bytes = toBytes(value);
  const chunk = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }

  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
