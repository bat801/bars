import { supabase } from './supabase.js';

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, role, status, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateDisplayName(displayName) {
  const { data, error } = await supabase.rpc('update_profile', {
    p_display_name: displayName,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
