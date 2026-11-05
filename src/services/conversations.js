import { supabase } from './supabase.js';

const CONVERSATION_SELECT = `
  id,
  kind,
  title,
  created_at,
  last_message_at,
  conversation_members (
    user_id,
    joined_at,
    profiles (
      id,
      username,
      display_name,
      avatar_url
    )
  )
`;

export async function ensureDefaultConversation() {
  const { data, error } = await supabase.rpc('ensure_default_conversation');
  if (error) throw error;
  return data;
}

export async function listConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .order('last_message_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(normalizeConversation);
}

export function normalizeConversation(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    members: (row.conversation_members ?? []).map((member) => ({
      userId: member.user_id,
      joinedAt: member.joined_at,
      profile: member.profiles
        ? {
            id: member.profiles.id,
            username: member.profiles.username,
            displayName: member.profiles.display_name,
            avatarUrl: member.profiles.avatar_url,
          }
        : null,
    })),
  };
}

export function conversationTitle(conversation, currentUserId) {
  if (conversation.kind === 'direct') {
    const other = conversation.members.find(
      (member) => member.userId !== currentUserId,
    );
    return other?.profile?.displayName || 'Личный диалог';
  }
  return conversation.title;
}

export function memberProfiles(conversation) {
  return conversation.members
    .map((member) => member.profile)
    .filter(Boolean);
}

export function memberLabel(conversation, currentUserId) {
  const names = conversation.members
    .filter((member) => member.userId !== currentUserId)
    .map((member) => member.profile?.displayName)
    .filter(Boolean);

  if (names.length === 0) return 'Только вы';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}`;
}
