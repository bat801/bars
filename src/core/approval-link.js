/**
 * Approval links only carry the public device id. They are a convenience for
 * moving the request to an already trusted device; approving still requires an
 * active session and an explicit confirmation through `approve_device`.
 */

const DEVICE_ID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const APPROVAL_HASH = new RegExp(`^#/approve/(${DEVICE_ID})/?$`, 'i');

export function approvalLink(deviceId, location = globalThis.location) {
  const suffix = `#/approve/${deviceId}`;

  if (!location?.origin) return suffix;

  return `${location.origin}${location.pathname}${suffix}`;
}

export function parseApprovalHash(hash) {
  const match = APPROVAL_HASH.exec(hash ?? '');
  return match ? match[1].toLowerCase() : null;
}
