import { h, clear } from '../../core/dom.js';
import { humanizeError, AppError } from '../../core/errors.js';
import {
  formatDay,
  formatListTime,
  formatTime,
  pluralRu,
} from '../../core/format.js';
import {
  MAX_MESSAGE_LENGTH,
  MESSAGE_PAGE_SIZE,
} from '../../core/config.js';
import { avatar } from '../../components/avatar.js';
import { icon, logoMark } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import {
  conversationTitle,
  memberLabel,
} from '../../services/conversations.js';
import {
  getMessage,
  listMessages,
  sendMessage,
} from '../../services/messages.js';
import * as devices from '../../services/devices.js';
import { subscribeToMessages } from '../../services/realtime.js';
import {
  listUnreadCounts,
  markConversationRead,
} from '../../services/reads.js';
import {
  claimNotification,
  getNotificationPermission,
  getNotificationPreference,
  notificationText,
  showBrowserNotification,
  shouldNotify,
} from '../../core/notifications.js';
import { importPublicJwk } from '../../crypto/keys.js';
import { decryptMessage, encryptMessage } from '../../crypto/envelope.js';
import { SettingsView } from '../settings/settings-view.js';
import { ApprovalView } from '../approval/approval-view.js';
import { NewDialogView } from './new-dialog-view.js';
import {
  clearUnread,
  formatUnreadCount,
  incrementUnread,
  maxSeq,
  totalUnread,
  unreadDocumentTitle,
  unreadFromRows,
} from './unread.js';

const shellTemplate = `
  <div class="app" id="app-shell">
    <aside class="sidebar glass">
      <header class="sidebar-header">
        <div class="brand">
          <span class="brand-mark">${logoMark}</span>
          <span class="brand-text">
            <span class="brand-name">BARS</span>
            <span class="brand-caption">PRIVATE MESSENGER</span>
          </span>
        </div>
        <button class="icon-btn icon-btn--badge" type="button" data-action="settings" aria-label="Настройки">
          ${icon('settings')}
          <span class="icon-badge" id="pending-badge" hidden></span>
        </button>
      </header>

      <div id="profile-card"></div>

      <div class="sidebar-section">
        <div class="sidebar-section-head">
          <span>Разговоры</span>
          <div class="sidebar-section-tools">
            <span class="sidebar-count" id="conversation-count"></span>
            <button class="icon-btn icon-btn--sm" type="button" data-action="new-direct" aria-label="Новый диалог" title="Новый диалог">
              ${icon('plus')}
            </button>
          </div>
        </div>
        <nav class="conversation-list" id="conversation-list" aria-label="Разговоры"></nav>
      </div>

      <footer class="sidebar-footer">
        <div class="sidebar-security">
          ${icon('lock')}
          <span>Сообщения защищены end-to-end</span>
        </div>
        <div class="sidebar-actions">
          <button class="text-btn" type="button" data-action="settings">
            ${icon('settings')} Настройки
          </button>
          <button class="text-btn text-btn--muted" type="button" data-action="logout">
            ${icon('logout')} Выйти
          </button>
        </div>
      </footer>
    </aside>

    <main class="chat glass">
      <header class="chat-header">
        <button class="icon-btn chat-back" type="button" data-action="back" aria-label="Назад">
          ${icon('back')}
        </button>
        <div class="chat-heading">
          <h1 class="chat-title" id="chat-title">BARS</h1>
          <p class="chat-subtitle" id="chat-subtitle">Приватный мессенджер</p>
        </div>
        <div class="chat-status">
          <span class="security-pill" title="Сквозное шифрование">
            ${icon('lock')}<span>E2EE</span>
          </span>
          <span class="connection" id="connection" data-state="connecting">
            <span class="connection-dot" aria-hidden="true"></span>
            <span class="connection-label" id="connection-label">Подключение</span>
          </span>
        </div>
      </header>

      <div class="messages" id="messages" aria-label="Сообщения"></div>

      <form class="composer" id="composer">
        <div class="composer-field">
          <textarea
            id="composer-input"
            rows="1"
            maxlength="${MAX_MESSAGE_LENGTH}"
            placeholder="Сообщение…"
            aria-label="Сообщение"
          ></textarea>
        </div>
        <button class="send-btn" type="submit" aria-label="Отправить" disabled>
          ${icon('send')}
        </button>
      </form>
    </main>
  </div>
`;

export class ChatView {
  constructor({ profile, device, recovery = null, conversations, callbacks }) {
    this.profile = profile;
    this.device = device;
    this.recovery = recovery ?? null;
    this.conversations = [...conversations];
    this.callbacks = callbacks ?? {};

    this.activeId = null;
    this.states = new Map();
    this.deviceMaps = new Map();
    this.unread = new Map();
    this.readMarkers = new Map();
    this.seenIncoming = new Set();
    this.unreadToken = 0;
    this.baseDocumentTitle = 'BARS — Private Messenger';
    this.unsubscribeRealtime = null;
    this.settings = null;
    this.approval = null;
    this.newDialog = null;
    this.pendingCount = 0;
    this.pendingTimer = null;
    this.pendingToken = 0;
    this.els = null;
    this.root = null;
    this.abort = null;
  }

  mount(root) {
    this.root = root;
    this.abort = new AbortController();
    const { signal } = this.abort;

    root.innerHTML = shellTemplate;

    this.els = {
      shell: root.querySelector('#app-shell'),
      profileCard: root.querySelector('#profile-card'),
      list: root.querySelector('#conversation-list'),
      count: root.querySelector('#conversation-count'),
      title: root.querySelector('#chat-title'),
      subtitle: root.querySelector('#chat-subtitle'),
      messages: root.querySelector('#messages'),
      composer: root.querySelector('#composer'),
      input: root.querySelector('#composer-input'),
      sendBtn: root.querySelector('.send-btn'),
      connection: root.querySelector('#connection'),
      connectionLabel: root.querySelector('#connection-label'),
      settingsButton: root.querySelector('.icon-btn[data-action="settings"]'),
      badge: root.querySelector('#pending-badge'),
    };

    this.els.shell.addEventListener('click', (event) => this.handleClick(event), {
      signal,
    });
    this.els.composer.addEventListener(
      'submit',
      (event) => this.handleSubmit(event),
      { signal },
    );
    this.els.input.addEventListener('input', () => this.handleInput(), {
      signal,
    });
    this.els.input.addEventListener(
      'keydown',
      (event) => this.handleKeydown(event),
      { signal },
    );

    window.addEventListener(
      'online',
      () => {
        this.setConnection('connecting');
        if (this.activeId) void this.syncLatest(this.activeId);
        void this.refreshUnreadCounts();
      },
      { signal },
    );

    window.addEventListener(
      'offline',
      () => this.setConnection('offline'),
      { signal },
    );

    window.addEventListener('focus', () => this.handleAttention(), { signal });

    this.renderProfileCard();
    this.renderConversationList();
    this.updateHeader();
    this.renderMessages();

    this.pendingTimer = window.setInterval(() => {
      void this.refreshPendingCount();
    }, 30_000);

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') {
          void this.refreshPendingCount();
          this.handleAttention();
        }
      },
      { signal },
    );

    void this.refreshPendingCount({ announce: true });
    void this.refreshUnreadCounts();
    this.subscribe();

    if (!navigator.onLine) this.setConnection('offline');
  }

  destroy() {
    if (this.pendingTimer !== null) {
      window.clearInterval(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingToken += 1;
    this.unreadToken += 1;
    this.unread.clear();
    this.readMarkers.clear();
    this.seenIncoming.clear();
    this.approval?.destroy();
    this.approval = null;
    this.newDialog?.destroy();
    this.newDialog = null;
    this.unsubscribeRealtime?.();
    this.unsubscribeRealtime = null;
    this.settings?.destroy();
    this.settings = null;
    this.abort?.abort();
    this.abort = null;
    this.root?.replaceChildren();
    this.root = null;
    this.els = null;
    document.title = 'BARS — Private Messenger';
  }

  get defaultConversationId() {
    return this.conversations[0]?.id ?? null;
  }

  hasConversation(conversationId) {
    return this.conversations.some(
      (conversation) => conversation.id === conversationId,
    );
  }

  activeConversation() {
    return (
      this.conversations.find(
        (conversation) => conversation.id === this.activeId,
      ) ?? null
    );
  }

  ensureState(conversationId) {
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        items: [],
        loaded: false,
        loading: false,
        loadingOlder: false,
        hasMore: true,
        loadError: null,
        needsSync: false,
      };
      this.states.set(conversationId, state);
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  openConversation(conversationId) {
    const conversation = this.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return false;

    const switched = this.activeId !== conversationId;
    this.activeId = conversationId;
    this.els.shell.classList.add('is-chat-open');

    const state = this.ensureState(conversationId);
    const wasUnread = this.unread.has(conversationId);
    this.unread = clearUnread(this.unread, conversationId);

    if (switched) {
      this.renderConversationList();
      this.updateHeader();
      this.els.input.value = '';
      this.autoSizeInput();
      this.updateSendState();

      if (!state.loaded) {
        this.renderMessages();
        void this.loadInitial(conversationId);
      } else {
        this.renderMessages({ scrollBottom: true });
        void this.syncLatest(conversationId);
      }
    } else {
      if (wasUnread) {
        this.renderConversationList();
        this.updateHeader();
      }

      if (!state.loaded && !state.loading) {
        this.renderMessages();
        void this.loadInitial(conversationId);
      }
    }

    if (state.loaded) void this.markActiveRead(conversationId);

    return true;
  }

  closeConversation() {
    if (this.activeId) void this.markActiveRead(this.activeId);

    this.activeId = null;
    this.els.shell.classList.remove('is-chat-open');
    this.renderConversationList();
    this.updateHeader();
    this.renderMessages();
    this.setConnection('connecting');
  }

  subscribe() {
    this.unsubscribeRealtime?.();
    this.unsubscribeRealtime = null;
    this.setConnection('connecting');

    this.unsubscribeRealtime = subscribeToMessages({
      onMessage: (row) => this.handleRealtimeMessage(row),
      onStatus: (status) => {
        if (status === 'SUBSCRIBED') {
          this.setConnection('online');
          // Recover anything inserted while the channel was connecting or
          // reconnecting. The unread RPC also catches messages in background
          // conversations that Realtime could not replay.
          if (this.activeId) void this.syncLatest(this.activeId);
          void this.refreshUnreadCounts();
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          this.setConnection('reconnecting');
        }
      },
    });
  }

  setConnection(state) {
    if (!this.els) return;

    const labels = {
      online: 'На связи',
      connecting: 'Подключение',
      reconnecting: 'Переподключение…',
      offline: 'Нет сети',
    };

    this.els.connection.dataset.state = state;
    this.els.connectionLabel.textContent = labels[state] ?? labels.connecting;
  }

  // -------------------------------------------------------------------------
  // Rendering: sidebar and header
  // -------------------------------------------------------------------------

  renderProfileCard() {
    const card = this.els.profileCard;
    clear(card);

    card.appendChild(
      h(
        'button',
        {
          class: 'profile-card',
          type: 'button',
          dataset: { action: 'settings' },
        },
        avatar(this.profile.display_name, { size: 'md' }),
        h(
          'span',
          { class: 'profile-info' },
          h('span', {
            class: 'profile-name',
            text: this.profile.display_name,
          }),
          h('span', {
            class: 'profile-username',
            text: `@${this.profile.username}`,
          }),
        ),
        h('span', {
          class: 'profile-chevron',
          html: icon('chevronRight'),
        }),
      ),
    );
  }

  renderConversationList() {
    const list = this.els.list;
    clear(list);
    this.els.count.textContent = String(this.conversations.length);

    if (this.conversations.length === 0) {
      list.appendChild(
        h('p', {
          class: 'sidebar-empty',
          text: 'Пока нет разговоров',
        }),
      );
      return;
    }

    for (const conversation of this.conversations) {
      const title = conversationTitle(conversation, this.profile.id);
      const isActive = conversation.id === this.activeId;
      const unread = this.unread.get(conversation.id) ?? 0;
      const count = conversation.members.length;
      const directPeer =
        conversation.kind === 'direct'
          ? conversation.members.find(
              (member) => member.userId !== this.profile.id,
            )
          : null;
      const preview =
        conversation.kind === 'direct'
          ? directPeer?.profile?.username
            ? `@${directPeer.profile.username}`
            : 'Личный диалог'
          : `${count} ${pluralRu(count, 'участник', 'участника', 'участников')}`;

      list.appendChild(
        h(
          'button',
          {
            class: `conversation${isActive ? ' is-active' : ''}${unread > 0 ? ' has-unread' : ''}`,
            type: 'button',
            dataset: { conversationId: conversation.id },
            attrs: {
              'aria-current': isActive ? 'true' : 'false',
            },
          },
          h(
            'span',
            { class: 'conversation-avatar' },
            avatar(title, { size: 'md' }),
          ),
          h(
            'span',
            { class: 'conversation-body' },
            h(
              'span',
              { class: 'conversation-top' },
              h('span', { class: 'conversation-title', text: title }),
              h(
                'span',
                { class: 'conversation-aside' },
                h('span', {
                  class: 'conversation-time',
                  text: formatListTime(conversation.lastMessageAt),
                }),
                unread > 0
                  ? h('span', {
                      class: 'conversation-unread',
                      text: formatUnreadCount(unread),
                      attrs: {
                        'aria-label': `${unread} ${pluralRu(
                          unread,
                          'непрочитанное сообщение',
                          'непрочитанных сообщения',
                          'непрочитанных сообщений',
                        )}`,
                      },
                    })
                  : null,
              ),
            ),
            h(
              'span',
              { class: 'conversation-bottom' },
              h('span', {
                class: 'conversation-preview',
                text: preview,
              }),
              h('span', { class: 'badge badge--soft', text: 'E2EE' }),
            ),
          ),
        ),
      );
    }
  }

  updateHeader() {
    const conversation = this.activeConversation();

    if (!conversation) {
      this.els.title.textContent = 'BARS';
      this.els.subtitle.textContent = 'Приватный мессенджер';
      this.baseDocumentTitle = 'BARS — Private Messenger';
      this.updateDocumentTitle();
      return;
    }

    const title = conversationTitle(conversation, this.profile.id);
    this.els.title.textContent = title;

    if (conversation.kind === 'direct') {
      const other = conversation.members.find(
        (member) => member.userId !== this.profile.id,
      );
      this.els.subtitle.textContent = other?.profile?.username
        ? `@${other.profile.username} · личный диалог`
        : 'Личный диалог';
    } else {
      const count = conversation.members.length;
      const label = memberLabel(conversation, this.profile.id);
      this.els.subtitle.textContent = label
        ? `${count} ${pluralRu(count, 'участник', 'участника', 'участников')} · ${label}`
        : `${count} ${pluralRu(count, 'участник', 'участника', 'участников')}`;
    }

    this.baseDocumentTitle = `${title} — BARS`;
    this.updateDocumentTitle();
  }

  updateDocumentTitle() {
    document.title = unreadDocumentTitle(
      this.baseDocumentTitle,
      totalUnread(this.unread),
    );
  }

  // -------------------------------------------------------------------------
  // Rendering: messages
  // -------------------------------------------------------------------------

  renderMessages({ scrollBottom = false, preserve = false } = {}) {
    const container = this.els.messages;
    if (!this.activeId) {
      this.renderPlaceholder();
      return;
    }

    const state = this.ensureState(this.activeId);
    const previousTop = container.scrollTop;
    const previousHeight = container.scrollHeight;

    clear(container);

    if (state.loading && state.items.length === 0) {
      container.appendChild(
        h(
          'div',
          { class: 'messages-state' },
          h('span', { class: 'spinner' }),
          h('span', { text: 'Расшифровываем историю…' }),
        ),
      );
      return;
    }

    if (state.loadError && state.items.length === 0) {
      container.appendChild(
        h(
          'div',
          { class: 'messages-state messages-state--error' },
          h('span', { class: 'messages-state-icon', html: icon('alert') }),
          h('h2', { text: 'Не удалось загрузить сообщения' }),
          h('p', { text: state.loadError }),
          h(
            'button',
            {
              class: 'btn btn-secondary',
              type: 'button',
              dataset: { action: 'retry-load' },
            },
            'Повторить',
          ),
        ),
      );
      return;
    }

    if (state.items.length === 0) {
      const conversation = this.activeConversation();
      container.appendChild(
        h(
          'div',
          { class: 'messages-state messages-state--empty' },
          h('span', { class: 'messages-state-icon', html: icon('shield') }),
          h('h2', { text: 'Тишина' }),
          h('p', {
            text: conversation
              ? 'Начните разговор. Каждое сообщение шифруется на вашем устройстве.'
              : 'Выберите разговор, чтобы продолжить.',
          }),
        ),
      );
      if (!conversation) this.renderPlaceholder();
      return;
    }

    if (state.hasMore) {
      container.appendChild(
        h(
          'button',
          {
            class: 'load-more',
            type: 'button',
            dataset: { action: 'load-older' },
            disabled: state.loadingOlder,
          },
          state.loadingOlder
            ? h('span', { class: 'spinner spinner--sm' })
            : h('span', { html: icon('arrowDown') }),
          h('span', {
            text: state.loadingOlder ? 'Загружаем…' : 'Загрузить раньше',
          }),
        ),
      );
    }

    let lastDay = null;

    for (const item of state.items) {
      const day = dayKey(item.createdAt);
      if (day && day !== lastDay) {
        lastDay = day;
        container.appendChild(
          h(
            'div',
            { class: 'date-separator' },
            h('span', { text: formatDay(item.createdAt) }),
          ),
        );
      }

      container.appendChild(this.buildMessageElement(item));
    }

    if (scrollBottom) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    } else if (preserve) {
      container.scrollTop =
        container.scrollHeight - previousHeight + previousTop;
    } else {
      container.scrollTop = previousTop;
    }
  }

  renderPlaceholder() {
    const container = this.els.messages;
    clear(container);
    container.appendChild(
      h(
        'div',
        { class: 'chat-placeholder' },
        h('span', { class: 'chat-placeholder-mark', html: logoMark }),
        h('h2', { text: 'Ваш закрытый круг' }),
        h('p', {
          text:
            this.conversations.length === 0
              ? 'Разговоры появятся здесь, когда администратор добавит вас в круг.'
              : 'Выберите разговор слева — и продолжайте с того места, где остановились.',
        }),
      ),
    );
  }

  buildMessageElement(item) {
    const own = item.senderId === this.profile.id;
    const author = this.senderName(item.senderId);

    const bubble = item.unavailable
      ? h(
          'span',
          { class: 'message-unavailable' },
          h('span', {
            class: 'message-unavailable-icon',
            html: icon('lock'),
          }),
          h('span', { text: unavailableText(item.unavailable) }),
        )
      : h('span', { class: 'message-text', text: item.text });

    const meta = h(
      'div',
      { class: 'message-meta' },
      h('span', {
        class: 'message-time',
        text: formatTime(item.createdAt),
        attrs: {
          title: item.createdAt
            ? new Date(item.createdAt).toLocaleString('ru-RU')
            : '',
        },
      }),
      own ? this.buildStatus(item) : null,
    );

    return h(
      'article',
      {
        class: [
          'message',
          own ? 'message--own' : 'message--other',
          item.status === 'sending' ? 'is-pending' : '',
          item.status === 'failed' ? 'is-failed' : '',
          item.unavailable ? 'is-unavailable' : '',
        ]
          .filter(Boolean)
          .join(' '),
        dataset: { messageId: item.id },
      },
      !own
        ? h(
            'div',
            { class: 'message-author' },
            avatar(author, { size: 'xs' }),
            h('span', { text: author }),
          )
        : null,
      h(
        'div',
        {
          class: `message-bubble${item.unavailable ? ' message-bubble--muted' : ''}`,
        },
        bubble,
      ),
      meta,
    );
  }

  buildStatus(item) {
    if (item.status === 'failed') {
      return h(
        'button',
        {
          class: 'message-retry',
          type: 'button',
          dataset: { action: 'retry-message', messageId: item.id },
          attrs: { title: item.error || 'Не отправлено' },
        },
        h('span', { html: icon('alert') }),
        h('span', { text: 'Повторить' }),
      );
    }

    if (item.status === 'sending') {
      return h('span', {
        class: 'message-state',
        html: icon('clock'),
        attrs: { title: 'Отправляется' },
      });
    }

    return h('span', {
      class: 'message-state message-state--sent',
      html: icon('check'),
      attrs: { title: 'Доставлено' },
    });
  }

  senderName(userId) {
    const conversation = this.activeConversation();
    const member = conversation?.members.find((item) => item.userId === userId);
    return member?.profile?.displayName || 'Участник';
  }

  isNearBottom() {
    const el = this.els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }

  // -------------------------------------------------------------------------
  // Loading and decryption
  // -------------------------------------------------------------------------

  async loadInitial(conversationId, { force = false } = {}) {
    const state = this.ensureState(conversationId);
    if (state.loading) return;
    if (state.loaded && !force) return;

    state.loading = true;
    state.loadError = null;
    if (this.activeId === conversationId) this.renderMessages();

    try {
      await this.ensureDeviceMap(conversationId, force);
      const rows = await listMessages({ conversationId });
      const items = await this.decryptRows(conversationId, rows);

      const merged = new Map();
      for (const existing of state.items) merged.set(existing.id, existing);
      for (const item of items) merged.set(item.id, item);

      state.items = [...merged.values()].sort(compareItems);
      state.loaded = true;
      state.hasMore = rows.length === MESSAGE_PAGE_SIZE;
      state.loading = false;

      if (this.activeId === conversationId) {
        this.renderMessages({ scrollBottom: true });
        if (this.isPageVisible()) void this.markActiveRead(conversationId);
        if (state.needsSync) {
          state.needsSync = false;
          void this.syncLatest(conversationId);
        }
      }
    } catch (error) {
      state.loading = false;
      state.loadError = humanizeError(
        error,
        'Не удалось загрузить историю сообщений.',
      );
      if (this.activeId === conversationId) this.renderMessages();
    }
  }

  async loadOlder() {
    if (!this.activeId) return;
    const state = this.ensureState(this.activeId);
    if (state.loadingOlder || !state.hasMore) return;

    const oldest = state.items.find((item) => Number.isFinite(item.seq));
    if (!oldest) return;

    state.loadingOlder = true;
    this.renderMessages({ preserve: true });

    try {
      const rows = await listMessages({
        conversationId: this.activeId,
        beforeSeq: oldest.seq,
      });
      const items = await this.decryptRows(this.activeId, rows);

      const merged = new Map(
        state.items.map((item) => [item.id, item]),
      );
      for (const item of items) merged.set(item.id, item);
      state.items = [...merged.values()].sort(compareItems);
      state.hasMore = rows.length === MESSAGE_PAGE_SIZE;
    } catch (error) {
      toast(
        humanizeError(error, 'Не удалось загрузить более ранние сообщения.'),
        'error',
      );
    } finally {
      state.loadingOlder = false;
      if (this.activeId) this.renderMessages({ preserve: true });
    }
  }

  async syncLatest(conversationId) {
    const state = this.ensureState(conversationId);
    if (!state.loaded) return;

    const maxSeq = state.items.reduce(
      (max, item) =>
        Number.isFinite(item.seq) ? Math.max(max, item.seq) : max,
      0,
    );

    // An empty conversation has no seq cursor. Reload its first page so a
    // message missed while Realtime was offline is not lost.
    if (maxSeq <= 0) {
      await this.loadInitial(conversationId, { force: true });
      return;
    }

    try {
      const items = [];
      let cursor = maxSeq;

      // Recover gaps in pages of 100. The cap avoids an unbounded loop if the
      // server keeps returning full pages; a later reconnect continues.
      for (let page = 0; page < 5; page += 1) {
        const rows = await listMessages({
          conversationId,
          afterSeq: cursor,
          limit: 100,
        });

        if (rows.length === 0) break;

        items.push(...(await this.decryptRows(conversationId, rows)));

        if (rows.length < 100) break;
        cursor = rows[rows.length - 1].seq;
      }

      if (items.length === 0) return;

      const merged = new Map(
        state.items.map((item) => [item.id, item]),
      );
      for (const item of items) merged.set(item.id, item);
      state.items = [...merged.values()].sort(compareItems);

      this.markActivity(conversationId, items[items.length - 1]?.createdAt);

      if (this.activeId === conversationId) {
        const nearBottom = this.isNearBottom();
        this.renderMessages({ scrollBottom: nearBottom, preserve: !nearBottom });
        if (this.isPageVisible()) void this.markActiveRead(conversationId);
      }
    } catch {
      // Realtime will retry on the next connection; do not interrupt the UI.
    }
  }

  async ensureDeviceMap(conversationId, force = false) {
    if (!force && this.deviceMaps.has(conversationId)) {
      return this.deviceMaps.get(conversationId);
    }

    const rows = await devices.getConversationDevices(conversationId);
    const map = new Map();

    for (const row of rows) {
      let publicKey = null;
      try {
        publicKey = await importPublicJwk(row.public_key_jwk);
      } catch {
        // A malformed key only makes this sender undecryptable, not the chat.
      }

      map.set(row.device_id, {
        deviceId: row.device_id,
        userId: row.user_id,
        name: row.device_name,
        displayName: row.display_name,
        username: row.username,
        status: row.status,
        profileStatus: row.profile_status,
        publicKey,
      });
    }

    this.deviceMaps.set(conversationId, map);
    return map;
  }

  async decryptRows(conversationId, rows) {
    let map = await this.ensureDeviceMap(conversationId);
    const items = [];

    for (const row of rows) {
      let senderDevice = map.get(row.sender_device_id);

      if (!senderDevice) {
        map = await this.ensureDeviceMap(conversationId, true);
        senderDevice = map.get(row.sender_device_id);
      }

      items.push(await this.decryptRow(row, senderDevice));
    }

    return items;
  }

  async decryptRow(row, senderDevice) {
    const base = {
      id: row.id,
      seq: row.seq,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderDeviceId: row.sender_device_id,
      type: row.type,
      cryptoVersion: row.crypto_version,
      createdAt: row.created_at,
      status: 'sent',
      text: '',
      unavailable: null,
      payload: null,
      error: null,
    };

    const envelopes = [];
    const deviceEnvelope = (row.message_keys ?? []).find(
      (key) => key.device_id === this.device.deviceId,
    );
    if (deviceEnvelope) {
      envelopes.push({ envelope: deviceEnvelope, identity: this.device });
    }

    // Messages sent after the recovery kit was created also carry an envelope
    // for the user-level recovery key. It is only usable on devices where the
    // kit has been restored.
    if (this.recovery && this.recovery.deviceId !== this.device.deviceId) {
      const recoveryEnvelope = (row.message_keys ?? []).find(
        (key) => key.device_id === this.recovery.deviceId,
      );
      if (recoveryEnvelope) {
        envelopes.push({ envelope: recoveryEnvelope, identity: this.recovery });
      }
    }

    if (envelopes.length === 0) {
      return { ...base, unavailable: 'other-device' };
    }

    if (!senderDevice?.publicKey) {
      return { ...base, unavailable: 'unknown-sender' };
    }

    for (const candidate of envelopes) {
      try {
        const text = await decryptMessage({
          message: row,
          envelope: candidate.envelope,
          senderPublicKey: senderDevice.publicKey,
          privateKey: candidate.identity.privateKey,
          publicKey: candidate.identity.publicKey,
          deviceId: candidate.identity.deviceId,
        });
        return { ...base, text };
      } catch {
        // Try the next envelope, then report the message as unreadable.
      }
    }

    return { ...base, unavailable: 'decrypt' };
  }

  setRecoveryIdentity(identity) {
    this.recovery = identity ?? null;

    // Server messages may become readable after a kit is restored. Keep local
    // pending/failed messages, drop already decrypted server items and let the
    // normal load path re-fetch them.
    for (const state of this.states.values()) {
      state.items = state.items.filter((item) => item.status !== 'sent');
      state.loaded = false;
      state.hasMore = true;
    }

    this.deviceMaps.clear();

    if (this.activeId) {
      this.renderMessages();
      void this.loadInitial(this.activeId, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  handleInput() {
    this.autoSizeInput();
    this.updateSendState();
  }

  autoSizeInput() {
    const input = this.els.input;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  updateSendState() {
    this.els.sendBtn.disabled =
      this.els.input.value.trim().length === 0 || !this.activeId;
  }

  handleKeydown(event) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      this.els.composer.requestSubmit();
    }
  }

  handleSubmit(event) {
    event.preventDefault();
    if (!this.activeId) return;

    const text = this.els.input.value.trim();
    if (!text) return;

    if (text.length > MAX_MESSAGE_LENGTH) {
      toast(`Максимум ${MAX_MESSAGE_LENGTH} символов.`, 'error');
      return;
    }

    this.els.input.value = '';
    this.autoSizeInput();
    this.updateSendState();

    const conversationId = this.activeId;
    const state = this.ensureState(conversationId);

    const item = {
      id: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      seq: null,
      conversationId,
      senderId: this.profile.id,
      senderDeviceId: this.device.deviceId,
      type: 'text',
      cryptoVersion: 1,
      createdAt: new Date().toISOString(),
      status: 'sending',
      text,
      unavailable: null,
      payload: null,
      error: null,
    };

    state.items.push(item);
    state.items.sort(compareItems);
    this.renderMessages({ scrollBottom: true });
    void this.sendItem(item);
  }

  async sendItem(item) {
    const state = this.ensureState(item.conversationId);

    try {
      if (!item.payload) {
        const deviceMap = await this.ensureDeviceMap(
          item.conversationId,
          true,
        );
        const recipients = [...deviceMap.values()].filter(
          (device) =>
            device.status === 'active' &&
            device.profileStatus === 'active' &&
            device.publicKey,
        );

        if (!recipients.some((device) => device.deviceId === this.device.deviceId)) {
          throw new AppError(
            'invalid_sender_device',
            'Current device is not active',
          );
        }

        item.payload = await encryptMessage({
          text: item.text,
          conversationId: item.conversationId,
          messageId: item.id,
          senderId: item.senderId,
          senderDeviceId: item.senderDeviceId,
          senderPrivateKey: this.device.privateKey,
          senderPublicKey: this.device.publicKey,
          recipients,
        });
      }

      const row = await sendMessage({
        conversationId: item.conversationId,
        messageId: item.id,
        clientMessageId: item.clientMessageId,
        deviceId: item.senderDeviceId,
        ciphertext: item.payload.ciphertext,
        iv: item.payload.iv,
        keys: item.payload.keys,
      });

      item.status = 'sent';
      item.error = null;
      if (row?.seq) item.seq = Number(row.seq);
      if (row?.created_at) item.createdAt = row.created_at;
      state.items.sort(compareItems);
      this.markActivity(item.conversationId, item.createdAt);

      if (
        this.activeId === item.conversationId &&
        this.isPageVisible()
      ) {
        void this.markActiveRead(item.conversationId);
      }
    } catch (error) {
      item.status = 'failed';
      item.error = humanizeError(error, 'Не удалось отправить сообщение.');
      toast(item.error, 'error');
    } finally {
      if (this.activeId === item.conversationId) {
        this.renderMessages({ scrollBottom: true });
      }
    }
  }

  retryMessage(messageId) {
    if (!this.activeId) return;
    const state = this.ensureState(this.activeId);
    const item = state.items.find((candidate) => candidate.id === messageId);
    if (!item || item.status !== 'failed') return;

    item.status = 'sending';
    item.error = null;
    item.payload = null;
    state.items.sort(compareItems);
    this.renderMessages();
    void this.sendItem(item);
  }

  async handleIncoming(row) {
    const conversationId = row.conversation_id;
    const state = this.ensureState(conversationId);

    if (state.items.some((item) => item.id === row.id)) return;
    if (!state.loaded) state.needsSync = true;

    try {
      const full = await getMessage(row.id);
      if (!full) return;
      if (state.items.some((item) => item.id === full.id)) return;

      const [item] = await this.decryptRows(conversationId, [full]);
      state.items.push(item);
      state.items.sort(compareItems);

      this.markActivity(conversationId, full.created_at);

      if (this.activeId === conversationId) {
        const nearBottom = this.isNearBottom();
        this.renderMessages({ scrollBottom: nearBottom, preserve: !nearBottom });
      }
    } catch {
      // A retry happens on reconnect via syncLatest().
    }
  }

  handleRealtimeMessage(row) {
    const conversationId = row?.conversation_id;
    if (!conversationId || !this.hasConversation(conversationId)) return;
    if (!row.id || this.seenIncoming.has(row.id)) return;

    this.seenIncoming.add(row.id);
    if (this.seenIncoming.size > 500) {
      const [oldest] = this.seenIncoming;
      this.seenIncoming.delete(oldest);
    }

    const own = row.sender_id === this.profile.id;
    const active = this.activeId === conversationId;
    const visible = this.isPageVisible();

    if (own) {
      void this.handleIncoming(row);
      return;
    }

    if (active && visible) {
      void this.handleIncoming(row).then(() => {
        if (this.activeId === conversationId && this.isPageVisible()) {
          void this.markActiveRead(conversationId);
        }
      });
      return;
    }

    this.unreadToken += 1;
    this.unread = incrementUnread(this.unread, conversationId, 1);
    this.renderUnreadIndicators();
    this.notifyIncoming(row);
    void this.handleIncoming(row);
  }

  notifyIncoming(row) {
    const conversation = this.conversations.find(
      (item) => item.id === row.conversation_id,
    );
    if (!conversation) return;

    const sender = conversation.members.find(
      (member) => member.userId === row.sender_id,
    );
    const senderName = sender?.profile?.displayName || 'Участник';
    const title = conversationTitle(conversation, this.profile.id);
    const focused =
      typeof document.hasFocus === 'function' ? document.hasFocus() : false;

    if (this.isPageVisible() && focused) {
      toast(`Новое сообщение от ${senderName}`, 'info');
      return;
    }

    const eligible = shouldNotify({
      enabled: getNotificationPreference(this.profile.id),
      permission: getNotificationPermission(),
      visibility: document.visibilityState,
      focused,
      senderId: row.sender_id,
      userId: this.profile.id,
    });

    if (!eligible || !claimNotification(row.id)) return;

    const text = notificationText({
      kind: conversation.kind,
      senderName,
      conversationTitle: title,
    });

    showBrowserNotification({
      ...text,
      tag: `bars:${conversation.id}`,
      onClick: () => {
        this.callbacks.onSelectConversation?.(conversation.id);
      },
    });
  }

  handleAttention() {
    if (!this.els) return;

    void this.markActiveRead();
    void this.refreshUnreadCounts();
  }

  async refreshUnreadCounts({ markActive = true } = {}) {
    if (!this.els) return;

    const token = ++this.unreadToken;

    try {
      const rows = await listUnreadCounts();
      if (!this.els || token !== this.unreadToken) return;

      const counts = unreadFromRows(rows);

      // The open conversation is being read right now. Do not let a refresh
      // that raced with the read RPC flash its badge back on screen.
      if (markActive && this.activeId && this.isPageVisible()) {
        const state = this.states.get(this.activeId);
        if (state?.loaded || state?.loading) counts.delete(this.activeId);
      }

      this.unread = counts;
      this.renderUnreadIndicators();

      if (markActive && this.activeId && this.isPageVisible()) {
        const state = this.states.get(this.activeId);
        if (state?.loaded) void this.markActiveRead(this.activeId);
      }
    } catch {
      // Counts are an enhancement; keep the last known state on failure.
    }
  }

  async markActiveRead(conversationId = this.activeId) {
    if (!conversationId) return;

    const state = this.states.get(conversationId);
    if (!state?.loaded) return;

    const seq = maxSeq(state.items);
    if (seq <= 0) {
      this.clearConversationUnread(conversationId);
      return;
    }

    await this.markReadUpTo(conversationId, seq);
  }

  async markReadUpTo(conversationId, seq) {
    this.clearConversationUnread(conversationId);

    const target = Math.floor(Number(seq));
    if (!conversationId || !Number.isFinite(target) || target <= 0) return;

    const previous = this.readMarkers.get(conversationId) ?? 0;
    if (target <= previous) return;

    this.readMarkers.set(conversationId, target);

    try {
      const stored = await markConversationRead(conversationId, target);
      if (Number.isFinite(stored)) {
        this.readMarkers.set(
          conversationId,
          Math.max(this.readMarkers.get(conversationId) ?? 0, stored),
        );
      }
    } catch {
      if (this.readMarkers.get(conversationId) === target) {
        this.readMarkers.delete(conversationId);
      }
      // The optimistic clear may hide a real badge; re-sync with the server.
      // Do not retry the failing mark from inside this refresh: a persistent
      // error would otherwise loop between mark and refresh.
      void this.refreshUnreadCounts({ markActive: false });
    }
  }

  clearConversationUnread(conversationId) {
    const next = clearUnread(this.unread, conversationId);
    if (next === this.unread) return;

    this.unread = next;
    this.renderUnreadIndicators();
  }

  renderUnreadIndicators() {
    if (!this.els) return;

    this.renderConversationList();
    this.updateDocumentTitle();
  }

  isPageVisible() {
    return document.visibilityState === 'visible';
  }

  markActivity(conversationId, createdAt) {
    const conversation = this.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation || !createdAt) return;

    if (
      !conversation.lastMessageAt ||
      new Date(createdAt).getTime() >
        new Date(conversation.lastMessageAt).getTime()
    ) {
      conversation.lastMessageAt = createdAt;
    }

    this.conversations.sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? 0).getTime() -
        new Date(a.lastMessageAt ?? 0).getTime(),
    );

    this.renderConversationList();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  handleClick(event) {
    const actionElement = event.target.closest('[data-action]');
    if (actionElement) {
      this.handleAction(actionElement.dataset.action, actionElement);
      return;
    }

    const conversationElement = event.target.closest('[data-conversation-id]');
    if (conversationElement) {
      this.callbacks.onSelectConversation?.(
        conversationElement.dataset.conversationId,
      );
    }
  }

  handleAction(action, element) {
    switch (action) {
      case 'settings':
        this.openSettings();
        break;
      case 'new-direct':
        this.openNewDialog();
        break;
      case 'logout':
        if (window.confirm('Выйти из аккаунта на этом устройстве?')) {
          this.callbacks.onLogout?.();
        }
        break;
      case 'back':
        this.callbacks.onBack?.();
        break;
      case 'retry-load':
        if (this.activeId) void this.loadInitial(this.activeId, { force: true });
        break;
      case 'load-older':
        void this.loadOlder();
        break;
      case 'retry-message':
        this.retryMessage(element.dataset.messageId);
        break;
      default:
        break;
    }
  }

  async refreshPendingCount({ announce = false } = {}) {
    if (!this.els) return;

    const token = ++this.pendingToken;
    try {
      const count = await devices.countPendingDevices(this.profile.id);
      if (!this.els || token !== this.pendingToken) return;
      this.applyPendingCount(count, { announce });
    } catch {
      // The badge is an enhancement; chat stays usable when polling fails.
    }
  }

  applyPendingCount(count, { announce = false } = {}) {
    if (!this.els) return;

    this.pendingToken += 1;
    const previous = this.pendingCount;
    this.pendingCount = count;

    if (this.els.badge) {
      this.els.badge.hidden = count === 0;
      this.els.badge.textContent = count > 9 ? '9+' : String(count);
    }

    this.els.settingsButton?.setAttribute(
      'aria-label',
      count > 0
        ? `Настройки, запросов на подключение: ${count}`
        : 'Настройки',
    );

    if (announce && previous === 0 && count > 0) {
      toast('Новое устройство ожидает подтверждения.', 'info');
    }
  }

  openSettings() {
    if (this.settings) return;

    this.newDialog?.close();

    this.settings = new SettingsView({
      profile: this.profile,
      currentDeviceId: this.device.deviceId,
      onClose: () => {
        this.settings = null;
        void this.refreshPendingCount();
      },
      onProfileUpdated: (profile) => {
        this.profile = { ...this.profile, ...profile };
        this.renderProfileCard();
      },
      onRecoveryUpdated: (identity) => this.setRecoveryIdentity(identity),
      onDevicesChanged: (count) => this.applyPendingCount(count),
      onLogout: () => this.callbacks.onLogout?.(),
    });

    this.settings.mount();
  }

  openNewDialog() {
    if (this.newDialog) return;

    this.settings?.close();
    this.approval?.close();
    this.newDialog = new NewDialogView({
      onClose: () => {
        this.newDialog = null;
      },
      onOpenConversation: (conversation) => {
        this.upsertConversation(conversation);
        this.callbacks.onSelectConversation?.(conversation.id);
      },
    });

    this.newDialog.mount();
  }

  upsertConversation(conversation) {
    const index = this.conversations.findIndex(
      (item) => item.id === conversation.id,
    );

    if (index >= 0) {
      this.conversations[index] = conversation;
    } else {
      this.conversations.push(conversation);
    }

    this.conversations.sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? 0).getTime() -
        new Date(a.lastMessageAt ?? 0).getTime(),
    );
    this.renderConversationList();
  }

  openApproval(deviceId) {
    if (this.approval?.deviceId === deviceId) return;

    this.settings?.close();
    this.newDialog?.close();
    this.approval?.destroy();
    this.approval = null;

    this.approval = new ApprovalView({
      deviceId,
      currentDeviceId: this.device.deviceId,
      userId: this.profile.id,
      onClose: () => {
        this.approval = null;
        this.callbacks.onApprovalClosed?.();
      },
      onResolved: () => {
        void this.refreshPendingCount();
      },
    });

    this.approval.mount();
  }

  closeApproval({ notify = true } = {}) {
    if (!this.approval) return false;

    const approval = this.approval;
    this.approval = null;
    approval.destroy();

    if (notify) this.callbacks.onApprovalClosed?.();
    return true;
  }
}

function compareItems(a, b) {
  const aSeq = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
  const bSeq = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;

  if (aSeq !== bSeq) return aSeq - bSeq;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function dayKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function unavailableText(reason) {
  switch (reason) {
    case 'other-device':
      return 'Зашифровано для другого устройства';
    case 'unknown-sender':
      return 'Ключ отправителя недоступен';
    default:
      return 'Не удалось расшифровать';
  }
}
