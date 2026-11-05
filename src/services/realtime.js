import { supabase } from './supabase.js';

/**
 * Subscribes to INSERT events for one conversation.
 * RLS is enforced by Supabase Realtime for Postgres Changes, so a client only
 * receives rows from conversations it is a member of.
 */
export function subscribeToMessages(conversationId, { onMessage, onStatus }) {
  const channel = supabase
    .channel(`bars:messages:${conversationId}:${crypto.randomUUID().slice(0, 8)}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
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
