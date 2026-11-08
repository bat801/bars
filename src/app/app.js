import { clear } from '../core/dom.js';
import { humanizeError } from '../core/errors.js';
import { icon, logoMark } from '../components/icons.js';
import { toast } from '../components/toast.js';
import * as auth from '../services/auth.js';
import * as profiles from '../services/profiles.js';
import * as conversations from '../services/conversations.js';
import * as devices from '../services/devices.js';
import { ensureDeviceIdentity, forgetDeviceIdentity } from '../services/identity.js';
import { getRecoveryIdentity } from '../services/recovery.js';
import { deviceApprovalCode } from '../crypto/device-code.js';
import { LoginView } from '../features/login/login-view.js';
import { AccessView } from '../features/access/access-view.js';
import { PendingView } from '../features/pending/pending-view.js';
import { ChatView } from '../features/chat/chat-view.js';

const MOBILE_QUERY = '(max-width: 900px)';

// A session whose device binding is missing, revoked or bound elsewhere can
// only be replaced by signing in again.
const SESSION_INVALID_CODES = new Set([
  'session_required',
  'session_revoked',
  'session_device_mismatch',
  'session_conflict',
]);

export class App {
  constructor(root) {
    this.root = root;
    this.session = null;
    this.userId = null;
    this.profile = null;
    this.device = null;
    this.mode = null;
    this.generation = 0;
    this.loadingUserId = null;
    this.loginView = null;
    this.accessView = null;
    this.pendingView = null;
    this.pendingCode = null;
    this.chat = null;
  }

  async start() {
    this.bindViewport();
    this.bindRouting();
    this.renderSplash();

    try {
      const { data } = await auth.getSession();
      await this.applySession(data.session);
    } catch (error) {
      this.renderFatal(error);
    }

    auth.onAuthStateChange((session) => {
      // Supabase requires auth callbacks to stay synchronous.
      window.setTimeout(() => {
        void this.applySession(session);
      }, 0);
    });
  }

  bindViewport() {
    const update = () => {
      const height =
        window.visualViewport?.height ?? window.innerHeight ?? 0;
      if (height > 0) {
        document.documentElement.style.setProperty(
          '--app-height',
          `${Math.round(height)}px`,
        );
      }
    };

    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
  }

  bindRouting() {
    window.addEventListener('hashchange', () => this.handleRoute());

    const query = window.matchMedia(MOBILE_QUERY);
    query.addEventListener('change', () => this.handleRoute());
  }

  async applySession(session, { force = false } = {}) {
    const user = session?.user ?? null;

    if (!user) {
      this.generation += 1;
      this.loadingUserId = null;
      this.session = null;
      this.userId = null;

      if (this.mode === 'login') return;

      this.reset();
      this.mode = 'login';
      this.renderLogin();
      return;
    }

    if (
      !force &&
      this.userId === user.id &&
      ['ready', 'access', 'pending', 'error'].includes(this.mode)
    ) {
      return;
    }

    if (this.loadingUserId === user.id) return;

    const generation = ++this.generation;
    this.loadingUserId = user.id;
    this.session = session;
    this.userId = null;
    this.profile = null;
    this.device = null;

    this.reset();
    this.renderSplash();

    try {
      const profile = await profiles.getProfile(user.id);
      if (generation !== this.generation) return;

      if (!profile || profile.status !== 'active') {
        this.userId = user.id;
        this.mode = 'access';
        this.renderAccess({ profile, email: user.email });
        return;
      }

      this.profile = profile;

      const device = await ensureDeviceIdentity(user.id);
      if (generation !== this.generation) return;

      if (device.status === 'pending') {
        const code = await deviceApprovalCode(device.publicJwk);
        if (generation !== this.generation) return;

        this.userId = user.id;
        this.profile = profile;
        this.device = device;
        this.pendingCode = code;
        this.mode = 'pending';
        this.renderPending({ profile, email: user.email, device, code });
        return;
      }

      // The recovery key is optional and local. A missing or unreadable record
      // only means that recovery envelopes cannot be opened on this device.
      let recovery = null;
      try {
        recovery = await getRecoveryIdentity(user.id);
      } catch {
        recovery = null;
      }
      if (generation !== this.generation) return;

      await conversations.ensureDefaultConversation();
      if (generation !== this.generation) return;

      const list = await conversations.listConversations();
      if (generation !== this.generation) return;

      this.userId = user.id;
      this.profile = profile;
      this.device = device;
      this.mode = 'ready';
      this.renderChat({ profile, device, recovery, conversations: list });
      this.handleRoute();
    } catch (error) {
      if (generation !== this.generation) return;
      this.userId = user.id;

      if (error?.code === 'device_revoked') {
        this.mode = 'access';
        this.renderAccess({
          profile: this.profile,
          email: user.email,
          reason: 'device_revoked',
        });
        return;
      }

      if (SESSION_INVALID_CODES.has(error?.code)) {
        this.mode = 'access';
        this.renderAccess({
          profile: this.profile,
          email: user.email,
          reason: 'session_invalid',
        });
        return;
      }

      this.mode = 'error';
      this.renderFatal(error);
    } finally {
      if (this.loadingUserId === user.id) this.loadingUserId = null;
    }
  }

  reset() {
    this.chat?.destroy();
    this.chat = null;
    this.loginView?.destroy();
    this.loginView = null;
    this.accessView?.destroy();
    this.accessView = null;
    this.pendingView?.destroy();
    this.pendingView = null;
    this.pendingCode = null;
    clear(this.root);
  }

  renderSplash() {
    clear(this.root);

    this.root.innerHTML = `
      <div class="splash">
        <div class="splash-inner">
          <span class="splash-mark">${logoMark}</span>
          <span class="splash-name">BARS</span>
          <span class="spinner"></span>
          <span class="splash-text">Защищаем соединение…</span>
        </div>
      </div>
    `;
  }

  renderLogin() {
    this.loginView = new LoginView({
      onSignedIn: (session) => {
        void this.applySession(session);
      },
    });
    this.loginView.mount(this.root);
  }

  renderAccess({ profile, email, reason = null }) {
    this.accessView = new AccessView({
      profile,
      email,
      reason,
      onRetry: () => this.retrySession(),
      onLogout: () => this.logout(),
    });
    this.accessView.mount(this.root);
  }

  renderPending({ profile, email, device, code }) {
    this.pendingView = new PendingView({
      profile,
      email,
      device,
      code,
      onCheck: () => this.checkPendingDevice(),
      onCancel: () => this.cancelPendingDevice(),
      onLogout: () => this.logout(),
    });
    this.pendingView.mount(this.root);
  }

  async checkPendingDevice() {
    if (!this.device?.deviceId || !this.session) {
      return { status: 'pending' };
    }

    const server = await devices.getDevice(this.device.deviceId);

    if (!server || server.status === 'revoked') {
      this.reset();
      this.mode = 'access';
      this.renderAccess({
        profile: this.profile,
        email: this.session.user?.email,
        reason: 'device_revoked',
      });
      return { status: 'revoked' };
    }

    if (server.status === 'active') {
      await this.applySession(this.session, { force: true });
      return { status: 'active' };
    }

    return { status: 'pending' };
  }

  async cancelPendingDevice() {
    await devices.cancelDeviceRequest(this.device.deviceId);

    // The server row is revoked; drop the local key so the next sign-in creates
    // a fresh request instead of showing the "device revoked" screen.
    await forgetDeviceIdentity(this.userId);
    await this.logout();
  }

  renderChat({ profile, device, recovery, conversations: list }) {
    this.chat = new ChatView({
      profile,
      device,
      recovery,
      conversations: list,
      callbacks: {
        onSelectConversation: (conversationId) => {
          const hash = `#/chat/${conversationId}`;
          if (location.hash === hash) {
            this.chat?.openConversation(conversationId);
          } else {
            location.hash = hash;
          }
        },
        onBack: () => {
          if (location.hash === '#/chat') {
            this.chat?.closeConversation();
          } else {
            location.hash = '#/chat';
          }
        },
        onLogout: () => this.logout(),
      },
    });

    this.chat.mount(this.root);
  }

  renderFatal(error) {
    this.reset();

    const message = humanizeError(
      error,
      'Не удалось подготовить приложение. Проверьте соединение и попробуйте снова.',
    );

    this.root.innerHTML = `
      <div class="auth">
        <div class="auth-glow auth-glow--one" aria-hidden="true"></div>
        <div class="auth-glow auth-glow--two" aria-hidden="true"></div>
        <main class="auth-card auth-card--access glass">
          <div class="brand brand--auth">
            <span class="brand-mark">${logoMark}</span>
            <span class="brand-text">
              <span class="brand-name">BARS</span>
              <span class="brand-caption">PRIVATE MESSENGER</span>
            </span>
          </div>
          <div class="access-icon access-icon--error" aria-hidden="true">${icon('alert')}</div>
          <h1 class="access-title">Не удалось загрузиться</h1>
          <p class="access-message" id="fatal-message"></p>
          <div class="access-actions">
            <button class="btn btn-primary" type="button" id="fatal-retry">Попробовать снова</button>
            <button class="btn btn-ghost" type="button" id="fatal-logout">Выйти</button>
          </div>
        </main>
      </div>
    `;

    this.root.querySelector('#fatal-message').textContent = message;
    this.root
      .querySelector('#fatal-retry')
      .addEventListener('click', () => this.retrySession());
    this.root
      .querySelector('#fatal-logout')
      .addEventListener('click', () => this.logout());
  }

  async retrySession() {
    try {
      const { data } = await auth.getSession();
      if (!data.session) {
        window.location.reload();
        return;
      }
      await this.applySession(data.session, { force: true });
    } catch (error) {
      toast(
        humanizeError(error, 'Не удалось проверить сессию. Попробуйте снова.'),
        'error',
      );
    }
  }

  handleRoute() {
    if (!this.chat) return;

    const match = /^#\/chat\/([0-9a-f-]{36})$/.exec(location.hash);

    if (match) {
      if (
        this.chat.hasConversation(match[1]) &&
        this.chat.openConversation(match[1])
      ) {
        return;
      }
      this.fallbackRoute();
      return;
    }

    if (this.isMobile()) {
      this.chat.closeConversation();
      if (location.hash && location.hash !== '#/chat') {
        history.replaceState(null, '', '#/chat');
      }
      return;
    }

    this.fallbackRoute();
  }

  fallbackRoute() {
    if (!this.chat) return;

    const conversationId = this.chat.defaultConversationId;

    if (!conversationId) {
      this.chat.closeConversation();
      return;
    }

    history.replaceState(null, '', `#/chat/${conversationId}`);
    this.chat.openConversation(conversationId);
  }

  isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  async logout() {
    try {
      await auth.signOut();
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}`,
      );
    } catch (error) {
      toast(humanizeError(error, 'Не удалось выйти из аккаунта.'), 'error');
    }
  }
}
