// 按 kind 取"当前内容"：head 的末条 revision。
//
// 旧包的数据模型是事件溯源，一次改动一条 revision；界面要的是最新那版，
// 所以读的一律是 `head.revisions` 末项。deleted 的 head 不出现。
import {
  STORE_HEADS,
  STORE_REVISIONS,
  openDb,
} from './db.js';

function getAll(store, index, query) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const s = t.objectStore(store);
    const req = index ? s.index(index).getAll(query) : s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function getOne(store, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

/**
 * 取某类记录的最新一版。
 * @param {string} kind   memory / journal / note / source / attachment / message / emotion
 * @param {{limit?: number, profileId?: string}} [opts]
 * @returns {Promise<Array<{headId, kind, revisionId, at, value, refs, deleted}>>}
 */
export async function listLatest(kind, { limit = 0, profileId = null } = {}) {
  const heads = profileId
    ? await getAll(STORE_HEADS, 'profileKind', [profileId, kind])
    : await getAll(STORE_HEADS, 'kind', kind);
  const alive = heads.filter((h) => h && !h.deleted && Array.isArray(h.revisions) && h.revisions.length);
  // 新的在前
  alive.sort((a, b) => {
    const ta = Number.isFinite(a.messageTime) ? a.messageTime : a.createdAt || 0;
    const tb = Number.isFinite(b.messageTime) ? b.messageTime : b.createdAt || 0;
    return tb - ta;
  });
  const picked = limit > 0 ? alive.slice(0, limit) : alive;
  const out = [];
  for (const h of picked) {
    const last = h.revisions[h.revisions.length - 1];
    const rev = await getOne(STORE_REVISIONS, last);
    if (!rev || rev.deleted) continue;
    out.push({
      headId: h.id,
      kind: h.kind,
      threadId: h.threadId,
      revisionId: rev.revisionId,
      at: rev.at,
      value: rev.value,
      refs: rev.refs || [],
      createdAt: h.createdAt,
    });
  }
  return out;
}

/** 各类记录的条数（界面/验收用）。 */
export async function countByKind() {
  const heads = await getAll(STORE_HEADS, null, null);
  const out = {};
  for (const h of heads) {
    if (!h || h.deleted) continue;
    out[h.kind] = (out[h.kind] || 0) + 1;
  }
  return out;
}

/** 最早一条消息的时间（相处天数要用它）。没有消息时返回 0。 */
export async function earliestMessageAt() {
  const heads = await getAll(STORE_HEADS, 'kind', 'message');
  let min = 0;
  for (const h of heads) {
    if (!h || h.deleted) continue;
    const t = Number.isFinite(h.messageTime) ? h.messageTime : h.createdAt || 0;
    if (t && (!min || t < min)) min = t;
  }
  return min;
}

/** 按 thread 聚消息条数（聊天历史页用）。 */
export async function messageThreads() {
  const heads = await getAll(STORE_HEADS, 'kind', 'message');
  const map = new Map();
  for (const h of heads) {
    if (!h || h.deleted || !h.threadId) continue;
    const t = Number.isFinite(h.messageTime) ? h.messageTime : h.createdAt || 0;
    const cur = map.get(h.threadId) || { threadId: h.threadId, count: 0, lastAt: 0 };
    cur.count += 1;
    if (t > cur.lastAt) cur.lastAt = t;
    map.set(h.threadId, cur);
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}
