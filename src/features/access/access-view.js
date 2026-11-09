import { icon, logoMark } from '../../components/icons.js';

export class AccessView {
  constructor({ profile, email, reason = null, onRetry, onLogout, onReset }) {
    this.profile = profile;
    this.email = email;
    this.reason = reason;
    this.onRetry = onRetry;
    this.onLogout = onLogout;
    this.onReset = onReset;
  }

  mount(root) {
    const status = this.profile?.status;
    const revoked = this.reason === 'device_revoked';
    const sessionInvalid = this.reason === 'session_invalid';
    const terminal = revoked || sessionInvalid;
    const canReset = revoked && Boolean(this.onReset);
    let title = 'Доступ закрыт';
    let message =
      'Ваш аккаунт пока не активирован. Попросите администратора BARS выдать приглашение.';

    if (revoked) {
      title = 'Устройство отозвано';
      message =
        'Это устройство больше не авторизовано для чтения и отправки сообщений. Начните заново на этом браузере или используйте другое устройство.';
    } else if (sessionInvalid) {
      title = 'Сессия недействительна';
      message =
        'Эта сессия больше не привязана к текущему устройству или была завершена. Выйдите из аккаунта и войдите снова, чтобы создать новую привязку.';
    } else if (status === 'blocked') {
      title = 'Аккаунт заблокирован';
      message = 'Доступ приостановлен администратором. Если это ошибка — свяжитесь с ним напрямую.';
    } else if (!this.profile) {
      title = 'Профиль не найден';
      message =
        'Аккаунт существует, но профиль BARS ещё не создан. Напишите администратору.';
    }

    const identity = this.profile
      ? `@${this.profile.username}`
      : this.email || '';

    root.innerHTML = `
      <div class="auth">
        <div class="auth-glow auth-glow--one" aria-hidden="true"></div>
        <div class="auth-glow auth-glow--two" aria-hidden="true"></div>
        <div class="auth-grid" aria-hidden="true"></div>

        <main class="auth-card auth-card--access glass">
          <div class="brand brand--auth">
            <span class="brand-mark">${logoMark}</span>
            <span class="brand-text">
              <span class="brand-name">BARS</span>
              <span class="brand-caption">PRIVATE MESSENGER</span>
            </span>
          </div>

          <div class="access-icon" aria-hidden="true">${icon('shield')}</div>
          <h1 class="access-title"></h1>
          <p class="access-message"></p>
          <p class="access-identity"></p>

          <div class="access-actions">
            ${
              terminal
                ? ''
                : `<button class="btn btn-primary" type="button" data-action="retry">
              <span class="btn-label">Проверить снова</span>
              <span class="spinner spinner--sm" aria-hidden="true"></span>
            </button>`
            }
            ${
              canReset
                ? `<button class="btn btn-primary" type="button" data-action="reset">
              <span class="btn-label">Начать заново на этом браузере</span>
              <span class="spinner spinner--sm" aria-hidden="true"></span>
            </button>`
                : ''
            }
            <button class="btn btn-ghost" type="button" data-action="logout">Выйти</button>
          </div>

          <footer class="auth-footer auth-footer--single">
            <span class="pill">${icon('lock')} Данные не раскрываются</span>
          </footer>
        </main>
      </div>
    `;

    root.querySelector('.access-title').textContent = title;
    root.querySelector('.access-message').textContent = message;
    root.querySelector('.access-identity').textContent = identity;

    this.root = root;
    this.retry = root.querySelector('[data-action="retry"]');
    this.retryLabel = this.retry?.querySelector('.btn-label') ?? null;
    this.reset = root.querySelector('[data-action="reset"]');
    this.resetLabel = this.reset?.querySelector('.btn-label') ?? null;
    this.logout = root.querySelector('[data-action="logout"]');

    this.retry?.addEventListener('click', () => this.handleRetry());
    this.reset?.addEventListener('click', () => void this.handleReset());
    this.logout.addEventListener('click', () => this.onLogout?.());
  }

  async handleRetry() {
    if (!this.retry) return;
    this.retry.classList.add('is-loading');
    this.retry.disabled = true;
    this.retryLabel.textContent = 'Проверяем…';

    try {
      await this.onRetry?.();
    } finally {
      this.retry.classList.remove('is-loading');
      this.retry.disabled = false;
      this.retryLabel.textContent = 'Проверить снова';
    }
  }

  async handleReset() {
    if (!this.reset) return;

    if (
      !window.confirm(
        'Удалить ключ этого устройства и выйти? Следующий вход создаст новый запрос на подключение.',
      )
    ) {
      return;
    }

    this.reset.classList.add('is-loading');
    this.reset.disabled = true;
    this.resetLabel.textContent = 'Сбрасываем…';

    try {
      await this.onReset?.();
    } finally {
      if (document.contains(this.reset)) {
        this.reset.classList.remove('is-loading');
        this.reset.disabled = false;
        this.resetLabel.textContent = 'Начать заново на этом браузере';
      }
    }
  }

  destroy() {}
}
