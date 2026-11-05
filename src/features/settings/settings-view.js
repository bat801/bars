import { clear, h } from '../../core/dom.js';
import { humanizeError } from '../../core/errors.js';
import { formatDeviceDate, pluralRu } from '../../core/format.js';
import { MIN_PASSWORD_LENGTH } from '../../core/config.js';
import { icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { updateDisplayName } from '../../services/profiles.js';
import {
  listMyDevices,
  revokeDevice,
} from '../../services/devices.js';
import { updatePassword } from '../../services/auth.js';

export class SettingsView {
  constructor({
    profile,
    currentDeviceId,
    onClose,
    onProfileUpdated,
    onLogout,
  }) {
    this.profile = profile;
    this.currentDeviceId = currentDeviceId;
    this.onClose = onClose;
    this.onProfileUpdated = onProfileUpdated;
    this.onLogout = onLogout;

    this.closed = false;
    this.abort = null;
    this.previousFocus = null;
    this.previousOverflow = '';
    this.devices = [];
  }

  mount() {
    this.previousFocus = document.activeElement;
    this.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    this.abort = new AbortController();
    const { signal } = this.abort;

    this.overlay = h('div', { class: 'modal-backdrop' });
    this.overlay.innerHTML = `
      <section class="modal glass" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header class="modal-header">
          <div>
            <h2 id="settings-title">Настройки</h2>
            <p class="modal-subtitle" id="settings-username"></p>
          </div>
          <button class="icon-btn" type="button" data-action="close" aria-label="Закрыть настройки">
            ${icon('close')}
          </button>
        </header>

        <div class="modal-body">
          <section class="settings-section">
            <h3 class="settings-title">Профиль</h3>
            <form id="settings-profile-form" class="settings-form">
              <label class="field">
                <span class="field-label">Отображаемое имя</span>
                <input class="input" id="settings-name" maxlength="60" autocomplete="nickname" />
              </label>
              <button class="btn btn-secondary" type="submit">
                <span class="btn-label">Сохранить имя</span>
                <span class="spinner spinner--sm" aria-hidden="true"></span>
              </button>
            </form>
          </section>

          <section class="settings-section">
            <h3 class="settings-title">Шифрование</h3>
            <div class="security-note">
              <span class="security-note-icon" aria-hidden="true">${icon('shield')}</span>
              <div>
                <strong>End-to-end по умолчанию</strong>
                <p>Ключи хранятся только на устройствах. Сервер видит лишь шифротекст и не может прочитать переписку.</p>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-section-head">
              <h3 class="settings-title">Устройства</h3>
              <span class="muted-count" id="settings-devices-count"></span>
            </div>
            <div class="device-list" id="settings-devices"></div>
          </section>

          <section class="settings-section">
            <h3 class="settings-title">Смена пароля</h3>
            <form id="settings-password-form" class="settings-form">
              <label class="field">
                <span class="field-label">Новый пароль</span>
                <input class="input" id="settings-password" type="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" placeholder="Минимум ${MIN_PASSWORD_LENGTH} символов" />
              </label>
              <label class="field">
                <span class="field-label">Повторите пароль</span>
                <input class="input" id="settings-password-confirm" type="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" />
              </label>
              <button class="btn btn-secondary" type="submit">
                <span class="btn-label">Обновить пароль</span>
                <span class="spinner spinner--sm" aria-hidden="true"></span>
              </button>
            </form>
          </section>

          <section class="settings-section settings-section--danger">
            <button class="btn btn-ghost btn-block" type="button" data-action="logout">
              ${icon('logout')} Выйти из аккаунта
            </button>
            <p class="settings-hint">
              Ключ устройства останется в этом браузере. Чтобы вернуться, снова войдите с почтой и паролем.
            </p>
          </section>
        </div>
      </section>
    `;

    document.body.appendChild(this.overlay);

    this.modal = this.overlay.querySelector('.modal');
    this.usernameEl = this.overlay.querySelector('#settings-username');
    this.nameInput = this.overlay.querySelector('#settings-name');
    this.profileForm = this.overlay.querySelector('#settings-profile-form');
    this.passwordForm = this.overlay.querySelector('#settings-password-form');
    this.passwordInput = this.overlay.querySelector('#settings-password');
    this.passwordConfirm = this.overlay.querySelector(
      '#settings-password-confirm',
    );
    this.devicesEl = this.overlay.querySelector('#settings-devices');
    this.devicesCount = this.overlay.querySelector('#settings-devices-count');

    this.usernameEl.textContent = `@${this.profile.username}`;
    this.nameInput.value = this.profile.display_name;

    this.overlay.addEventListener(
      'click',
      (event) => this.handleClick(event),
      { signal },
    );
    this.overlay.addEventListener(
      'submit',
      (event) => this.handleSubmit(event),
      { signal },
    );
    document.addEventListener(
      'keydown',
      (event) => this.handleKeydown(event),
      { signal },
    );

    if (window.matchMedia('(pointer: fine)').matches) {
      requestAnimationFrame(() => this.nameInput.focus());
    }

    void this.loadDevices();
  }

  destroy() {
    this.teardown();
  }

  close() {
    if (this.closed) return;
    this.onClose?.();
    this.teardown();
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.abort = null;
    this.overlay?.remove();
    this.overlay = null;
    document.body.style.overflow = this.previousOverflow;

    if (
      this.previousFocus instanceof HTMLElement &&
      document.contains(this.previousFocus)
    ) {
      this.previousFocus.focus();
    }
  }

  handleClick(event) {
    if (event.target === this.overlay) {
      this.close();
      return;
    }

    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;

    switch (actionElement.dataset.action) {
      case 'close':
        this.close();
        break;
      case 'logout':
        if (window.confirm('Выйти из аккаунта на этом устройстве?')) {
          this.onLogout?.();
          this.close();
        }
        break;
      case 'revoke':
        void this.handleRevoke(
          actionElement.dataset.deviceId,
          actionElement.dataset.deviceName || 'это устройство',
        );
        break;
      default:
        break;
    }
  }

  handleSubmit(event) {
    event.preventDefault();

    if (event.target === this.profileForm) {
      void this.saveProfile();
    } else if (event.target === this.passwordForm) {
      void this.savePassword();
    }
  }

  handleKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = [
      ...this.modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.offsetParent !== null);

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async saveProfile() {
    const name = this.nameInput.value.trim();
    if (!name) {
      toast('Имя не может быть пустым.', 'error');
      return;
    }

    const button = this.profileForm.querySelector('button[type="submit"]');
    this.setBusy(button, true, 'Сохраняем…');

    try {
      const profile = await updateDisplayName(name);
      this.profile = { ...this.profile, ...profile };
      this.nameInput.value = profile.display_name;
      this.onProfileUpdated?.({
        display_name: profile.display_name,
        updated_at: profile.updated_at,
      });
      toast('Имя обновлено.', 'success');
    } catch (error) {
      toast(humanizeError(error, 'Не удалось сохранить имя.'), 'error');
    } finally {
      this.setBusy(button, false, 'Сохранить имя');
    }
  }

  async savePassword() {
    const password = this.passwordInput.value;
    const confirm = this.passwordConfirm.value;

    if (password.length < MIN_PASSWORD_LENGTH) {
      toast(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`, 'error');
      return;
    }

    if (password !== confirm) {
      toast('Пароли не совпадают.', 'error');
      return;
    }

    const button = this.passwordForm.querySelector('button[type="submit"]');
    this.setBusy(button, true, 'Обновляем…');

    try {
      await updatePassword(password);
      this.passwordInput.value = '';
      this.passwordConfirm.value = '';
      toast('Пароль обновлён.', 'success');
    } catch (error) {
      toast(humanizeError(error, 'Не удалось обновить пароль.'), 'error');
    } finally {
      this.setBusy(button, false, 'Обновить пароль');
    }
  }

  async loadDevices() {
    clear(this.devicesEl);
    this.devicesEl.appendChild(
      h(
        'div',
        { class: 'device-loading' },
        h('span', { class: 'spinner spinner--sm' }),
        h('span', { text: 'Загружаем устройства…' }),
      ),
    );

    try {
      this.devices = await listMyDevices(this.profile.id);
      this.renderDevices();
    } catch (error) {
      clear(this.devicesEl);
      this.devicesEl.appendChild(
        h(
          'div',
          { class: 'device-loading device-loading--error' },
          h('span', { text: humanizeError(error, 'Не удалось загрузить устройства.') }),
          h(
            'button',
            {
              class: 'text-btn',
              type: 'button',
              onClick: () => this.loadDevices(),
            },
            'Повторить',
          ),
        ),
      );
    }
  }

  renderDevices() {
    clear(this.devicesEl);
    const active = this.devices.filter(
      (device) => device.status === 'active',
    ).length;
    this.devicesCount.textContent = `${active} ${pluralRu(active, 'активное', 'активных', 'активных')}`;

    for (const device of this.devices) {
      const isCurrent = device.id === this.currentDeviceId;
      const revoked = device.status === 'revoked';

      this.devicesEl.appendChild(
        h(
          'div',
          {
            class: [
              'device-card',
              isCurrent ? 'device-card--current' : '',
              revoked ? 'device-card--revoked' : '',
            ]
              .filter(Boolean)
              .join(' '),
          },
          h('span', { class: 'device-icon', html: icon('devices') }),
          h(
            'div',
            { class: 'device-info' },
            h(
              'div',
              { class: 'device-name-row' },
              h('span', { class: 'device-name', text: device.name }),
              isCurrent
                ? h('span', { class: 'badge badge--accent', text: 'это устройство' })
                : revoked
                  ? h('span', { class: 'badge badge--muted', text: 'отозвано' })
                  : null,
            ),
            h('span', {
              class: 'device-meta',
              text: revoked
                ? `Отозвано ${formatDeviceDate(device.revoked_at)}`
                : `Создано ${formatDeviceDate(device.created_at)} · активно ${formatDeviceDate(device.last_seen_at)}`,
            }),
          ),
          !isCurrent && !revoked
            ? h(
                'button',
                {
                  class: 'text-btn text-btn--danger',
                  type: 'button',
                  dataset: {
                    action: 'revoke',
                    deviceId: device.id,
                    deviceName: device.name,
                  },
                },
                'Отозвать',
              )
            : null,
        ),
      );
    }
  }

  async handleRevoke(deviceId, deviceName) {
    if (
      !window.confirm(
        `Отозвать устройство «${deviceName}»? Оно перестанет получать новые сообщения.`,
      )
    ) {
      return;
    }

    try {
      await revokeDevice(deviceId);
      toast('Устройство отозвано.', 'success');
      await this.loadDevices();
    } catch (error) {
      toast(humanizeError(error, 'Не удалось отозвать устройство.'), 'error');
    }
  }

  setBusy(button, busy, label) {
    if (!button) return;
    const labelElement = button.querySelector('.btn-label');
    button.classList.toggle('is-loading', busy);
    button.disabled = busy;
    if (labelElement) labelElement.textContent = label;
  }
}
