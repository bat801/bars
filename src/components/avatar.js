import { h } from '../core/dom.js';
import { initials } from '../core/format.js';

export function avatar(name, { size = 'md', className = '' } = {}) {
  const hue = hash(String(name ?? '')) % 360;

  return h(
    'span',
    {
      class: `avatar avatar--${size} ${className}`.trim(),
      style: { '--avatar-hue': String(hue) },
      attrs: { 'aria-hidden': 'true' },
    },
    h('span', { class: 'avatar-initials', text: initials(name) }),
  );
}

function hash(value) {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = (result * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(result);
}
