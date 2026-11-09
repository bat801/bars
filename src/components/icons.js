const stroke = (body, className = 'icon') =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const paths = {
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.8"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/><path d="M12 14.5v2.2"/>',
  send: '<path d="M12 19V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/>',
  back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  settings:
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  devices:
    '<rect x="2.5" y="4" width="13" height="10" rx="2"/><path d="M7 20h12"/><path d="M10.5 17h5"/><rect x="17" y="11" width="4.5" height="9" rx="1.4"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 6.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 9v4.2"/><path d="M12 16.8h.01"/>',
  close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="m3 3 18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.8"/><path d="M6.1 6.1C3.8 7.9 2.5 12 2.5 12S6 18 12 18a9.6 9.6 0 0 0 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  shield:
    '<path d="M12 2.8 4.5 6v5.4c0 4.7 3.2 8.3 7.5 9.8 4.3-1.5 7.5-5.1 7.5-9.8V6L12 2.8Z"/><path d="m8.8 12 2.1 2.1 4.3-4.3"/>',
  refresh:
    '<path d="M20 11a8 8 0 0 0-14.7-4.5L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.7 4.5L21 15"/><path d="M21 20v-5h-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.3 11.7 8.2-8.2"/><path d="m16.5 6.5 2.5 2.5"/><path d="m14 9 2 2"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  dots: '<circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};

export function icon(name, className = 'icon') {
  const body = paths[name];
  if (!body) return '';
  return stroke(body, className);
}

export const logoMark = `
<svg class="brand-mark-svg" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="bars-logo-bg" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8B5CF6"/>
      <stop offset="1" stop-color="#4C2A85"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="9" fill="url(#bars-logo-bg)"/>
  <rect x="7.5" y="14" width="3.6" height="11" rx="1.8" fill="#F5F0FF" opacity="0.94"/>
  <rect x="14.2" y="7" width="3.6" height="18" rx="1.8" fill="#F5F0FF"/>
  <rect x="20.9" y="11" width="3.6" height="14" rx="1.8" fill="#F5F0FF" opacity="0.94"/>
</svg>`;
