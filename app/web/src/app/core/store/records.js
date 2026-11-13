// 记录层：事件溯源的 heads / revisions 读写。
//
// 结构照旧包（真机实测见 contract/M4-数据模型-真机实测.md）：
//   head     { id, kind, profileId, threadId, createdAt, messageTime,
//              revisions:[revisionId...], conflict:false, deleted:false, threadKeys:[] }
//   revision { id, kind, profileId, revisionId, parents:[..], origin:{deviceId,platform},
//              at, deleted:false, value, refs:[] }
//
// 规则：记录一旦写出就不再改，变更 = 追加一条 revision 并把 head.revisions 推长。
import { STORE_HEADS, STORE_META, STORE_PROFILES, STORE_REVISIONS, tx, reqDone, openDb } from './db.js';

/** 设备标识：首次生成后固定在 localStorage，跨重启不变（旧包同款 origin.deviceId）。 */
const DEVICE_KEY = 'ellen-device-id';

export function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能抛 */
  }
  if (!id) {
    id = uuid();
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* 存不住就每次变，只影响冲突判定 */
    }
  }
  return id;
}

export function platform() {
  return 'android';
}

/** UUID v4，crypto.randomUUID 缺失时自己拼（老 bug ⑥）。 */
export function uuid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* 非安全上下文时降级 */
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 当前 profile（单用户，一个就够）。没有就建。 */
let profileCache = null;

/**
 * 清掉 profile 缓存。导入资料包后必须调 —— 否则还拿旧 profileId 去查索引，
 * 查出来是空的（数据明明在库里，界面却什么都没有）。
 */
export function invalidateProfile() {
  profileCache = null;
}

export async function ensureProfile() {
  if (profileCache) return profileCache;
  const db = await openDb();
  const existing = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_PROFILES, 'readonly');
    const r = t.objectStore(STORE_PROFILES).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  if (existing.length === 1) {
    profileCache = existing[0];
    return profileCache;
  }
  if (existing.length > 1) {
    // 有多个 profile（换签名包重装后导入旧包 = 新 profile + 旧 profile 并存）：
    // 取「消息最多的那个」，否则会随机挑到新装时自动建的空 profile，
    // 数据明明在库里、界面却是一片空白（2026-11-13 真机踩到）。
    const counts = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_HEADS, 'readonly');
      const r = t.objectStore(STORE_HEADS).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    const tally = new Map();
    for (const h of counts) {
      if (h.kind !== 'message' || !h.profileId) continue;
      tally.set(h.profileId, (tally.get(h.profileId) || 0) + 1);
    }
    let best = existing[0];
    let bestN = tally.get(best.id) || 0;
    for (const p of existing) {
      const n = tally.get(p.id) || 0;
      if (n > bestN) {
        best = p;
        bestN = n;
      }
    }
    profileCache = best;
    return profileCache;
  }
  const profile = {
    id: `profile:${uuid()}`,
    createdAt: Date.now(),
    kind: 'profile',
  };
  await tx(STORE_PROFILES, 'readwrite', (t) => t.objectStore(STORE_PROFILES).put(profile));
  profileCache = profile;
  return profile;
}

/** meta 表读写（键值对，放当前线程、本地统计这类小东西）。 */
export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_META, 'readonly');
    const r = t.objectStore(STORE_META).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return rec ? rec.value : fallback;
}

export async function putMeta(key, value) {
  return tx(STORE_META, 'readwrite', (t) => t.objectStore(STORE_META).put({ key, value }));
}

/** 当前线程 id（旧包用 `thread:<uuid>` 形态）。 */
export async function currentThreadId() {
  let id = await getMeta('current-thread');
  if (id) {
    // 自愈：meta 指着的这条线程如果一条消息都没有，而库里别的线程有，
    // 就切到那条。换签名包重装后导入旧资料时踩到过 —— 新装首启自动建了个空线程，
    // 导入的记录都在旧 threadId 下，界面于是一片空白，看着像「数据没进来」。
    const empty = !(await threadHasMessages(id));
    if (empty) {
      const better = await busiestThreadId();
      if (better && better !== id) {
        await putMeta('current-thread', better);
        await putMeta('current-thread-at', Date.now());
        return better;
      }
    }
    return id;
  }
  id = `thread:${uuid()}`;
  await putMeta('current-thread', id);
  await putMeta('current-thread-at', Date.now());
  return id;
}

/** 这条线程下还有没有消息（软删的不算）。 */
async function threadHasMessages(threadId) {
  try {
    const profile = await ensureProfile();
    const db = await openDb();
    const n = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_HEADS, 'readonly');
      const r = t.objectStore(STORE_HEADS).index('profileKindThread').count([profile.id, 'message', threadId]);
      r.onsuccess = () => resolve(r.result || 0);
      r.onerror = () => reject(r.error);
    });
    return n > 0;
  } catch (err) {
    return true;
  }
}

/** 消息最多的那条线程（自愈用；没有就 null）。 */
async function busiestThreadId() {
  try {
    const profile = await ensureProfile();
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_HEADS, 'readonly');
      const r = t.objectStore(STORE_HEADS).index('profileKind').getAll([profile.id, 'message']);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    const tally = new Map();
    for (const h of rows) {
      if (!h.threadId || h.deleted) continue;
      tally.set(h.threadId, (tally.get(h.threadId) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [tid, n] of tally) {
      if (n > bestN) {
        best = tid;
        bestN = n;
      }
    }
    return best;
  } catch (err) {
    return null;
  }
}

/** 切到某个线程（聊天历史页点一条就走这里）。 */
export async function setCurrentThread(id) {
  if (!id) return null;
  await putMeta('current-thread', id);
  await putMeta('current-thread-at', Date.now());
  return id;
}

/**
 * 追加一条记录。返回 { headId, revisionId }。
 * @param {object} p
 * @param {string} p.kind      message / memory / journal / attachment / source / emotion / note / thread
 * @param {object} p.value     记录的载荷（message 的字段见 M4 文档）
 * @param {string} [p.threadId]
 * @param {number} [p.at]
 * @param {Array}  [p.refs]
 */
export async function appendRecord({ kind, value, threadId = null, at = Date.now(), refs = [] }) {
  const profile = await ensureProfile();
  const id = `${kind}:${uuid()}`;
  const revisionId = uuid();
  const revision = {
    id,
    kind,
    profileId: profile.id,
    revisionId,
    parents: [],
    origin: { deviceId: deviceId(), platform: platform() },
    at,
    deleted: false,
    value,
    refs,
  };
  const head = {
    id,
    kind,
    profileId: profile.id,
    threadId,
    createdAt: at,
    messageTime: kind === 'message' ? at : undefined,
    revisions: [revisionId],
    conflict: false,
    deleted: false,
    threadKeys: threadId ? [threadId] : [],
  };
  await tx([STORE_HEADS, STORE_REVISIONS], 'readwrite', (t) => {
    t.objectStore(STORE_REVISIONS).put(revision);
    t.objectStore(STORE_HEADS).put(head);
  });
  return { headId: id, revisionId };
}

/** 给已有记录追加新 revision（内容变更走这条，不改老数据）。 */
export async function reviseRecord(headId, value, { at = Date.now(), deleted = false } = {}) {
  const db = await openDb();
  const head = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_HEADS, 'readonly');
    const r = t.objectStore(STORE_HEADS).get(headId);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (!head) throw new Error(`记录不存在：${headId}`);
  const revisionId = uuid();
  const revision = {
    id: head.id,
    kind: head.kind,
    profileId: head.profileId,
    revisionId,
    parents: head.revisions.slice(-1),
    origin: { deviceId: deviceId(), platform: platform() },
    at,
    deleted,
    value,
    refs: [],
  };
  const next = {
    ...head,
    revisions: head.revisions.concat(revisionId),
    deleted: !!deleted,
    messageTime: head.kind === 'message' ? at : head.messageTime,
  };
  await tx([STORE_HEADS, STORE_REVISIONS], 'readwrite', (t) => {
    t.objectStore(STORE_REVISIONS).put(revision);
    t.objectStore(STORE_HEADS).put(next);
  });
  return { headId, revisionId };
}

/** 取某条记录的最新有效 revision（head.deleted 视为不存在）。 */
export async function latestOf(head) {
  const db = await openDb();
  if (!head || head.deleted) return null;
  const last = head.revisions[head.revisions.length - 1];
  const rev = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_REVISIONS, 'readonly');
    const r = t.objectStore(STORE_REVISIONS).get(last);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return rev || null;
}

/**
 * 按 thread + kind 倒序取最近 limit 条（转成升序返回）。
 * 索引 profileKindThread = [profileId, kind, threadId]
 */
export async function recentRecords(kind, threadId, limit = 50) {
  const profile = await ensureProfile();
  const db = await openDb();
  const heads = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_HEADS, 'readonly');
    const idx = t.objectStore(STORE_HEADS).index('profileKindThread');
    const range = IDBKeyRange.only([profile.id, kind, threadId]);
    const out = [];
    const cur = idx.openCursor(range, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || out.length >= limit) {
        resolve(out);
        return;
      }
      if (!c.value.deleted) out.push(c.value);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  // 索引是 [profileId, kind, threadId]，不保证按时间序，自己排一下
  heads.sort((a, b) => (b.messageTime || b.createdAt || 0) - (a.messageTime || a.createdAt || 0));
  const trimmed = heads.slice(0, limit).reverse();
  const revs = [];
  for (const h of trimmed) {
    const rev = await latestOf(h);
    if (rev) revs.push(rev);
  }
  return revs;
}

/** 导出全部（迁移/备份用）——流式读，不一次性把大表塞内存。 */
export async function dumpAll() {
  const db = await openDb();
  const read = (store) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readonly');
      const r = t.objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  const [meta, profiles, heads, revisions] = await Promise.all([
    read(STORE_META),
    read(STORE_PROFILES),
    read(STORE_HEADS),
    read(STORE_REVISIONS),
  ]);
  return { meta, profiles, heads, revisions };
}

export { reqDone };
