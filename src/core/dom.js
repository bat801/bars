/**
 * Tiny DOM helpers. User-controlled strings must only be passed through
 * `text` or as TextNodes — never through `html`.
 */

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      // Static markup only. Every caller in this project passes a constant.
      node.innerHTML = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style') {
      for (const [name, styleValue] of Object.entries(value)) {
        if (name.startsWith('--')) node.style.setProperty(name, styleValue);
        else node.style[name] = styleValue;
      }
    } else if (key === 'attrs') {
      for (const [name, attrValue] of Object.entries(value)) {
        if (attrValue === null || attrValue === undefined || attrValue === false) {
          continue;
        }
        node.setAttribute(name, attrValue === true ? '' : String(attrValue));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function setText(node, value) {
  if (node) node.textContent = value ?? '';
}

export function setHidden(node, hidden) {
  if (!node) return;
  node.toggleAttribute('hidden', Boolean(hidden));
}
