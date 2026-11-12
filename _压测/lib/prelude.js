// 注入到页面里的公共垫片，run.mjs 会拼在每个 page/*.js 前面。
// 注意：这段是「页面内 JS」，不是 Node 模块 —— 不要写 import / require。
const DB_NAME = 'ellen-mobile-data-v1';

// 不传 ver 就按当前版本打开（不要硬写 3，升 schema 会炸）
const openDB = (ver) =>
  new Promise((res, rej) => {
    const r = ver ? indexedDB.open(DB_NAME, ver) : indexedDB.open(DB_NAME);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IDB 被阻塞：页面上还有未结束的写事务，稍等再跑'));
  });

const txDone = (t) =>
  new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });

const countStore = (db, store) =>
  new Promise((res, rej) => {
    const rq = db.transaction(store, 'readonly').objectStore(store).count();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });

// 按 kind 数（走 kind 索引，不 getAll）
const countKind = (db, kind) =>
  new Promise((res, rej) => {
    const rq = db
      .transaction('data-heads', 'readonly')
      .objectStore('data-heads')
      .index('kind')
      .count(kind);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });

// 所有 head 的 profileId 分布（造数要跟现库同 profile，否则 listLatest 查不到）
const profilesInUse = (db) =>
  new Promise((res, rej) => {
    const seen = new Map();
    const c = db.transaction('data-heads', 'readonly').objectStore('data-heads').openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return res([...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n })));
      const p = cur.value.profileId || '(none)';
      seen.set(p, (seen.get(p) || 0) + 1);
      cur.continue();
    };
    c.onerror = () => rej(c.error);
  });

const nowMs = () => Date.now();
