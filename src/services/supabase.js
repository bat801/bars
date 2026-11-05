import { createClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from '../core/config.js';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Supabase configuration is missing');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
    storageKey: 'bars.auth.session',
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});
