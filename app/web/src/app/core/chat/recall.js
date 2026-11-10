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
export async function recall(text, { limit = 6, minScore = 0.16, sources = ['memory', 'journal'] } = {}) {
  const q = tokens(text);
  const rows = [];
  for (const kind of sources) {
    let list = [];
    try {
      list = await listLatest(kind, { limit: 300 });
    } catch (err) {
      console.warn('[recall] 读不到', kind, err);
      continue;
    }
    for (const entry of list) {
      const body = textOfEntry(entry);
      const score = overlapScore(q, tokens(body));
      rows.push({ kind, entry, score, at: entry.at || 0 });
    }
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
