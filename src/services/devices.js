import { supabase } from './supabase.js';

export async function getDevice(deviceId) {
  const { data, error } = await supabase
    .from('devices')
    .select('id, user_id, name, public_key_jwk, status, kind, created_at, last_seen_at')
    .eq('id', deviceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function listMyDevices(userId) {
  const { data, error } = await supabase
    .from('devices')
    .select('id, user_id, name, public_key_jwk, status, kind, created_at, last_seen_at, revoked_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function countPendingDevices(userId) {
  const { count, error } = await supabase
    .from('devices')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', 'device')
    .eq('status', 'pending');

  if (error) throw error;
  return count ?? 0;
}

export async function getMyRecoveryDevice(userId) {
  const { data, error } = await supabase
    .from('devices')
    .select('id, user_id, name, public_key_jwk, status, kind, created_at, last_seen_at, revoked_at')
    .eq('user_id', userId)
    .eq('kind', 'recovery')
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function registerDevice({ deviceId, name, publicJwk }) {
  const { data, error } = await supabase.rpc('register_device', {
    p_device_id: deviceId,
    p_name: name,
    p_public_key_jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x,
      y: publicJwk.y,
    },
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function registerRecoveryKey({ deviceId, publicJwk }) {
  const { data, error } = await supabase.rpc('register_recovery_key', {
    p_device_id: deviceId,
    p_public_key_jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x,
      y: publicJwk.y,
    },
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function revokeDevice(deviceId) {
  const { data, error } = await supabase.rpc('revoke_device', {
    p_device_id: deviceId,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function approveDevice(deviceId) {
  const { data, error } = await supabase.rpc('approve_device', {
    p_device_id: deviceId,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function cancelDeviceRequest(deviceId) {
  const { data, error } = await supabase.rpc('cancel_device_request', {
    p_device_id: deviceId,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function getConversationDevices(conversationId) {
  const { data, error } = await supabase.rpc('get_conversation_devices', {
    p_conversation_id: conversationId,
  });

  if (error) throw error;
  return data ?? [];
}
