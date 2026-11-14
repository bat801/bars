/**
 * Browser notification helpers.
 *
 * M2.1 has no service worker and no push: notifications only work while a tab
 * is open. The preference is stored locally per user (localStorage is already
 * scoped to one browser/device) and notification text never includes message
 * contents.
 */

const PREFERENCE_PREFIX = 'bars:notifications:';
const CLAIM_PREFIX = 'bars:notification-claim:';
const CLAIM_TTL = 5 * 60 * 1000;

function safeStorage() {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function notificationPreferenceKey(userId) {
  return `${PREFERENCE_PREFIX}${userId}`;
}

export function getNotificationPreference(userId, storage = safeStorage()) {
  if (!userId || !storage) return false;

  try {
    return storage.getItem(notificationPreferenceKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function setNotificationPreference(
  userId,
  enabled,
  storage = safeStorage(),
) {
  if (!userId || !storage) return;

  try {
    storage.setItem(notificationPreferenceKey(userId), enabled ? '1' : '0');
  } catch {
    // A blocked storage area only means the preference cannot be persisted.
  }
}

export function notificationSupport() {
  return (
    typeof window !== 'undefined' && typeof window.Notification === 'function'
  );
}

export function getNotificationPermission() {
  if (!notificationSupport()) return 'unsupported';
  return window.Notification.permission;
}

export async function requestNotificationPermission() {
  if (!notificationSupport()) return 'unsupported';

  const current = window.Notification.permission;
  if (current !== 'default') return current;

  try {
    return await window.Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Decides whether an incoming message should produce a browser notification.
 * The decision is pure so it can be tested without a DOM.
 */
export function shouldNotify({
  enabled,
  permission,
  visibility,
  focused,
  senderId,
  userId,
  fresh = true,
}) {
  if (!enabled || permission !== 'granted' || !fresh) return false;
  if (!senderId || senderId === userId) return false;
  if (visibility === 'visible' && focused) return false;
  return true;
}

/**
 * Notification text contains only the sender/conversation and a generic
 * phrase. Message text must never be passed here.
 */
export function notificationText({ kind, senderName, conversationTitle }) {
  if (kind === 'direct') {
    return {
      title: senderName || conversationTitle || 'BARS',
      body: 'Новое сообщение',
    };
  }

  return {
    title: conversationTitle || 'BARS',
    body: `${senderName || 'Участник'}: Новое сообщение`,
  };
}

/**
 * Prevents two open tabs from showing the same notification. The claim is a
 * short-lived localStorage marker; the race window is acceptable for a
 * private messenger with a handful of users.
 */
export function claimNotification(
  messageId,
  { storage = safeStorage(), now = Date.now(), ttl = CLAIM_TTL } = {},
) {
  if (!messageId || !storage) return true;

  const key = `${CLAIM_PREFIX}${messageId}`;

  try {
    const previous = Number(storage.getItem(key));
    if (Number.isFinite(previous) && previous > 0 && now - previous < ttl) {
      return false;
    }

    storage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

export function showBrowserNotification({ title, body, tag, onClick }) {
  if (getNotificationPermission() !== 'granted') return null;

  try {
    const notification = new window.Notification(title, {
      body,
      tag,
      renotify: false,
    });

    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };

    return notification;
  } catch {
    // Mobile browsers may expose Notification but reject page-context
    // construction. Badges and toasts remain the fallback.
    return null;
  }
}
