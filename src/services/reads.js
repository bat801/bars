import { supabase } from './supabase.js';

/**
 * Read state is stored per user on the server and is private to that user.
 * The client only sends a high-water mark, never message contents.
 */
export async function listUnreadCounts() {
  const { data, error } = await supabase.rpc('list_unread_counts');
  if (error) throw error;

  return (data ?? []).map((row) => ({
    conversationId: row.conversation_id,
    count: Number(row.unread_count),
  }));
}

export async function markConversationRead(conversationId, seq) {
  const { data, error } = await supabase.rpc('mark_conversation_read', {
    p_conversation_id: conversationId,
    p_seq: seq,
  });

  if (error) throw error;
  return Number(data);
}
