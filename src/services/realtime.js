import { supabase } from './supabase.js';

/**
 * One global channel for every conversation the user can see.
 *
 * Supabase Realtime enforces the `messages` RLS policy for Postgres Changes,
 * so this client only receives rows from conversations it is a member of.
 * A global channel keeps unread badges and notifications working for
 * background conversations without opening one subscription per dialog.
 */
export function subscribeToMessages({ onMessage, onStatus }) {
  const channel = supabase
    .channel('bars:messages')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      },
      (payload) => {
        if (payload?.new) onMessage(payload.new);
      },
    );

  channel.subscribe((status, error) => {
    onStatus?.(status, error);
  });

  return () => {
    void supabase.removeChannel(channel);
  };
}
