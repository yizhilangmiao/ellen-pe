// IndexedDB 打开与升级。
//
// 库结构与旧包**逐字对齐**（contract/M4-数据模型-真机实测.md）：
//   DB  `ellen-mobile-data-v1`  version 4
//   store `data-meta`      keyPath 'key'
//   store `data-profiles`  keyPath 'id'
//   store `data-heads`     keyPath 'id'   index: kind / messageTime / profileId / profileKind / profileKindThread
//   store `data-revisions` keyPath 'revisionId'
//
// 对齐的意义：旧包导出的数据不用变形就能灌进来，将来也能双向导。

export const DB_NAME = 'ellen-mobile-data-v1';
// 3 → 4：只加消息字段（type/recalled/quoteOf…），表结构一个没动。
// 升版本号是为了让「老库已经打开过」的设备也走一次 onupgradeneeded 把新索引/新表补齐，
// 数据本身靠 migrateMessages() 补，这里**禁止**删库或清 objectStore。
export const DB_VERSION = 4;

export const STORE_META = 'data-meta';
export const STORE_PROFILES = 'data-profiles';
export const STORE_HEADS = 'data-heads';
export const STORE_REVISIONS = 'data-revisions';

let dbPromise = null;

/** 建库/升级。只在需要时跑，失败时把原因抛清楚（别静默白屏）。 */
function upgrade(db, oldVersion) {
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_PROFILES)) {
    db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_HEADS)) {
    const heads = db.createObjectStore(STORE_HEADS, { keyPath: 'id' });
    heads.createIndex('kind', 'kind', { unique: false });
    heads.createIndex('messageTime', 'messageTime', { unique: false });
    heads.createIndex('profileId', 'profileId', { unique: false });
    heads.createIndex('profileKind', ['profileId', 'kind'], { unique: false });
    heads.createIndex('profileKindThread', ['profileId', 'kind', 'threadId'], { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE_REVISIONS)) {
    db.createObjectStore(STORE_REVISIONS, { keyPath: 'revisionId' });
  }
  if (oldVersion < 3 && !db.objectStoreNames.contains(STORE_PROFILES)) {
    // 老版本可能只有 heads/revisions，补上 profiles（上面已建，这里只是显式记账）
  }
}

/** 打开库（单例）。 */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new Error(`IndexedDB 打不开：${err && err.message ? err.message : err}`));
      return;
    }
    req.onupgradeneeded = (e) => {
      try {
        upgrade(req.result, e.oldVersion || 0);
      } catch (err) {
        console.error('[db] 升级失败', err);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`IndexedDB 打开失败：${req.error && req.error.message}`));
    req.onblocked = () => console.warn('[db] 另一个页面还占着旧版本，升级被阻塞');
  });
  return dbPromise;
}

/** 在一个事务里跑 fn(store, isDone)。返回 Promise，事务 complete 才 resolve。 */
export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('事务失败'));
    t.onabort = () => reject(t.error || new Error('事务被中止'));
    try {
      result = fn(t);
    } catch (err) {
      try {
        t.abort();
      } catch {
        /* 已经结束 */
      }
      reject(err);
    }
  });
}

/** Promise 化单个请求。 */
export function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 只读计数（验收脚本用）。 */
export async function count(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const r = t.objectStore(storeName).count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 删库（清空重来用，M4 迁移重跑时靠它）。 */
export async function dropDb() {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      /* ignore */
    }
    dbPromise = null;
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删库被阻塞：还有连接没关'));
  });
}
