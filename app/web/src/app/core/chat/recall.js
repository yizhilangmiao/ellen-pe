// 记忆召回：把「你这句话」和「她记得的事」对上号。
//
// 旧版的病（老 bug ③）：召回永远是同样 7 条 —— 打分只看时间窗不看内容，
// 于是聊天再久，她回忆的还是那几句。这里改成：
//   1) 按当前这句话做中文二元组（bigram）重叠打分，落点越密分越高
//   2) 记忆标题/正文整段命中再加一档
//   3) 时间只做轻微加权（0.15），不让「新的」压掉「对的」
//   4) 一条都没命中时才退回最近的几条，避免聊天空转
//
// 召回到的记忆由 chat/session.js 拼进 system 段，不进聊天记录。
import { listLatest } from '../store/library.js';
import { openDb, STORE_HEADS, STORE_REVISIONS } from '../store/db.js';

/** 中文按二元组切，英文/数字按整词。返回 Set。 */
export function tokens(text) {
  const out = new Set();
  const src = String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：""''（）《》…—·~,.!?;:"'()<>[\]{}/\\|@#$%^&*+=_`]/g, ' ');
  for (const part of src.split(' ')) {
    if (!part) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 2) out.add(part);
      continue;
    }
    const chars = [...part];
    if (chars.length === 1) {
      out.add(part);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

function overlapScore(query, target) {
  if (!query.size || !target.size) return 0;
  let hit = 0;
  for (const t of target) if (query.has(t)) hit++;
  return hit / Math.sqrt(target.size || 1);
}

function textOfEntry(entry) {
  const v = entry.value || {};
  if (entry.kind === 'memory') {
    return [v.title, v.subject, v.summary, v.body, v.reason].filter(Boolean).join(' ');
  }
  if (entry.kind === 'journal') {
    return [v.title, v.diary, v.thoughts, v.understanding && v.understanding.body].filter(Boolean).join(' ');
  }
  return [v.title, v.summary, v.text].filter(Boolean).join(' ');
}

function summarize(entry) {
  const v = entry.value || {};
  const title = v.title || v.subject || (entry.kind === 'journal' ? v.day : '') || '一件事';
  const body = v.summary || v.diary || v.thoughts || v.body || '';
  return { title: String(title), body: String(body).replace(/\s+/g, ' ').slice(0, 160) };
}

/**
 * 召回与这句话相关的记忆。
 * @param {string} text 用户刚说的话
 * @param {{limit?: number, minScore?: number, sources?: string[]}} [opts]
 * @returns {Promise<Array<{kind,title,body,score,at}>>}
 */
// ── 记忆索引缓存 ────────────────────────────────────────────────
// 为什么要有这一层：原来每条消息都调 listLatest(kind, {limit:300})，只看得见
// 「最近 300 条」。压测 5,000 条记忆时复现了老 bug ③ 的升级版：**最老那条永远
// 召回不到**（问「你还记得我那枚吊坠吗」她答「我不太清楚吊坠的事」）。
// 全量扫一遍 5,000 条实测 544 ms（读 heads 212 + 读 revisions 287 + 打分 44），
// 摊在每条消息上不可接受，所以：索引建一次缓存住，之后每次查询只打分（44 ms）。
// 写入（新记忆/新修改/新日记）会调 invalidateRecall() 让它重建，另外 5 分钟兜底过期。
const INDEX_TTL_MS = 5 * 60 * 1000;
const INDEX_MAX_ENTRIES = 20000; // 超过这个量级再谈分库，别偷偷截断而不报
let indexCache = null; // { at, entries: [{kind, entry, at, bag}] }

/** 记忆/日记被写过后调用：下次 recall 重建索引。 */
export function invalidateRecall() {
  indexCache = null;
}

// 「一个事务读完一类记录」的旁路读法。
//
// 为什么不用 listLatest：它在 store/library.js:51 对**每条 head 各起一个事务**
// （`await getOne(STORE_REVISIONS, last)`）。压测 5,020 条记忆时实测：
// 逐条独立事务外推 2,333 ms，同样的读收进一个事务只要 446 ms —— 差 5 倍，
// 慢的原因就是事务个数，不是数据量。
//
// 为什么不直接改 library.js：它是公共读路径（记忆页、备份、聊天历史都走），
// 改它要连带动一大片回归。召回只需要「全量 + 末条 revision」，足够自己读，
// 所以在这里开个旁路，library.js 一个字不动。
//
// 顺带的好处：按 revisionId 精确取，不会扫到库里那些没有 head 的孤儿 revision。
//
// 返回结构和 listLatest 逐字段一致；失败时抛出去，由 buildIndex 回退老路。
function readLatestOneTx(kinds) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([STORE_HEADS, STORE_REVISIONS], 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const headStore = tx.objectStore(STORE_HEADS);
    const revStore = tx.objectStore(STORE_REVISIONS);
    const byKind = new Map();

    for (const kind of kinds) {
      byKind.set(kind, []);
      const req = headStore.index('kind').getAll(kind);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const heads = (req.result || []).filter(
          (h) => h && !h.deleted && Array.isArray(h.revisions) && h.revisions.length,
        );
        heads.sort((a, b) => {
          const ta = Number.isFinite(a.messageTime) ? a.messageTime : a.createdAt || 0;
          const tb = Number.isFinite(b.messageTime) ? b.messageTime : b.createdAt || 0;
          return tb - ta;
        });
        const bucket = byKind.get(kind);
        for (const h of heads) {
          const last = h.revisions[h.revisions.length - 1];
          const r = revStore.get(last);
          r.onsuccess = () => {
            const rev = r.result;
            if (!rev || rev.deleted) return;
            bucket.push({
              headId: h.id,
              kind: h.kind,
              threadId: h.threadId,
              revisionId: rev.revisionId,
              at: rev.at,
              value: rev.value,
              refs: rev.refs || [],
              createdAt: h.createdAt,
            });
          };
        }
      };
    }

    // 事务只在「没有挂起请求」时才提交，所以 heads 回调里追加的 get 都算数。
    tx.oncomplete = () => {
      const out = [];
      for (const kind of kinds) out.push(...(byKind.get(kind) || []));
      resolve(out);
    };
    tx.onerror = () => reject(tx.error || new Error('[recall] 批量读事务失败'));
    tx.onabort = () => reject(tx.error || new Error('[recall] 批量读事务被中止'));
  }));
}

async function buildIndex(sources) {
  const entries = [];
  let all = null;
  try {
    all = await readLatestOneTx(sources);
  } catch (err) {
    console.warn('[recall] 单事务批量读失败，回退 listLatest：', err);
    all = null;
  }

  if (all) {
    for (const entry of all) {
      entries.push({ kind: entry.kind, entry, at: entry.at || 0, bag: tokens(textOfEntry(entry)) });
    }
  } else {
    for (const kind of sources) {
      let list = [];
      try {
        list = await listLatest(kind, { limit: 0 });
      } catch (err) {
        console.warn('[recall] 读不到', kind, err);
        continue;
      }
      for (const entry of list) {
        entries.push({ kind, entry, at: entry.at || 0, bag: tokens(textOfEntry(entry)) });
      }
    }
  }

  if (entries.length > INDEX_MAX_ENTRIES) {
    console.warn('[recall] 索引条目过多，按时间保留最近的', INDEX_MAX_ENTRIES, '条，共', entries.length);
    entries.sort((a, b) => b.at - a.at);
    entries.length = INDEX_MAX_ENTRIES;
  }
  indexCache = { at: Date.now(), entries };
  return entries;
}

export async function recall(text, { limit = 6, minScore = 0.16, sources = ['memory', 'journal'] } = {}) {
  const q = tokens(text);
  const rows = [];
  const cached = indexCache && Date.now() - indexCache.at < INDEX_TTL_MS ? indexCache : null;
  const index = cached ? cached.entries : await buildIndex(sources);
  for (const item of index) {
    const score = overlapScore(q, item.bag);
    rows.push({ kind: item.kind, entry: item.entry, score, at: item.at });
  }

  const now = Date.now();
  const scored = rows.map((r) => {
    // 时间只做轻微加权：三个月内线性，之后归零
    const age = Math.max(0, now - (r.at || now));
    const recency = Math.max(0, 1 - age / (90 * 24 * 3600 * 1000)) * 0.15;
    return { ...r, total: r.score + recency };
  });

  const hits = scored.filter((r) => r.score >= minScore).sort((a, b) => b.total - a.total);
  let picked = hits.slice(0, limit);

  if (!picked.length) {
    // 一句都没对上：退回最近的几条，别让她失忆
    picked = scored.sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0)).slice(0, Math.min(3, limit));
  }

  return picked.map((r) => ({
    kind: r.kind,
    at: r.at,
    score: Number(r.total.toFixed(3)),
    hit: Number(r.score.toFixed(3)),
    ...summarize(r.entry),
  }));
}

/** 把召回结果拼成一段给模型看的文字。没有就返回空串。 */
export function renderRecall(items) {
  if (!items || !items.length) return '';
  const lines = items.map((it, i) => `${i + 1}. [${it.kind === 'journal' ? '手记' : '记忆'}] ${it.title}：${it.body}`);
  return `这些是你记得的事，和现在的话题有关就用得上，不相关就忽略：\n${lines.join('\n')}`;
}
