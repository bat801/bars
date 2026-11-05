import { supabase } from './supabase.js';
import { MESSAGE_PAGE_SIZE } from '../core/config.js';

const MESSAGE_SELECT = `
  id,
  conversation_id,
  sender_id,
  sender_device_id,
  type,
  crypto_version,
  ciphertext,
  iv,
  seq,
  created_at,
  message_keys (
    device_id,
    enc,
    wrapped_key
  )
`;

export async function listMessages({
  conversationId,
  beforeSeq = null,
  afterSeq = null,
  limit = MESSAGE_PAGE_SIZE,
}) {
  let query = supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .limit(limit);

  if (beforeSeq !== null && beforeSeq !== undefined) {
    query = query.lt('seq', beforeSeq).order('seq', { ascending: false });
  } else if (afterSeq !== null && afterSeq !== undefined) {
    query = query.gt('seq', afterSeq).order('seq', { ascending: true });
  } else {
    query = query.order('seq', { ascending: false });
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []).map(normalizeMessageRow);
  return afterSeq !== null && afterSeq !== undefined ? rows : rows.reverse();
}

export async function getMessage(messageId) {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('id', messageId)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeMessageRow(data) : null;
}

export async function sendMessage({
  conversationId,
  messageId,
  clientMessageId,
  deviceId,
  ciphertext,
  iv,
  keys,
}) {
  const { data, error } = await supabase.rpc('send_message', {
    p_conversation_id: conversationId,
    p_message_id: messageId,
    p_client_message_id: clientMessageId,
    p_device_id: deviceId,
    p_type: 'text',
    p_crypto_version: 1,
    p_ciphertext: ciphertext,
    p_iv: iv,
    p_keys: keys.map((key) => ({
      device_id: key.deviceId,
      enc: key.enc,
      wrapped_key: key.wrappedKey,
    })),
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export function normalizeMessageRow(row) {
  return {
    ...row,
    crypto_version: Number(row.crypto_version),
    seq: Number(row.seq),
    message_keys: row.message_keys ?? [],
  };
}
