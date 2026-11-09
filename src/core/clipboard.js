/**
 * Copies text with the async Clipboard API when available and falls back to a
 * hidden textarea for older browsers or non-secure contexts.
 */
export async function copyText(text) {
  const value = String(text ?? '');

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission can be denied even on HTTPS; try the legacy path.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
