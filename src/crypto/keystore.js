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
const DB_VERSION = 2;
const STORE = 'devices';
const RECOVERY_STORE = 'recovery';

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'userId' });
        }
        if (
          oldVersion < 2 &&
          !db.objectStoreNames.contains(RECOVERY_STORE)
        ) {
          db.createObjectStore(RECOVERY_STORE, { keyPath: 'userId' });
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

function wrapStorageError(error) {
  if (error instanceof AppError) return error;
  return new AppError('key_storage_failed', String(error?.message ?? error));
}

async function getRecord(store, userId) {
  try {
    const db = await getDb();
    return await db.get(store, userId);
  } catch (error) {
    throw wrapStorageError(error);
  }
}

async function putRecord(store, identity) {
  try {
    const db = await getDb();
    await db.put(store, identity);
    return identity;
  } catch (error) {
    throw wrapStorageError(error);
  }
}

async function deleteRecord(store, userId) {
  try {
    const db = await getDb();
    await db.delete(store, userId);
  } catch (error) {
    throw wrapStorageError(error);
  }
}

export function loadIdentity(userId) {
  return getRecord(STORE, userId);
}

export function saveIdentity(identity) {
  return putRecord(STORE, identity);
}

export function deleteIdentity(userId) {
  return deleteRecord(STORE, userId);
}

export function loadRecoveryIdentity(userId) {
  return getRecord(RECOVERY_STORE, userId);
}

export function saveRecoveryIdentity(identity) {
  return putRecord(RECOVERY_STORE, identity);
}

export function deleteRecoveryIdentity(userId) {
  return deleteRecord(RECOVERY_STORE, userId);
}
