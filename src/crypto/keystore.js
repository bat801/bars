import { openDB } from 'idb';
import { AppError } from '../core/errors.js';
import { SUPABASE_URL } from '../core/config.js';

const projectRef = (() => {
  try {
    return new URL(SUPABASE_URL).hostname.split('.')[0];
  } catch {
    return 'local';
  }
})();

const DB_NAME = `bars-e2ee-${projectRef}`;
const DB_VERSION = 1;
const STORE = 'devices';

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'userId' });
        }
      },
    }).catch((error) => {
      dbPromise = null;
      throw new AppError(
        'key_storage_failed',
        `IndexedDB unavailable: ${error?.message ?? error}`,
      );
    });
  }
  return dbPromise;
}

export async function loadIdentity(userId) {
  try {
    const db = await getDb();
    return await db.get(STORE, userId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('key_storage_failed', String(error?.message ?? error));
  }
}

export async function saveIdentity(identity) {
  try {
    const db = await getDb();
    await db.put(STORE, identity);
    return identity;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('key_storage_failed', String(error?.message ?? error));
  }
}

export async function deleteIdentity(userId) {
  try {
    const db = await getDb();
    await db.delete(STORE, userId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('key_storage_failed', String(error?.message ?? error));
  }
}
