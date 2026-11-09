import { clear, h } from '../../core/dom.js';
import { humanizeError } from '../../core/errors.js';
import { formatDeviceDate } from '../../core/format.js';
import { icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import {
  approveDevice,
  getDevice,
  revokeDevice,
} from '../../services/devices.js';
import { deviceApprovalCode } from '../../crypto/device-code.js';

/**
 * Modal opened from an approval link (`#/approve/<deviceId>`). The link only
 * selects the request; this view re-reads it under RLS, shows the same public
 * key fingerprint as the pending device and requires explicit confirmation.
 */
export class ApprovalView {
  constructor({
    deviceId,
    currentDeviceId,
    userId,
    onClose,
    onResolved,
  }) {
    this.deviceId = deviceId;
    this.currentDeviceId = currentDeviceId;
    this.userId = userId;
    this.onClose = onClose;
    this.onResolved = onResolved;

    this.closed = false;
    this.busy = false;
    this.device = null;
    this.overlay = null;
    this.modal = null;
    this.content = null;
    this.approveButton = null;
    this.denyButton = null;
    this.checkbox = null;
    this.errorEl = null;
    this.abort = null;
    this.previousFocus = null;
    this.previousOverflow = '';
  }

  mount() {
    this.previousFocus = document.activeElement;
    this.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    this.abort = new AbortController();
    const { signal } = this.abort;

    this.overlay = h('div', { class: 'modal-backdrop' });
    this.overlay.innerHTML = `
      <section class="modal modal--approval glass" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <header class="modal-header">
          <div>
            <h2 id="approval-title">Подключение устройства</h2>
            <p class="modal-subtitle">Проверьте запрос перед одобрением.</p>
          </div>
          <button class="icon-btn" type="button" data-action="close" aria-label="Закрыть">
            ${icon('close')}
          </button>
        </header>
        <div class="modal-body">
          <div id="approval-content"></div>
        </div>
      </section>
    `;

    document.body.appendChild(this.overlay);

    this.modal = this.overlay.querySelector('.modal');
    this.content = this.overlay.querySelector('#approval-content');

    this.overlay.addEventListener(
      'click',
      (event) => this.handleClick(event),
      { signal },
    );
    document.addEventListener(
      'keydown',
      (event) => this.handleKeydown(event),
      { signal },
    );

    void this.load();
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
      case 'retry':
        void this.load();
        break;
      case 'approve':
        void this.approve();
        break;
      case 'deny':
        void this.deny();
        break;
      default:
        break;
    }
  }

  handleKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key !== 'Tab' || !this.modal) return;

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

  async load() {
    if (this.closed) return;

    this.device = null;
    this.renderLoading();

    try {
      const device = await getDevice(this.deviceId);
      if (this.closed) return;

      if (!device) {
        this.renderNotice({
          kind: 'error',
          iconName: 'alert',
          title: 'Запрос не найден',
          message:
            'Возможно, он уже обработан, отменён или ссылка устарела.',
        });
        return;
      }

      if (device.user_id !== this.userId) {
        this.renderNotice({
          kind: 'error',
          iconName: 'alert',
          title: 'Ссылка относится к другому аккаунту',
          message: 'Войдите в аккаунт, которому принадлежит это устройство.',
        });
        return;
      }

      if (device.id === this.currentDeviceId) {
        this.renderNotice({
          kind: 'muted',
          iconName: 'shield',
          title: 'Это текущее устройство',
          message:
            'Ссылку нужно открыть на уже активном устройстве, чтобы одобрить новое.',
        });
        return;
      }

      if (device.kind !== 'device') {
        this.renderNotice({
          kind: 'error',
          iconName: 'alert',
          title: 'Некорректный запрос',
          message: 'Эта ссылка не относится к браузерному устройству.',
        });
        return;
      }

      if (device.status === 'active') {
        this.renderNotice({
          kind: 'success',
          iconName: 'check',
          title: 'Устройство уже подключено',
          message: 'Этот запрос уже был одобрен. Можно закрыть окно.',
        });
        return;
      }

      if (device.status !== 'pending') {
        this.renderNotice({
          kind: 'muted',
          iconName: 'clock',
          title: 'Запрос больше неактуален',
          message:
            'Устройство было отклонено, отозвано или запрос отменён на новом устройстве.',
        });
        return;
      }

      const code = await deviceApprovalCode(device.public_key_jwk);
      if (this.closed) return;

      this.renderRequest(device, code);
    } catch (error) {
      if (this.closed) return;

      this.renderNotice({
        kind: 'error',
        iconName: 'alert',
        title: 'Не удалось загрузить запрос',
        message: humanizeError(
          error,
          'Проверьте соединение и попробуйте снова.',
        ),
        retry: true,
      });
    }
  }

  renderLoading() {
    clear(this.content);
    this.content.appendChild(
      h(
        'div',
        { class: 'device-loading' },
        h('span', { class: 'spinner spinner--sm' }),
        h('span', { text: 'Загружаем запрос…' }),
      ),
    );
  }

  renderNotice({ kind, iconName, title, message, retry = false }) {
    clear(this.content);

    this.content.appendChild(
      h(
        'div',
        { class: `approval-state approval-state--${kind}` },
        h('span', {
          class: 'approval-state-icon',
          html: icon(iconName),
        }),
        h('h3', { text: title }),
        h('p', { text: message }),
        h(
          'div',
          { class: 'approval-actions' },
          retry
            ? h(
                'button',
                {
                  class: 'btn btn-secondary',
                  type: 'button',
                  dataset: { action: 'retry' },
                },
                'Повторить',
              )
            : null,
          h(
            'button',
            {
              class: 'btn btn-ghost',
              type: 'button',
              dataset: { action: 'close' },
            },
            'Закрыть',
          ),
        ),
      ),
    );
  }

  renderRequest(device, code) {
    clear(this.content);
    this.device = device;
    this.busy = false;

    this.checkbox = h('input', {
      id: 'approval-match',
      type: 'checkbox',
    });
    this.checkbox.addEventListener('change', () => this.updateApproveState());

    this.approveButton = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        dataset: { action: 'approve' },
        disabled: true,
      },
      h('span', { class: 'btn-label', text: 'Одобрить' }),
      h('span', {
        class: 'spinner spinner--sm',
        attrs: { 'aria-hidden': 'true' },
      }),
    );

    this.denyButton = h(
      'button',
      {
        class: 'btn btn-ghost',
        type: 'button',
        dataset: { action: 'deny' },
      },
      h('span', { class: 'btn-label', text: 'Отклонить запрос' }),
    );

    this.errorEl = h('p', {
      class: 'approval-error',
      attrs: { role: 'alert' },
    });

    this.content.appendChild(
      h(
        'div',
        { class: 'approval-content' },
        h(
          'div',
          { class: 'approval-device' },
          h('span', { class: 'device-icon', html: icon('devices') }),
          h(
            'div',
            { class: 'device-info' },
            h('span', { class: 'device-name', text: device.name }),
            h('span', {
              class: 'device-meta',
              text: `Запрошено ${formatDeviceDate(device.created_at)}`,
            }),
          ),
        ),
        h(
          'div',
          { class: 'device-approval' },
          h('span', {
            class: 'device-approval-label',
            text: 'Код устройства',
          }),
          h('span', {
            class: 'device-approval-code',
            text: code || '—',
          }),
          h('span', {
            class: 'device-approval-name',
            text: device.name,
          }),
        ),
        h(
          'div',
          { class: 'approval-warning' },
          h('span', {
            class: 'approval-warning-icon',
            html: icon('shield'),
          }),
          h('p', {
            text: 'Одобряйте только если вы сами начали подключение на этом устройстве. Код на новом устройстве должен совпадать с кодом выше.',
          }),
        ),
        h(
          'label',
          { class: 'approval-check', attrs: { for: 'approval-match' } },
          this.checkbox,
          h('span', { text: 'Код на новом устройстве совпадает' }),
        ),
        this.errorEl,
        h(
          'div',
          { class: 'approval-actions' },
          this.approveButton,
          this.denyButton,
        ),
      ),
    );
  }

  updateApproveState() {
    if (!this.approveButton) return;
    this.approveButton.disabled = this.busy || !this.checkbox?.checked;
  }

  setBusy(action, busy, label) {
    this.busy = busy;

    const button = action === 'approve' ? this.approveButton : this.denyButton;
    if (!button) return;

    button.classList.toggle('is-loading', busy);
    const labelElement = button.querySelector('.btn-label');
    if (labelElement) labelElement.textContent = label;

    if (busy) {
      if (this.approveButton) this.approveButton.disabled = true;
      if (this.denyButton) this.denyButton.disabled = true;
    } else {
      if (this.denyButton) this.denyButton.disabled = false;
      this.updateApproveState();
    }
  }

  async approve() {
    if (this.busy || !this.checkbox?.checked || !this.device) return;

    this.errorEl.textContent = '';
    this.setBusy('approve', true, 'Одобряем…');

    try {
      await approveDevice(this.device.id);
      toast('Устройство подключено.', 'success');
      this.onResolved?.({ status: 'active' });
      this.close();
    } catch (error) {
      if (this.closed) return;

      const message = humanizeError(
        error,
        'Не удалось одобрить устройство.',
      );
      this.errorEl.textContent = message;
      toast(message, 'error');
      this.setBusy('approve', false, 'Одобрить');

      if (String(error?.message ?? '').includes('device_not_found')) {
        void this.load();
      }
    }
  }

  async deny() {
    if (this.busy || !this.device) return;

    if (
      !window.confirm(
        `Отклонить запрос устройства «${this.device.name}»? Оно не получит доступ к переписке.`,
      )
    ) {
      return;
    }

    this.errorEl.textContent = '';
    this.setBusy('deny', true, 'Отклоняем…');

    try {
      await revokeDevice(this.device.id);
      toast('Запрос отклонён.', 'success');
      this.onResolved?.({ status: 'revoked' });
      this.close();
    } catch (error) {
      if (this.closed) return;

      const message = humanizeError(
        error,
        'Не удалось отклонить запрос.',
      );
      this.errorEl.textContent = message;
      toast(message, 'error');
      this.setBusy('deny', false, 'Отклонить запрос');
    }
  }
}
