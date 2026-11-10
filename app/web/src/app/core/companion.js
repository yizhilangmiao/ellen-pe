// 相处页（底栏「相处」）的数据层。
//
// 这一页要四样东西，来源各不相同：
//   1. 相处天数 —— 最早一条消息的时间，没有消息时用 meta 里的 first-seen（安装第一天）
//   2. 艾莲的此刻（心情）—— `emotion` 类记录，最新一条
//   3. 艾莲的便签 —— 跟心情同一次调用里写下的短句（旧包也是绑在一起的）
//   4. 我们之间（关系）—— meta 里的 relationship，默认「恋人」（老包 localStorage
//      的 ellen-lover / ellen-close 就是这一档，新壳收进库，跨设备才带得走）
//
// 心情不每条消息都问一遍模型：MEET_GAP_MS 内只记一次，否则一天几十次调用。
import { listLatest, earliestMessageAt } from './store/library.js';
import { getMeta, putMeta, appendRecord } from './store/records.js';
import { ask } from './chat/oneshot.js';

const RELATIONSHIPS = [
  { id: 'lover', label: '恋人' },
  { id: 'close', label: '亲近' },
  { id: 'friend', label: '朋友' },
  { id: 'new', label: '刚认识' },
];

const DEFAULT_RELATIONSHIP = 'lover';
const MOOD_GAP_MS = 6 * 60 * 60 * 1000;
const MOOD_LOOKBACK = 24;

export { RELATIONSHIPS, MOOD_GAP_MS };

export function relationshipOf(id) {
  return RELATIONSHIPS.find((r) => r.id === id) || RELATIONSHIPS[0];
}

export async function relationship() {
  const v = await getMeta('relationship', DEFAULT_RELATIONSHIP);
  return relationshipOf(v);
}

export async function setRelationship(id) {
  const target = relationshipOf(id);
  await putMeta('relationship', target.id);
  return target;
}

/**
 * 相处天数。起点优先用库里最早一条消息（最准）；
 * 一次消息都没有过（刚装就打开相处页）才退回 first-seen。
 */
export async function daysTogether(now = Date.now()) {
  const earliest = await earliestMessageAt();
  let start = earliest;
  if (!start) {
    start = await getMeta('first-seen', null);
    if (!start) {
      start = now;
      await putMeta('first-seen', start);
    }
  }
  const days = Math.floor((now - start) / 86400000) + 1;
  return days > 0 ? days : 1;
}

function moodCard(item) {
  const v = (item && item.value) || {};
  return {
    mood: v.mood || '',
    note: v.note || '',
    at: item ? item.at : 0,
    headId: item ? item.headId : null,
  };
}

/** 最新心情。没有记录时返回 null，页面显示「待了解」。 */
export async function currentMood() {
  const rows = await listLatest('emotion', { limit: 1 });
  if (!rows.length) return null;
  const card = moodCard(rows[0]);
  return card.mood ? card : null;
}

async function lastMoodAt() {
  const rows = await listLatest('emotion', { limit: 1 });
  return rows.length ? rows[0].at || 0 : 0;
}

/**
 * 问她现在心情如何 + 让她写一句便签。
 * 一次调用同时产出 mood 与 note，跟旧包一样绑在一起 —— 便签是「此刻想说的话」，
 * 心情是「此刻是什么状态」，分开两次问会自相矛盾。
 */
export async function composeMood({ config, messages, now = Date.now() }) {
  const recent = (messages || [])
    .filter((m) => m && m.text && !m.pending && !m.failed && !m.text.startsWith('（'))
    .slice(-MOOD_LOOKBACK);
  if (!recent.length) return { skipped: 'noMessages' };

  const transcript = recent
    .map((m) => `${m.role === 'user' ? '他' : '你'}：${String(m.text).trim()}`)
    .join('\n');

  const raw = await ask({
    config,
    maxTokens: 400,
    messages: [
      {
        role: 'system',
        content:
          '你在扮演「艾莲」，一个有点黏人、说话直白、会照顾人的女孩子。\n' +
          '根据下面这段聊天，回答你自己此刻的状态。只输出 JSON：\n' +
          '{"mood":"两个到四个字的此刻心情","note":"一句二十字以内、写给自己的便签"}\n' +
          '要求：\n' +
          '- mood 用具体情绪词（如 有点想他 / 心里踏实 / 空落落 / 提不起劲），不要「开心」「难过」这种大词；\n' +
          '- note 是第一人称的一句话，像手机备忘录里随手写的，不要总结聊天内容；\n' +
          '- 不要输出 JSON 以外的任何字。',
      },
      { role: 'user', content: `我们最近的聊天：\n${transcript}` },
    ],
  });

  let mood = '';
  let note = '';
  try {
    const parsed = JSON.parse(String(raw).trim());
    mood = String(parsed.mood || '').trim();
    note = String(parsed.note || '').trim();
  } catch {
    // 模型没照格式写：把整段当便签，心情留空（页面会显示「待了解」）
    note = String(raw || '').trim().slice(0, 40);
  }
  if (!mood && !note) return { skipped: 'empty' };

  const at = Date.now();
  const value = {
    mood: mood.slice(0, 8),
    note: note.slice(0, 60),
    at,
    sourceIds: recent.slice(-6).map((m) => m.headId).filter(Boolean),
  };
  return { value, at };
}

/** 有门槛地记一次心情：距上次不足 MOOD_GAP_MS 就跳过。 */
let running = false;
export function isRunning() {
  return running;
}

export async function maybeRecordMood({ config, messages, now = Date.now() }) {
  if (running) return { skipped: 'running' };
  const last = await lastMoodAt();
  if (last && now - last < MOOD_GAP_MS) {
    return { skipped: 'tooSoon', nextAt: last + MOOD_GAP_MS };
  }
  running = true;
  try {
    const composed = await composeMood({ config, messages, now });
    if (composed.skipped) return composed;
    const rec = await appendRecord({
      kind: 'emotion',
      value: composed.value,
      threadId: null,
      at: composed.at,
    });
    return { ok: true, headId: rec.headId, value: composed.value };
  } finally {
    running = false;
  }
}

/** 相处页一次性把四块数据取全。 */
export async function snapshot(now = Date.now()) {
  const [days, mood, rel] = await Promise.all([daysTogether(now), currentMood(), relationship()]);
  return { days, mood, relationship: rel };
}
