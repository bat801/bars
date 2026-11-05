import { humanizeError } from '../../core/errors.js';
import { icon, logoMark } from '../../components/icons.js';
import { signIn } from '../../services/auth.js';

export class LoginView {
  constructor({ onSignedIn } = {}) {
    this.onSignedIn = onSignedIn;
  }

  mount(root) {
    root.innerHTML = `
      <div class="auth">
        <div class="auth-glow auth-glow--one" aria-hidden="true"></div>
        <div class="auth-glow auth-glow--two" aria-hidden="true"></div>
        <div class="auth-grid" aria-hidden="true"></div>

        <main class="auth-card glass">
          <div class="brand brand--auth">
            <span class="brand-mark">${logoMark}</span>
            <span class="brand-text">
              <span class="brand-name">BARS</span>
              <span class="brand-caption">PRIVATE MESSENGER</span>
            </span>
          </div>

          <div class="auth-intro">
            <h1>С возвращением</h1>
            <p>Закрытое пространство для своего круга. Вход только по приглашению.</p>
          </div>

          <form class="auth-form" novalidate>
            <label class="field">
              <span class="field-label">Почта</span>
              <input
                class="input"
                type="email"
                name="email"
                autocomplete="username"
                inputmode="email"
                autocapitalize="none"
                spellcheck="false"
                placeholder="you@example.com"
                required
              />
            </label>

            <label class="field">
              <span class="field-label">Пароль</span>
              <span class="field-password">
                <input
                  class="input"
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  placeholder="••••••••"
                  required
                />
                <button class="icon-btn field-toggle" type="button" aria-label="Показать пароль">
                  ${icon('eye')}
                </button>
              </span>
            </label>

            <p class="form-error" role="alert"></p>

            <button class="btn btn-primary btn-block" type="submit">
              <span class="btn-label">Войти</span>
              <span class="spinner spinner--sm" aria-hidden="true"></span>
            </button>
          </form>

          <footer class="auth-footer">
            <span class="pill">${icon('lock')} End-to-end</span>
            <span>Только для приглашённых</span>
          </footer>
        </main>

        <p class="auth-legal">BARS · Private messenger · <span>v0.1</span></p>
      </div>
    `;

    this.root = root;
    this.form = root.querySelector('.auth-form');
    this.email = this.form.elements.email;
    this.password = this.form.elements.password;
    this.toggle = root.querySelector('.field-toggle');
    this.error = root.querySelector('.form-error');
    this.submit = this.form.querySelector('button[type="submit"]');
    this.label = this.submit.querySelector('.btn-label');

    this.form.addEventListener('submit', (event) => this.handleSubmit(event));
    this.toggle.addEventListener('click', () => this.togglePassword());
    this.email.addEventListener('input', () => this.clearError());
    this.password.addEventListener('input', () => this.clearError());

    if (window.matchMedia('(pointer: fine)').matches) {
      requestAnimationFrame(() => this.email.focus());
    }
  }

  destroy() {}

  togglePassword() {
    const visible = this.password.type === 'text';
    this.password.type = visible ? 'password' : 'text';
    this.toggle.setAttribute(
      'aria-label',
      visible ? 'Показать пароль' : 'Скрыть пароль',
    );
    this.toggle.innerHTML = icon(visible ? 'eye' : 'eyeOff');
    this.password.focus();
  }

  async handleSubmit(event) {
    event.preventDefault();
    this.clearError();

    const email = this.email.value.trim();
    const password = this.password.value;

    if (!email || !password) {
      this.showError('Введите почту и пароль.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.showError('Похоже, почта указана неверно.');
      return;
    }

    this.setBusy(true);

    try {
      const data = await signIn(email, password);
      this.onSignedIn?.(data.session);
    } catch (error) {
      this.setBusy(false);
      this.showError(humanizeError(error, 'Не удалось войти. Проверьте данные.'));
      this.password.select?.();
    }
  }

  setBusy(busy) {
    this.submit.classList.toggle('is-loading', busy);
    this.submit.disabled = busy;
    this.form.elements.email.disabled = busy;
    this.form.elements.password.disabled = busy;
    this.label.textContent = busy ? 'Входим…' : 'Войти';
  }

  showError(message) {
    this.error.textContent = message;
    this.error.classList.add('is-visible');
  }

  clearError() {
    this.error.textContent = '';
    this.error.classList.remove('is-visible');
  }
}
