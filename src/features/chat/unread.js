/**
 * Pure unread-state helpers.
 *
 * The state is a Map<conversationId, count> that only contains conversations
 * with at least one unread message. Keeping it sparse makes clearing a
 * conversation a delete instead of a write of zero.
 */

export function unreadFromRows(rows = []) {
  const counts = new Map();

  for (const row of rows) {
    const conversationId = row?.conversationId ?? row?.conversation_id;
    const count = Number(row?.count ?? row?.unread_count ?? 0);

    if (conversationId && Number.isFinite(count) && count > 0) {
      counts.set(conversationId, count);
    }
  }

  return counts;
}

export function incrementUnread(counts, conversationId, amount = 1) {
  if (!conversationId) return counts;

  const delta = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1;
  const next = new Map(counts);
  next.set(conversationId, (next.get(conversationId) ?? 0) + delta);
  return next;
}

export function clearUnread(counts, conversationId) {
  if (!counts.has(conversationId)) return counts;

  const next = new Map(counts);
  next.delete(conversationId);
  return next;
}

export function totalUnread(counts) {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

export function maxSeq(items = []) {
  let max = 0;

  for (const item of items) {
    const seq = Number(item?.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }

  return max;
}

export function formatUnreadCount(count) {
  const value = Number(count);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value > 99 ? '99+' : String(value);
}

export function unreadDocumentTitle(baseTitle, total) {
  return total > 0 ? `(${total}) ${baseTitle}` : baseTitle;
}
