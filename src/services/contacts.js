import { supabase } from './supabase.js';

/**
 * Active users who share at least one conversation with the caller.
 * The RPC keeps profile visibility scoped to the existing closed circle.
 */
export async function listContacts() {
  const { data, error } = await supabase.rpc('list_contacts');
  if (error) throw error;

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    directConversationId: row.direct_conversation_id,
  }));
}
