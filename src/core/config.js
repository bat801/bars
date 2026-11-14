/**
 * BARS application configuration.
 *
 * The Supabase "publishable" key is designed to be shipped to browsers.
 * It only grants the `anon` role; all access is enforced by RLS.
 * Never put a service-role key or database password in this file.
 */

const env = import.meta.env ?? {};

export const SUPABASE_URL =
  env.VITE_SUPABASE_URL || 'https://ozcthmspxtrcfxomovoq.supabase.co';

export const SUPABASE_KEY =
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_vtZ4QSdQuzfakRh7qYOpPA_TQm-0w6D';

export const APP_NAME = 'BARS';
export const APP_VERSION = '0.4.0';

/** Current envelope format. Bump only together with a migration path. */
export const CRYPTO_VERSION = 1;

/** Fixed id of the seeded group conversation. */
export const DEFAULT_CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';

export const MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_LENGTH = 4000;
export const MIN_PASSWORD_LENGTH = 8;

export const IS_GITHUB_PAGES = /github\.io$/i.test(
  typeof location !== 'undefined' ? location.hostname : '',
);
