import { describe, expect, it } from 'vitest';
import { renderSVG } from 'uqr';
import {
  approvalLink,
  parseApprovalHash,
} from '../src/core/approval-link.js';

const DEVICE_ID = '6f1c2f0a-9d4e-4f5a-8b3c-2d1e0f9a8b7c';
const ORIGIN = 'https://bat801.github.io';
const PATHNAME = '/bars/';

describe('approval links', () => {
  it('builds a link that contains only the public device id', () => {
    const link = approvalLink(DEVICE_ID, {
      origin: ORIGIN,
      pathname: PATHNAME,
    });

    expect(link).toBe(`${ORIGIN}${PATHNAME}#/approve/${DEVICE_ID}`);
    expect(link.split('#/approve/')[1]).toBe(DEVICE_ID);
  });

  it('parses a valid approval hash and normalizes the id', () => {
    expect(parseApprovalHash(`#/approve/${DEVICE_ID}`)).toBe(DEVICE_ID);
    expect(parseApprovalHash(`#/approve/${DEVICE_ID.toUpperCase()}`)).toBe(
      DEVICE_ID,
    );
  });

  it('rejects malformed or unrelated hashes', () => {
    expect(parseApprovalHash('#/chat')).toBeNull();
    expect(parseApprovalHash('#/approve/not-a-uuid')).toBeNull();
    expect(parseApprovalHash(`#/approve/${DEVICE_ID}/extra`)).toBeNull();
    expect(parseApprovalHash('')).toBeNull();
  });

  it('renders a QR svg for the approval link without embedding its text', () => {
    const link = approvalLink(DEVICE_ID, {
      origin: ORIGIN,
      pathname: PATHNAME,
    });

    const svg = renderSVG(link, {
      ecc: 'M',
      border: 2,
      pixelSize: 6,
      blackColor: '#120a20',
      whiteColor: '#ffffff',
    });

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
    expect(svg).not.toContain(DEVICE_ID);
  });
});
