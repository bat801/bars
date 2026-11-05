import { h } from '../core/dom.js';
import { icon } from './icons.js';

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = h('div', {
    class: 'toast-stack',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
  });
  document.body.appendChild(container);
  return container;
}

export function toast(message, kind = 'info') {
  const host = ensureContainer();
  const iconName = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'shield';

  const node = h(
    'div',
    { class: `toast toast--${kind}` },
    h('span', { class: 'toast-icon', html: icon(iconName) }),
    h('span', { class: 'toast-text', text: message }),
  );

  host.appendChild(node);

  const remove = () => {
    node.classList.add('toast--out');
    window.setTimeout(() => node.remove(), 220);
  };

  const timer = window.setTimeout(remove, 4200);
  node.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
  });
}
