import '@fontsource-variable/manrope';
import './styles/index.css';
import { App } from './app/app.js';

const root = document.getElementById('app');

if (!root) {
  throw new Error('Application root is missing');
}

const app = new App(root);

app.start().catch((error) => {
  console.error('[BARS] Failed to start', error);
  root.innerHTML = '';
  const fallback = document.createElement('div');
  fallback.className = 'noscript';
  fallback.textContent =
    'Не удалось запустить BARS. Обновите страницу или проверьте соединение.';
  root.appendChild(fallback);
});
