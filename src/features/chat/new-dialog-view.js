import { clear, h } from '../../core/dom.js';
import { AppError, humanizeError } from '../../core/errors.js';
import { avatar } from '../../components/avatar.js';
import { icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { listContacts } from '../../services/contacts.js';
import {
  createDirectConversation,
  getConversation,
} from '../../services/conversations.js';

/**
 * Contact picker for starting a 1:1 conversation. The contact list comes from
 * an RPC and only contains active users who already share a conversation with
 * the caller, so the closed circle stays closed.
 */
export class NewDialogView {
  constructor({ onClose, onOpenConversation }) {
    this.onClose = onClose;
    this.onOpenConversation = onOpenConversation;

    this.closed = false;
    this.abort = null;
    this.previousFocus = null;
    this.previousOverflow = '';
    this.overlay = null;
    this.modal = null;
    this.listEl = null;
    this.searchInput = null;
    this.contacts = [];
    this.query = '';
    this.loadToken = 0;
    this.busyContactId = null;
  }

  mount() {
    this.previousFocus = document.activeElement;
    this.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    this.abort = new AbortController();
    const { signal } = this.abort;

    this.overlay = h('div', { class: 'modal-backdrop' });
    this.overlay.innerHTML = `
      <section class="modal modal--new-dialog glass" role="dialog" aria-modal="true" aria-labelledby="new-dialog-title">
        <header class="modal-header">
          <div>
            <h2 id="new-dialog-title">Новый диалог</h2>
            <p class="modal-subtitle">Личная переписка только с одним человеком.</p>
          </div>
          <button class="icon-btn" type="button" data-action="close" aria-label="Закрыть">
            ${icon('close')}
          </button>
        </header>
        <div class="modal-body">
          <label class="field new-dialog-search">
            <span class="field-label">Найти человека</span>
            <input
              class="input"
              id="new-dialog-search"
              type="search"
              autocomplete="off"
              placeholder="Имя или @username"
            />
          </label>
          <div class="contact-list" id="new-dialog-contacts" aria-live="polite"></div>
        </div>
      </section>
    `;

    document.body.appendChild(this.overlay);

    this.modal = this.overlay.querySelector('.modal');
    this.listEl = this.overlay.querySelector('#new-dialog-contacts');
    this.searchInput = this.overlay.querySelector('#new-dialog-search');

    this.overlay.addEventListener(
      'click',
      (event) => this.handleClick(event),
      { signal },
    );
    this.overlay.addEventListener(
      'input',
      (event) => this.handleInput(event),
      { signal },
    );
    document.addEventListener(
      'keydown',
      (event) => this.handleKeydown(event),
      { signal },
    );

    if (window.matchMedia('(pointer: fine)').matches) {
      requestAnimationFrame(() => this.searchInput?.focus());
    }

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
    this.loadToken += 1;
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
    if (actionElement) {
      switch (actionElement.dataset.action) {
        case 'close':
          this.close();
          break;
        case 'retry':
          void this.load();
          break;
        default:
          break;
      }
      return;
    }

    const contactElement = event.target.closest('[data-contact-id]');
    if (contactElement) {
      void this.openContact(contactElement.dataset.contactId);
    }
  }

  handleInput(event) {
    if (event.target !== this.searchInput) return;
    this.query = event.target.value;
    this.renderContacts();
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

    const token = ++this.loadToken;
    this.renderLoading();

    try {
      const contacts = await listContacts();
      if (this.closed || token !== this.loadToken) return;

      this.contacts = contacts;
      this.renderContacts();
    } catch (error) {
      if (this.closed || token !== this.loadToken) return;
      this.renderError(error);
    }
  }

  renderLoading() {
    clear(this.listEl);
    this.listEl.appendChild(
      h(
        'div',
        { class: 'contact-state' },
        h('span', { class: 'spinner spinner--sm' }),
        h('span', { text: 'Загружаем контакты…' }),
      ),
    );
  }

  renderError(error) {
    clear(this.listEl);
    this.listEl.appendChild(
      h(
        'div',
        { class: 'contact-state contact-state--error' },
        h('span', {
          text: humanizeError(error, 'Не удалось загрузить контакты.'),
        }),
        h(
          'button',
          {
            class: 'text-btn',
            type: 'button',
            dataset: { action: 'retry' },
          },
          'Повторить',
        ),
      ),
    );
  }

  renderContacts() {
    if (!this.listEl) return;
    clear(this.listEl);

    const query = this.query.trim().toLowerCase().replace(/^@/, '');
    const contacts = this.contacts.filter((contact) => {
      if (!query) return true;
      return (
        contact.displayName.toLowerCase().includes(query) ||
        contact.username.toLowerCase().includes(query)
      );
    });

    if (this.contacts.length === 0) {
      this.listEl.appendChild(
        h(
          'div',
          { class: 'contact-state' },
          h('span', { class: 'contact-state-icon', html: icon('user') }),
          h('span', {
            text: 'Пока некого добавить. Активные участники появятся здесь.',
          }),
        ),
      );
      return;
    }

    if (contacts.length === 0) {
      this.listEl.appendChild(
        h('div', {
          class: 'contact-state',
          text: 'Никого не нашли. Попробуйте другое имя или @username.',
        }),
      );
      return;
    }

    for (const contact of contacts) {
      const busy = this.busyContactId === contact.userId;
      const disabled = this.busyContactId !== null;

      this.listEl.appendChild(
        h(
          'button',
          {
            class: `contact${busy ? ' is-loading' : ''}`,
            type: 'button',
            dataset: { contactId: contact.userId },
            disabled,
            attrs: {
              'aria-label': `Открыть личный диалог с ${contact.displayName}`,
            },
          },
          avatar(contact.displayName, { size: 'md' }),
          h(
            'span',
            { class: 'contact-info' },
            h('span', {
              class: 'contact-name',
              text: contact.displayName,
            }),
            h('span', {
              class: 'contact-username',
              text: `@${contact.username}`,
            }),
          ),
          h(
            'span',
            { class: 'contact-action' },
            busy
              ? h('span', {
                  class: 'spinner spinner--sm',
                  attrs: { 'aria-hidden': 'true' },
                })
              : contact.directConversationId
                ? h('span', {
                    class: 'badge badge--muted',
                    text: 'есть диалог',
                  })
                : h('span', {
                    class: 'contact-chevron',
                    html: icon('chevronRight'),
                  }),
          ),
        ),
      );
    }
  }

  async openContact(contactId) {
    if (this.busyContactId !== null || this.closed) return;

    const contact = this.contacts.find((item) => item.userId === contactId);
    if (!contact) return;

    this.busyContactId = contact.userId;
    this.renderContacts();

    try {
      const conversationId = await createDirectConversation(contact.userId);
      if (!conversationId) {
        throw new AppError(
          'direct_conversation_not_created',
          'Direct conversation was not created',
        );
      }

      const conversation = await getConversation(conversationId);
      if (!conversation) {
        throw new AppError(
          'conversation_not_found',
          'Direct conversation was not found',
        );
      }

      if (this.closed) return;

      this.onOpenConversation?.(conversation);
      this.close();
    } catch (error) {
      if (this.closed) return;

      this.busyContactId = null;
      this.renderContacts();
      toast(
        humanizeError(error, 'Не удалось открыть личный диалог.'),
        'error',
      );
    }
  }
}
