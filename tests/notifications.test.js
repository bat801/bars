import { describe, expect, it } from 'vitest';
import {
  claimNotification,
  getNotificationPreference,
  notificationPreferenceKey,
  notificationText,
  setNotificationPreference,
  shouldNotify,
} from '../src/core/notifications.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
  };
}

const base = {
  enabled: true,
  permission: 'granted',
  visibility: 'hidden',
  focused: false,
  senderId: 'peer',
  userId: 'me',
  fresh: true,
};

describe('browser notification decisions', () => {
  it('notifies only for other users with permission and an inactive tab', () => {
    expect(shouldNotify(base)).toBe(true);
    expect(shouldNotify({ ...base, enabled: false })).toBe(false);
    expect(shouldNotify({ ...base, permission: 'default' })).toBe(false);
    expect(shouldNotify({ ...base, permission: 'denied' })).toBe(false);
    expect(shouldNotify({ ...base, senderId: 'me' })).toBe(false);
    expect(shouldNotify({ ...base, fresh: false })).toBe(false);
    expect(
      shouldNotify({ ...base, visibility: 'visible', focused: true }),
    ).toBe(false);
  });

  it('notifies when the tab is visible but another window has focus', () => {
    expect(
      shouldNotify({ ...base, visibility: 'visible', focused: false }),
    ).toBe(true);
  });

  it('never includes message text in notification copy', () => {
    expect(
      notificationText({
        kind: 'direct',
        senderName: 'Бат',
        conversationTitle: 'Бат',
      }),
    ).toEqual({ title: 'Бат', body: 'Новое сообщение' });

    expect(
      notificationText({
        kind: 'group',
        senderName: 'Бат',
        conversationTitle: 'Закрытый круг',
      }),
    ).toEqual({ title: 'Закрытый круг', body: 'Бат: Новое сообщение' });
  });

  it('stores the preference locally per user', () => {
    const storage = memoryStorage();

    expect(notificationPreferenceKey('user-1')).toBe(
      'bars:notifications:user-1',
    );
    expect(getNotificationPreference('user-1', storage)).toBe(false);

    setNotificationPreference('user-1', true, storage);
    expect(getNotificationPreference('user-1', storage)).toBe(true);
    expect(getNotificationPreference('user-2', storage)).toBe(false);

    setNotificationPreference('user-1', false, storage);
    expect(getNotificationPreference('user-1', storage)).toBe(false);
  });

  it('claims each message once per short window across tabs', () => {
    const storage = memoryStorage();

    expect(claimNotification('message-1', { storage, now: 1000 })).toBe(true);
    expect(claimNotification('message-1', { storage, now: 2000 })).toBe(false);
    expect(
      claimNotification('message-1', { storage, now: 1000 + 6 * 60 * 1000 }),
    ).toBe(true);
    expect(claimNotification('message-2', { storage, now: 2000 })).toBe(true);
    expect(claimNotification('', { storage, now: 2000 })).toBe(true);
  });
});
