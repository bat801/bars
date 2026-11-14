import { describe, expect, it } from 'vitest';
import {
  clearUnread,
  formatUnreadCount,
  incrementUnread,
  maxSeq,
  totalUnread,
  unreadDocumentTitle,
  unreadFromRows,
} from '../src/features/chat/unread.js';

describe('unread state helpers', () => {
  it('builds a sparse map from RPC rows and ignores empty counts', () => {
    const counts = unreadFromRows([
      { conversationId: 'a', count: 3 },
      { conversation_id: 'b', unread_count: '2' },
      { conversationId: 'c', count: 0 },
      { conversationId: 'd', count: -1 },
      { conversationId: null, count: 5 },
      { conversationId: 'e', count: 'nope' },
    ]);

    expect([...counts.entries()]).toEqual([
      ['a', 3],
      ['b', 2],
    ]);
  });

  it('increments and clears without mutating the input map', () => {
    const empty = new Map();
    const first = incrementUnread(empty, 'chat', 1);
    const second = incrementUnread(first, 'chat', 2);
    const other = incrementUnread(second, 'other');

    expect(empty.size).toBe(0);
    expect(first.get('chat')).toBe(1);
    expect(second.get('chat')).toBe(3);
    expect(other.get('other')).toBe(1);

    const cleared = clearUnread(other, 'chat');
    expect(cleared.has('chat')).toBe(false);
    expect(other.has('chat')).toBe(true);
    expect(clearUnread(cleared, 'chat')).toBe(cleared);
  });

  it('counts totals and caps the list badge', () => {
    const counts = new Map([
      ['a', 2],
      ['b', 3],
    ]);

    expect(totalUnread(counts)).toBe(5);
    expect(totalUnread(new Map())).toBe(0);
    expect(formatUnreadCount(0)).toBe('');
    expect(formatUnreadCount(7)).toBe('7');
    expect(formatUnreadCount(99)).toBe('99');
    expect(formatUnreadCount(100)).toBe('99+');
  });

  it('finds the highest numeric sequence', () => {
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([{ seq: 4 }, { seq: '9' }, { seq: null }, { seq: 'x' }])).toBe(
      9,
    );
  });

  it('prefixes the document title only when unread messages exist', () => {
    expect(unreadDocumentTitle('BARS', 0)).toBe('BARS');
    expect(unreadDocumentTitle('Чат — BARS', 3)).toBe('(3) Чат — BARS');
  });
});
