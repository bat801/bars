import { humanizeError } from '../../core/errors.js';
import { icon, logoMark } from '../../components/icons.js';
import { toast } from '../../components/toast.js';

const POLL_INTERVAL = 6000;

/**
 * Shown when the account is active but this browser device is waiting for an
 * approval from an already trusted device. Polling only reads the device row,
 * which RLS exposes to its owner even while the device is pending.
 */
export class PendingView {
  constructor({ profile, email, device, code, onCheck, onCancel, onLogout }) {
    this.profile = profile;
    this.email = email;
    this.device = device;
    this.code = code;
    this.onCheck = onCheck;
    this.onCancel = onCancel;
    this.onLogout = onLogout;
    this.timer = null;
    this.destroyed = false;
    this.checking = false;
  }

  mount(root) {
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

          <div class="access-icon access-icon--pending" aria-hidden="true">${icon('clock')}</div>
          <h1 class="access-title">Ожидает подтверждения</h1>
          <p class="access-message">
            Аккаунт уже привязан к другому устройству. Откройте BARS на нём,
            зайдите в настройки и одобрите запрос на подключение.
          </p>

          <div class="device-approval">
            <span class="device-approval-label">Код устройства</span>
            <span class="device-approval-code" id="pending-code"></span>
            <span class="device-approval-name" id="pending-name"></span>
          </div>

          <p class="access-message access-message--hint">
            Код на этом экране должен совпадать с кодом в запросе на другом
            устройстве. Не одобряйте запрос, если коды отличаются.
          </p>
          <p class="access-identity" id="pending-identity"></p>
          <p class="pending-status" id="pending-status" role="status"></p>

          <div class="access-actions">
            <button class="btn btn-primary" type="button" data-action="check">
              <span class="btn-label">Проверить снова</span>
              <span class="spinner spinner--sm" aria-hidden="true"></span>
            </button>
            <button class="btn btn-ghost" type="button" data-action="cancel">
              Отменить запрос
            </button>
            <button class="btn btn-ghost" type="button" data-action="logout">
              Выйти
            </button>
          </div>

          <footer class="auth-footer auth-footer--single">
            <span class="pill">${icon('clock')} Проверяем автоматически</span>
          </footer>
        </main>
      </div>
    `;

    this.root = root;
    this.codeEl = root.querySelector('#pending-code');
    this.nameEl = root.querySelector('#pending-name');
    this.identityEl = root.querySelector('#pending-identity');
    this.statusEl = root.querySelector('#pending-status');
    this.checkButton = root.querySelector('[data-action="check"]');
    this.checkLabel = this.checkButton.querySelector('.btn-label');
    this.cancelButton = root.querySelector('[data-action="cancel"]');
    this.logoutButton = root.querySelector('[data-action="logout"]');

    this.codeEl.textContent = this.code || '—';
    this.nameEl.textContent = this.device.name || 'Это устройство';
    this.identityEl.textContent = identity;

    this.checkButton.addEventListener('click', () => void this.check());
    this.cancelButton.addEventListener('click', () => void this.cancel());
    this.logoutButton.addEventListener('click', () => this.onLogout?.());

    this.timer = window.setInterval(() => {
      void this.check({ silent: true });
    }, POLL_INTERVAL);
  }

  async check({ silent = false } = {}) {
    if (this.destroyed || this.checking) return;
    this.checking = true;

    if (!silent) {
      this.checkButton.classList.add('is-loading');
      this.checkButton.disabled = true;
      this.checkLabel.textContent = 'Проверяем…';
      this.statusEl.textContent = '';
    }

    try {
      const result = await this.onCheck?.();
      if (this.destroyed) return;

      if (result?.status === 'pending') {
        this.statusEl.textContent = 'Пока не подтверждено. Проверьте код на другом устройстве.';
      }
    } catch (error) {
      if (this.destroyed) return;

      if (silent) {
        this.statusEl.textContent = 'Нет связи с сервером. Попробуем ещё раз.';
      } else {
        toast(
          humanizeError(error, 'Не удалось проверить статус устройства.'),
          'error',
        );
      }
    } finally {
      this.checking = false;

      if (!this.destroyed) {
        this.checkButton.classList.remove('is-loading');
        this.checkButton.disabled = false;
        this.checkLabel.textContent = 'Проверить снова';
      }
    }
  }

  async cancel() {
    if (
      !window.confirm(
        'Отменить запрос на подключение этого устройства? Ключ устройства будет удалён, и при следующем входе потребуется новое одобрение.',
      )
    ) {
      return;
    }

    this.cancelButton.disabled = true;
    this.cancelButton.textContent = 'Отменяем…';

    try {
      await this.onCancel?.();
    } catch (error) {
      if (this.destroyed) return;
      toast(humanizeError(error, 'Не удалось отменить запрос.'), 'error');
      this.cancelButton.disabled = false;
      this.cancelButton.textContent = 'Отменить запрос';
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
